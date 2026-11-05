import { createHmac, timingSafeEqual } from 'crypto'
import { readFileSync } from 'fs'
import { isIP } from 'net'
import { dirname, join } from 'path'
import { findThread, followAgent, followThread, type Step, type Thread } from './activity.ts'
import { Call, transcript, type Mark, type Sent, type Speaker, type Task } from './call.ts'
import { CallLog, ending, usage, type CallRecord, type Ending, type Source } from './calls.ts'
import { Changes } from './changes.ts'
import { Chats } from './chat.ts'
import { PORT, STATE_DIR, env } from './env.ts'
import { clip, Questions, type Question } from './questions.ts'
import { relay } from './relay.ts'
import { Board, opener, type Page, type Run } from './board.ts'
import { jobs, overall } from './overall.ts'
import { open } from '../../hub/store.ts'
import { begin, title as oneWord, type Held, type VoiceLine } from '../../hub/hub.ts'
import page from './page.html' with { type: 'text' }

const KEY = env.OPENAI_API_KEY
const VOICE = env.VOICE
const MODEL = env.VOICE_MODEL ?? 'gpt-live-1'
const API = `${env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'}/live/sessions`
const TWILIO_SID = env.TWILIO_ACCOUNT_SID
const TWILIO_TOKEN = env.TWILIO_AUTH_TOKEN
const TWILIO_NUMBER = env.TWILIO_NUMBER
const TWILIO_API = env.TWILIO_BASE_URL ?? 'https://api.twilio.com'
const CALLER_NUMBER = env.CALLER_NUMBER
const PUBLIC_HOST = env.VOICE_PUBLIC_URL?.replace(/^\w+:\/\//, '')
const PUBLIC_HOSTNAME = PUBLIC_HOST ? URL.parse(`https://${PUBLIC_HOST}`)?.hostname : undefined
const TOKEN = env.VOICE_TOKEN
const calls = new CallLog(join(STATE_DIR, 'calls'))
const activity = new Changes()
const follows = new Map<string, () => void>()
let board: Board
let yours: Questions
let chats: Chats

const IDENTITY = (() => {
  try {
    return readFileSync(env.VOICE_INSTRUCTIONS ?? join(STATE_DIR, 'instructions.md'), 'utf8').trim()
  } catch {
    return 'You are the voice of a personal assistant, on a live call with the person it works for. Speak warmly and naturally, like a sharp friend: plain words, short answers.'
  }
})()

const VOICE_PROMPT = `${IDENTITY}

Backchannel policy: Use moderate backchannels. Acknowledge naturally without competing with the main response.

Interruption policy: Stop speaking when the caller interrupts. Listen to what they say.

Delegation policy:
Backend tools:
- Assistant: the caller's files, machines, projects, memory, messages, email, calendar and the web. It looks things up, takes actions, runs long tasks and ends the call.

Generate <|SpawnThinking|> when:
- The caller asks something or wants something done, including how a task is going, what's running, and hanging up. Your task board holds only what this call started, never everything hex runs.
- A correction changes the work already requested.

Do not generate <|SpawnThinking|> when:
- The caller only greets or thanks you.
- You can answer from the conversation or a still-current result.
- You need a brief clarification to understand the request.

Generate <|SpawnThinking|> before giving an answer that depends on backend work, then tell the caller in a few words that you're on it.
Do not guess the result while waiting.
Say something is done only when the backend says so.`

type Pending = { resolve: () => void; reject: (error: Error) => void }
type Ring = { delegation: string; offset: number }
type Live = {
  id: string
  shown: Map<string, Question>
  socket: WebSocket
  call: Call
  record: Omit<CallRecord, 'turns' | 'tasks' | 'moments'>
  pending: Map<string, Pending>
  rings: Ring[]
  changes: Changes
  spoke: number
  warning?: ReturnType<typeof setTimeout>
  speak?: (audio: string) => void
  // Each transcript fragment's start on the session's timeline, as it comes in, for a line whose
  // own buffer plays the voice: the caller talking over it cuts off what they haven't heard yet.
  heard?: (who: Speaker, start: number, text: string) => void
  // The first hang-up asked, which the call ends by, and whether it went out.
  closing?: string
  closed?: true
}
type Attaching = { id: string; closing?: string }
// notes: what the voice should know once this call connects, sent while it rang.
type Placed = { to: string; why?: string; started: string; session?: string; notes: string[] }
// move: the caller's own call going to their phone, which ends the live call once it picks up.
type Dial = { greeting: string; from: Source; token: string; why?: string; callee?: string; move?: boolean }
// unheard: the voice's audio sent to Twilio that its marks say hasn't played yet, in chunks, and
// since: where on the session's timeline the voice began saying it.
type Phone = Dial & { openai?: WebSocket; stream?: string; started?: true; refused?: true; unheard: number; since?: number }

// What the call engine asks of the voice thread's hub: hand its session a message, hold the session
// for a call (keep) or let it start over for the next (renew), wait for a renew on its way, and
// name the session now serving the thread.
export type Hub = {
  deliver: (content: string, meta: Record<string, string>) => void
  keep: () => Promise<void>
  renew: () => void
  renewal: () => Promise<void>
  session: () => string | undefined
}

let hub: Hub
let HEX_STATE: string
// Every step to the hub in the order the calls take them; a new call's first step waits out the
// last call's renew, so the new call's words reach the new session.
let lane = Promise.resolve()
let live: Live | undefined
// The call recover() is attaching back to after a restart, until it opens or is hung up.
let attaching: Attaching | undefined
let ended: string | undefined
let seq = 0
const dials = new Map<string, Dial>()
const placed = new Map<string, Placed>()
const RETRIES = [250, 1000, 2000, 4000, 8000]
const WARN_BEFORE = 120_000
const HANDOFF_WAIT = 3000
const ACK_WAIT = 10_000

// The voice session's tools, which the hub hands here.
export async function tool(name: string, args: Record<string, any>): Promise<string> {
  if (name === 'running') {
    board.refresh()
    return overall(board.runs, board.strays(), await jobs(), open(HEX_STATE).names(), Date.now(), yours.view.asks)
  }
  if (name === 'phone') return dial(args)
  if (name === 'title') return title(args.call, args)
  if (name === 'task') return task(args.id, args.state as Task['state'], args.text, args.call, args.agent)
  if (name === 'send') return pass(args.thread, args.about, args.text, args.app, args.channel)
  if (name === 'answer') return answerQuestion(args.id, args.label, 'call').then(sent => `sent "${args.label}" to ${sent.topic}${missed(sent)}`)
  const ringing = name === 'note' && !live && [...placed.values()].findLast(call => !call.session)
  if (ringing) {
    ringing.notes.push(args.text)
    return 'the call is still ringing; the voice gets this when it connects'
  }
  if (name === 'hang_up' && !live && attaching) {
    retire(attaching, `close_hex_${++seq}`)
    return 'hung up; the voice gets its close once the connection is back'
  }
  if (!live) throw new Error('no call is live')
  switch (name) {
    case 'say':
      await tell(live, 'say', args.text, args.delegation_id)
      return 'said'
    case 'note':
      await tell(live, 'note', args.text, args.delegation_id)
      return 'noted'
    case 'hang_up':
      return hangUpCall(live)
    case 'ask':
      return show(live, args.id)
    default:
      throw new Error(`unknown tool ${name}`)
  }
}

function send(call: Live, type: string, content: string, delegation?: string) {
  if (call.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('the connection to the voice is coming back; try again in a few seconds'))
  const event_id = `${type.split('.')[1]}_${++seq}`
  call.socket.send(JSON.stringify({ type, event_id, delegation_id: delegation ?? null, content }))
  // A tool waits on the voice's word that it has the update; one that never comes would hold the
  // voice session's turn, and every handoff after it, for good.
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      call.pending.delete(event_id)
      reject(new Error(`the voice didn't confirm it within ${ACK_WAIT / 1000}s, so it may not have it`))
    }, ACK_WAIT)
    const settle = <T,>(then: (value: T) => void) => (value: T) => {
      clearTimeout(timer)
      then(value)
    }
    call.pending.set(event_id, { resolve: settle(resolve), reject: settle(reject) })
  })
}

