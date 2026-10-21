import { createServer } from 'net'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type FSWatcher } from 'fs'
import { basename, join } from 'path'
import * as claude from './claude.ts'
import { clock } from './clock.ts'
import { endpoint, type ChannelServer, type Line } from './mcp.ts'
import { schedule, zoneOf } from './schedule.ts'
import { asked, open, storeDir as storeOf, type MessageId, type Row, type Store } from './store.ts'

export type { ChannelServer, Tool } from './mcp.ts'

// key: the app's own id for what the message is, so the app sending it again changes nothing.
export type Message = { content: string; meta: Record<string, string>; key?: string }
export type Call = (thread: string, tool: string, args: Record<string, unknown>) => Promise<string>
// background: the session's turn ended with background agents still working.
export type State = (thread: string, busy: boolean, background: boolean) => void
export type Failed = (thread: string, reason: string) => void
export type Permission = { request_id: string; tool_name: string; description: string; input_preview: string }
export type Settings = { model?: string; effort?: string }

// The choices a client offers for a thread's settings. Models are Claude Code's aliases, so a
// thread runs the newest model of the family it picked.
export const MODELS = [
  { value: 'opus', name: 'Opus' },
  { value: 'sonnet', name: 'Sonnet' },
  { value: 'haiku', name: 'Haiku' },
  { value: 'fable', name: 'Fable' },
]
export const EFFORTS = [
  { value: 'low', name: 'Low' },
  { value: 'medium', name: 'Medium' },
  { value: 'high', name: 'High' },
  { value: 'xhigh', name: 'Extra High' },
  { value: 'max', name: 'Max' },
]

// A full model id as its family's alias: claude-opus-5-5 is opus. Anything else stays as it is.
export function family(model: string) {
  return MODELS.find(({ value }) => model.startsWith(`claude-${value}-`))?.value ?? model
}

// A permission prompt's input as one "key: value" line per field, leaving out what its description already says.
export function preview({ input_preview, description }: Permission): string {
  try {
    return Object.entries(JSON.parse(input_preview))
      .filter(([, value]) => value !== description)
      .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join('\n')
  } catch {
    return input_preview
  }
}
// What another process (the voice app, hex's check) can do with a question the client asked
// with buttons: answer it for the owner, settle it as no longer asked, or take an answer back.
export type Questions = {
  answer: (thread: string, message: MessageId, label: string, via: string) => void
  settle: (thread: string, message: MessageId, note: string) => void
  reopen: (thread: string, message: MessageId, via: string) => void
}
export type Hub = ReturnType<typeof startHub>

// idleStop: how long a quiet session stays warm before it stops. cacheWarm: how long the main
// thread rests before it compacts, while its cache is still warm. Both sit just inside Claude
// Code's one-hour prompt cache, so coming back within the hour costs no new cache write. compactAbove: the context above
// which a session compacts before it rests. reconnect: how long a running session's channel may be
// gone before the session restarts to get it back. capacity: how much context a fresh thread's
// session holds before a new one takes over; with 0, every message that finds it done goes to a new one.
export type Limits = { idleStop: number; cacheWarm: number; compactAbove: number; reconnect: number; capacity: number }

// from: the session the thread continues as a fork with its first message, until it has its own.
type Saved = Settings & { name: string; session?: string; from?: string; cwd?: string; launched?: string }
type Timer = ReturnType<typeof setTimeout>

// Where a thread's session stands. launching: the hub started or restarted it and waits for its
// channel, so one that ends first failed to start. recovering: it runs without its channel, which
// Claude Code may still bring back. Either wait ends at its deadline.
type Phase =
  | { is: 'stopped' }
  // again: the hub started the thread again on its own (retry, revive), not for a message or prompt.
  | { is: 'launching'; job?: string; watch?: FSWatcher; deadline?: Timer; respawned?: boolean; again?: boolean }
  | { is: 'recovering'; deadline?: Timer; again?: boolean }
  | { is: 'live'; line: Line }

// Everything the hub keeps on a thread while it runs; threads.json keeps what outlives the hub.
type Run = {
  phase: Phase
  queue: Message[]
  // The kept messages the hub has passed on since its session's channel last connected.
  handed: Set<string>
  // From the session's hooks; background: its turn ended with agents still working.
  turn: 'busy' | 'background' | 'done'
  // asked: the session asked to start over (a call ended). stale: it started with what the hub no
  // longer gives a session. underway: it's starting over, and its renewal waits for the new session.
  renew?: 'asked' | 'stale' | 'underway'
  rest?: Timer
  leaving?: (session: string) => void
  // The thread's session was told to stop and hasn't exited yet.
  ending?: Promise<void>
  // The owner's Stop pressing Esc in the session, until the transcript shows it landed.
  interrupting?: Promise<void>
  // A new session whose conversation Claude hasn't saved yet.
  unsaved?: string
  held: (() => void)[]
  // The starts that failed in a row since the thread's session last connected; retried: another
  // session's start set one off since a message's last failed, told: General heard.
  failing?: { count: number; retried?: boolean; told?: boolean }
  opening?: Opening
}

// What a new session starts with: its first prompt, and the session it continues as a fork. quiet:
// the prompt is the hub's own (a compaction), so the thread doesn't show as working.
type Opening = { prompt?: string; fork?: string; quiet?: boolean }

// A call on a line a client holds, like a Discord voice channel: the line plays the voice's audio
// and ends when the call does, and the call engine hears the caller and can be hung up on. Audio is
// base64 PCM at 24 kHz, mono.
export type VoiceLine = { play: (audio: string) => void; end: () => void }
export type Held = { hear: (audio: string) => void; hangUp: () => void }

// The voice app's call engine, once it runs in this process, for a client that holds a line.
export const engine: { take?: (from: 'discord', greeting: string, line: VoiceLine) => Held } = {}

// One message of a thread's chat as its log keeps it: the owner's, or hex's reply.
export type Turn = { from: 'me' | 'hex'; text: string }

// Every client running in this process, so a thread can move between them.
// place() opens a thread on the client, led by its about line if given, for a session working in cwd,
// and returns its id and a link to it.
// backfill() posts a thread's chat so far into a thread it placed, in order.
export type Client = {
  hub: Hub
  place: (name: string, where?: string, about?: string, cwd?: string) => Promise<{ thread: string; link: string }>
  backfill?: (thread: string, turns: Turn[]) => Promise<void>
  // The client shows only the turns its own messages start, so a session moved there waits for one.
  waits?: boolean
  // What the client does as the hub stops, once no call is live.
  close?: () => Promise<void>
  // The owner's stop as the client's own Stop does it, when it keeps state of its own about a turn.
  stop?: (thread: string) => void
}
export const clients = new Map<string, Client>()

