import { clock } from './clock.ts'

export type Tool = { name: string; description: string; inputSchema: object; annotations?: { readOnlyHint?: boolean }; _meta?: object }
// What a chat app's channel says to each session: how to read its messages, and the tools that act in its thread.
export type ChannelServer = { title: string; instructions: string; tools: Tool[]; permission?: boolean }
export type Payload = { type: 'inbound'; content: string; meta: Record<string, string> } | { type: 'permission'; request_id: string; behavior: string }
export type Line = { send: (payload: Payload) => void }

type Hooks = {
  call: (thread: string, tool: string, args: Record<string, unknown>) => Promise<string>
  permission: (thread: string, request: any) => void
  open: (thread: string, line: Line) => void
  close: (thread: string, line: Line) => void
}

// The revisions whose standalone GET stream carries server notifications. Claude Code first probes
// `server/discover` for 2026-07-28, where it registers no channel ("no unsolicited notification
// path"), and falls back to `initialize` when that's declined.
const REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26']
const encoder = new TextEncoder()
const NUDGE = 250
// Claude Code gives up on a tool call after the timeout in the channel's .mcp.json (300000 ms),
// while the hub still carries it out, and the session then makes the same call again before its
// turn ends. A call stays unheard until the session hears its answer, and the same call in its
// thread, until the thread's turn ends (rested), gets that answer instead of acting twice. A call
// that reached the hub GAVE_UP before its answer counts as unheard even with no abort seen, since a
// lagging hub accepts late and can miss the session leaving. KEEP bounds a finished call's record
// for sessions whose turns the hub doesn't follow. A tool that only reads runs every time.
const GAVE_UP = 120_000
const KEEP = 30 * 60_000

type Result = { content: { type: 'text'; text: string }[]; isError?: true }
type Run = { answer: Promise<Result>; at: number; done?: true }

// How far a session initialized here is from listening. Claude Code drops channel messages that come
// before it listens and says nothing when it starts, but it registers its channel handler in the same
// step as its tools/list_changed handler, so once its stream is open and it has listed the tools, it's
// told they changed, and the list that answers is the sign it listens. A session starting cold
// registers them a while after it lists the tools and drops what came before, so it's told again
// until it answers.
type Handshake = { is: 'initialized' } | { is: 'listed' } | { is: 'streaming'; nudge: () => void; open: () => void } | { is: 'nudged'; open: () => void }