async function tell(call: Live, kind: 'say' | 'note', text: string, delegation?: string) {
  await send(call, kind === 'say' ? 'session.commentary.append' : 'session.thinking.append', text, delegation)
  remember(call, kind, text)
}

function since(call: Live) {
  return Date.now() - Date.parse(call.record.started)
}

function remember(call: Live, kind: Mark['kind'], text: string, more: Pick<Mark, 'ask' | 'sent'> = {}) {
  call.call.mark({ at: since(call), kind, text, ...more })
  save(call)
}

function save(call: Live) {
  calls.save(whole(call))
  call.changes.changed()
}

function whole(call: Live): CallRecord {
  return { ...call.record, ...call.call.record() }
}

async function task(id: string, state: Task['state'], text: string, call = live?.id ?? ended, agent?: string) {
  if (!call) throw new Error('no call yet')
  if (agent || state !== 'running') stop(call, id)
  const following = live?.id === call && state === 'running' && agent && followAgent(agent, hub.session(), step => see(call, id, step))
  if (following) follows.set(`${call} ${id}`, following)
  const result = await mark(call, { ...current(call, id), id, state, text, ...(agent && { agent }) })
  return agent && live?.id === call && !following ? `${result}, but no transcript of agent ${agent} turned up, so the caller won't see its steps` : result
}

// app: no thread has the work yet, so one named name opens there with it.
async function pass(name: string, about: string, text: string, app?: string, where?: string, call = live?.id ?? ended) {
  const known = app ? undefined : findThread(HEX_STATE, name)
  if (!app && !known) throw new Error(`no hex thread is named ${name}; pass app to open one`)
  if (call && live?.id !== call) past(call)
  const id = call && fresh(call, about)
  const meta = { user: 'hex voice', ...(id && { voice_task: `${call}:${id}` }) }
  let thread = known
  if (app) {
    const opened = await begin(app, oneWord(name), { content: text, author: 'prompt', meta }, { about: `From a call: ${about}`, where })
    thread = { app, id: opened.thread, name, state: HEX_STATE }
  }
  // Telling the voice can fail, as while its connection comes back, and that mustn't keep the
  // message from going out and being followed.
  const told = call && id ? mark(call, { id, state: 'running', text: about, to: thread!.name, agent: `${thread!.app}:${thread!.id}` }).then(() => true, () => false) : true
  if (call && id) watch(call, id, thread!, !!app)
  if (!app) {
    try {
      await relay(HEX_STATE, thread!.app, { type: 'inbound', thread: thread!.id, content: text, meta })
    } catch (error) {
      if (call && id) see(call, id, { end: 'failed' })
      throw error
    }
  }
  const sent = app ? `opened ${name} in ${app}` : `sent to ${thread!.name}`
  if (!id) return sent
  return (await told) ? `${sent}, on the board as ${id}` : `${sent}, on the board as ${id}, but the voice may not have heard of it; the work went out, so it needn't be sent again`
}

// Work a past call sent out is picked back up when the engine starts, read from the start of the
// session that took it.
function resume() {
  const since = Date.now() - 24 * 60 * 60_000
  for (const { id: call, started } of calls.list()) {
    if (Date.parse(started) < since) break
    const latest = new Map(past(call).tasks.map(task => [task.id, task]))
    for (const task of latest.values()) {
      let thread
      try {
        thread = task.state === 'running' && task.to && task.agent && findThread(HEX_STATE, task.agent)
      } catch (error) {
        process.stderr.write(`voice: ${call}'s task ${task.id} isn't followed again: ${error}\n`)
      }
      if (thread) watch(call, task.id, thread, true)
    }
  }
}

// The task's followers, the thread's and then the board's, are held from the outset, and one that
// starts after the task stopped stops at once.
function watch(call: string, id: string, thread: Thread, resumed: boolean) {
  stop(call, id)
  const stops: (() => void)[] = []
  let stopped = false
  const hold = (off: () => void) => void (stopped ? off() : stops.push(off))
  follows.set(`${call} ${id}`, () => {
    stopped = true
    for (const off of stops.splice(0)) off()
  })
  hold(followThread(thread, dirname(HEX_STATE), `${call}:${id}`, resumed, step => (step.end ? settle(call, id, thread, step.end, hold) : see(call, id, step))))
}

// The turn that took the message in has ended, but the thread's work may not have: the board keeps
// a thread working while its background agents, workflows or next turns run, so the task follows
// the board's row until it rests.
function settle(call: string, id: string, thread: Thread, end: NonNullable<Step['end']>, hold: (off: () => void) => void) {
  const check = () => {
    const row = board.get(`${thread.app}:${thread.id}`)
    if (row?.state === 'working') see(call, id, { line: newest(row) })
    else see(call, id, { end: row?.state === 'failed' ? 'failed' : end })
  }
  hold(board.listen(check))
  check()
}

function newest(row: Run) {
  return row.agents.find(agent => agent.state === 'working' && agent.line)?.line ?? row.line
}

function fresh(call: string, about: string) {
  const base = about.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'sent'
  let id = base
  for (let n = 2; current(call, id); n++) id = `${base}-${n}`
  return id
}

function current(call: string, id: string): Task | undefined {
  if (live?.id === call) return live.call.task(id)
  const moment = calls.get(call)?.tasks.findLast(task => task.id === id)
  if (!moment) return
  const { at, ...task } = moment
  return task
}

// The change is on the call's record when mark returns, or it throws; what it returns settles once
// the voice has heard of it, on a live call.
function mark(call: string, task: Task): Promise<string> {
  if (live?.id === call) {
    live.call.track(task, Date.now() - Date.parse(live.record.started))
    save(live)
    activity.changed()
    return send(live, 'session.thinking.append', live.call.change(task.id)).then(() => 'board updated')
  }
  const record = past(call)
  calls.save({ ...record, tasks: [...record.tasks, { ...task, at: Date.now() - Date.parse(record.started) }] })
  return Promise.resolve('that call has ended, so only its record changed')
}

function see(call: string, id: string, { line, end }: Step) {
  if (line && live?.id === call && live.call.see(id, line)) activity.changed()
  if (!end) return
  stop(call, id)
  const task = current(call, id)
  if (task?.state !== 'running') return
  try {
    mark(call, { ...task, state: end }).catch(error => trace(`the voice didn't hear ${id} ${end}: ${error.message}`))
  } catch (error) {
    trace(`couldn't mark ${id} ${end}: ${(error as Error).message}`)
  }
}

function stop(call: string, id: string) {
  follows.get(`${call} ${id}`)?.()
  follows.delete(`${call} ${id}`)
}

function title(call: string, { title, summary, waiting }: { title?: string; summary?: string; waiting?: string[] }) {
  const change = { ...(title ? { title } : {}), ...(summary ? { summary } : {}), ...(Array.isArray(waiting) ? { waiting } : {}) }
  if (live?.id === call) {
    Object.assign(live.record, change)
    save(live)
  } else calls.save({ ...past(call), ...change })
  if (Array.isArray(waiting)) yours.called()
  return 'saved'
}

function past(id: string) {
  const record = calls.get(id)
  if (!record) throw new Error(`no call ${id}`)
  return record
}

async function hangUpCall(call: Live) {
  const asked = Date.now()
  while (live === call && Date.now() - asked < 20_000 && Date.now() - Math.max(asked, call.spoke) < 2000) await Bun.sleep(250)
  if (live !== call) return 'the call had already ended'
  close(call, `close_hex_${++seq}`)
  return 'hanging up'
}

