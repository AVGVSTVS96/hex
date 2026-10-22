#!/usr/bin/env bun
import { createServer, type Socket } from 'net'
import { Readable, Writable } from 'stream'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import { agent, ndJsonStream, PROTOCOL_VERSION, RequestError, type AgentContext, type ContentBlock, type McpServer, type PromptRequest, type PromptResponse, type SessionConfigOption, type SessionNotification, type StopReason } from '@agentclientprotocol/sdk'
import { startHub, clients, begin, move, title, family, MODELS, EFFORTS, type Settings, type Turn as Said } from '../../hub/hub.ts'
import { asked } from '../../hub/store.ts'
import { server } from './channel.ts'
import { follow, transcriptPath } from './transcript.ts'
import { withT3, projectAt, linkTo, promptedBy, steering, appThreads } from './t3code.ts'
import { version } from './package.json'

const STATE_DIR = process.env.T3_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'hex', 't3')
const INBOX_DIR = join(STATE_DIR, 'inbox')
const SOCKET = join(STATE_DIR, 'acp.sock')
const PLACED_FILE = join(STATE_DIR, 'placed.json')
// The provider instance T3 Code runs hex as, under providerInstances in its settings.
const INSTANCE = process.env.T3_INSTANCE ?? 'hex'
const HEX_DIR = process.env.HEX_DIR ?? process.cwd()
const HOME = homedir()
const SCRATCH = join(HOME, '.t3', 'scratch')
const COMMANDS = [{ name: 'compact', description: 'Summarize the conversation so far to free up context' }]
type Turn = {
  client: AgentContext
  reader?: ReturnType<typeof follow>
  sent: Promise<unknown>
  done: boolean
  since: number
  compaction?: string
  resolve: (response: PromptResponse) => void
  reject: (error: Error) => void
}

// One ACP prompt per thread at a time: it is answered when the session's turn ends.
const turns = new Map<string, Turn>()

// A thread T3 opened that has had no prompt yet, and what its pickers chose. T3's provider check
// opens a session it never uses, so a thread is only kept once its first prompt arrives; until
// then it lasts as long as the connection that opened it.
type Opened = { cwd: string; settings: Settings; socket: Socket }
const opened = new Map<string, Opened>()

// A chat backfilled into a T3 thread, waiting for T3 to send each of the owner's messages back as a
// prompt, which its replies answer as they were.
type Replay = { asked: string; replies: string[] }
const replays = new Map<string, Replay[]>()

// The threads hex opened in T3 for a conversation from another app, which T3 imports as its sessions.
const placed = new Set<string>(existsSync(PLACED_FILE) ? JSON.parse(readFileSync(PLACED_FILE, 'utf8')) : [])
// T3's own id for each thread it imported since hex started.
const imports = new Map<string, string>()

// T3 Code hands each thread its own MCP servers, with tools like html_render, preview
// and delegate_task. A session loads them as it starts, so it starts again when they change.
const servers = new Map<string, string>()

mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 })

// T3 Code's records, read once per save, since a save asks for every thread's link at once: null
// until read, undefined with none to go by. They give a thread its link and its name, T3's title for
// it. A thread T3 deleted closes here too, as does one T3 never recorded, once T3 has had a few
// minutes to record what hex kept (since it kept it, or since this hub started for one an older hub
// kept). Records that have none of hex's threads aren't T3's records of them, so nothing closes.
const RECORDING = Number(process.env.T3_RECORDING_MS) || 5 * 60_000
const started = Date.now()
const kept = new Map<string, number>()
let recorded: ReturnType<typeof appThreads> | null = null
function link(thread: string) {
  if (recorded === null) {
    queueMicrotask(() => {
      mirror(recorded)
      recorded = null
    })
    try {
      recorded = appThreads()
    } catch (error) {
      recorded = undefined
      throw error
    }
  }
  const opened = recorded?.get(thread)
  return opened && linkTo(opened.thread)
}

function mirror(records: ReturnType<typeof appThreads>) {
  const threads = hub.threads()
  if (!records || !threads.some(thread => records.has(thread))) return
  for (const thread of threads) {
    const record = records.get(thread)
    if (record) {
      kept.delete(thread)
      hub.rename(thread, record.title || hub.name(thread)!)
    } else if (!turns.has(thread) && Date.now() - (kept.get(thread) ?? started) > RECORDING) void hub.retire(thread)
  }
}