// A channel over MCP's Streamable HTTP transport, for sessions whose plugin's .mcp.json points here
// with their binding and the hub's token in headers. Every session id is taken as it comes, so a
// session that connected before the hub restarted carries on where it was without initializing again.
export function endpoint(name: string, channel: string, token: string, server: ChannelServer, hooks: Hooks, zone = () => Temporal.Now.timeZoneId()) {
  const starting = new Map<string, Handshake>()

  function threadOf(request: Request) {
    const thread = request.headers.get('x-hex-thread')
    return request.headers.get('x-hex-channel') === channel && thread ? thread : undefined
  }

  function result(id: unknown, value: object) {
    return Response.json({ jsonrpc: '2.0', id, result: value })
  }

  const unheard = new Map<string, Map<string, Run>>()
  const reads = new Set(server.tools.filter(tool => tool.annotations?.readOnlyHint).map(tool => tool.name))

  function once(thread: string | undefined, tool: string, args: Record<string, unknown>, gone: AbortSignal, arrived: number): Promise<Result> {
    if (reads.has(tool)) return call(thread, tool, args)
    for (const [scope, runs] of unheard) {
      for (const [key, run] of runs) if (run.done && clock.now() - run.at > KEEP) runs.delete(key)
      if (!runs.size) unheard.delete(scope)
    }
    const scope = String(thread)
    const runs = unheard.get(scope) ?? new Map<string, Run>()
    unheard.set(scope, runs)
    const key = JSON.stringify([tool, Object.entries(args).sort(([a], [b]) => (a < b ? -1 : 1))])
    const repeat = runs.get(key)
    const run: Run = repeat ?? { answer: call(thread, tool, args), at: arrived }
    if (!repeat) {
      runs.set(key, run)
      void run.answer.then(() => Object.assign(run, { done: true, at: clock.now() }))
    }
    return run.answer.then(answer => {
      if (!gone.aborted && clock.now() - arrived < GAVE_UP && runs.get(key) === run) runs.delete(key)
      if (!repeat) return answer
      return { ...answer, content: [{ type: 'text', text: `this same ${tool} call came before and its answer never reached you, so it ran once: ${answer.content[0]!.text}` }] }
    })
  }

  async function call(thread: string | undefined, tool: string, args: Record<string, unknown>): Promise<Result> {
    try {
      if (!thread) throw new Error(`this session is not bound to a ${server.title} thread (HEX_THREAD is unset)`)
      return { content: [{ type: 'text', text: await hooks.call(thread, tool, args) }] }
    } catch (error) {
      return { content: [{ type: 'text', text: `${tool} failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true }
    }
  }

  function listed(session: string | null) {
    const step = session ? starting.get(session) : undefined
    if (step?.is === 'initialized') starting.set(session!, { is: 'listed' })
    if (step?.is === 'streaming') {
      starting.set(session!, { is: 'nudged', open: step.open })
      step.nudge()
    }
    if (step?.is === 'nudged') {
      starting.delete(session!)
      step.open()
    }
  }

  // Bun starts a response's body only once it sends it, so writes wait for that.
  function stream(thread: string | undefined, session: string | null) {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let line: Line | undefined
    let keepAlive: ReturnType<typeof setInterval> | undefined
    const waiting = [': open\n\n']
    const write = (text: string) => {
      if (!controller) return void waiting.push(text)
      try {
        controller.enqueue(encoder.encode(text))
      } catch {
        gone()
      }
    }
    const event = (message: object) => write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', ...message })}\n\n`)
    function gone() {
      clearInterval(keepAlive)
      if (session) starting.delete(session)
      if (thread && line) hooks.close(thread, line)
      line = undefined
    }
    const body = new ReadableStream<Uint8Array>({
      start(started) {
        controller = started
        for (const text of waiting.splice(0)) write(text)
      },
      cancel: gone,
    })
    if (thread) {
      line = { send: payload => event(notification(payload, zone())) }
      keepAlive = setInterval(write, 15_000, ': keepalive\n\n')
      const open = () => line && hooks.open(thread, line)
      const nudge = () => {
        event({ method: 'notifications/tools/list_changed' })
        clock.setTimeout(() => line && starting.get(session!)?.is === 'nudged' && nudge(), NUDGE)
      }
      const step = session ? starting.get(session) : undefined
      if (!step) open()
      else if (step.is === 'listed') {
        starting.set(session!, { is: 'nudged', open })
        nudge()
      } else starting.set(session!, { is: 'streaming', nudge, open })
    }
    return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...(session && { 'mcp-session-id': session }) } })
  }

  const handle = async (request: Request): Promise<Response> => {
    const arrived = clock.now()
    // The token comes as Authorization: Claude Code then takes a refusal as a failed connection,
    // where with any other header it marks the server as needing a login for 15 minutes.
    if (request.headers.has('origin') || !['127.0.0.1', 'localhost'].includes(new URL(request.url).hostname) || request.headers.get('authorization') !== `Bearer ${token}`) return new Response('Forbidden', { status: 403 })
    const thread = threadOf(request)
    const session = request.headers.get('mcp-session-id')
    if (request.method === 'GET') return stream(thread, session)
    if (request.method === 'DELETE') return new Response(null, { status: 204 })
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
    let message: any
    try {
      message = await request.json()
    } catch {
      return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 })
    }
    const { id, method, params } = message ?? {}
    if (id === undefined || !method) {
      if (method === 'notifications/claude/channel/permission_request' && thread) hooks.permission(thread, params)
      return new Response(null, { status: 202 })
    }
    if (method === 'initialize') {
      const opened = crypto.randomUUID()
      starting.set(opened, { is: 'initialized' })
      const capabilities = { tools: { listChanged: true }, experimental: { 'claude/channel': {}, ...(server.permission && { 'claude/channel/permission': {} }) } }
      const revision = REVISIONS.includes(params?.protocolVersion) ? params.protocolVersion : REVISIONS[0]
      const response = result(id, { protocolVersion: revision, capabilities, serverInfo: { name, version: '1.0.0' }, instructions: server.instructions })
      response.headers.set('mcp-session-id', opened)
      return response
    }
    if (method === 'tools/list') {
      listed(session)
      return result(id, { tools: server.tools })
    }
    if (method === 'tools/call') return result(id, await once(thread, params?.name, params?.arguments ?? {}, request.signal, arrived))
    if (method === 'ping') return result(id, {})
    return Response.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
  }

  // The thread's turn ended with nothing left working: its session moved on from every call that
  // answered. One still running stays, since anything that joins it never heard back from it.
  function rested(thread: string) {
    const runs = unheard.get(thread)
    for (const [key, run] of runs ?? []) if (run.done) runs!.delete(key)
  }

  return Object.assign(handle, { rested })
}

function notification(payload: Payload, zone: string) {
  if (payload.type === 'inbound') return { method: 'notifications/claude/channel', params: { content: payload.content, meta: local(payload.meta, zone) } }
  return { method: 'notifications/claude/channel/permission', params: { request_id: payload.request_id, behavior: payload.behavior } }
}

// The apps stamp a message in UTC, and a session that reads 06:31Z writes it down as 6:31am, so the
// tag carries the owner's clock time with its offset instead.
export function local(meta: Record<string, string>, zone: string): Record<string, string> {
  const at = meta.ts ? Date.parse(meta.ts) : NaN
  if (Number.isNaN(at)) return meta
  try {
    return { ...meta, ts: Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(zone).toString({ timeZoneName: 'never', smallestUnit: 'second' }) }
  } catch {
    return meta
  }
}