// The caller or hex hangs up, and the first hang-up is the one the call ends by. Each goes out at
// once over an open connection to the voice, so a later one retries a close the session didn't act
// on; without one, the first goes out once one opens or, if the call ends first, on a connection
// opened just for it. A phone or Discord call's socket is its session, so once that socket isn't
// open there's nothing left to close.
function close(call: Live, event: string) {
  const state = call.socket.readyState
  if (call.speak && state !== WebSocket.OPEN) return
  call.closing ??= event
  if (state === WebSocket.OPEN) sendClose(call, event)
}

function sendClose(call: Live, event = call.closing, socket = call.socket) {
  socket.send(JSON.stringify({ type: 'session.close', event_id: event }))
  call.closed = true
}

function closeSession(id: string, event: string) {
  const socket = sideband(id)
  let sent = false
  socket.onopen = () => {
    socket.send(JSON.stringify({ type: 'session.close', event_id: event }))
    sent = true
    socket.close()
  }
  socket.onclose = () => sent || trace(`couldn't send ${id} its close (${event})`)
}

function deliver(content: string, meta: Record<string, string>) {
  const time = clock()
  toHub(() => hub.deliver(content, { ...meta, time }))
}

function toHub(step: () => void | Promise<void>) {
  lane = lane.then(step).catch(error => trace(`the hub step failed: ${error}`))
}

function clock() {
  return new Date().toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
}

function ring(call: Live, { delegation, offset }: Ring) {
  const turns = call.call.handOff()
  deliver(turns.length ? transcript(turns) : '(no new words since the last handoff)', {
    call: call.id,
    delegation_id: delegation,
    at: `${(offset / 1000).toFixed(1)}s`,
    ...(call.record.callee && { callee: call.record.callee }),
  })
  save(call)
}

function hear(call: Live, who: Speaker, event: { delta: string; start_ms: number; end_ms: number }) {
  call.call.hear({ who, text: event.delta, start: event.start_ms, end: event.end_ms })
  call.heard?.(who, event.start_ms, event.delta)
  call.changes.changed()
  while (call.rings[0] && call.rings[0].offset <= event.start_ms) ring(call, call.rings.shift()!)
}

const ENDINGS: Record<Ending, string> = {
  you: 'the caller hung up',
  hex: 'hex ended it',
  dropped: 'the connection dropped',
  expired: 'it hit its time limit',
  'no-connect': 'it never connected',
  'no-answer': 'nobody answered',
  busy: 'the line was busy',
}

function finish(call: Live, reason: string, by?: string) {
  if (live !== call) return
  live = undefined
  ended = call.id
  clearTimeout(call.warning)
  const end = ending(reason, by)
  for (const pending of call.pending.values()) pending.reject(new Error(`the call ended (${reason})`))
  // A subagent's steps show only on its live call; a thread's work goes on into the call's record.
  for (const task of call.call.activity()) if (task.agent && !task.to) stop(call.id, task.id)
  for (const pending of call.rings.splice(0)) ring(call, pending)
  const rest = call.call.handOff()
  call.record = { ...call.record, ended: new Date().toISOString(), end, reason }
  save(call)
  activity.changed()
  deliver(
    [`The call ended: ${ENDINGS[end]} (${reason}). Name it with title.`, ...(rest.length ? ['Last words:', transcript(rest)] : [])].join('\n'),
    { call: call.id, ended: end, reason, ...(call.record.callee && { callee: call.record.callee }) },
  )
  toHub(hub.renew)
  call.socket.onclose = null
  call.socket.close()
  if (call.closing && !call.closed && !call.speak) closeSession(call.id, call.closing)
}

function failed(record: Pick<CallRecord, 'from' | 'end' | 'reason'> & Partial<CallRecord>, to?: string) {
  const now = new Date().toISOString()
  const id = record.id ?? `failed-${Date.now().toString(36)}`
  calls.save({ id, started: now, turns: [], tasks: [], ...record, ended: now })
  const where = record.from === 'phone-out' ? `Your phone call to ${to ?? 'the caller'}` : `A call from ${record.from === 'phone-in' ? 'the caller\'s phone' : record.from === 'discord' ? 'a Discord voice channel' : `the ${record.from}`}`
  deliver(
    [`${where} didn't happen: ${ENDINGS[record.end!]} (${record.reason}).`, ...(record.why ? [`You were calling because: ${record.why}`] : [])].join('\n'),
    { call: id, ended: record.end!, reason: record.reason ?? '' },
  )
  trace(`${id} ${record.end}: ${record.reason}`)
}

function follow(
  socket: WebSocket,
  record: Live['record'],
  { call = new Call(), speak, heard, notes = [], hello, about }: { call?: Call; speak?: Live['speak']; heard?: Live['heard']; notes?: string[]; hello?: string; about?: Topic } = {},
) {
  if (live) {
    const by = live.closing
    close(live, 'close-you-moved')
    finish(live, by ? 'close_requested' : 'moved to a new call', live.closing ?? 'close-you-moved')
  }
  if (attaching) retire(attaching, 'close-you-moved')
  const current: Live = { id: record.id, shown: new Map(), socket, call, record, pending: new Map(), rings: [], changes: new Changes(), spoke: 0, speak, heard }
  live = current
  save(current)
  activity.changed()
  toHub(async () => {
    await hub.renewal()
    await hub.keep()
    current.record.claude = hub.session()
  })
  listen(current, socket)
  warn(current)
  deliver(
    hello ??
      [
        `A call started.${record.why ? ` You placed it because: ${record.why}` : ''}`,
        ...(about ? [about.claude] : []),
        'Send the voice what it should know right away, with note.',
      ].join('\n'),
    { call: record.id, started: 'true', from: record.from, ...(about && { task: about.id }) },
  )
  for (const text of notes.splice(0)) void tell(current, 'note', text).catch(() => {})
  return current
}

// What a call is about when the app starts it on something: what Claude hears, and what the voice
// is told to do first.
type Topic = { id: string; claude: string; voice: string }

function runTopic(run: Run): Topic {
  return {
    id: run.id,
    claude: `The caller started it with Talk it through on a task. ${opener(run)}`,
    voice: `The caller tapped Talk it through on a task, so bring it up now in a sentence or two, then listen. ${opener(run)}`,
  }
}

// Go through them with hex: Claude walks the caller's questions in the app's order, one card at a time.
// What the voice should know about an ask left half done: only one choice, or an undo in the app, finishes it.
function half({ partly, undoing }: Question) {
  if (undoing) return ' [taking back its answer stopped partway: only Undo in the app finishes it]'
  return partly ? ` ["${partly}" already went out to part of it: only "${partly}" finishes it, or Undo in the app]` : ''
}

function walkTopic(questions: Question[]): Topic {
  const list = questions.map(
    (question, i) =>
      `${i + 1}. ${question.id} · ${question.topic} · ${question.question}${question.context ? ` (${clip(question.context.replace(/\s+/g, ' ').trim(), 280)})` : ''} Options: ${question.options.map(option => `${option.label}${option.pick ? ' (hex’s pick)' : ''}`).join(' / ')}${question.tag ? ` [${question.tag}]` : ''}${half(question)}`,
  )
  return {
    id: 'asks',
    claude: [
      `The caller tapped Go through them with hex: walk them through the ${questions.length} things waiting on them, one at a time, in this order. For each, put it on screen with ask, say it in a sentence or two with hex's pick if it has one, and listen. When they say a choice, answer sends it to the thread that asked; when they tap the card instead, a message tells you. Move on when they skip one. Say so when a choice costs money or goes out in their name.`,
      ...list,
    ].join('\n'),
    voice: `The caller wants to go through what's waiting on them, one at a time. Generate <|SpawnThinking|> now, then say you'll start with the first one: the backend brings each one up.`,
  }
}