const hub = startHub({
  stateDir: STATE_DIR,
  channel: process.env.T3_CHANNEL ?? 'plugin:t3@hex',
  server,
  link,
  // T3 Code owns its threads, so a handoff leaves this one here and a copy carries on there.
  call: async (thread, tool, args) => {
    const where = args.channel as string | undefined
    if (tool === 'new_thread') {
      const name = title(args.title as string)
      const { link } = await begin(args.app as string, name, args.prompt as string, { about: args.about as string | undefined, where, cwd: hub.cwd(thread) })
      return `started thread "${name}" in ${args.app}: ${link}`
    }
    if (tool === 'handoff') return `a copy of this conversation continues in ${args.to}: ${await move(hub, thread, args.to as string, title(args.title as string), where, true)}. You stay here.`
    throw new Error(`unknown tool: ${tool}`)
  },
  // A new thread's session starts with its first prompt and is only known once its channel connects.
  // Its turn is done once a stop leaves no background agent working.
  state: (thread, busy, background) => {
    const turn = turns.get(thread)
    if (!turn) return
    turn.done = !busy && !background
    const session = hub.session(thread)
    if (busy && session && !turn.reader) turn.reader = reader(thread, session, turn, turn.since)
    turn.reader?.settle()
  },
  failed: (thread, reason) => {
    const turn = turns.get(thread)
    turns.delete(thread)
    turn?.reader?.close()
    turn?.reject(RequestError.internalError(undefined, `hex couldn't start this thread's session: ${reason}`))
  },
  args: thread => {
    const config = servers.get(thread)
    return config ? ['--mcp-config', config] : []
  },
  hexDir: HEX_DIR,
  launcher: process.env.HEX_LAUNCHER,
})

function remember(thread: string, list: McpServer[] = []) {
  const entries = list.flatMap(server => {
    if (!('type' in server)) return [[server.name, { command: server.command, args: server.args, env: pairs(server.env) }] as const]
    if (server.type === 'acp') return []
    return [[server.name, { type: server.type, url: server.url, headers: pairs(server.headers) }] as const]
  })
  if (entries.length) servers.set(thread, JSON.stringify({ mcpServers: Object.fromEntries(entries) }))
  else servers.delete(thread)
}

function pairs(list: { name: string; value: string }[]) {
  return Object.fromEntries(list.map(({ name, value }) => [name, value]))
}

function reader(thread: string, session: string, turn: Turn, since?: number) {
  const cwd = hub.cwd(thread) ?? HEX_DIR
  return follow({
    path: transcriptPath(cwd, session),
    sessionId: thread,
    cwd,
    since,
    done: () => turn.done,
    end: error => finish(thread, 'end_turn', error),
    emit: notification => send(turn, notification),
  })
}

function send(turn: Turn, notification: SessionNotification) {
  const { update } = notification
  turn.sent = turn.sent.then(() => turn.client.notify('session/update', notification)).catch(() => {})
}

function compaction(turn: Turn, thread: string, status: string, error?: string) {
  send(turn, { sessionId: thread, update: { sessionUpdate: 'compaction_update', compactionId: turn.compaction!, status, ...(error && { error }) } })
}

// The session's Stop hook keeps a turn's words and queues its pass. A turn cut short runs none and,
// like an interrupted turn in any app, keeps no words, so its pass is queued here.
function cut(thread: string) {
  hub.turned(thread)
  finish(thread, 'cancelled')
}

function finish(thread: string, stopReason: StopReason, error?: string) {
  const turn = turns.get(thread)
  if (!turn) return
  turns.delete(thread)
  turn.reader?.close()
  if (turn.compaction) compaction(turn, thread, error ? 'failed' : stopReason === 'cancelled' ? 'cancelled' : 'completed', error)
  void turn.sent.then(() => (error ? turn.reject(RequestError.internalError(undefined, error)) : turn.resolve({ stopReason })))
}

function known(thread: string) {
  if (!hub.name(thread) && !opened.has(thread)) throw RequestError.resourceNotFound(thread)
  return thread
}

// T3 resumes a thread it opened and never prompted as a new one, since hex never kept it.
function reopen(thread: string, cwd: string, socket: Socket) {
  const waiting = opened.get(thread)
  if (waiting) waiting.socket = socket
  else if (!hub.name(thread)) opened.set(thread, { cwd, settings: {}, socket })
  return thread
}

function keep(thread: string) {
  const waiting = opened.get(thread)
  if (!waiting) return
  opened.delete(thread)
  kept.set(thread, Date.now())
  const folder = folderFor(waiting.cwd)
  hub.register(thread, basename(folder ?? HEX_DIR), folder)
  hub.configure(thread, waiting.settings)
}