// Each hub's restart of its threads whose session failed to start, run whenever a session this
// process started connects: a start just went through, so theirs can too.
const retries = new Set<() => void>()

// The hub serving General, which hears of a thread once this many of its starts fail in a row.
let generalHub: Hub | undefined
const TELL_AFTER = 3

// Resolves with the hub serving General once General's session first connects to it: from then
// on, hex works on the code this process runs.
let reached: (hub: Hub) => void
export const up = new Promise<Hub>(resolve => (reached = resolve))

export const PORT = Number(process.env.HEX_PORT ?? 8789)
// The apps whose hubs run in this process: a message one of them kept is its own to deliver.
const apps = new Set<string>()

// Each hub's channel under its plugin's name, behind the one HTTP listener serve.ts opens.
const channels = new Map<string, (request: Request) => Promise<Response>>()

export function route(request: Request): Promise<Response> {
  return channels.get(new URL(request.url).pathname)?.(request) ?? Promise.resolve(new Response('Not Found', { status: 404 }))
}

// serve.ts's listener. A hub a stop left running holds the port until it has finished its call and
// exited, so the next one waits for the port instead of failing to start, which bin/hex would count
// against the commit. It tries each second, since nothing says the port is free: a connection to
// the old hub that hasn't sent anything is never accepted, so it can stay open after the hub exits.
export async function listen(port = PORT): Promise<ReturnType<typeof Bun.serve>> {
  for (let held = false; ; held = true) {
    try {
      const server = Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 0, fetch: route })
      if (held) process.stderr.write(`hub: port ${port} is free; starting\n`)
      return server
    } catch (error) {
      if ((error as { code?: string }).code !== 'EADDRINUSE') throw error
    }
    if (!held) process.stderr.write(`hub: port ${port} is in use; this hub starts once it's free\n`)
    await Bun.sleep(1000)
  }
}

// Chat apps only link web addresses, so a buzz:// link goes through a page on hex's site that opens it.
export function tappable(text: string): string {
  return text.replace(/buzz:\/\/[^\s)>\]\\]*[^\s)>\]\\.,;:!?'"]/g, url => `https://hex-sand.vercel.app/open.html#${encodeURIComponent(url)}`)
}

const SAID = /^## (.+?) · (\w+) · (?:\d{4}-\d{2}-\d{2} )?\d{1,2}:\d{2}\n/gm
// Who the owner is in a log: themself, or the hex app they answered, typed or spoke in.
const OWNER = new Set(['me', 'hex app', 'hex call'])

// Where bin/log keeps each session's log, and each log's chat as last read: a chat open in the app
// asks for them on every change anywhere.
const logs = new Map<string, string>()
const read = new Map<string, { stamp: string; turns: Turn[] }>()

// A session's log (bin/log): where it is, when it was last written, and its chat.
export function logged(hexDir: string, session: string): { mtime: Date; turns: Turn[] } | undefined {
  const id = join(hexDir, session)
  const known = logs.get(id)
  const file = known && existsSync(known) ? known : logOf(hexDir, session)
  if (!file) return
  logs.set(id, file)
  const { mtime, mtimeMs, size } = statSync(file)
  const stamp = `${mtimeMs}:${size}`
  const last = read.get(file)
  const turns = last?.stamp === stamp ? last.turns : chatOf(readFileSync(file, 'utf8'))
  read.set(file, { stamp, turns })
  return { mtime, turns }
}

function logOf(hexDir: string, session: string): string | undefined {
  const suffix = `-${session.slice(0, 8)}.md`
  return [join(hexDir, 'log', 'threads'), join(hexDir, 'log')]
    .flatMap(dir => (existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(suffix)).map(name => join(dir, name)) : []))[0]
}

// A session's chat from its log (bin/log): what the owner said and hex replied in an app, leaving
// out the terminal, which no chat showed, and what other threads and tools sent it.
export function history(hexDir: string, session: string): Turn[] {
  return logged(hexDir, session)?.turns ?? []
}

function chatOf(log: string): Turn[] {
  const heads = [...log.matchAll(SAID)]
  return heads.flatMap((head, i) => {
    const [, who, app] = head
    const text = log.slice(head.index + head[0].length, heads[i + 1]?.index).trim()
    const said = app === 't3' ? asked(text) : text
    const from = OWNER.has(who!) ? 'me' : who === 'assistant' ? 'hex' : undefined
    return app === 'terminal' || !said || !from ? [] : [{ from, text: said } as Turn]
  })
}

// TRANSCRIBE_URL is any OpenAI-compatible /audio/transcriptions endpoint.
export async function transcribe(recording: () => Promise<string>): Promise<string | undefined> {
  const { TRANSCRIBE_URL: url, TRANSCRIBE_MODEL: model, TRANSCRIBE_API_KEY: key } = process.env
  if (!url || !model) return
  const path = await recording()
  const form = new FormData()
  form.append('file', Bun.file(path), basename(path))
  form.append('model', model)
  const res = await fetch(url, { method: 'POST', body: form, headers: key ? { authorization: `Bearer ${key}` } : {} })
  if (!res.ok) throw new Error(`transcription failed: HTTP ${res.status}`)
  return ((await res.json()) as { text?: string }).text?.trim() || undefined
}

// Claude Code shows nothing when Esc meets a turn with nothing left to interrupt, so a press gets
// this long to show in the transcript; a real one shows in under a second.
const PRESS = 5_000
// Claude Code keeps a conversation in the prompt cache for an hour after its last request, and
// compacts a background session only when told to. It retries a dropped HTTP server at about 0, 1,
// 3, 7 and 15 seconds, then gives up for good.
const LIMITS: Limits = { idleStop: 54 * 60_000, cacheWarm: 54 * 60_000, compactAbove: 150_000, reconnect: 20_000, capacity: capacity(process.env.HEX_CHAT_CAPACITY) }

function capacity(tokens?: string) {
  if (!tokens) return 350_000
  if (!/^\d+$/.test(tokens)) throw new Error(`HEX_CHAT_CAPACITY must be a number of tokens, got "${tokens}"`)
  return Number(tokens)
}

// What a session reads only as it starts: its launch arguments, its channel's instructions and
// tools, and the hooks its launcher loads. threads.json keeps a digest of what each thread's
// session started with.
export function stamp(args: string[], server?: ChannelServer, hooks: string[] = []) {
  const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : null)
  return createHash('sha256').update(JSON.stringify([args, server ?? null, ...(hooks.length ? [hooks.map(read)] : [])])).digest('hex').slice(0, 16)
}