function talkAbout(topic: Topic) {
  if (!live) return new Response('No call is live', { status: 409 })
  deliver(`The caller asked for this from the app during the call. ${topic.claude}`, { call: live.id, task: topic.id })
  void send(live, 'session.instructions.append', topic.voice).catch(() => {})
  return new Response(null, { status: 204 })
}

// Puts a question on the caller's screen as a card in the transcript.
function show(call: Live, id: string) {
  const question = yours.find(id)
  if (!question) throw new Error(`no open ask ${id}`)
  call.shown.set(id, question)
  remember(call, 'ask', question.question, { ask: id })
  activity.changed()
  return `showing "${question.question}" to the caller`
}

// How many copies or threads an answer couldn't reach, for whoever is told it went.
function missed({ missed }: Sent) {
  return missed ? `, but ${missed} of its copies or threads couldn't be reached` : ''
}

// A question answered on a call, said aloud (via call) or tapped on its card (via app).
async function answerQuestion(id: string, label: string, via: string) {
  const call = live
  const question = yours.find(id) ?? call?.shown.get(id)
  const sent = await yours.answer(id, label, via)
  if (call && live === call && question) {
    call.shown.set(id, question)
    remember(call, 'answered', label, { ask: id, sent })
    activity.changed()
  }
  return sent
}

function listen(call: Live, socket: WebSocket, attempt = 0) {
  const opened = Date.now()
  const hungUp = () => {
    if (call.closing && !call.closed && live === call) sendClose(call)
  }
  if (socket.readyState === WebSocket.OPEN) hungUp()
  else socket.addEventListener('open', hungUp, { once: true })
  socket.onmessage = ({ data }) => {
    const event = JSON.parse(String(data))
    switch (event.type) {
      case 'session.input_transcript.delta':
        return hear(call, 'you', event)
      case 'session.output_transcript.delta':
        call.spoke = Date.now()
        return hear(call, 'voice', event)
      case 'session.delegation.created': {
        if (event.delegation?.target !== 'client') return
        const pending = { delegation: event.delegation.id, offset: event.offset_ms }
        call.rings.push(pending)
        // Words after the handoff are what send it, so the request is all there; when none come,
        // as when the voice says nothing and the caller waits, it goes anyway after a moment.
        setTimeout(() => {
          const i = live === call ? call.rings.indexOf(pending) : -1
          for (const due of i < 0 ? [] : call.rings.splice(0, i + 1)) ring(call, due)
        }, HANDOFF_WAIT)
        return
      }
      case 'session.commentary.appended':
      case 'session.thinking.appended':
      case 'session.instructions.appended':
        call.pending.get(event.client_event_id)?.resolve()
        return call.pending.delete(event.client_event_id)
      case 'error': {
        const id = event.client_event_id ?? event.error?.client_event_id ?? event.error?.event_id
        const failed = call.pending.get(id)
        call.pending.delete(id)
        if (failed) return failed.reject(new Error(event.error?.message ?? JSON.stringify(event)))
        return trace(JSON.stringify(event))
      }
      case 'session.output_audio.delta':
        call.spoke = Date.now()
        return call.speak?.(event.delta)
      case 'session.usage.updated':
        call.record.usage = usage(event.usage.seconds, event.context_window?.usage_ratio ?? call.record.usage?.context)
        return
      case 'session.closed':
        if (event.usage) call.record.usage = usage(event.usage.seconds, call.record.usage?.context)
        return finish(call, event.reason ?? 'closed', (event.reason === 'close_requested' && call.closing) || event.client_event_id)
    }
  }
  socket.onclose = () => reconnect(call, Date.now() - opened < 5000 ? attempt + 1 : 0)
}

function reconnect(call: Live, attempt: number) {
  if (live !== call) return
  for (const pending of call.pending.values()) pending.reject(new Error('the connection to the voice dropped and is coming back; try again in a few seconds'))
  call.pending.clear()
  // A close sent on the dropped connection may never have reached the session, so it goes out again.
  delete call.closed
  if (call.speak || attempt >= RETRIES.length) {
    const lost = !call.closing && !call.speak
    finish(call, call.closing ? 'close_requested' : 'connection_lost', call.closing)
    // The app's audio goes straight to the voice, so a call let go here would go on with nothing
    // behind the voice: it's closed too, if a last connection gets through.
    if (lost) closeSession(call.id, `close_hex_${++seq}`)
    return
  }
  trace(`lost the connection to ${call.id}, reattaching (try ${attempt + 1})`)
  setTimeout(() => {
    if (live !== call) return
    const socket = sideband(call.id)
    socket.onopen = () => {
      if (live !== call) {
        if (call.closing && !call.closed) sendClose(call, call.closing, socket)
        return socket.close()
      }
      trace(`reattached to ${call.id}`)
      call.socket = socket
      listen(call, socket, attempt)
    }
    socket.onclose = () => reconnect(call, attempt + 1)
  }, RETRIES[attempt])
}