// T3's MCP credentials live only in its running server, so when T3 quits or restarts
// mid-turn (the prompt's request aborts) the session's T3 tools are dead: the session stops.
function prompt({ sessionId: thread, prompt: blocks, _meta }: PromptRequest, client: AgentContext, signal: AbortSignal): Promise<PromptResponse> {
  keep(known(thread))
  const name = hub.name(thread)!
  const replay = replays.get(thread)?.shift()
  if (replay && asked(render(blocks)) === replay.asked) return replayed(thread, replay, client)
  replays.delete(thread)
  if (turns.has(thread)) throw RequestError.invalidRequest(undefined, 'this thread is already working on a prompt')
  const session = hub.session(thread)
  const compact = compacting(blocks)
  if (compact && !session) throw RequestError.invalidRequest(undefined, 'this thread has nothing to compact yet')
  return new Promise((resolve, reject) => {
    const turn = track(thread, client, signal, resolve, reject, Date.now(), compact)
    if (session) turn.reader = reader(thread, session, turn)
    if (!compact) return hub.deliver(thread, name, message(thread, blocks, turn.since, _meta))
    compaction(turn, thread, 'in_progress')
    hub.command(thread, '/compact')
  })
}

// T3 Code follows a command with its own context block, which the command doesn't take.
function compacting(blocks: ContentBlock[]) {
  return blocks[0]?.type === 'text' && blocks[0].text.trim() === '/compact'
}

function track(thread: string, client: AgentContext, signal: AbortSignal, resolve: Turn['resolve'], reject: Turn['reject'], since: number, compact = false) {
  const turn: Turn = { client, sent: Promise.resolve(), done: false, since, resolve, reject, ...(compact && { compaction: randomUUID() }) }
  turns.set(thread, turn)
  signal.addEventListener('abort', () => {
    if (turns.get(thread) !== turn) return
    cut(thread)
    void hub.stop(thread)
  }, { once: true })
  return turn
}

