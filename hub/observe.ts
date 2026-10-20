import { spawn } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import { holds, keysOf, owners, verdict } from './notes.ts'
import { names } from './profile.ts'
import { zoneOf } from './schedule.ts'
import { open, type Row } from './store.ts'

// Memory written off to the side, the way a personal assistant's should be
// (https://dhravya.dev/writing/memory-on-the-harness-level/): after a session's turn, a model reads
// the owner's messages it took that no note names yet, with the reply they got and the newest
// notes, and writes the notes worth keeping in the owner's own words. Sessions still write their
// own notes as they work; this keeps what they didn't, and each note it writes is held to the same
// check a session's is, against the message it quotes.

const MODEL = 'sonnet'
const BYTES = 280
const NEWEST = 40
const hexDir = process.env.HEX_DIR ?? resolve(import.meta.dir, '../..')
const MEMO = join(import.meta.dir, '..', 'vendor', 'memo')

const SYSTEM = `You keep the long-term memory of hex, the owner's personal assistant. A session just finished a turn. You get the owner's messages from that turn that no memory names yet, the reply the session gave, and the newest memories.

Write the memories worth keeping from those messages: what the owner decided, asked for, corrected, taught, or said about their life, their work or how they want things done, and anything of lasting effect that happened. Most turns need one memory or none. A message that only answers the turn, like "ok" or "go", needs none.

Each memory is one line of at most ${BYTES} bytes, written like the newest memories: the owner's local time, then what happened in plain words, the words it rests on quoted in double quotes exactly as the owner wrote them ("…" skips a part), and the message's key in brackets at the end. Quote the words that carry what the owner meant; anger and curses stay in the log. When the owner corrects or changes something a memory says, the new line starts with "Correction:". A memory that's already there doesn't need writing again.

If you need what a message answers, the whole conversation is in the log file named with the turn.`

const SCHEMA = { type: 'object', properties: { notes: { type: 'array', items: { type: 'string' } } }, required: ['notes'] }

type Hook = { session_id?: string; last_assistant_message?: string }
type Pass = { session: string; reply: string; by: string }

export async function observe(state: string, session: string, reply: string, { ask = claude, memo = MEMO, by = new Date().toISOString() } = {}) {
  const recall = (pattern: string) => Bun.spawnSync([memo, 'recall', pattern], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString()
  const store = open(state)
  const taken = store.observe(session, by)
  const rows = owners(taken)
  try {
    const named = rows.length ? recall(rows.map(row => `\\[${escape(row.key)}\\]`).join('|')) : ''
    const fresh = rows.filter(row => !named.includes(`[${row.key}]`))
    const written: string[] = []
    if (fresh.length) {
      const zone = zoneOf(hexDir) ?? Temporal.Now.timeZoneId()
      const threads = names(state)
      const turn = [
        `<turn thread="${threads[fresh[0]!.to] ?? fresh[0]!.to}" log="${logOf(session) ?? 'none'}">`,
        ...fresh.map(row => said(row, zone)),
        `The session's reply:\n${reply.trim() || '(none)'}`,
        '</turn>',
      ]
      const input = `<newest memories>\n${newest(recall('.'))}\n</newest memories>\n\n${turn.join('\n\n')}`
      const ours = new Set(fresh.map(row => row.key))
      for (const note of (await ask(input)).map(line).filter(Boolean)) {
        if (Buffer.byteLength(note) > BYTES || !keysOf(note).every(key => ours.has(key)) || !holds(verdict(note, store))) continue
        if (Bun.spawnSync([memo, 'note', note], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0) written.push(note)
      }
    }
    store.observed(taken.map(row => row.key))
    return written
  } catch (error) {
    store.observed(taken.map(row => row.key), false)
    console.error(`hex couldn't look over this turn for memories: ${error}`)
    return []
  }
}

// The newest notes, enough to show what memory already says and how its lines read.
const newest = (recalled: string) => recalled.split('\n').filter(line => line.startsWith('#')).slice(-NEWEST).join('\n')

// A note as memo takes it: one line, without the number and date memo puts in front of it itself.
const line = (note: string) => note.replace(/\s+/g, ' ').trim().replace(/^(#\d+ )?\d{4}-\d\d-\d\d /, '')

// A message as the pass reads it: its key, when it came on the owner's clock, what it answers, and its words.
function said(row: Row, zone: string) {
  const replying = row.meta?.reply_to_text ? `, replying to "${row.meta.reply_to_text.slice(0, 300)}"` : ''
  return `[${row.key}] ${clock(row.meta?.ts ?? row.at, zone)}${replying}:\n${row.body}`
}

// "Oct 20 12:47am", the way notes write the time.
export function clock(at: string, zone: string) {
  const time = Temporal.Instant.from(at).toZonedDateTimeISO(zone)
  const hour = time.hour % 12 || 12
  const month = time.toLocaleString('en-US', { month: 'short' })
  return `${month} ${time.day} ${hour}:${String(time.minute).padStart(2, '0')}${time.hour < 12 ? 'am' : 'pm'}`
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function logOf(session: string) {
  const id = session.slice(0, 8)
  for (const dir of [join(hexDir, 'log', 'threads'), join(hexDir, 'log')]) {
    const file = existsSync(dir) && readdirSync(dir).find(name => name.endsWith(`-${id}.md`))
    if (file) return join(dir, file)
  }
}

// One read-only call: the model may open the turn's log, and its only effect is the notes it returns.
async function claude(input: string): Promise<string[]> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HEX_') && !name.startsWith('CLAUDECODE')))
  const run = Bun.spawn(
    ['claude', '-p', '--safe-mode', '--model', MODEL, '--effort', 'high', '--tools', 'Read,Grep', '--system-prompt', SYSTEM, '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA), '--no-session-persistence'],
    { cwd: join(hexDir, 'log'), env, stdin: new Blob([input]), stdout: 'pipe', stderr: 'pipe' },
  )
  const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
  const result = JSON.parse(out || '{}')
  if (code !== 0 || result.is_error || !result.structured_output) throw new Error(`claude exited ${code}: ${result.result ?? err.slice(-500)}`)
  return result.structured_output.notes
}

// The Stop hook hands the turn to a pass of its own and returns, since Claude Code ends a hook still
// running when its session exits, and a hex session often exits right after a turn (a restart, an
// update, a call that ended). The pass takes only what the session had taken by then, not the
// next turn's message.
if (import.meta.main) {
  const { HEX_STORE, MEMORY_DIR, HEX_PASS } = process.env
  if (HEX_PASS) {
    const { session, reply, by } = JSON.parse(HEX_PASS) as Pass
    await observe(HEX_STORE!, session, reply, { by })
  } else if (HEX_STORE && MEMORY_DIR && existsSync(MEMO)) {
    const hook = JSON.parse((await Bun.stdin.text()) || '{}') as Hook
    const pass: Pass = { session: hook.session_id ?? '', reply: hook.last_assistant_message ?? '', by: new Date().toISOString() }
    if (pass.session) spawn(process.execPath, [import.meta.path], { detached: true, stdio: 'ignore', env: { ...process.env, HEX_PASS: JSON.stringify(pass) } }).unref()
  }
}