function warn(call: Live) {
  const left = call.record.expires ? Date.parse(call.record.expires) - Date.now() : NaN
  if (!(left > WARN_BEFORE)) return
  call.warning = setTimeout(() => {
    if (live !== call) return
    const at = new Date(Date.parse(call.record.expires!)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    remember(call, 'warned', `Two minutes left: the call ends at ${at}`)
    void send(call, 'session.instructions.append', 'This call hits its time limit in about two minutes. Tell the caller now, in a sentence, so they can wrap up or call back.').catch(() => {})
    deliver(`This call hits its time limit at ${at}, about two minutes from now. Wrap up anything the caller needs before it ends.`, { call: call.id, expires: call.record.expires! })
  }, left - WARN_BEFORE)
}

function sideband(id: string) {
  return new WebSocket(`${API}/${id}/attach`, { headers: { Authorization: `Bearer ${KEY}` } } as any)
}

function expiry(seconds?: number) {
  return seconds ? new Date(seconds * 1000).toISOString() : undefined
}

function base(id: string, from: Source, extra: Partial<CallRecord> = {}): Live['record'] {
  return { id, started: new Date().toISOString(), from, ...extra }
}

function recover() {
  const open = calls.list().filter(call => !call.ended)
  for (const [i, { id }] of open.entries()) {
    const record = calls.get(id)
    if (!record) continue
    const latest = i === 0 && KEY && (record.from === 'app' || record.from === 'web') && !(record.expires && Date.parse(record.expires) < Date.now())
    if (latest) reattach(record)
    else closeOut(record)
  }
}

// A call lost with the engine ends like any other: Claude names it, and the session renews.
// by: the hang-up that ended it while the engine was attaching back to it, at that moment.
function closeOut(record: CallRecord, by?: string) {
  const heard = Math.max(0, ...record.turns.map(turn => turn.at), ...record.tasks.map(task => task.at), ...(record.moments ?? []).map(mark => mark.at))
  const reason = by === 'close-you-moved' ? 'moved to a new call' : by ? 'close_requested' : "hex's service restarted and the call was gone"
  const end = ending(reason, by)
  calls.save({ ...record, ended: by ? new Date().toISOString() : new Date(Date.parse(record.started) + heard).toISOString(), end, reason })
  trace(`closed out ${record.id}: ${by ? 'hung up while it was picked back up' : 'it never got an end'}`)
  deliver(`The call ended: ${ENDINGS[end]} (${reason}). Name it with title.`, { call: record.id, ended: end, reason })
  if (!live) {
    if (by) ended = record.id
    toHub(hub.renew)
  }
}

// A call hung up or replaced while recover() attaches back to it ends then; its close goes out on the
// attach once it opens, or on a connection opened for it if the attach fails.
function retire(pending: Attaching, event: string) {
  attaching = undefined
  pending.closing = event
  const record = calls.get(pending.id)
  if (record) closeOut(record, event)
  else if (!live) toHub(hub.renew)
}

// Tasks the call sent out can end while the connection comes back, so the record is read again then;
// a call deleted, replaced by a new one or hung up meanwhile is let go.
function reattach({ id }: CallRecord) {
  const socket = sideband(id)
  const pending: Attaching = { id }
  attaching = pending
  socket.onopen = () => {
    if (attaching === pending) attaching = undefined
    const record = pending.closing ? undefined : calls.get(id)
    if (!record || live) {
      socket.send(JSON.stringify({ type: 'session.close', event_id: pending.closing ?? `close_hex_${++seq}` }))
      socket.onclose = null
      socket.close()
      if (record) closeOut(record)
      else if (!live && !pending.closing) toHub(hub.renew)
      return
    }
    const { turns, tasks, moments, ...rest } = record
    const so = turns.slice(-40).map(({ who, at, text }) => ({ who, text, start: at }))
    trace(`picked ${record.id} back up after a restart`)
    follow(socket, rest, {
      call: Call.resume(record),
      hello: [
        `A call resumed: hex's service restarted during call ${record.id} and picked it back up. The caller is still on it, and the voice kept its own memory of the call.`,
        ...(record.why ? [`You placed it because: ${record.why}`] : []),
        ...(so.length ? ['The call so far:', transcript(so)] : []),
        ...(tasks.length ? [Call.resume(record).board()] : []),
      ].join('\n'),
    })
  }
  socket.onclose = () => {
    if (attaching === pending) attaching = undefined
    if (pending.closing) return closeSession(id, pending.closing)
    if (live?.id === id) return
    const record = calls.get(id)
    if (record) closeOut(record)
    else if (!live) toHub(hub.renew)
  }
}

async function dial({ to = CALLER_NUMBER, why, move = false }: { to?: string; why?: string; move?: boolean } = {}) {
  if (!KEY || !TWILIO_SID || !TWILIO_TOKEN || !TWILIO_NUMBER || !PUBLIC_HOST)
    throw new Error(`phone calls need TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER and VOICE_PUBLIC_URL in ${join(STATE_DIR, '.env')}`)
  if (!to) throw new Error('no number to call: pass to, or set CALLER_NUMBER')
  if (move && to !== CALLER_NUMBER) throw new Error("a call moves only to the caller's own phone: leave out to")
  // On a call hex placed to someone else, what was meant for the owner isn't theirs to hear.
  if (live?.record.callee)
    throw new Error(move ? `hex is on a call to ${live.record.callee}; move once it ends` : `a call to ${live.record.callee} is live, and another would end it: ring again once it ends, which a message tells you`)
  if ((live || attaching) && !move) throw new Error('a call is live, and another would end it: tell the caller on this one with say or note')
  const token = crypto.randomUUID()
  const greeting = why
    ? `You placed this phone call because: ${why}. Greet them briefly and tell them why you're calling, then listen.`
    : 'You placed this phone call. Greet them briefly first, then listen.'
  // On a call hex placed to someone else, "you" in the transcript is them, not the owner.
  dials.set(token, { greeting, from: 'phone-out', token, why, move, ...(to !== CALLER_NUMBER && { callee: to }) })
  placed.set(token, { to, why, started: new Date().toISOString(), notes: [] })
  setTimeout(() => placed.get(token)?.session || placed.delete(token), 300_000)
  const response = await fetch(`${TWILIO_API}/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`)}` },
    body: new URLSearchParams({
      To: to,
      From: TWILIO_NUMBER,
      Url: `https://${PUBLIC_HOST}/twilio/${token}/twiml`,
      StatusCallback: `https://${PUBLIC_HOST}/twilio/status/${token}`,
    }),
  })
  if (!response.ok) {
    dials.delete(token)
    placed.delete(token)
    const reason = `Twilio refused the call: ${problem(await response.text())}`
    failed({ from: 'phone-out', end: 'no-connect', reason, why }, to)
    throw new Error(reason)
  }
  return `ringing ${to}; if nobody answers or it fails, a message tells you`
}

