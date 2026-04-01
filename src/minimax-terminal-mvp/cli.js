#!/usr/bin/env node
const fs = require('fs/promises')
const path = require('path')
const os = require('os')
const readline = require('readline/promises')
const { stdin, stdout } = require('process')
const { createMinimaxProvider } = require('./minimaxProvider')
const { createToolRuntime } = require('./toolRuntime')

const APP_DIR = path.join(os.homedir(), '.minimax-terminal-mvp')
const CONFIG_PATH = path.join(APP_DIR, 'config.json')
const HISTORY_PATH = path.join(APP_DIR, 'history.json')

async function ensureAppDir() {
  await fs.mkdir(APP_DIR, { recursive: true })
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')
}

async function loadConfig() {
  await ensureAppDir()
  return readJson(CONFIG_PATH, {
    model: process.env.MINIMAX_MODEL || 'MiniMax-M2.7',
    endpoint: process.env.MINIMAX_CHAT_ENDPOINT || '',
    timeoutMs: Number(process.env.MINIMAX_TIMEOUT_MS || 120000),
    temperature: 0.2,
    max_tokens: 4096,
    workspace: process.cwd(),
    requireConfirm: true,
  })
}

function parseSSE(buffer, onEvent) {
  const chunks = buffer.split('\n\n')
  const rest = chunks.pop() || ''
  for (const chunk of chunks) {
    const lines = chunk.split('\n')
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        onEvent(JSON.parse(data))
      } catch {
        // ignore invalid stream fragments
      }
    }
  }
  return rest
}

function extractTextDelta(event) {
  const delta =
    event?.choices?.[0]?.delta?.content ??
    event?.choices?.[0]?.delta?.reasoning_content ??
    ''
  return typeof delta === 'string' ? delta : ''
}

function extractToolCallsFromEvent(event) {
  const tc =
    event?.choices?.[0]?.delta?.tool_calls ||
    event?.choices?.[0]?.message?.tool_calls ||
    event?.tool_calls
  return Array.isArray(tc) ? tc : []
}

async function streamCompletion(provider, payload, onDelta) {
  const res = await provider.chatCompletions({ ...payload, stream: true })
  let acc = ''
  const toolCallMap = new Map()
  let buffer = ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    buffer = parseSSE(buffer, (event) => {
      const t = extractTextDelta(event)
      if (t) {
        acc += t
        onDelta(t)
      }
      const tcs = extractToolCallsFromEvent(event)
      for (const tc of tcs) {
        const idx = Number(tc?.index ?? 0)
        const curr = toolCallMap.get(idx) || {
          id: tc?.id,
          type: tc?.type || 'function',
          function: { name: '', arguments: '' },
        }
        if (tc?.id) curr.id = tc.id
        if (tc?.function?.name) curr.function.name += tc.function.name
        if (tc?.function?.arguments) curr.function.arguments += tc.function.arguments
        toolCallMap.set(idx, curr)
      }
    })
  }
  return { text: acc, toolCalls: [...toolCallMap.values()] }
}

async function runAssistantTurn({ provider, toolRuntime, messages, config }) {
  const payload = {
    messages,
    tools: toolRuntime.tools,
    temperature: config.temperature,
    max_tokens: config.max_tokens,
  }

  const streamed = await streamCompletion(provider, payload, (d) => stdout.write(d))
  stdout.write('\n')
  const text = streamed.text
  const toolCalls = streamed.toolCalls
  if (!toolCalls.length) {
    return [{ role: 'assistant', content: text || '(empty response)' }]
  }

  const appended = []
  appended.push({
    role: 'assistant',
    content: text || '',
    tool_calls: toolCalls,
  })

  for (const [i, tc] of toolCalls.entries()) {
    const result = await toolRuntime.executeToolCall(tc)
    appended.push({
      role: 'tool',
      tool_call_id:
        tc.id ||
        `${tc.function?.name || 'tool'}-${Date.now()}-${i + 1}`,
      name: tc.function?.name || 'tool',
      content: JSON.stringify(result),
    })
  }
  return appended
}

async function isValidWorkspace(p) {
  try {
    const st = await fs.stat(p)
    return st.isDirectory()
  } catch {
    return false
  }
}

function printHelp() {
  stdout.write(
    [
      'Commands:',
      '  /help                     Show help',
      '  /exit                     Exit',
      '  /model [name]             Show/set model',
      '  /config                   Show current config',
      '  /workspace [abs_path]     Show/set workspace',
      '',
    ].join('\n') + '\n',
  )
}

async function main() {
  const config = await loadConfig()
  const messages = await readJson(HISTORY_PATH, [])

  const provider = createMinimaxProvider({
    model: config.model,
    endpoint: config.endpoint || undefined,
    timeoutMs: config.timeoutMs,
  })

  const toolRuntime = createToolRuntime({
    rootDir: config.workspace,
    requireConfirm: !!config.requireConfirm,
    log: (m) => stdout.write(`[tool] ${m}\n`),
  })

  stdout.write(`Minimax Terminal MVP\nmodel=${provider.model}\nworkspace=${config.workspace}\n`)
  printHelp()
  const rl = readline.createInterface({ input: stdin, output: stdout })
  try {
    while (true) {
      const input = (await rl.question('\n> ')).trim()
      if (!input) continue
      const [cmd, ...rest] = input.split(/\s+/)
      const arg = rest.join(' ').trim()

      if (input === '/exit') break
      if (input === '/help') {
        printHelp()
        continue
      }
      if (cmd === '/model') {
        const next = arg
        if (next) {
          config.model = next
          await writeJson(CONFIG_PATH, config)
          stdout.write(`model updated: ${next}\n`)
        } else {
          stdout.write(`model: ${config.model}\n`)
        }
        continue
      }
      if (input === '/config') {
        stdout.write(`${JSON.stringify(config, null, 2)}\n`)
        continue
      }
      if (cmd === '/workspace') {
        const p = arg
        if (p) {
          if (!path.isAbsolute(p)) {
            stdout.write('workspace path must be absolute\n')
            continue
          }
          if (!(await isValidWorkspace(p))) {
            stdout.write('workspace path must exist and be a directory\n')
            continue
          }
          config.workspace = p
          await writeJson(CONFIG_PATH, config)
          stdout.write(`workspace updated: ${p}\n`)
        } else {
          stdout.write(`workspace: ${config.workspace}\n`)
        }
        continue
      }

      messages.push({ role: 'user', content: input })
      const appended = await runAssistantTurn({
        provider,
        toolRuntime,
        messages,
        config,
      })
      messages.push(...appended)
      await writeJson(HISTORY_PATH, messages)
    }
  } finally {
    rl.close()
  }
}

main().catch((e) => {
  stdout.write(`Fatal: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