// A voice call runs in this process (its call engine holds the caller's audio), so a restart
// waits for every thread on a call to hang up.
const onCall = new Set<Run>()
const hungUp: (() => void)[] = []

export function free(): Promise<void> {
  return new Promise(resolve => (onCall.size ? hungUp.push(resolve) : resolve()))
}

function hangUp(run: Run) {
  if (onCall.delete(run) && !onCall.size) for (const resolve of hungUp.splice(0)) resolve()
}

export function title(text: string): string {
  const title = text.trim()
  if (!/^[^\s_-]+$/.test(title)) throw new Error(`title must be one word, got "${title}"`)
  return title
}

// A hub's sessions show it this in a header, since any local user can reach its port.
function tokenOf(stateDir: string) {
  const file = join(stateDir, 'token')
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 })
  return readFileSync(file, 'utf8').trim()
}

export function startHub({ stateDir, storeDir = storeOf(stateDir), channel, server, port = PORT, main, mainName = 'main', general = false, call, state, failed, permission, questions, args = () => [], fresh = () => false, limits, hexDir = process.cwd(), launcher = 'claude', hooks = process.env.HEX_HOOKS?.split(':').filter(Boolean) ?? [] }: {
  stateDir: string
  storeDir?: string
  channel: string
  // What the channel serves its sessions over HTTP.
  server: ChannelServer
  // Where serve.ts listens for every hub's sessions.
  port?: number
  main?: string
  mainName?: string
  // The main thread is hex's General: its settings env says HEX_MAIN, and the hub runs schedules.json.
  general?: boolean
  call: Call
  state: State
  failed: Failed
  permission?: (thread: string, request: Permission) => void
  questions?: Questions
  args?: (thread: string) => string[]
  // A fresh thread's session is never compacted: its launcher builds what a new session knows
  // of the chat, and a new one takes over once the old one's context or cache is spent.
  fresh?: (thread: string) => boolean
  limits?: Partial<Limits>
  hexDir?: string
  launcher?: string
  // The hooks files the launcher's plugins load (HEX_HOOKS, colon-separated): a change to one
  // renews sessions like a change to the channel does.
  hooks?: string[]
}) {
  const { idleStop, cacheWarm, compactAbove, reconnect, capacity } = { ...LIMITS, ...limits }
  const registry = join(stateDir, 'threads.json')
  const socketPath = join(stateDir, 'hub.sock')
  // Each thread's session reads its settings, binding and token from here, so none of it shows in
  // a process's arguments, and a respawn reads the thread's current ones.
  const sessionsDir = join(stateDir, 'sessions')
  const threads: Record<string, Saved> = read()
  const runs = new Map<string, Run>()
  const plugin = channel.replace(/^plugin:/, '')
  const path = `/${plugin.split('@')[0]}`
  const app = path.slice(1)
  let store: Store | undefined
  apps.add(app)
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 })
  keepNames()
  const token = tokenOf(stateDir)
  const inherited = claude.inherited()
  let closed = false
  const closing = new AbortController()
  const serving = () => !closed

  function read(): Record<string, Saved> {
    let text: string
    try {
      text = readFileSync(registry, 'utf8')
    } catch {
      return {}
    }
    try {
      const entries = Object.entries(JSON.parse(text) ?? {})
      const kept = entries.filter(([, known]: [string, any]) => typeof known?.name === 'string')
      for (const [thread] of entries.filter(entry => !kept.includes(entry))) process.stderr.write(`hub: dropped malformed thread ${thread} from ${registry}\n`)
      for (const [, known] of kept as [string, Saved][]) if (known.model) known.model = family(known.model)
      return Object.fromEntries(kept) as Record<string, Saved>
    } catch (error) {
      const aside = `${registry}.corrupt-${Date.now()}`
      renameSync(registry, aside)
      process.stderr.write(`hub: ${registry} is unreadable (${error}), moved it to ${aside} and started with no threads\n`)
      return {}
    }
  }

  // threads.json forgets a closed thread; hex.db keeps every thread's name for whatever reads one.
  function save() {
    writeFileSync(`${registry}.tmp`, JSON.stringify(threads, null, 2) + '\n')
    renameSync(`${registry}.tmp`, registry)
    keepNames()
  }

  function keepNames() {
    kept(store => store.named(app, Object.fromEntries(Object.entries(threads).map(([thread, { name }]) => [thread, name]))), undefined)
  }

  function runOf(thread: string): Run {
    let run = runs.get(thread)
    if (!run) runs.set(thread, (run = { phase: { is: 'stopped' }, queue: [], handed: new Set(), turn: 'done', held: [] }))
    return run
  }

  function become(run: Run, phase: Phase) {
    const was = run.phase
    if (was.is === 'launching') was.watch?.close()
    if (was.is === 'launching' || was.is === 'recovering') clock.clearTimeout(was.deadline)
    run.phase = phase
  }

  function underway(run: Run) {
    return run.phase.is === 'launching' || run.phase.is === 'live'
  }

  function setState(thread: string, working: boolean, background = false) {
    const run = runOf(thread)
    state(thread, working, background)
    claim(thread)
    run.turn = working ? 'busy' : background ? 'background' : 'done'
    if (run.turn === 'done' && (run.renew === 'asked' || run.renew === 'stale')) void renew(thread, run.renew === 'asked')
    rest(thread, run.turn === 'done')
    letGo(thread)
  }

  // A thread renews at its next rest: the main thread and a fresh thread start over as soon as
  // the process exits, any other when its next message resumes it. A keep (a call started) cancels
  // it. When the session asked for it, a rest the Stop hook reported with no agents working is
  // taken as it is: Claude's own status lags the hook and counts a running shell as busy, so
  // checking it could put the renew off for good, and a session that asked is done with what its
  // shells were for.
  async function renew(thread: string, rested = false) {
    const run = runOf(thread)
    const session = current(thread)
    if (!session) return
    const running = await claude.agent(session, serving)
    if (!(run.renew === 'asked' || run.renew === 'stale') || run.turn === 'busy' || onCall.has(run) || (!rested && running?.status === 'busy')) return
    run.renew = running && (thread === main || fresh(thread)) ? 'underway' : undefined
    if (run.renew) void cycle(thread, running)
    else stop(thread)
    letGo(thread)
  }

  // A renew is on its way while the thread's session winds down its turn or restarts, but not
  // while it waits on background agents, which can take as long as they like.
  function pending(run: Run) {
    return run.renew === 'underway' || (!!run.renew && run.turn !== 'background')
  }

  // Resolves once the thread's renew is through (its new session connected) or off, right
  // away when none is on its way, so a voice call can wait for the new session.
  function renewal(thread: string): Promise<void> {
    const run = runOf(thread)
    if (!pending(run)) return Promise.resolve()
    return new Promise(resolve => run.held.push(resolve))
  }

  function letGo(thread: string) {
    const run = runOf(thread)
    if (pending(run)) return
    for (const resolve of run.held.splice(0)) resolve()
  }

  // A running session that isn't busy stops after a while; its next message resumes it.
  // The main thread keeps running, and compacts before its cache goes cold.
  function rest(thread: string, rested = false) {
    const run = runOf(thread)
    clock.clearTimeout(run.rest)
    run.rest = undefined
    if (run.turn === 'busy' || run.phase.is !== 'live') return
    if (thread === main) run.rest = clock.setTimeout(stopIfIdle, cacheWarm, thread)
    else if (run.leaving) stop(thread)
    else if (fresh(thread)) {
      const left = warmFor(thread)
      if (left === 0 && rested) void handOff(thread, true)
      else if (left !== undefined) run.rest = clock.setTimeout(handOff, left, thread)
    } else run.rest = clock.setTimeout(stopIfIdle, idleStop, thread)
  }

  // A fresh thread keeps one session running, which takes its messages while its context has
  // room and its cache is warm. Once either is spent, a new session built from the chat takes
  // over at the old one's rest, so the next message finds it running: after the cache expires,
  // the old session would send its whole context uncached, and a new one costs no more.
  // warmFor is how long a session stays worth its messages, undefined before its first request.
  // Its cache lives an hour on a Claude subscription and five minutes by default on an API key;
  // the transcript records which.
  function warmFor(thread: string) {
    const session = current(thread)
    const { sent, at, short } = session ? claude.usage(cwdOf(thread), session) : { sent: 0 }
    if (!sent) return
    return sent >= capacity ? 0 : Math.max(0, (at ?? clock.now()) + (short ? cacheWarm / 12 : cacheWarm) - clock.now())
  }

  // A session on a call takes every message of the call, so a call never changes sessions midway.
  function spent(thread: string) {
    return fresh(thread) && !onCall.has(runOf(thread)) && warmFor(thread) === 0
  }

  // At a rest the Stop hook reported with no agents working, Claude's own status still says busy
  // for about a second, so a session that filled up on that turn hands over without asking it.
  async function handOff(thread: string, rested = false) {
    const run = runOf(thread)
    run.rest = undefined
    const running = await claude.agent(current(thread) ?? '', serving)
    if (running && run.turn !== 'busy' && (rested || running.status === 'idle') && spent(thread)) void cycle(thread, running)
  }

  // The Stop hook ends a turn, but background tasks keep a session busy past it,
  // so Claude's own status decides; a busy session reports idle again when it's done.
  // A big conversation compacts first, while its cache is warm: resumed after the cache
  // expires, it would be written to the cache whole again.
  async function stopIfIdle(thread: string) {
    const run = runOf(thread)
    run.rest = undefined
    const session = current(thread)
    if (!session) return
    const running = await claude.agent(session, serving)
    if (run.turn === 'busy' || running?.status === 'busy') return
    if (running && !run.leaving && !fresh(thread) && !onCall.has(run) && claude.usage(cwdOf(thread), session).sent > compactAbove) void cycle(thread, running, '/compact', true)
    else if (thread !== main) stop(thread)
  }

  // `claude stop` returns before the process exits, and the session keeps its channel until it
  // does, so a message meanwhile waits for the exit (route). Its process is found while Claude
  // still lists it, before the stop; when Claude can't say, the stop goes ahead without the wait.
  function stop(thread: string, running?: claude.Agent) {
    const run = runOf(thread)
    clock.clearTimeout(run.rest)
    run.rest = undefined
    const session = running?.sessionId ?? current(thread)
    if (!session) return Promise.resolve()
    if (run.ending) return run.ending
    const ending: Promise<void> = (running ? Promise.resolve(running) : claude.listing(session))
      .then(agent => {
        if (closed) return
        void claude.stop(session)
        return agent && claude.exited(agent.pid)
      })
      .finally(() => (run.ending = undefined))
    return (run.ending = ending)
  }

  // Resolves with the thread's session once it has stopped and the thread is forgotten.
  function retire(thread: string): Promise<string> {
    if (thread === main) throw new Error('the main thread stays open')
    return new Promise(resolve => {
      const run = runOf(thread)
      run.leaving = resolve
      if (run.phase.is !== 'live') return forget(thread)
      void stopIfIdle(thread)
    })
  }

  // Like retire, for a thread whose session another client resumes.
  function release(thread: string) {
    if (thread === main) throw new Error('the main thread stays here')
    if (!threads[thread]?.session) throw new Error('this thread has no session yet')
    return retire(thread)
  }

  function forget(thread: string) {
    const run = runOf(thread)
    const session = threads[thread]?.session ?? ''
    delete threads[thread]
    save()
    become(run, { is: 'stopped' })
    clock.clearTimeout(run.rest)
    runs.delete(thread)
    rmSync(settingsOf(thread), { force: true })
    run.leaving!(session)
  }

  function adopt(thread: string, name: string, session: string, prompt?: string, cwd?: string) {
    threads[thread] = { name, session, ...(cwd && { cwd }) }
    save()
    if (prompt) void launch(thread, name, { prompt })
  }

  function find(nameOrThread: string) {
    if (threads[nameOrThread]) return nameOrThread
    const wanted = nameOrThread.trim().toLowerCase()
    const matches = Object.keys(threads).filter(thread => threads[thread]!.name.toLowerCase() === wanted)
    if (matches.length !== 1) throw new Error(matches.length ? `more than one thread is named "${nameOrThread}"` : `no thread named "${nameOrThread}"`)
    return matches[0]!
  }

  function rename(thread: string, name: string) {
    const known = threads[thread]
    if (!known || known.name === name) return
    known.name = name
    save()
  }

  function follow(thread: string, name: string, session: string, cwd?: string) {
    threads[thread] = { name, from: session, ...(cwd && { cwd }) }
    save()
  }

  function register(thread: string, name: string, cwd?: string) {
    return (threads[thread] ??= { name, ...(cwd && { cwd }) })
  }

  // A start's prompt and the session it forks are kept until a session connects, so the next start
  // after a failed one, a retry or the thread's next message, starts with them; its cwd is kept in
  // threads.json.
  async function launch(thread: string, name: string, { cwd, again, ...given }: Opening & { cwd?: string; again?: boolean } = {}) {
    const run = runOf(thread)
    if (closed || underway(run)) return
    if (given.prompt || given.fork) run.opening = given
    const { prompt, fork, quiet = false } = run.opening ?? {}
    const known = register(thread, name, cwd)
    claim(thread)
    if ((prompt && !quiet) || run.queue.length) setState(thread, true)
    const phase: Phase = { is: 'launching', again }
    become(run, phase)
    // A fork's first start has no session to find; after a failed one, the session it started may run on.
    if (fork && !run.failing) return start(thread, prompt, fork)
    const running = await sessionOf(thread)
    if (run.phase !== phase) return
    if (running) {
      become(run, { is: 'recovering', again })
      return recover(thread)
    }
    if (!fork && known.session && !fresh(thread)) await claude.rm(known.session)
    if (run.phase === phase) await start(thread, prompt, fork)
  }

  // The running session serving a thread: its current one, or one started for it whose
  // conversation isn't saved yet.
  async function sessionOf(thread: string) {
    const running = await claude.agents(serving)
    return running.find(agent => agent.sessionId === current(thread)) ?? running.find(agent => boundTo(agent) === thread)
  }

  function boundTo(agent: claude.Agent) {
    const env = claude.settingsOf(agent)?.env
    return env?.HEX_CHANNEL === channel ? env.HEX_THREAD : undefined
  }

  function extra(thread: string) {
    const { model, effort } = threads[thread]!
    return [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []), ...args(thread)]
  }

  // A session that started with other arguments or another channel starts over: with its next
  // message for a changed model or effort, and at its next rest after an update, so a crash or a
  // plain restart of the hub leaves every session running. A thread with no record started its
  // session with none of its own arguments, before the hub kept one.
  function stale(thread: string) {
    return (threads[thread]?.launched ?? stamp([], server)) !== stamp(extra(thread), server, hooks)
  }

  function configure(thread: string, settings: Settings) {
    const known = threads[thread]!
    for (const [key, value] of Object.entries(settings) as [keyof Settings, string | undefined][]) {
      if (value) known[key] = value
      else delete known[key]
    }
    save()
  }

  function settingsOf(thread: string) {
    return join(sessionsDir, `${encodeURIComponent(thread)}.json`)
  }

  // A respawn reads the same file, so it gets the hub's current token too. It runs without the
  // launcher, so the file keeps what the launcher added and renews only the hub's keys.
  function writeSettings(thread: string, launched: ReturnType<typeof claude.settingsOf> = {}) {
    const env = {
      HEX_CHANNEL: channel,
      HEX_THREAD: thread,
      HEX_HUB: socketPath,
      HEX_PORT: String(port),
      HEX_TOKEN: token,
      HEX_STORE: storeDir,
      ...(general && thread === main ? { HEX_MAIN: '1' } : {}),
      ...(fresh(thread) ? { HEX_FRESH: '1' } : {}),
    }
    writeFileSync(settingsOf(thread), JSON.stringify({ ...launched, enabledPlugins: { ...launched?.enabledPlugins, [plugin]: true }, env: { ...launched?.env, ...env } }), { mode: 0o600 })
  }

  async function start(thread: string, prompt?: string, fork?: string) {
    const known = threads[thread]!
    writeSettings(thread)
    const launchArgs = extra(thread)
    const launched = stamp(launchArgs, server, hooks)
    if (known.launched !== launched) {
      known.launched = launched
      save()
    }
    const source = fork ?? (known.session ? undefined : known.from)
    const resume = source ? ['--resume', source, '--fork-session'] : known.session && !fresh(thread) ? ['--resume', known.session] : []
    try {
      watchJob(thread, await claude.start(launcher, ['--channels', channel, '--name', known.name, ...resume, ...launchArgs, '--settings', settingsOf(thread), ...(prompt ? [prompt] : [])], { cwd: known.cwd ?? hexDir, env: inherited }))
    } catch (error) {
      fail(thread, error instanceof Error ? error.message : String(error))
    }
  }

  function watchJob(thread: string, job: string) {
    const phase = runOf(thread).phase
    if (phase.is !== 'launching') return
    phase.job = job
    recover(thread)
    const check = () => {
      const { state: status, detail } = claude.record(job)
      if (status === 'failed') fail(thread, detail || 'the session failed to start')
    }
    try {
      phase.watch = claude.watchJob(job, check)
      check()
    } catch {
      process.stderr.write(`hub: no job record for ${job}, so a failed start of ${thread} can't be seen\n`)
    }
  }

  // A run of failed starts ends when the thread's session connects. Its chat hears of each one a
  // message or prompt set off, but of one the hub set off on its own only as the run's first, and
  // General hears once, from the third on. General's own failed starts reach only its chat, which
  // needs no session to read them.
  function fail(thread: string, reason: string) {
    const run = runOf(thread)
    const { phase } = run
    if (phase.is !== 'launching') return
    become(run, { is: 'stopped' })
    if (run.renew === 'underway') run.renew = undefined
    const failing = (run.failing ??= { count: 0 })
    failing.count++
    if (!phase.again) failing.retried = false
    process.stderr.write(`hub: ${thread}'s session failed to start, ${failing.count} in a row: ${reason}\n`)
    if (!phase.again || failing.count === 1) failed(thread, reason)
    if (failing.count >= TELL_AFTER && !failing.told && generalHub && !(general && thread === main)) {
      failing.told = true
      const content = `[hub] hex couldn't start the session of ${app} thread "${threads[thread]?.name ?? thread}" ${failing.count} times in a row: ${reason}. Its next message starts it again.`
      generalHub.deliver(generalHub.main!, generalHub.name(generalHub.main!) ?? 'hex', { content, meta: { user: 'hub' } })
    }
    setState(thread, false)
  }

  // The store while it opens and writes; without it the hub goes on from memory, as it did before
  // it had one, so a failing disk never leaves hex deaf.
  function kept<T>(use: (store: Store) => T, otherwise: T): T {
    try {
      return use((store ??= open(storeDir)))
    } catch (error) {
      process.stderr.write(`hub: ${join(storeDir, 'hex.db')} failed, so the hub goes on from memory: ${error}\n`)
      return otherwise
    }
  }

  // A message is kept before anything else happens to it, so once this returns the app can be told
  // it arrived: a crash from then on leaves it with hex, for whichever session serves the thread
  // next. A key kept already is the app sending it again. along: the change to hex's records the
  // message tells of, like the answer a tap gives, made in the same write so both land or neither
  // does; when it changes nothing, or hex.db can't take it, there's nothing to tell. Whether the
  // thread is told.
  function deliver(thread: string, name: string, message: Message, along?: () => boolean): boolean {
    const key = `${app}:${message.key ?? randomUUID()}`
    const { content, meta } = message
    const added = kept(store => store.write(() => (!along || along()) && store.deliver({ key, to: thread, from: app, body: content, meta })), along ? false : undefined)
    if (added === false) return false
    pass(thread, name, added ? { content, meta: { key, ...meta } } : { content, meta })
    return true
  }

  function pass(thread: string, name: string, message: Message) {
    const { handed } = runOf(thread)
    const { key } = message.meta
    if (key && handed.has(key)) return
    if (key) handed.add(key)
    route(thread, name, message)
  }

  function route(thread: string, name: string, message: Message) {
    const run = runOf(thread)
    if (run.ending) {
      run.queue.push(message)
      return void run.ending.then(() => resume(thread, name))
    }
    if (run.phase.is === 'live') return (stale(thread) && !onCall.has(run)) || spent(thread) ? void refresh(thread, message) : run.phase.line.send({ type: 'inbound', ...message })
    run.queue.push(message)
    if (run.phase.is === 'launching') run.phase.again = false
    void launch(thread, name)
  }

  // A message another app's hub kept is that hub's to deliver; one kept by anything else (a job, a
  // schedule, the hex command) goes to the hub that serves its thread.
  const mine = (row: Row) => row.from === app || !apps.has(row.from)
  // The key goes first on the channel tag, where the session's hook reads it (state.ts).
  const toMessage = (row: Row): Message => ({ content: row.body, meta: { key: row.key, ...row.meta } })

  // What a thread's next session gets: every message no session has taken, and any the store couldn't keep.
  function waiting(thread: string): Message[] {
    const rows = kept(store => store.untaken(thread), [])
    return [...rows.filter(mine).map(toMessage), ...runOf(thread).queue.filter(message => !message.meta.key)]
  }

  // Messages kept outside this hub reach its threads as the bell rings, and at its start so do any
  // that no session took before the hub stopped.
  function wake() {
    if (closed) return
    for (const row of kept(store => store.untaken(), [])) if (threads[row.to] && mine(row)) pass(row.to, threads[row.to]!.name, toMessage(row))
  }

  // A thread whose session failed to start keeps its prompt and the messages it was handed waiting,
  // and the main thread is always running, so each starts again once starts go through. Once for
  // each failed start a message set off: one that fails even then has a problem of its own, and
  // waits for its next message.
  function retry() {
    for (const [thread, run] of runs) {
      if (!run.failing || run.failing.retried || run.phase.is !== 'stopped' || !(thread === main || run.opening || waiting(thread).length)) continue
      run.failing.retried = true
      void launch(thread, threads[thread]?.name ?? thread, { again: true })
    }
  }

  // A session that started before hex kept messages can't mark one taken itself, so its hook says so here.
  function took(keys: unknown, session: unknown) {
    if (!Array.isArray(keys) || typeof session !== 'string') return
    for (const key of keys) kept(store => store.take(String(key), session), false)
  }

  // Messages that came while the thread's session was stopping resume it once it's gone, unless a
  // restart already took them.
  function resume(thread: string, name: string) {
    const run = runOf(thread)
    if (!run.queue.length || run.leaving) return
    if (run.phase.is === 'live' || run.phase.is === 'recovering') become(run, { is: 'stopped' })
    void launch(thread, name)
  }

  // Claude Code runs a slash command like /compact only as a session's first prompt,
  // and reads its launch arguments only at start, so a running session stops and
  // resumes for either.
  async function restart(thread: string, prompt?: string) {
    const session = current(thread)
    if (!session) return launch(thread, threads[thread]!.name, { prompt })
    void cycle(thread, await claude.agent(session, serving), prompt)
  }

  // Delivers a message to a fresh start of the thread's session, so it gets new launch
  // arguments or, in a fresh thread, a new session; a session still working, on its turn
  // or on background agents, keeps running and takes it as it is, unless earlier messages
  // already wait for the new start.
  // A session that took over while Claude was asked gets the message as any message would.
  async function refresh(thread: string, message: Message) {
    const run = runOf(thread)
    const phase = run.phase
    const running = await claude.agent(current(thread) ?? '', serving)
    if (run.phase !== phase || phase.is !== 'live') return route(thread, threads[thread]!.name, message)
    const working = fresh(thread) ? run.turn === 'busy' || (running && running.status !== 'idle') : running?.status === 'busy'
    if (working && !run.queue.length) return phase.line.send({ type: 'inbound', ...message })
    run.queue.push(message)
    void cycle(thread, running)
  }

  // Resuming before the old process exits starts a copy, so it waits for the exit. The stopped
  // session's stream can close after that, so it isn't waited for.
  async function cycle(thread: string, running?: claude.Agent, prompt?: string, quiet = false) {
    const run = runOf(thread)
    if (running) await stop(thread, running)
    if (run.phase.is === 'live' || run.phase.is === 'recovering') become(run, { is: 'stopped' })
    void launch(thread, threads[thread]!.name, { prompt, quiet })
  }

  // A session's channel connected over HTTP: its session is the one the hub started, or the one
  // Claude reports running for the thread. One that only reconnects still owes a renew it asked for.
  function welcome(thread: string, line: Line) {
    const run = runOf(thread)
    const was = run.phase
    const job = was.is === 'launching' ? was.job : undefined
    become(run, { is: 'live', line })
    run.failing = run.opening = undefined
    if (general && thread === main) reached(api)
    if (run.renew !== 'asked') run.renew = undefined
    threads[thread] ??= { name: thread }
    const id = job && claude.record(job).sessionId
    if (id) note(thread, id)
    const given = waiting(thread)
    for (const message of given) line.send({ type: 'inbound', ...message })
    run.handed = new Set(given.flatMap(message => message.meta.key ?? []))
    run.queue.length = 0
    rest(thread)
    letGo(thread)
    if (stale(thread)) {
      run.renew = 'stale'
      void renew(thread)
    }
    void sessionOf(thread).then(running => {
      if (running && run.phase.is === 'live' && run.phase.line === line) note(thread, running.sessionId)
    })
    if (was.is === 'launching') for (const each of retries) each()
  }

  function note(thread: string, session: string) {
    runOf(thread).unsaved = threads[thread]?.session !== session ? session : undefined
    claim(thread)
  }

  function drop(thread: string, line: Line) {
    const run = runs.get(thread)
    if (run?.phase.is !== 'live' || run.phase.line !== line) return
    become(run, { is: 'recovering' })
    setState(thread, false)
    if (run.leaving) return forget(thread)
    recover(thread)
  }

  // A session without its channel gets Claude Code's reconnect window to come back. After that, one
  // still running restarts in place (a turn it was on runs again) if it started before the wait
  // did, or else gets another window; a start that ended is reported, a gone main thread starts
  // again, and a thread whose messages waited on a session that has since ended resumes.
  function recover(thread: string, since = clock.now()) {
    const run = runOf(thread)
    const phase = run.phase
    if (closed || phase.is === 'stopped' || phase.is === 'live' || phase.deadline) return
    phase.deadline = clock.setTimeout(async () => {
      phase.deadline = undefined
      const running = await sessionOf(thread)
      if (run.phase !== phase) return
      if (!running) return gone(thread)
      if ((running.startedAt ?? 0) >= since) return recover(thread)
      // A respawn starts from the flags the session started with, which read the thread's current
      // settings file only for a session the hub started that way.
      if (claude.settingsOf(running)) return respawn(thread, running)
      void cycle(thread, running)
    }, reconnect)
  }

  function gone(thread: string) {
    const run = runOf(thread)
    const started = run.phase.is === 'launching'
    if (started) fail(thread, 'its session ended before its channel connected')
    else become(run, { is: 'stopped' })
    if (thread === main) revive()
    else if (!started && waiting(thread).length) void launch(thread, threads[thread]?.name ?? thread)
  }

  async function respawn(thread: string, running: claude.Agent) {
    const run = runOf(thread)
    const id = running.id ?? running.sessionId.slice(0, 8)
    if (run.phase.is === 'launching' && run.phase.respawned) {
      process.stderr.write(`hub: ${thread}'s session ${id} restarted and still has no channel\n`)
      return fail(thread, 'its session runs, but its channel never connects')
    }
    process.stderr.write(`hub: ${thread}'s session ${id} runs without its channel, so it restarts in place\n`)
    if (run.phase.is === 'launching') run.phase.respawned = true
    else become(run, { is: 'launching', respawned: true, again: run.phase.is === 'recovering' && run.phase.again })
    const phase = run.phase
    writeSettings(thread, claude.settingsOf(running))
    await claude.respawn(running)
    if (run.phase === phase) recover(thread)
  }

  // A session that dies before Claude saves its conversation can't be resumed, so the
  // thread keeps its last saved session until the new one has a conversation on disk.
  function claim(thread: string) {
    const run = runOf(thread)
    const known = threads[thread]
    if (!run.unsaved || !known || !existsSync(claude.transcript(cwdOf(thread), run.unsaved))) return
    known.session = run.unsaved
    delete known.from
    run.unsaved = undefined
    save()
  }

  function cwdOf(thread: string) {
    return threads[thread]?.cwd ?? hexDir
  }

  function current(thread: string) {
    return runs.get(thread)?.unsaved ?? threads[thread]?.session
  }

  // A thread is on a call from its keep until its renew, which starts the next call in a new session.
  function keep(thread: string) {
    const run = runOf(thread)
    if (run.renew !== 'underway') run.renew = undefined
    onCall.add(run)
    letGo(thread)
  }

  function renewAsked(thread: string) {
    const run = runOf(thread)
    if (run.renew !== 'underway') run.renew = 'asked'
    hangUp(run)
  }

  const serve = endpoint(path.slice(1), channel, token, server, {
    call,
    permission: (thread, request) => permission?.(thread, request),
    open: welcome,
    close: drop,
  }, () => zoneOf(hexDir) ?? Temporal.Now.timeZoneId())
  channels.set(path, serve)

  // Where a session's hooks and hex's own tools reach the hub, one JSON line each.
  rmSync(socketPath, { force: true })
  const sock = createServer(socket => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const raw = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        try {
          handle(JSON.parse(raw))
        } catch (error) {
          process.stderr.write(`hub: dropped a bad line: ${error}\n`)
        }
      }
    })
    socket.on('error', () => {})
  }).listen(socketPath)

  function handle(request: any) {
    if (request.type === 'state') {
      took(request.taken, request.session)
      setState(request.thread, request.busy, request.background === true)
    }
    if (request.type === 'open') void launch(request.thread, request.name, { prompt: request.prompt })
    if (request.type === 'answer') questions?.answer(request.thread, request.message, request.label, request.via)
    if (request.type === 'settle') questions?.settle(request.thread, request.message, request.note)
    if (request.type === 'reopen') questions?.reopen(request.thread, request.message, request.via)
    if (request.type === 'inbound') inbound(request.thread, { content: request.content, meta: request.meta ?? {}, key: request.key })
    if (request.type === 'mirror') void mirror(api, find(request.thread), request.to, request.where).then(
      link => process.stderr.write(`hub: mirrored ${request.thread} to ${link}\n`),
      error => process.stderr.write(`hub: couldn't mirror ${request.thread} to ${request.to}: ${error}\n`),
    )
  }

  // A local message reaches a thread this hub already has. A key from another app's list would
  // otherwise open a stray thread here, under the same key, that later wakes find first.
  function inbound(thread: string, message: Message) {
    if (Object.hasOwn(threads, thread)) return deliver(thread, threads[thread]!.name, message)
    process.stderr.write(`hub: no thread ${thread} in ${registry}, so a message for it from ${message.meta?.user ?? 'a local tool'} was dropped\n`)
  }

  // The owner's Stop ends the turn as Esc does in a terminal: the session and what it started in the
  // background keep running, and the next message continues the conversation. A turn the hooks
  // report over is left alone; one they never reported (the hub restarted) is the daemon's to say.
  // An Esc that doesn't land changes nothing, and the owner can press Stop again.
  function interrupt(thread: string): Promise<void> {
    const run = runOf(thread)
    run.interrupting ??= press(thread).finally(() => (run.interrupting = undefined))
    return run.interrupting
  }

  async function press(thread: string): Promise<void> {
    const run = runOf(thread)
    const session = current(thread)
    if (!session || run.turn === 'background') return
    const agent = await claude.listing(session)
    if (!agent) return
    if (run.turn === 'done' && agent.state !== 'working') return
    const deadline = new AbortController()
    const timer = clock.setTimeout(() => deadline.abort(), PRESS)
    const how = await claude
      .interrupt(cwdOf(thread), session, AbortSignal.any([deadline.signal, closing.signal]))
      .catch(error => void process.stderr.write(`hub: couldn't interrupt ${thread}'s turn: ${error}\n`))
      .finally(() => clock.clearTimeout(timer))
    if (closing.signal.aborted || current(thread) !== session) return
    if (how === 'interrupted') {
      setState(thread, false, true)
      if ((await claude.listing(session))?.state !== 'working' && run.turn === 'background') setState(thread, false)
      return
    }
    process.stderr.write(`hub: Esc didn't interrupt ${thread}'s turn\n`)
  }

  // After the owner's stop only the thread's next message starts it again, without the prompt it
  // was opened with, though a moved copy still starts from the conversation it forks.
  function halt(thread: string) {
    const run = runs.get(thread)
    if (run?.failing) run.failing.retried = true
    if (run?.opening) run.opening = run.opening.fork ? { fork: run.opening.fork } : undefined
    return stop(thread)
  }

  // The main thread is always running: started with the hub, and started again when its session
  // is gone.
  function revive() {
    if (!main || closed || runOf(main).phase.is === 'live') return
    rename(main, mainName)
    void launch(main, mainName, { again: true })
  }
  // Sessions that outlived the hub (a hub restart) reconnect, or recover. A fresh main thread's
  // launch never resumes, so one still running waits for its session instead of starting another.
  if (main || Object.keys(threads).length) {
    void claude.agents(serving).then(running => {
      const serving = new Set(Object.keys(threads).filter(thread => running.some(agent => agent.sessionId === current(thread) || boundTo(agent) === thread)))
      for (const thread of serving) {
        const run = runOf(thread)
        if (run.phase.is !== 'stopped') continue
        become(run, { is: 'recovering' })
        recover(thread)
      }
      if (main && !(fresh(main) && serving.has(main))) revive()
      wake()
    })
  }
  const unwatch = kept(store => store.watch(wake), () => {})
  const unschedule = general && main ? schedule(storeDir, hexDir, main) : () => {}

  const api = {
    deliver,
    command: restart,
    configure,
    settings: (thread: string): Settings => ({ model: threads[thread]?.model, effort: threads[thread]?.effort }),
    register: (thread: string, name: string, cwd?: string) => void register(thread, name, cwd),
    open: (thread: string, name: string, prompt?: string, cwd?: string) => void launch(thread, name, { prompt, cwd }),
    fork: (thread: string, name: string, session: string, prompt: string, cwd?: string) => void launch(thread, name, { prompt, fork: session, cwd }),
    main,
    renewal,
    keep,
    renew: renewAsked,
    session: current,
    running: sessionOf,
    threads: () => Object.keys(threads),
    name: (thread: string) => threads[thread]?.name,
    cwd: (thread: string) => threads[thread]?.cwd,
    stop: halt,
    interrupt,
    answer: (thread: string, request_id: string, behavior: 'allow' | 'deny') => {
      const { phase } = runOf(thread)
      if (phase.is === 'live') phase.line.send({ type: 'permission', request_id, behavior })
    },
    release,
    adopt,
    follow,
    history: (thread: string) => {
      const session = current(thread)
      return session ? history(hexDir, session) : []
    },
    retire,
    find,
    rename,
    close: () => {
      closed = true
      unwatch()
      unschedule()
      retries.delete(retry)
      if (generalHub === api) generalHub = undefined
      apps.delete(app)
      sock.close()
      if (channels.get(path) === serve) channels.delete(path)
      closing.abort()
      for (const run of runs.values()) {
        become(run, { is: 'stopped' })
        clock.clearTimeout(run.rest)
        hangUp(run)
      }
    },
  }
  retries.add(retry)
  if (general && main) generalHub = api
  return api
}