async function phoneStatus(request: Request, token: string) {
  const form = await signed(request)
  if (!form) return new Response('forbidden', { status: 403 })
  const call = placed.get(token)
  const state = String(form.get('CallStatus'))
  trace(`Twilio call ${state}${call?.session ? ` (${call.session})` : ''}`)
  if (!call || !['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(state)) return new Response(null, { status: 204 })
  placed.delete(token)
  dials.delete(token)
  if (call.session) return new Response(null, { status: 204 })
  const error = form.get('ErrorCode') ? `, Twilio error ${form.get('ErrorCode')}` : ''
  failed(
    {
      id: String(form.get('CallSid') ?? '') || undefined,
      from: 'phone-out',
      started: call.started,
      why: call.why,
      end: state === 'busy' ? 'busy' : state === 'no-answer' ? 'no-answer' : 'no-connect',
      reason: state === 'completed' ? `the phone picked up for ${form.get('CallDuration') ?? 0}s but the voice never joined${error}` : `Twilio: ${state}${error}`,
    },
    call.to,
  )
  return new Response(null, { status: 204 })
}

// A call whose audio the engine passes through one WebSocket session: a phone call, as μ-law at
// 8 kHz, or a line another client holds, as PCM at 24 kHz. A session that never starts is refused once.
type Passed = {
  name: string
  from: Source
  callee?: string
  move?: boolean
  greeting: string
  why?: string
  format: { type: string; rate: number }
  play: (audio: string) => void
  heard?: Live['heard']
  notes?: string[]
  started: (session: string) => void
  refused: (reason: string) => void
  closed: () => void
}

function passThrough({ name, from, callee, move, greeting, why, format, play, heard, notes, started, refused, closed }: Passed) {
  const openai = new WebSocket(API, { headers: { Authorization: `Bearer ${KEY}` } } as any)
  let up = false
  let refusing = false
  const refuse = (reason: string) => {
    if (up || refusing) return
    refusing = true
    refused(reason)
  }
  openai.onopen = () =>
    openai.send(JSON.stringify({
      type: 'session.start',
      session: session({ audio: { format, ...(VOICE ? { output: { voice: VOICE } } : {}) } }, greeting),
    }))
  openai.addEventListener('message', ({ data }) => {
    const event = JSON.parse(String(data))
    if (event.type === 'error') refuse(`OpenAI refused the ${name} session: ${event.error?.message ?? JSON.stringify(event.error)}`)
    // A session that starts once its caller has already hung up is let go, never taken as live.
    if (event.type !== 'session.started' || openai.readyState !== WebSocket.OPEN) return
    // A call hex placed that picks up once another is live, as a voicemail can, never takes its place;
    // a move takes the caller's own call, never one hex placed to someone else.
    if (from === 'phone-out' && (live?.record.callee || ((live || attaching) && !move))) return refuse('it picked up while another call was live, so it was let go')
    up = true
    started(event.session.id)
    follow(openai, base(event.session.id, from, { voice: VOICE, why, callee, expires: expiry(event.session.expires_at) }), { speak: play, heard, notes })
  })
  openai.addEventListener('close', ({ code, reason }) => {
    trace(`OpenAI closed the ${name} session (${code} ${reason})`)
    refuse(`OpenAI closed the ${name} session before it started (${code} ${reason || 'no reason'})`)
    closed()
  })
  return openai
}

function answer(twilio: Bun.ServerWebSocket<Phone>) {
  twilio.data.openai = passThrough({
    name: 'phone',
    from: twilio.data.from,
    callee: twilio.data.callee,
    move: twilio.data.move,
    greeting: twilio.data.greeting,
    why: twilio.data.why,
    format: { type: 'audio/pcmu', rate: 8000 },
    notes: placed.get(twilio.data.token)?.notes,
    // Twilio plays what it's sent as it comes, faster than it's said, and echoes each mark once the
    // audio before it has played or been cleared.
    play: audio => {
      twilio.send(JSON.stringify({ event: 'media', streamSid: twilio.data.stream, media: { payload: audio } }))
      twilio.send(JSON.stringify({ event: 'mark', streamSid: twilio.data.stream, mark: { name: 'voice' } }))
      twilio.data.unheard++
    },
    // Words the caller began before the voice did are what it's answering, however late their
    // transcript comes in; words begun after it are the caller talking over it.
    heard: (who, start, text) => {
      const phone = twilio.data
      if (!phone.unheard) return
      if (who === 'voice') phone.since ??= start
      else if (phone.since !== undefined && start >= phone.since && !backchannel(text)) {
        twilio.send(JSON.stringify({ event: 'clear', streamSid: phone.stream }))
        phone.since = undefined
      }
    },
    started: session => {
      twilio.data.started = true
      const call = placed.get(twilio.data.token)
      if (call) call.session = session
    },
    refused: reason => refuse(twilio, reason),
    closed: () => twilio.close(),
  })
}

// A call on a line another client holds, like a Discord voice channel: it hands the engine the
// caller's audio and plays the voice's, both base64 PCM at 24 kHz, mono, and the engine holds the
// call as it does a phone call. The line ends when the call does, and a session refused or hung up
// on before it started never becomes a call.
export function take(from: Source, greeting: string, line: VoiceLine): Held {
  if (!KEY) throw new Error(`calls need OPENAI_API_KEY in ${join(STATE_DIR, '.env')}`)
  let up = false
  let gone = false
  const openai: WebSocket = passThrough({
    name: from,
    from,
    greeting,
    format: { type: 'audio/pcm', rate: 24000 },
    play: line.play,
    started: () => (up = true),
    refused: reason => {
      if (!gone) failed({ from, end: 'no-connect', reason })
      gone = true
      openai.close()
      line.end()
    },
    closed: line.end,
  })
  return {
    hear: audio => void (up && openai.send(JSON.stringify({ type: 'session.input_audio.append', audio }))),
    hangUp: () => {
      if (!up) {
        gone = true
        return openai.close()
      }
      closeSocket(openai, `close-you-${from}`)
    },
  }
}

// The caller's "mm-hmm" or "yeah" while the voice talks, or a fragment with no words, is them
// listening, not talking over it: the voice goes on, so what Twilio holds is what they'd miss.
const LISTENING = new Set(['mm', 'mmm', 'hm', 'hmm', 'mhm', 'mmhm', 'mmhmm', 'mm-hmm', 'mm-hm', 'uh-huh', 'uhhuh', 'uh', 'um', 'ah', 'oh', 'yeah', 'yep', 'yup', 'yes', 'ok', 'okay', 'right', 'sure'])

function backchannel(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .split(/\s+/)
    .filter(word => word.replace(/-/g, ''))
    .every(word => LISTENING.has(word))
}

function refuse(twilio: Bun.ServerWebSocket<Phone>, reason: string) {
  if (twilio.data.refused) return
  twilio.data.refused = true
  const call = placed.get(twilio.data.token)
  placed.delete(twilio.data.token)
  failed({ from: twilio.data.from, end: 'no-connect', reason, why: twilio.data.why, ...(call ? { started: call.started } : {}) }, call?.to)
  twilio.close()
}

function problem(text: string) {
  try {
    const { error, message } = JSON.parse(text)
    return String(error?.message ?? message ?? text).slice(0, 300)
  } catch {
    return text.slice(0, 300)
  }
}

function trace(line: string) {
  process.stderr.write(`voice: ${line}\n`)
}

function twiml(body: string) {
  return new Response(`<Response>${body}</Response>`, { headers: { 'content-type': 'text/xml' } })
}

function stream(token: string) {
  return twiml(`<Connect><Stream url="wss://${PUBLIC_HOST}/twilio/${token}" /></Connect>`)
}

async function signed(request: Request) {
  const form = await request.formData()
  const params = [...form.keys()].sort().map(key => key + form.get(key)).join('')
  const signature = createHmac('sha1', TWILIO_TOKEN ?? '').update(`https://${PUBLIC_HOST}${new URL(request.url).pathname}${params}`).digest('base64')
  return TWILIO_TOKEN && same(request.headers.get('x-twilio-signature') ?? '', signature) ? form : undefined
}

async function pickUp(request: Request) {
  const form = await signed(request)
  if (!form || form.get('From') !== CALLER_NUMBER) return twiml('<Reject />')
  const token = crypto.randomUUID()
  dials.set(token, { greeting: 'They called you. Answer briefly, then listen.', from: 'phone-in', token })
  return stream(token)
}

function hearPhone(twilio: Bun.ServerWebSocket<Phone>, raw: string | Buffer) {
  const message = JSON.parse(String(raw))
  if (message.event === 'start') twilio.data.stream = message.start.streamSid
  if (message.event === 'start' || message.event === 'stop') trace(`Twilio stream ${message.event}`)
  if (message.event === 'mark') {
    twilio.data.unheard = Math.max(0, twilio.data.unheard - 1)
    if (!twilio.data.unheard) delete twilio.data.since
  }
  if (message.event === 'media' && twilio.data.started)
    twilio.data.openai?.send(JSON.stringify({ type: 'session.input_audio.append', audio: message.media.payload }))
  if (message.event === 'stop') hangUp(twilio)
}

// A caller who hangs up before the voice session starts takes the session down with them: it's
// closed, not left to start into a call nobody is on, and isn't counted as OpenAI refusing it.
function hangUp(twilio: Bun.ServerWebSocket<Phone>) {
  const openai = twilio.data.openai
  if (!openai) return
  if (twilio.data.started) return closeSocket(openai, 'close-you-phone')
  twilio.data.refused = true
  openai.close()
}

// A phone or Discord caller hangs up on the session socket itself: through the call once it's live,
// so the call keeps one close.
function closeSocket(openai: WebSocket, event: string) {
  if (live?.socket === openai) close(live, event)
  else if (openai.readyState === WebSocket.OPEN) openai.send(JSON.stringify({ type: 'session.close', event_id: event }))
}

function session(extra: object = {}, opening?: string) {
  return {
    model: MODEL,
    instructions: `${VOICE_PROMPT}\n\nThe call started ${clock()}, the caller's local time.`,
    delegation: { type: 'client' },
    ...(opening && { input: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: opening }] }] }),
    ...extra,
  }
}

async function start(request: Request) {
  if (!KEY) return new Response(`Set OPENAI_API_KEY in ${join(STATE_DIR, '.env')}`, { status: 503 })
  const { sdp, voice = VOICE, from: origin, about } = (await request.json()) as { sdp?: string; voice?: string; from?: string; about?: string }
  if (!sdp) return new Response('An SDP offer is required', { status: 400 })
  const from = origin === 'app' ? 'app' : 'web'
  const topic = topicOf(about)
  let response: Response
  try {
    response = await fetch(API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: session({
          ...(voice ? { audio: { output: { voice } } } : {}),
          client: { data_channel: { allowed_client_events: ['session.input_audio.mute', 'session.input_audio.unmute', 'session.close'] } },
        }, topic?.voice),
        transport: { type: 'webrtc', sdp },
      }),
    })
  } catch (error) {
    const reason = `couldn't reach OpenAI: ${error instanceof Error ? error.message : error}`
    failed({ from, end: 'no-connect', reason, voice })
    return new Response(reason, { status: 502 })
  }
  if (!response.ok) {
    const text = await response.text()
    failed({ from, end: 'no-connect', reason: `OpenAI refused the call (${response.status}): ${problem(text)}`, voice })
    return new Response(text, { status: response.status })
  }
  const result = (await response.json()) as { session: { id: string; expires_at?: number } }
  follow(sideband(result.session.id), base(result.session.id, from, { voice, expires: expiry(result.session.expires_at) }), { about: topic })
  return Response.json(result, { status: 201 })
}

