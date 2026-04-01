const DEFAULT_BASE_URL = 'https://api.minimax.chat/v1'
const DEFAULT_CHAT_PATH = '/chat/completions'
const DEFAULT_MODEL = 'MiniMax-M2.7'

function createMinimaxProvider(config = {}) {
  const baseUrl = (config.baseUrl || process.env.MINIMAX_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const endpoint = config.endpoint || process.env.MINIMAX_CHAT_ENDPOINT || `${baseUrl}${DEFAULT_CHAT_PATH}`
  const apiKey = config.apiKey || process.env.MINIMAX_API_KEY || ''
  const model = config.model || process.env.MINIMAX_MODEL || DEFAULT_MODEL
  const timeoutMs = Number(config.timeoutMs || process.env.MINIMAX_TIMEOUT_MS || 120000)

  if (!apiKey) {
    throw new Error('Missing MINIMAX_API_KEY')
  }

  async function chatCompletions({ messages, tools, stream = false, temperature = 0.2, max_tokens = 4096 }) {
    const body = {
      model,
      messages,
      temperature,
      max_tokens,
      stream,
      ...(Array.isArray(tools) && tools.length ? { tools } : {}),
      tool_choice: 'auto',
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!res.ok) {
        const errText = await res.text()
        throw new Error(`Minimax API ${res.status}: ${errText}`)
      }

      if (!stream) {
        return { stream: false, data: await res.json() }
      }

      if (!res.body) {
        throw new Error('Stream response has no body')
      }
      return { stream: true, body: res.body }
    } finally {
      clearTimeout(timeout)
    }
  }

  return {
    model,
    endpoint,
    chatCompletions,
  }
}

module.exports = {
  createMinimaxProvider,
  DEFAULT_MODEL,
}

