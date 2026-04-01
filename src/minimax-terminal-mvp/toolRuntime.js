const fs = require('fs/promises')
const path = require('path')
const readline = require('readline/promises')
const { stdin, stdout } = require('process')
const { exec } = require('child_process')

function safeResolvePath(rootDir, p) {
  const abs = path.resolve(rootDir, p || '.')
  if (!abs.startsWith(path.resolve(rootDir))) {
    throw new Error('Path is outside allowed workspace')
  }
  return abs
}

function createToolRuntime({ rootDir, requireConfirm = true, log = () => {} }) {
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
    async function walk(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) {
          await walk(p)
        } else {
          const text = await fs.readFile(p, 'utf8').catch(() => null)
          if (!text) continue
          if (text.toLowerCase().includes(q)) {
            out.push(path.relative(rootDir, p))
          }
        }
      }
    }
    await walk(target)
    return { matches: out.slice(0, 200) }
  }

  async function run_bash(args = {}) {
    const cmd = String(args.command || '')
    if (!cmd) return { error: 'Missing command' }
    const ok = await confirmAction(`Run command: ${cmd}?`)
    if (!ok) return { cancelled: true }
    return new Promise((resolve) => {
      exec(cmd, { cwd: rootDir, timeout: 120000, maxBuffer: 2 * 1024 * 1024 }, (error, out, err) => {
        resolve({
          code: error && typeof error.code === 'number' ? error.code : 0,
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

