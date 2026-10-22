import { connect } from 'net'
import { open, stateDir } from './store.ts'

const { HEX_HUB, HEX_THREAD, HEX_OWNER } = process.env
const busy = process.argv[2] === 'busy'

// Claude Code counts a session with these running as still working, and shells or monitors as not.
const WORKING = new Set(['subagent', 'workflow'])
// A message hex kept has its key first on its channel tag. Claude Code sends each channel message
// as its own prompt, so only the opening tag is hex's: one further in is the message's own words.
const KEY = /^<channel source="[^"]*" key="([^"]+)"/

async function input(): Promise<{ prompt?: unknown; session_id?: string; background_tasks?: { type?: string }[] }> {
  try {
    return JSON.parse(await Bun.stdin.text())
  } catch {
    return {}
  }
}

const { prompt, session_id = '', background_tasks } = await input()
const fromChat = typeof prompt === 'string' && prompt.startsWith('<channel source=')
const background = !busy && !!background_tasks?.some(task => WORKING.has(task.type ?? ''))
const key = busy && fromChat ? prompt.match(KEY)?.[1] : undefined

// The session takes the message its prompt brings in, in the store itself while it can reach it,
// or else through the hub. One that was taken already is a second copy (the hub sends again what it
// can't tell a session took), so Claude Code drops it.
let untold = key
if (key) {
  try {
    const store = open(stateDir())
    if (store.take(key, session_id)) untold = undefined
    else if (store.message(key)) {
      console.error(`hex gave this session ${key} already`)
      process.exit(2)
    }
  } catch {}
}

// What's typed in a session's terminal is kept like any message, already taken by the session: the
// owner's, except the prompt a job's session opens on (the hub keeps the prompt it starts a session
// with itself; observe.ts keeps a terminal's answers). Typed into a job's session later, by someone
// attached to it, it's the owner's again.
const said = busy && typeof prompt === 'string' && !fromChat && !/^(\/|<(local-command|command-|system-reminder|task-notification|(agent|cross-session|teammate)-message[\s>]))/.test(prompt) ? prompt : undefined
if (said && session_id) {
  try {
    const store = open(stateDir())
    const to = HEX_THREAD ?? session_id
    const author = HEX_OWNER && !HEX_THREAD && !store.said(to, 1).length ? 'prompt' : 'owner'
    const started = author === 'owner' && store.said(to, 20).some(row => row.from === 'hub' && row.body.trim() === said.trim())
    if (!started) store.deliver({ key: `terminal:${crypto.randomUUID()}`, to, from: 'terminal', author, body: said, meta: { session: session_id } }, session_id)
  } catch {}
}

if (HEX_HUB && HEX_THREAD && (!busy || fromChat)) {
  connect(HEX_HUB)
    .on('connect', function () {
      this.end(JSON.stringify({ type: 'state', thread: HEX_THREAD, busy, ...(background && { background }), ...(untold && { taken: [untold], session: session_id }) }) + '\n')
    })
    .on('error', () => {})
}