function client(app: string) {
  const there = clients.get(app)
  if (!there) throw new Error(`${app} isn't connected${clients.size ? `; threads open in ${[...clients.keys()].join(', ')}` : ''}`)
  return there
}

// Opens a thread on any client and starts its session: on a prompt, its first message as the
// session starts, or on a message that reaches it the way the app's own messages do.
export async function begin(app: string, name: string, first: string | Message, { about, where, cwd }: { about?: string; where?: string; cwd?: string } = {}) {
  const there = client(app)
  const opened = await there.place(name, where, about)
  if (typeof first === 'string') there.hub.open(opened.thread, name, first, cwd)
  else {
    there.hub.register(opened.thread, name, cwd)
    there.hub.deliver(opened.thread, name, first)
  }
  return opened
}

// Opens the thread on another client and posts its chat so far there; the backfill settles either way.
async function carry(from: Hub, thread: string, to: string, name: string, where?: string) {
  const target = client(to)
  const session = from.session(thread)
  if (!session) throw new Error('this thread has no session yet')
  const cwd = from.cwd(thread)
  const { thread: dest, link } = await target.place(name, where, undefined, cwd)
  const filled = Promise.resolve(target.backfill?.(dest, from.history(thread))).catch(error => {
    process.stderr.write(`hub: couldn't backfill ${to} thread ${dest}: ${error}\n`)
  })
  return { target, session, dest, link, filled, cwd }
}

// Moves a thread to another client: its session stops here and resumes there, memory intact, once
// its chat is backfilled. The main thread never leaves, and a thread its app owns (copy) stays, so a
// copy continues instead.
export async function move(from: Hub, thread: string, to: string, name: string, where?: string, copy = thread === from.main) {
  const { target, session, dest, link, filled, cwd } = await carry(from, thread, to, name, where)
  const prompt = target.waits ? undefined : `This conversation just moved to ${to}, into the thread "${name}". Your ${to} tools now post there. Carry on where you left off.`
  if (copy) void filled.then(() => (prompt ? target.hub.fork(dest, name, session, prompt, cwd) : target.hub.follow(dest, name, session, cwd)))
  else void Promise.all([from.release(thread), filled]).then(([session]) => target.hub.adopt(dest, name, session, prompt, cwd))
  return link
}

// Opens a copy of the thread on another client with its chat so far, and leaves it here. The copy
// continues the thread's session as a fork with its first message, so the two never share a session.
export async function mirror(from: Hub, thread: string, to: string, where?: string) {
  const name = from.name(thread) ?? thread
  const { target, session, dest, link, filled, cwd } = await carry(from, thread, to, name, where)
  target.hub.follow(dest, name, session, cwd)
  await filled
  return link
}
