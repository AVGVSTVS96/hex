import { readFileSync } from 'fs'
import { join } from 'path'
import { route } from './hub.ts'

// Claude Code's side of a session's channel to a hub, for tests: it initializes, opens the stream
// its messages arrive on, lists the tools, and lists them again when told they changed. deaf: how
// many tools/list_changed it drops, as a session starting cold does before it listens.
export type Session = ReturnType<typeof http>

// A PATH whose claude lists no sessions, for a test whose hub would otherwise ask the real one, which
// starts a daemon of its own for any CLAUDE_CONFIG_DIR a test left set, and never stops it. It lives
// in the repo, so a hub still running after its test's folder is gone keeps finding it.
export const noClaude = () => `${join(import.meta.dir, 'no-claude')}:${process.env.PATH}`

// A fake claude's `attach`: in its terminal, Esc interrupts the session's turn, which its transcript
// records, and it stays attached until it's hung up on. With a file named gone in Claude's config
// folder, the session's job is gone and it exits, as Claude's does; with one named idle, the
// session's turn is over, so Esc changes nothing and the transcript only records a request that
// repeats an earlier interrupt.
export const ATTACH = `[ "$1" = attach ] && [ -f "$CLAUDE_CONFIG_DIR/gone" ] && { echo "No job matching $2"; exit 1; }
[ "$1" = attach ] && [ -f "$CLAUDE_CONFIG_DIR/idle" ] && { stty raw -echo; printf 'Attaching\\r\\nscreen'; dd bs=1 count=1 >/dev/null 2>&1; echo '{"type":"api-request-blob","message":{"content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}' >> "$(ls "$CLAUDE_CONFIG_DIR"/projects/*/"$2"*.jsonl | head -1)"; exec sleep 60; }
[ "$1" = attach ] && { stty raw -echo; printf 'Attaching\\r\\nscreen'; [ "$(dd bs=1 count=1 2>/dev/null)" = "$(printf '\\033')" ] && echo '{"type":"user","message":{"content":"[Request interrupted by user for tool use]"}}' >> "$(ls "$CLAUDE_CONFIG_DIR"/projects/*/"$2"*.jsonl | head -1)"; exec sleep 60; }`

let ids = 0
const streams: AbortController[] = []
let listener: ReturnType<typeof Bun.serve> | undefined

// The one listener serve.ts opens, for a test's hubs.
export function port() {
  listener ??= Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: route })
  return listener.port
}

export function hangUpAll() {
  for (const stream of streams.splice(0)) stream.abort()
}

// A client's bot.ts run in its own process the way serve.ts runs it, behind a listener on a free
// port, which the hub reads from HEX_PORT as it loads.
export async function service(bot: string, env: Record<string, string | undefined>) {
  const hub = JSON.stringify(join(import.meta.dir, 'hub.ts'))
  const script = `const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: request => route(request) })
process.env.HEX_PORT = String(listener.port)
const { route } = await import(${hub})
console.log(listener.port)
await import(${JSON.stringify(bot)})`
  const child = Bun.spawn(['bun', '-e', script], { env, stdout: 'pipe', stderr: 'ignore' })
  const reader = child.stdout.getReader()
  let out = ''
  while (!out.includes('\n')) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`${bot} exited before it listened`)
    out += new TextDecoder().decode(value)
  }
  void (async () => { while (!(await reader.read()).done); })()
  return { process: child, port: Number(out.split('\n')[0]) }
}

// at: the port of a hub in another process; this process's own listener by default.
export function http({ stateDir, path, channel, thread, extra = {}, deaf = 0, at = port() }: { stateDir: string; path: string; channel: string; thread?: string; extra?: Record<string, string>; deaf?: number; at?: number }) {
  const url = `http://127.0.0.1:${at}${path}`
  const headers = { ...(thread && { 'x-hex-channel': channel, 'x-hex-thread': thread }), authorization: `Bearer ${readFileSync(join(stateDir, 'token'), 'utf8')}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra }
  const received: any[] = []
  const stream = new AbortController()
  streams.push(stream)
  let mcp = ''
  let lists = 0
  const post = (body: object) => fetch(url, { method: 'POST', headers: { ...headers, ...(mcp && { 'mcp-session-id': mcp }) }, body: JSON.stringify({ jsonrpc: '2.0', ...body }) })
  // A list counts once the hub has answered it, so whatever the list set off on its side is done.
  const rpc = async (method: string, params: object = {}) => {
    const reply = await (await post({ id: ++ids, method, params })).json()
    if (method === 'tools/list') lists++
    return reply as any
  }
  return {
    received,
    listed: () => lists,
    post,
    rpc,
    initialize: async () => (mcp = (await post({ id: ++ids, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } } })).headers.get('mcp-session-id')!),
    open: async (adopted?: string) => {
      if (adopted) mcp = adopted
      const response = await fetch(url, { headers: { ...headers, 'mcp-session-id': mcp }, signal: stream.signal })
      void listen(response, received, () => void (deaf-- > 0 || rpc('tools/list')))
      return response
    },
    close: () => stream.abort(),
    call: async (tool: string, args: object = {}) => (await rpc('tools/call', { name: tool, arguments: args })).result,
    ask: (request: object) => post({ method: 'notifications/claude/channel/permission_request', params: request }),
  }
}

// A session connected and listening, the way it is once Claude Code has started it. Its tool
// calls answer with the text, or the error, the tool gave.
export async function connect(options: Parameters<typeof http>[0]) {
  const line = http(options)
  await line.initialize()
  await line.open()
  await line.rpc('tools/list')
  for (const end = Date.now() + 3000; line.listed() < 2; await Bun.sleep(10)) if (Date.now() > end) throw new Error('the hub never opened the channel')
  await Bun.sleep(10)
  return {
    ...line,
    call: async (tool: string, args: object = {}) => {
      const { content, isError } = await line.call(tool, args)
      const text: string = content[0].text
      return isError ? { error: text.replace(`${tool} failed: `, '') } : { text }
    },
  }
}

async function listen(response: Response, received: any[], changed: () => void) {
  let buffer = ''
  try {
    for await (const chunk of response.body!) {
      buffer += new TextDecoder().decode(chunk)
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const data = buffer.slice(0, end).split('\n').find(line => line.startsWith('data: '))
        buffer = buffer.slice(end + 2)
        if (!data) continue
        const { method, params } = JSON.parse(data.slice(6))
        if (method === 'notifications/tools/list_changed') changed()
        else received.push({ type: method === 'notifications/claude/channel' ? 'inbound' : 'permission', ...params })
      }
    }
  } catch {}
}
