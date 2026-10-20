import { existsSync, readFileSync, writeFileSync } from 'fs'
import { connect } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { clip, owners } from './notes.ts'
import { open, type Store } from './store.ts'

const { HEX_HUB, HEX_THREAD, HEX_STORE } = process.env
const mode = process.argv[2]
const busy = mode === 'busy'

// Claude Code counts a session with these running as still working, and shells or monitors as not.
const WORKING = new Set(['subagent', 'workflow'])
// A message hex kept has its key first on its channel tag. Claude Code sends each channel message
// as its own prompt, so only the opening tag is hex's: one further in is the message's own words.
const KEY = /^<channel source="[^"]*" key="([^"]+)"/

async function input(): Promise<{ hook_event_name?: string; prompt?: unknown; session_id?: string; stop_hook_active?: boolean; background_tasks?: { type?: string }[] }> {
  try {
    return JSON.parse(await Bun.stdin.text())
  } catch {
    return {}
  }
}

const { hook_event_name, prompt, session_id = '', stop_hook_active, background_tasks } = await input()
// What the session has taken counts from its start, so a resumed session leaves its history be.
const seen = join(process.env.TMPDIR || tmpdir(), `hex-asked-${session_id}`)
if (mode === 'begin') {
  if (session_id) writeFileSync(seen, new Date().toISOString())
  process.exit(0)
}
const fromChat = typeof prompt === 'string' && prompt.startsWith('<channel source=')
const background = !busy && !!background_tasks?.some(task => WORKING.has(task.type ?? ''))
const key = busy && fromChat ? prompt.match(KEY)?.[1] : undefined

// The session takes the message its prompt brings in, in the store itself while it can reach it,
// or else through the hub. One that was taken already is a second copy (the hub sends again what it
// can't tell a session took), so Claude Code drops it.
let untold = key
if (key && HEX_STORE) {
  try {
    const store = open(HEX_STORE)
    if (!store.take(key, session_id) && store.message(key)) {
      console.error(`hex gave this session ${key} already`)
      process.exit(2)
    }
    untold = undefined
  } catch {}
}

// Each of the owner's asks becomes a task in their words. A turn that ends with messages of theirs
// no task quotes goes on once with them in front of it; the reply went out already, so they wait
// on nothing, and the hub hears the session is idle only when it really is.
if (hook_event_name === 'Stop' && !stop_hook_active && HEX_STORE && session_id) {
  try {
    const store = open(HEX_STORE)
    const took = store.took(session_id, existsSync(seen) ? readFileSync(seen, 'utf8') : '')
    if (took.length) writeFileSync(seen, took.at(-1)!.taken!.at)
    const unquoted = asks(store, took)
    if (unquoted.length) {
      const hex = join(import.meta.dir, '../bin/hex')
      console.log(
        JSON.stringify({
          decision: 'block',
          reason: `No task quotes these messages from the owner yet:\n\n${unquoted.map(row => `[${row.key}] ${clip(row.body, 600)}`).join('\n\n')}\n\nEach one that asks for something becomes a task: \`${hex} task new <key>\`, with \`--quote "<part>"\` when only part of it is the ask and \`--done-when\` for the outcome they're after. One that adds to a task, or edits a message a task quotes, goes on it with \`${hex} task add <task> <key>\`. The rest need nothing. They have your reply already, so send nothing more.`,
        }),
      )
      process.exit(0)
    }
  } catch {}
}

if (HEX_HUB && HEX_THREAD && (!busy || fromChat)) {
  connect(HEX_HUB)
    .on('connect', function () {
      this.end(JSON.stringify({ type: 'state', thread: HEX_THREAD, busy, ...(background && { background }), ...(untold && { taken: [untold], session: session_id }) }) + '\n')
    })
    .on('error', () => {})
}

// Every handoff on a call is a message of the owner's, mostly talk, and a turn held up after one
// keeps the next one waiting while they're on the line.
function asks(store: Store, took: ReturnType<Store['took']>) {
  const quoted = store.db.query('select 1 from words where message = ?')
  return owners(took).filter(row => row.from !== 'voice' && !row.meta?.reaction && !row.meta?.button && !row.meta?.vote && !row.meta?.deleted && !row.meta?.answered_in && !quoted.get(row.key))
}