const PAUSED = "The caller's phone took over their audio, a phone call or Siri: they can't hear you or talk. Stay quiet until they're back."
const RESUMED = "The caller is back. If you were in the middle of something, pick it back up in a sentence."

async function interruption(request: Request, id: string) {
  const { kind, text } = (await request.json().catch(() => ({}))) as { kind?: string; text?: string }
  if (kind !== 'paused' && kind !== 'resumed') return new Response('kind is paused or resumed', { status: 400 })
  if (live?.id !== id) return new Response('That call is not live', { status: 409 })
  remember(live, kind, text || (kind === 'paused' ? 'Your phone took over the audio' : 'Back on the call'))
  void send(live, 'session.instructions.append', kind === 'paused' ? PAUSED : RESUMED).catch(() => {})
  return new Response(null, { status: 204 })
}

// The app ends the call it started, by its id; one that already ended has nothing left to end.
async function endSession(request: Request) {
  const { sessionId } = ((await request.json().catch(() => null)) ?? {}) as { sessionId?: unknown }
  if (typeof sessionId !== 'string') return new Response('Name the call to end with sessionId', { status: 400 })
  if (live?.id === sessionId) close(live, 'close-you-app')
  else if (attaching?.id === sessionId) retire(attaching, 'close-you-app')
  return new Response(null, { status: 204 })
}

