const fs = require('fs/promises')
const path = require('path')
const readline = require('readline/promises')
const { stdin, stdout } = require('process')
const { spawn } = require('child_process')

function safeResolvePath(rootDir, p) {
  const abs = path.resolve(rootDir, p || '.')
  if (!abs.startsWith(path.resolve(rootDir))) {
    throw new Error('Path is outside allowed workspace')
  }
  return abs
}

function createToolRuntime({ rootDir, requireConfirm = true, log = () => {} }) {
  const MAX_SEARCH_DEPTH = 8
  const MAX_SEARCH_RESULTS = 200
  const COMMAND_TIMEOUT_MS = Number(
    process.env.MINIMAX_COMMAND_TIMEOUT_MS || process.env.MINIMAX_TIMEOUT_MS || 120000,
  )
  const SKIP_DIRS = new Set([
    '.git',
    'node_modules',
    '.next',
    '.turbo',
    'dist',
    'build',
    '.cache',
  ])

  function parseCommand(raw) {
    const s = String(raw || '').trim()
    if (!s) return null
    // block shell metacharacters to avoid shell injection patterns
    if (/[;&|><`$(){}\n\r]/.test(s)) return null

    const tokens = []
    let cur = ''
    let quote = null
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i]
      if (quote) {
        if (ch === quote) {
          quote = null
        } else if (ch === '\\' && i + 1 < s.length) {
          i += 1
          cur += s[i]
        } else {
          cur += ch
        }
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (/\s/.test(ch)) {
        if (cur) {
          tokens.push(cur)
          cur = ''
        }
      } else {
        cur += ch
      }
    }
    if (quote) return null
    if (cur) tokens.push(cur)
    if (!tokens.length) return null
    return { command: tokens[0], args: tokens.slice(1) }
  }

  async function confirmAction(message) {
    if (!requireConfirm) return true
    const rl = readline.createInterface({ input: stdin, output: stdout })
    try {
      const ans = (await rl.question(`${message} [y/N]: `)).trim().toLowerCase()
      return ans === 'y' || ans === 'yes'
    } finally {
      rl.close()
    }
  }

  async function read_file(args = {}) {
    const target = safeResolvePath(rootDir, args.path)
    const content = await fs.readFile(target, 'utf8')
    return { path: target, content }
  }

  async function write_file(args = {}) {
    const target = safeResolvePath(rootDir, args.path)
    const ok = await confirmAction(`Write file: ${target}?`)
    if (!ok) return { cancelled: true }
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, String(args.content ?? ''), 'utf8')
    return { path: target, written: true }
  }

  async function search_text(args = {}) {
    const target = safeResolvePath(rootDir, args.path || '.')
    const q = String(args.query || '').toLowerCase()
    if (!q) return { matches: [] }
    const out = []
    let skippedUnreadable = 0
    async function walk(dir, depth = 0) {
      if (depth > MAX_SEARCH_DEPTH) return
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) continue
          await walk(p, depth + 1)
        } else {
          let text
          try {
            text = await fs.readFile(p, 'utf8')
          } catch {
            skippedUnreadable += 1
            continue
          }
          if (text.toLowerCase().includes(q)) {
            out.push(path.relative(rootDir, p))
          }
        }
      }
    }
    await walk(target, 0)
    return { matches: out.slice(0, MAX_SEARCH_RESULTS), skippedUnreadable }
  }

  async function run_bash(args = {}) {
    const parsed = parseCommand(args.command)
    if (!parsed) {
      return {
        error:
          'Invalid or unsafe command format. Use plain command and args without shell operators.',
      }
    }
    const printable = [parsed.command, ...parsed.args].join(' ')
    const ok = await confirmAction(`Run command: ${printable}?`)
    if (!ok) return { cancelled: true }
    return new Promise((resolve) => {
      const child = spawn(parsed.command, parsed.args, {
        cwd: rootDir,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let out = ''
      let err = ''
      let finished = false
      const timer = setTimeout(() => {
        if (!finished) {
          child.kill('SIGTERM')
        }
      }, COMMAND_TIMEOUT_MS)

      child.stdout.on('data', (chunk) => {
        out += chunk.toString()
      })
      child.stderr.on('data', (chunk) => {
        err += chunk.toString()
      })
      child.on('error', (error) => {
        finished = true
        clearTimeout(timer)
        resolve({
          code: 1,
          stdout: out,
          stderr: `${err}\n${error.message}`.trim(),
        })
      })
      child.on('close', (code) => {
        finished = true
        clearTimeout(timer)
        resolve({
          code: typeof code === 'number' ? code : 1,
          stdout: out,
          stderr: err,
        })
      })
    })
  }

  const toolFns = { read_file, write_file, search_text, run_bash }
  const tools = [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read UTF-8 file content inside workspace',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write UTF-8 content to file inside workspace',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_text',
        description: 'Search text in workspace files',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            path: { type: 'string' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_bash',
        description: 'Execute shell command in workspace with confirmation',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    },
  ]

  async function executeToolCall(toolCall) {
    const name = toolCall?.function?.name
    const args = JSON.parse(toolCall?.function?.arguments || '{}')
    const fn = toolFns[name]
    if (!fn) return { error: `Unknown tool: ${name}` }
    log(`tool:${name}`)
    try {
      return await fn(args)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }

  return {
    tools,
    executeToolCall,
  }
}

module.exports = { createToolRuntime }