// The key `hex acp` gives a prompt (acp.ts) keeps it one message in hex.db however often it's sent,
// and T3's records say who wrote it.
function message(thread: string, blocks: ContentBlock[], since: number, meta: PromptRequest['_meta']) {
  const content = render(blocks)
  return { content, meta: { ts: new Date(since).toISOString() }, key: meta?.['hex/key'] as string | undefined, author: promptedBy(thread, asked(blocks.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n'))) }
}

// After a hub restart, `hex acp` asks again for the turn T3 was waiting on (acp.ts): it streams
// from when T3 sent the prompt, and ends like any turn. The prompt is delivered again under its
// key, which reaches the session only if the old hub never kept it; a /compact that isn't running
// anymore ended while hex was down. The new hub may not know a session that started just
// before the restart until its channel reconnects, so the session the turn follows is the one
// running for the thread.
type Rejoin = PromptRequest & { since: number }
async function rejoin({ sessionId: thread, prompt: blocks, since, _meta }: Rejoin, client: AgentContext, signal: AbortSignal): Promise<PromptResponse> {
  keep(known(thread))
  const running = await hub.running(thread)
  if (turns.has(thread)) throw RequestError.invalidRequest(undefined, 'this thread is already working on a prompt')
  const session = running?.sessionId ?? hub.session(thread)
  const working = running?.status === 'busy'
  return new Promise((resolve, reject) => {
    const turn = track(thread, client, signal, resolve, reject, since)
    if (session) turn.reader = reader(thread, session, turn, since)
    const asked = !!turn.reader?.asked()
    if (!compacting(blocks)) hub.deliver(thread, hub.name(thread)!, message(thread, blocks, since, _meta))
    else if (!working && !asked) return finish(thread, 'end_turn')
    turn.done = asked && !working
    turn.reader?.settle()
  })
}

async function replayed(thread: string, { replies }: Replay, client: AgentContext): Promise<PromptResponse> {
  if (!replays.get(thread)?.length) replays.delete(thread)
  for (const text of replies) await client.notify('session/update', { sessionId: thread, update: { sessionUpdate: 'agent_message_chunk', messageId: randomUUID(), content: { type: 'text', text } } })
  return { stopReason: 'end_turn' }
}

// T3 shows these as its model and effort pickers. A thread with no choice of its own
// runs on what hex's settings say, so that's what they show.
function options(thread: string): SessionConfigOption[] {
  const chosen = opened.get(thread)?.settings ?? hub.settings(thread)
  const defaults = settings()
  const model = chosen.model ?? (defaults.model && family(defaults.model)) ?? MODELS[0]!.value
  const effort = chosen.effort ?? EFFORTS.find(effort => effort.value === defaults.effortLevel)?.value ?? 'medium'
  return [
    { type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: model, options: MODELS.map(({ value, name }) => ({ value, name })) },
    { type: 'select', id: 'effort', name: 'Effort', category: 'thought_level', currentValue: effort, options: EFFORTS },
  ]
}

function settings(): { model?: string; effortLevel?: string } {
  try {
    return JSON.parse(readFileSync(join(HEX_DIR, '.claude', 'settings.json'), 'utf8'))
  } catch {
    return {}
  }
}

// The thread's session starts again with the new choice at its next prompt. A model T3 kept
// from before hex offered aliases comes back as a full id, which is its family's alias now.
function configure(thread: string, id: string, raw: unknown) {
  const value = id === 'model' && typeof raw === 'string' ? family(raw) : raw
  const choices = id === 'model' ? MODELS : id === 'effort' ? EFFORTS : undefined
  if (!choices) throw RequestError.invalidParams(undefined, `no option ${id}`)
  if (!choices.some(choice => choice.value === value)) throw RequestError.invalidParams(undefined, `${id} can't be ${value}`)
  const waiting = opened.get(known(thread))
  if (waiting) waiting.settings[id as keyof Settings] = value as string
  else hub.configure(thread, { [id]: value as string })
  return { configOptions: options(thread) }
}

// Sent once the session/new or session/resume answer is out, so the client knows the session.
function advertise(client: AgentContext, sessionId: string) {
  setImmediate(() => client.notify('session/update', { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: COMMANDS } }).catch(() => {}))
}

// T3 Code steers a turn by cancelling it and sending the steer as a new prompt, which reaches the
// running session the way a message typed into it would, so a steer leaves the session and all it
// started running. Any other cancel is a Stop, which interrupts the turn the way Esc does and leaves
// the session and its background work running too; T3 hears the turn is cancelled once it is.
function cancel(thread: string) {
  const turn = turns.get(thread)
  if (!turn) return
  if (steering(thread)) return finish(thread, 'cancelled')
  stop(thread)
}

function stop(thread: string) {
  const turn = turns.get(thread)
  void hub.interrupt(thread).finally(() => turns.get(thread) === turn && cut(thread))
}

// Images and binary files land in the inbox, so the session reads them by path.
function render(blocks: ContentBlock[]) {
  return blocks.map(block => {
    switch (block.type) {
      case 'text':
        return block.text
      case 'resource_link':
        return `[${block.name}](${path(block.uri)})`
      case 'resource':
        if ('text' in block.resource) return `<file path="${path(block.resource.uri)}">\n${block.resource.text}\n</file>`
        return `[file: ${save(block.resource.blob, block.resource.mimeType)}] (from ${path(block.resource.uri)})`
      case 'image':
      case 'audio':
        return `[${block.type}: ${save(block.data, block.mimeType)}]`
    }
  }).join('\n\n')
}

function path(uri: string) {
  return uri.startsWith('file://') ? fileURLToPath(uri) : uri
}

function save(base64: string, mimeType?: string | null) {
  const file = join(INBOX_DIR, `${randomUUID()}.${mimeType?.split('/')[1]?.replace(/\W.*/, '') || 'bin'}`)
  writeFileSync(file, Buffer.from(base64, 'base64'), { mode: 0o600 })
  return file
}

// A T3 chat with no project (home, a folder above it, or T3's scratch folders) works in hex's own folder.
function folderFor(cwd: string): string | undefined {
  const real = (path: string) => {
    try {
      return realpathSync(path)
    } catch {
      return path.replace(/\/+$/, '')
    }
  }
  const folder = `${real(cwd)}/`.replace(/^\/\/$/, '/')
  if (`${real(HOME)}/`.startsWith(folder) || folder === `${real(HEX_DIR)}/` || folder.startsWith(`${real(SCRATCH)}/`)) return
  return cwd
}

// Opens a thread T3 Code imports as one of hex's sessions, in the T3 project of its folder.
async function place(name: string, _where?: string, _about?: string, cwd?: string) {
  const root = cwd ?? HEX_DIR
  const projectId = projectAt(root)
  if (!projectId) throw new Error(`T3 Code has no project for ${root}`)
  const thread = randomUUID()
  const { threadId } = await withT3(call => call('server.importAcpRegistrySession', { instanceId: INSTANCE, projectId, sessionId: thread, title: name }))
  kept.set(thread, Date.now())
  hub.register(thread, name, cwd)
  placed.add(thread)
  writeFileSync(PLACED_FILE, JSON.stringify([...placed].filter(known => hub.name(known))))
  imports.set(thread, threadId)
  return { thread, link: linkTo(threadId) }
}

// T3 shows only what an agent says on a turn, so the chat goes in as turns: each of the owner's
// messages is sent to the thread, and its replies answer the prompt it comes back as. A chat that
// opens with hex's own messages gets a first message saying so.
async function backfill(thread: string, said: Said[]) {
  const chat = said.reduce<Replay[]>((chat, { from, text }) => {
    if (from === 'me') chat.push({ asked: text, replies: [] })
    else (chat.at(-1) ?? chat[chat.push({ asked: '(hex started this thread)', replies: [] }) - 1]!).replies.push(text)
    return chat
  }, [])
  const threadId = imports.get(thread)
  if (!chat.length || !threadId) return
  const queue = [...chat]
  replays.set(thread, queue)
  await withT3(async call => {
    for (const [i, { asked: text }] of chat.entries()) {
      await call('orchestration.dispatchCommand', {
        type: 'message.dispatch',
        commandId: randomUUID(),
        threadId,
        messageId: `message:hex:${randomUUID()}`,
        text,
        attachments: [],
        createdBy: 'user',
        creationSource: 'server',
        dispatchMode: { type: 'queue_after_active' },
      }).catch(error => {
        queue.splice(queue.length - (chat.length - i))
        throw error
      })
    }
  })
}

function serve(socket: Socket) {
  agent({ name: 'hex' })
    .onRequest('initialize', () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'hex', title: 'hex', version },
      agentCapabilities: {
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
        loadSession: true,
        sessionCapabilities: { resume: {}, list: {} },
      },
      authMethods: [],
    }))
    .onRequest('session/new', ({ params, client }) => {
      const thread = reopen(randomUUID(), params.cwd, socket)
      remember(thread, params.mcpServers)
      advertise(client, thread)
      return { sessionId: thread, configOptions: options(thread) }
    })
    .onRequest('session/resume', ({ params, client }) => {
      remember(reopen(params.sessionId, params.cwd, socket), params.mcpServers)
      advertise(client, params.sessionId)
      return { configOptions: options(params.sessionId) }
    })
    .onRequest('session/list', ({ params }) => ({
      sessions: [...placed].filter(thread => hub.name(thread) && (!params.cwd || (hub.cwd(thread) ?? HEX_DIR) === params.cwd)).map(thread => ({ sessionId: thread, cwd: hub.cwd(thread) ?? HEX_DIR, title: hub.name(thread) })),
    }))
    .onRequest('session/load', async ({ params, client }) => {
      remember(reopen(params.sessionId, params.cwd, socket), params.mcpServers)
      for (const [i, { from, text }] of hub.history(params.sessionId).entries()) {
        await client.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: from === 'me' ? 'user_message_chunk' : 'agent_message_chunk', messageId: `${hub.session(params.sessionId)}:${i}`, content: { type: 'text', text } } })
      }
      advertise(client, params.sessionId)
      return { configOptions: options(params.sessionId) }
    })
    .onRequest('session/set_config_option', ({ params }) => configure(params.sessionId, params.configId, params.value))
    .onRequest('session/prompt', ({ params, client, signal }) => prompt(params, client, signal))
    .onRequest('_hex/rejoin', { parse: params => params as Rejoin }, ({ params, client, signal }) => rejoin(params, client, signal))
    .onNotification('session/cancel', ({ params }) => cancel(params.sessionId))
    .connect(ndJsonStream(Writable.toWeb(socket) as WritableStream<Uint8Array>, Readable.toWeb(socket) as ReadableStream<Uint8Array>))
  socket.on('error', () => {})
  socket.on('close', () => {
    for (const [thread, waiting] of opened) {
      if (waiting.socket !== socket) continue
      opened.delete(thread)
      servers.delete(thread)
    }
  })
}

// The owner's Stop from another app is never a steer, so it interrupts the turn even while T3 Code
// is steering, and finishes T3's prompt when one is running.
clients.set('t3', {
  hub,
  place,
  backfill,
  waits: true,
  stop,
})

rmSync(SOCKET, { force: true })
createServer(serve).listen(SOCKET)