function same(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function allowed(request: Request) {
  return !TOKEN || same(request.headers.get('authorization') ?? '', `Bearer ${TOKEN}`)
}

// A page on another site, open in the owner's browser, can post here, or point its own name at this
// machine to read and post here as if it were this page, which would hand it the token too.
function foreign(request: Request) {
  const url = new URL(request.url)
  const origin = request.headers.get('origin')
  return !ours(url.hostname) || (request.method !== 'GET' && origin !== null && URL.parse(origin)?.host !== url.host)
}

// Names a site can't point here: IPs, short names, localhost, tailnet names, and the public one.
function ours(host: string) {
  return isIP(host.replace(/^\[|\]$/g, '')) > 0 || /^[^.]+$|(^|\.)localhost$|\.ts\.net$/.test(host) || host === PUBLIC_HOSTNAME
}

function home(request: Request) {
  const local = !request.headers.get('x-forwarded-for')
  return new Response(String(page).replace('__VOICE_TOKEN__', local && TOKEN ? TOKEN : ''), { headers: { 'content-type': 'text/html; charset=utf-8' } })
}

async function showActivity(url: URL) {
  const after = url.searchParams.get('after')
  if (after) await activity.changes(Number(after), 25_000)
  return Response.json({ version: activity.version, call: live?.id ?? null, tasks: live ? [...live.call.activity(), ...elsewhere(live)] : [], asks: live ? cards(live) : [] })
}

// Everything else hex is working on, from the board: every thread and background session at work
// that the call isn't already following, so a call shows all of it and not only what it sent.
function elsewhere(call: Live): (Task & { line?: string })[] {
  const following = new Set(call.call.activity().flatMap(task => (task.state === 'running' && task.agent ? [task.agent] : [])))
  return board.runs
    .filter(row => row.state === 'working' && row.app !== 'voice' && !following.has(`${row.app}:${row.thread}`))
    .map(row => ({ id: row.id, state: 'running', text: row.name, to: row.name, line: newest(row) }))
}

// The questions put on screen in this call, in order, each with the answer given after it was shown,
// until an undo takes that back.
function cards(call: Live) {
  const marks = call.call.record().moments
  return marks
    .filter(mark => mark.kind === 'ask' && call.shown.has(mark.ask!))
    .map((mark, i, shown) => {
      const next = shown.slice(i + 1).find(later => later.ask === mark.ask)?.at ?? Infinity
      const answered = marks.findLast(answer => answer.kind === 'answered' && answer.ask === mark.ask && answer.at >= mark.at && answer.at < next)
      const undone = marks.findLast(undo => undo.kind === 'undone' && undo.ask === mark.ask)?.at ?? -1
      return { at: mark.at, ask: call.shown.get(mark.ask!)!, ...(answered && answered.at > undone && { answer: answered.text, sent: answered.sent }) }
    })
}

function topicOf(about?: string): Topic | undefined {
  if (about === 'asks') return walkTopic(yours.view.asks)
  const run = about ? board.get(about) : undefined
  return run && runTopic(run)
}


async function showRuns(url: URL, runs: Board) {
  const after = url.searchParams.get('after')
  if (after) await runs.changes(Number(after), 25_000)
  return Response.json({ version: runs.version, tasks: runs.rows() })
}

// The Tasks button's counts: threads that need you and are working, and how many things are yours,
// as many as Tasks lists under Needs you: every question, everything stuck, and every thread that needs
// you without a question.
async function showSummary(url: URL, runs: Board, questions: Questions) {
  const version = () => runs.counts.version + questions.counts.version
  const after = Number(url.searchParams.get('after'))
  if (after === version()) await Promise.race([runs.counts.changes(runs.counts.version, 25_000), questions.counts.changes(questions.counts.version, 25_000)])
  const asked = new Set(questions.view.asks.map(question => question.task))
  const unasked = runs.rows().filter(row => row.state === 'needs' && !asked.has(row.id)).length
  return Response.json({ version: version(), ...runs.summary, yours: questions.view.asks.length + questions.view.stuck.length + unasked })
}

async function showQuestions(url: URL, questions: Questions) {
  const after = url.searchParams.get('after')
  if (after) await questions.changes(Number(after), 25_000)
  return Response.json({ version: questions.version, ...questions.view })
}

// What the app's tap on a question, a stuck item or a new result does. Each answers once the hub has it;
// the change itself comes back through the list.
async function questionRoutes(request: Request, url: URL) {
  const questions = yours
  if (url.pathname === '/asks' && request.method === 'GET') {
    if (!url.searchParams.get('after')) questions.opened()
    return showQuestions(url, questions)
  }
  if (url.pathname === '/asks/check' && request.method === 'GET') return questions.lastCheck ? Response.json(questions.lastCheck) : new Response('No check yet', { status: 404 })
  const [, asked] = url.pathname.match(/^\/asks\/([^/]+)\/words$/) ?? []
  if (asked && request.method === 'GET') {
    const words = questions.words(decodeURIComponent(asked))
    return words ? Response.json(words) : new Response('Nothing to show', { status: 404 })
  }
  if (url.pathname === '/asks/talk' && request.method === 'POST') return talkAbout(walkTopic(questions.view.asks))
  const [, kind, id, verb] = url.pathname.match(/^\/(asks|stuck|fresh)\/([^/]+)\/(answer|note|dismiss|undo|act|read)$/) ?? []
  if (!kind || request.method !== 'POST') return new Response('404', { status: 404 })
  try {
    const key = decodeURIComponent(id!)
    // The call the card is on, if it still is once the verb has gone out; heard: the call that had
    // its answer, from the card or the list.
    const shown = live?.shown.has(key) && live.call.record().moments.some(mark => mark.kind === 'ask' && mark.ask === key) ? live : undefined
    const heard = live?.call.record().moments.some(mark => mark.kind === 'answered' && mark.ask === key) ? live : undefined
    const onCall = (call = shown) => (call && live === call ? call : undefined)
    if (kind === 'asks' && verb === 'answer') {
      const label = ((await request.json().catch(() => null)) as { label?: unknown } | null)?.label
      if (typeof label !== 'string' || !label) return new Response('An answer needs its label', { status: 400 })
      const sent = await answerQuestion(key, label, 'app')
      const call = onCall()
      if (call) deliver(`The caller tapped "${label}" on the card for ${key}; it's sent to its thread${missed(sent)}.`, { call: call.id })
      return Response.json(sent)
    }
    if (kind === 'asks' && verb === 'note') {
      const raw = ((await request.json().catch(() => null)) as { text?: unknown } | null)?.text
      const text = typeof raw === 'string' ? raw.trim() : ''
      if (!text) return new Response('A note needs its text', { status: 400 })
      const sent = await questions.note(key, text, 'app')
      const call = onCall()
      if (call) deliver(`The caller wrote a note on the card for ${key}: "${text}". It's sent to its thread, and the question stays open.`, { call: call.id })
      return Response.json(sent)
    }
    if (kind === 'asks' && verb === 'dismiss') {
      const question = questions.find(key)
      const sent = await questions.dismiss(key, 'app')
      const call = onCall()
      if (call) {
        call.shown.set(key, question!)
        remember(call, 'answered', 'Not needed', { ask: key, sent })
        activity.changed()
        deliver(`The caller marked the card for ${key} not needed; its threads are told${missed(sent)}.`, { call: call.id })
      }
      return Response.json(sent)
    }
    if (kind === 'asks' && verb === 'undo') {
      try {
        await questions.undo(key, 'app')
      } finally {
        const call = !questions.answered(key) && onCall(heard)
        if (call) {
          remember(call, 'undone', 'Taken back', { ask: key })
          activity.changed()
        }
      }
      const card = onCall()
      if (card) deliver(`The caller took back what they gave on the card for ${key}; it's open again.`, { call: card.id })
    } else if (kind === 'stuck' && verb === 'act') await questions.act(key)
    else if (kind === 'fresh' && verb === 'read') questions.read(key)
    else return new Response('404', { status: 404 })
  } catch (error) {
    return new Response(error instanceof Error ? error.message : String(error), { status: 409 })
  }
  return new Response(null, { status: 204 })
}

function runRoutes(request: Request, url: URL) {
  const runs = board
  if (url.pathname === '/tasks' && request.method === 'GET') return showRuns(url, runs)
  if (url.pathname === '/tasks/summary' && request.method === 'GET') return showSummary(url, runs, yours)
  const [, id, verb] = url.pathname.match(/^\/tasks\/([^/]+)(?:\/(talk|chat|stop))?$/) ?? []
  const key = id && decodeURIComponent(id)
  // A thread off the board is a page to read: its run, asks, pin and chat, and nothing to act on.
  const page = key && request.method === 'GET' && runs.find(key)
  if (page && verb === 'chat') return showChat(url, page, !runs.get(key))
  if (page && !verb) return Response.json({ ...page, ...yours.of(page.id) })
  const run = key && runs.get(key)
  if (!run) return new Response('404', { status: 404 })
  if (verb === 'talk' && request.method === 'POST') return talkAbout(runTopic(run))
  if (verb === 'chat' && request.method === 'POST') return sendChat(request, run)
  if (verb === 'stop' && request.method === 'POST') return done(() => chats.stop(run))
}

// A thread's chat, and with after, the next time it changes. A page's is there to read, so it
// never offers to send.
async function showChat(url: URL, run: Run | Page, page = false) {
  const where = () => ({ ...run, session: board.session(run.id) })
  const after = url.searchParams.get('after')
  const chat = after ? await chats.next(where, Number(after), 25_000) : chats.of(where())
  return Response.json(page ? { ...chat, sends: false } : chat)
}

async function sendChat(request: Request, run: Run) {
  const { text, key } = ((await request.json().catch(() => null)) ?? {}) as { text?: unknown; key?: unknown }
  if (typeof text !== 'string' || !text.trim()) return new Response('Send some words', { status: 400 })
  if (typeof key !== 'string' || !/^app-[\w-]{8,60}$/.test(key)) return new Response('Name the message with a key starting app-', { status: 400 })
  return done(() => chats.send(run, text.trim(), key))
}

// No content once act is through, or why it couldn't be.
function done(act: () => void) {
  try {
    act()
    return new Response(null, { status: 204 })
  } catch (error) {
    return new Response((error as Error).message, { status: 409 })
  }
}

// A live call's record is read from the call itself, so it has every word heard so far, and a
// request with after waits until the next word or change; an ended call's comes from disk.
async function showCall(id: string, url: URL) {
  const after = url.searchParams.get('after')
  if (after && live?.id === id) await live.changes.changes(Number(after), 25_000)
  if (live?.id === id) return Response.json({ ...whole(live), version: live.changes.version })
  const record = calls.get(id)
  return record ? Response.json(record) : new Response('404', { status: 404 })
}

async function listCalls(url: URL) {
  const after = url.searchParams.get('after')
  if (after) await calls.changes(Number(after), 25_000)
  return Response.json({ version: calls.version, live: live?.id, calls: calls.list() })
}

function routes(request: Request) {
  const { pathname } = new URL(request.url)
  if (pathname === '/session' && request.method === 'POST') return start(request)
  if (pathname === '/session' && request.method === 'DELETE') return endSession(request)
  if (pathname === '/calls' && request.method === 'GET') return listCalls(new URL(request.url))
  if (pathname === '/activity' && request.method === 'GET') return showActivity(new URL(request.url))
  if (pathname === '/tasks' || pathname.startsWith('/tasks/')) return runRoutes(request, new URL(request.url))
  if (/^\/(asks|stuck|fresh)(\/|$)/.test(pathname)) return questionRoutes(request, new URL(request.url))
  const [, callId, moments] = pathname.match(/^\/calls\/([\w-]+)(\/moments)?$/) ?? []
  if (callId && moments && request.method === 'POST') return interruption(request, callId)
  if (callId && !moments && request.method === 'GET') return showCall(callId, new URL(request.url))
  if (callId && !moments && request.method === 'DELETE') {
    if (live?.id === callId) return new Response('That call is still going', { status: 409 })
    return new Response(null, { status: calls.delete(callId) ? 204 : 404 })
  }
  if (pathname === '/phone' && request.method === 'POST')
    return dial({ move: true }).then(text => new Response(text), error => new Response(error.message, { status: 502 }))
}

// The call engine: it holds the voice page, the app's routes and the phone line on the voice port,
// for as long as hex's service runs, and hands what the caller asks to the voice session.
export function serve(voiceHub: Hub, state: string) {
  hub = voiceHub
  HEX_STATE = state
  board = new Board(state, dirname(state))
  chats = new Chats(state)
  board.listen(() => {
    activity.changed()
    chats.changed()
  })
  yours = new Questions(state)
  recover()
  resume()
  return Bun.serve<Phone>({
    port: PORT,
    hostname: '127.0.0.1',
    idleTimeout: 40,
    fetch(request, server) {
      const { pathname } = new URL(request.url)
      if (pathname === '/twilio/incoming' && request.method === 'POST') return pickUp(request)
      const [, statusToken] = pathname.match(/^\/twilio\/status\/([\w-]+)$/) ?? []
      if (statusToken && request.method === 'POST') return phoneStatus(request, statusToken)
      const [, token, twimlPath] = pathname.match(/^\/twilio\/([\w-]+)(\/twiml)?$/) ?? []
      const dialed = dials.get(token)
      if (token) trace(`Twilio ${request.method} ${twimlPath ? 'TwiML' : 'stream'}, ${dialed ? 'known' : 'unknown'} token`)
      if (dialed && twimlPath) return stream(token)
      if (dialed && dials.delete(token)) return server.upgrade(request, { data: { ...dialed, unheard: 0 } }) ? undefined : new Response('upgrade failed', { status: 400 })
      if (foreign(request)) return new Response('Forbidden', { status: 403 })
      if (pathname === '/') return home(request)
      if (!allowed(request)) return new Response('Unauthorized', { status: 401, headers: { 'www-authenticate': 'Bearer' } })
      return routes(request) ?? new Response('404', { status: 404 })
    },
    websocket: {
      open: answer,
      message: hearPhone,
      close: hangUp,
    },
  })
}
