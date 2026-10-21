import { spawn } from 'child_process'
import { appendFileSync, existsSync, openSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { clip, holds, keysOf, owners, problems, quotesOf, verdict } from './notes.ts'
import { zoneOf } from './schedule.ts'
import { open, replied, type Row, type Store } from './store.ts'

// The owner's profile, which this agent keeps current after every turn; bin/wake puts it in front of
// the memory every session starts with. It never passes PROFILE.
export const profilePath = (state: string) => join(state, 'profile.md')
export const profileOf = (state: string) => (existsSync(profilePath(state)) ? readFileSync(profilePath(state), 'utf8').trim() : '')
export const PROFILE = 6_500

// hex's memory agent, the observer from https://dhravya.dev/writing/memory-on-the-harness-level/:
// after a session's turn, a model reads the messages it took, with the reply they got, the newest
// notes and the owner's profile. It writes every note memory gets, the owner's words in their own
// words and what happened in plain ones, and keeps the profile (state/profile.md) one consolidated,
// current account of who they are, a changed fact replaced rather than stacked; their rules,
// wants and history live in AGENTS.md, tasks and memory. Every note and profile line that names a message is checked against the words it quotes.

const MODEL = 'sonnet'
const BYTES = 280
const NEWEST = 40
// How many of the thread's messages before the turn the pass reads, for what the turn answers.
const BEFORE = 10
const CALL = 5 * 60_000
const hexDir = process.env.HEX_DIR ?? resolve(import.meta.dir, '../..')
const MEMO = join(import.meta.dir, '..', 'vendor', 'memo')

const SYSTEM = `You are the memory agent of hex, the owner's personal assistant. A session just finished a turn. You get the owner's profile, the newest memories, and the messages of that turn in order, the owner's, others' (jobs, schedules, other sessions) and what hex replied; an owner's message a memory already names is marked so. You keep two things.

Memories: one line each, appended forever. Sessions write none, so every memory comes from you. Write the ones worth keeping: from the owner's messages no memory names yet, what they decided, asked for, corrected, taught, or said about their life, their work or how they want things done; and from the whole turn, anything of lasting effect that happened, like work shipped, a fact found or a plan changed. Most turns need one memory or none; a message that only answers the turn, like "ok" or "go", needs none. Each is at most ${BYTES} bytes, written like the newest memories: the owner's local time, then what happened in plain words. One that rests on the owner's words quotes them in double quotes exactly as the owner wrote them ("…" skips a part) and ends with the message's key in brackets; quote and key only the owner's messages, and name anything else in plain words, without double quotes. When the owner corrects or changes something a memory says, the new line starts with "Correction:". A memory that's already there doesn't need writing again.

The profile: a small markdown file every session reads, who the owner is: their life, health, home, people, work, and plans that hold for a while, like a trip. Each fact has one home, and the others are elsewhere: how they want things done is in their AGENTS.md, what they want done is in tasks, and what happened is in memories. When a message changes a fact, rewrite its line so only the current truth stays; a line stays until a message says it's no longer true or it has ended, like a trip that's over. Keep it short and never over ${PROFILE} characters; over it, merge and tighten lines, then drop the facts that matter least. A line that rests on the owner's words quotes them exactly and names the message's key in brackets. Return the whole profile when it changes, or null when nothing in it needs to change.

In both, quote the words that carry what the owner meant; anger and curses stay in the log. What came before the turn in its thread is there for what a message answers: write about the turn's own messages.`

const SCHEMA = {
  type: 'object',
  properties: { notes: { type: 'array', items: { type: 'string' } }, profile: { type: ['string', 'null'] } },
  required: ['notes', 'profile'],
}
export type Answer = { notes: string[]; profile: string | null }

type Hook = { session_id?: string; last_assistant_message?: string }
export type Pass = { session: string; by: string; thread?: string }

export async function observe(state: string, session: string, { ask = claude, memo = MEMO, by = new Date().toISOString(), thread = undefined as string | undefined } = {}) {
  const recall = (pattern: string) => Bun.spawnSync([memo, 'recall', pattern], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString()
  const named = (rows: Row[]) => (rows.length ? recall(rows.map(row => `\\[${escape(row.key)}\\]`).join('|')) : '')
  const store = open(state)
  const taken = store.observe(session, by, thread, 4 * CALL)
  const rows = owners(taken)
  const others = taken.filter(row => !rows.includes(row))
  const written: string[] = []
  try {
    const noted = named(rows)
    const fresh = rows.filter(row => !noted.includes(`[${row.key}]`))
    let wanted = false
    let wrong = ''
    let reasons = ''
    if (taken.length) {
      const zone = zoneOf(hexDir) ?? Temporal.Now.timeZoneId()
      const threads = store.names()
      const place = taken[0]?.to ?? thread
      const shown = (row: Row) => !replied(row) || (!row.meta?.failed && !row.meta?.edited && !row.meta?.permission)
      const whose = (row: Row) => (row.meta?.unsent ? 'hex, in its terminal, which the owner does not see,' : replied(row) ? 'hex replied,' : row.author === 'prompt' ? "hex's words to the session," : `From ${row.author}, not the owner,`)
      const before = place ? store.said(place, BEFORE, [...rows, ...others].reduce((first, row) => (row.at < first ? row.at : first), by)).filter(shown) : []
      const turn = [
        ...(before.length ? [`<before>\n${before.map(row => `${row.author === 'owner' ? 'The owner,' : whose(row)} ${clock(row.at, zone)}:\n${clip(row.body, 1000)}`).join('\n\n')}\n</before>`] : []),
        `<turn thread="${place ? (threads[place] ?? place) : 'none'}">`,
        ...taken.filter(shown).map(row =>
          rows.includes(row)
            ? `${said(row, zone)}${noted.includes(`[${row.key}]`) ? '\n(a note already names this message: write no note for it)' : ''}`
            : `${whose(row)} ${clock(row.at, zone)}:\n${clip(row.body, 2000)}`,
        ),
        '</turn>',
      ].join('\n\n')
      const ours = new Set(fresh.map(row => row.key))
      // A profile that misquotes the owner goes back with what's wrong, and another pass may
      // rewrite the profile while this one thinks: either way it thinks again.
      for (let tries = 0; tries < 3; tries++) {
        const before = profileOf(state)
        const answer = await ask(`<profile>\n${before || '(none yet)'}\n</profile>\n\n<newest memories>\n${newest(recall('.'))}\n</newest memories>\n\n${turn}${wrong}`)
        const now = named(fresh)
        for (const note of tries ? [] : answer.notes.map(line).filter(Boolean)) {
          const keys = keysOf(note)
          const kept = keys.length ? keys.every(key => ours.has(key) && !now.includes(`[${key}]`)) && holds(verdict(note, store)) : !quotesOf(note).length
          if (Buffer.byteLength(note) > BYTES || !kept) continue
          if (Bun.spawnSync([memo, 'note', note], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0) written.push(note)
        }
        wanted = answer.profile !== null
        if (answer.profile === null) break
        const bad = misquoted(answer.profile, store)
        reasons = bad.join('\n')
        wrong = bad.length ? retry(bad, answer.profile) : ''
        if (wrong || !swap(state, store, before, answer.profile)) continue
        wanted = false
        break
      }
      if (wanted) console.error(`hex left the profile as it was after 3 tries:${reasons ? `\n${reasons}` : ' another pass kept rewriting it'}`)
    }
    // A pass that lost to other passes leaves its turn for the next, unless it wrote notes, which a
    // second look could write again; one that kept misquoting would again, so its turn is done.
    store.observed(taken.map(row => row.key), !wanted || !!wrong || written.length > 0)
    return written
  } catch (error) {
    store.observed(taken.map(row => row.key), written.length > 0)
    console.error(`hex couldn't look over this turn for memories: ${error}`)
    return written
  }
}

// What keeps a profile from being kept: too long, empty, or a line that quotes someone without
// naming the owner's message it quotes, or misquotes it.
function misquoted(profile: string | null, store: Store): string[] {
  if (!profile?.trim()) return ['(empty)']
  if (profile.length > PROFILE) return [`(${profile.length} characters: cut it by merging and tightening lines, then dropping the facts that matter least)`]
  return profile.split('\n').flatMap(each => {
    if (!keysOf(each).length) return quotesOf(each).length ? [`${each}\n  names no message of the owner's for its quote`] : []
    const found = verdict(each, store)
    if (!holds(found)) return [`${each}\n  ${problems(found, false).join('\n  ')}`]
    const foreign = found.keys.filter(row => !owners([row]).length)
    return foreign.length ? [`${each}\n  ${foreign.map(row => `[${row.key}]`).join(', ')} isn't the owner's message`] : []
  })
}

const retry = (bad: string[], draft: string) =>
  `\n\nYour last profile wasn't kept. It must stay under ${PROFILE} characters, and a line that quotes the owner must name the message it quotes, quoting it as written:\n${bad.join('\n')}\n\nFix that draft rather than starting over:\n<draft>\n${draft.trim()}\n</draft>`

// Puts the profile in place only if it's still the one this pass read, inside the store's write
// lock so two passes never both pass that check, and whole, so a session never reads half a profile.
function swap(state: string, store: Store, before: string, profile: string) {
  return store.write(() => {
    if (profileOf(state) !== before.trim()) return false
    const next = `${profilePath(state)}.${process.pid}.new`
    writeFileSync(next, `${profile.trim()}\n`)
    renameSync(next, profilePath(state))
    // The file holds the newest version and the history every one it replaced, hand edits too.
    try {
      if (before.trim()) appendFileSync(`${profilePath(state)}.history`, `${JSON.stringify({ at: new Date().toISOString(), profile: before.trim() })}\n`)
    } catch (error) {
      console.error(`hex couldn't keep the replaced profile: ${error}`)
    }
    return true
  })
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

// One call with no tools: its only effect is what it returns.
// Its three tries end inside the pass's lease (4 calls long), so a hung call fails rather than racing the next pass.
async function call(input: string, system: string, args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HEX_') && !name.startsWith('CLAUDECODE')))
  const run = Bun.spawn(
    ['claude', '-p', '--safe-mode', '--model', MODEL, ...args, '--system-prompt', system, '--output-format', 'json', '--no-session-persistence'],
    { cwd: hexDir, env, stdin: new Blob([input]), stdout: 'pipe', stderr: 'pipe', timeout: CALL },
  )
  const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
  const result = JSON.parse(out || '{}')
  if (code !== 0 || result.is_error) throw new Error(`claude exited ${code}: ${result.result ?? err.slice(-500)}`)
  return result
}

async function claude(input: string): Promise<Answer> {
  const result = await call(input, SYSTEM, ['--effort', 'high', '--tools', '', '--json-schema', JSON.stringify(SCHEMA)])
  if (!result.structured_output) throw new Error(`claude answered without the schema: ${result.result}`)
  return result.structured_output
}

// OptMem asks whoever writes a note to do the compressions it makes due. The memory agent writes
// every note, so it does them too, and a session's wake never has to ask for one. Each one starts
// only while keep() holds the pass's lease.
export async function nap(memo = MEMO, compress = summarize, keep = () => true) {
  for (let asked; keep() && (asked = Bun.spawnSync([memo, 'nap'], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString()).startsWith('Compress'); ) {
    const block = asked.match(/^Compress memories #(\d+-\d+)/)![1]!
    let why = ''
    for (let tries = 0; ; tries++) {
      const line = await compress(asked.slice(0, asked.lastIndexOf('\nRun:')) + why)
      const kept = Bun.spawnSync([memo, 'nap', block, tries === 2 ? within(line, BYTES) : line], { stdout: 'pipe', stderr: 'pipe' })
      if (kept.exitCode === 0) break
      if (tries === 2) throw new Error(`memo kept no summary of #${block}: ${kept.stdout}${kept.stderr}`)
      why = `\n\nThat line wasn't kept: ${kept.stdout}${kept.stderr}`
    }
  }
}

// A summary that stayed too long after its tries loses its last words, so one stuck block can't hold
// back every compression after it.
export function within(line: string, bytes: number) {
  const size = (text: string) => Buffer.byteLength(text)
  const flat = line.replace(/\s+/g, ' ').trim()
  if (size(flat) <= bytes) return flat
  let cut = Array.from(flat)
  while (cut.length && size(`${cut.join('')}…`) > bytes) cut = cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : cut.length - 1)
  return `${cut.join('').trimEnd()}…`
}

const LINE = { type: 'object', properties: { line: { type: 'string' } }, required: ['line'] }

async function summarize(prompt: string) {
  const { structured_output } = await call(prompt, 'You compress the memories of an AI assistant into one line.', ['--effort', 'low', '--tools', '', '--json-schema', JSON.stringify(LINE)])
  return String(structured_output?.line ?? '').trim()
}

// A session reloads its memory file after compacting, so each pass leaves it current: the profile
// and memory as they are now, not as they were when the newest session started.
export function refresh(wake = join(hexDir, 'state', 'wake', 'CLAUDE.md')) {
  if (!existsSync(dirname(wake))) return
  const text = Bun.spawnSync([join(import.meta.dir, '..', 'bin', 'wake'), 'all'], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString()
  // A wake that stopped to ask for a compression holds no memory, so the file keeps the one it has.
  if (!text.includes('You are awake.')) return
  writeFileSync(`${wake}.${process.pid}`, text)
  renameSync(`${wake}.${process.pid}`, wake)
}

// A pass looks over the turn, does the compressions its notes made due, and leaves the memory file current.
async function pass(state: string, turn: Pass, keep: () => boolean) {
  await observe(state, turn.session, turn)
  try {
    await nap(MEMO, summarize, keep)
  } finally {
    refresh()
  }
}

// Turns wait in hex.db, oldest first, and one process at a time works through them, so each pass
// reads the notes and profile the last one left: two never write the same note or race for the
// profile, and a turn outlives a pass that died. A drainer that died holds the lease only until it
// runs out; each turn renews it, and one whose lease ran out mid-turn stops. One that finds the lease taken leaves its turn to the holder,
// which looks again after letting go.
export async function drain(state: string, run: (pass: Pass, keep: () => boolean) => Promise<unknown> = (each, keep) => pass(state, each, keep)) {
  const store = open(state)
  const holder = crypto.randomUUID()
  while (store.waiting() && store.lease('observe', holder, 4 * CALL)) {
    try {
      for (let next; (next = store.waiting()); ) {
        await run(next.pass as Pass, () => store.lease('observe', holder, 4 * CALL)).catch(error => console.error(`hex couldn't look over a turn for memories: ${error}`))
        store.passed(next.n)
        if (!store.lease('observe', holder, 4 * CALL)) return
      }
    } finally {
      store.release('observe', holder)
    }
  }
}

// The Stop hook queues the turn and hands the queue to a process of its own, since Claude Code ends
// a hook still running when its session exits, and a hex session often exits right after a turn (a
// restart, an update, a call that ended). A pass takes only what the session had taken when its
// turn ended, not the next turn's message, and what an earlier pass in its thread left unfinished.
// Errors go to state/observe.log.
if (import.meta.main) {
  const { HEX_STORE = join(hexDir, 'state'), MEMORY_DIR, HEX_PASS, HEX_THREAD, HEX_CHANNEL } = process.env
  if (HEX_PASS) await drain(HEX_STORE)
  else {
    const hook = JSON.parse((await Bun.stdin.text()) || '{}') as Hook
    // A turn's last words in the terminal are kept before the turn is queued: a session no app holds
    // answers there, and an app's session sums up there what its replies may not say. In T3 Code the
    // terminal is the conversation, which T3's bot keeps as hex's reply.
    const answer = HEX_CHANNEL?.startsWith('plugin:t3@') ? undefined : hook.last_assistant_message?.trim()
    try {
      if (hook.session_id && answer) open(HEX_STORE).deliver({ key: `terminal:${crypto.randomUUID()}`, to: HEX_THREAD ?? hook.session_id, from: 'terminal', author: 'hex', body: answer, meta: { session: hook.session_id, ...(HEX_CHANNEL && { unsent: true }) } }, hook.session_id)
    } catch (error) {
      process.stderr.write(`hex couldn't keep this turn's answer: ${error}\n`)
    }
    if (hook.session_id && MEMORY_DIR && existsSync(MEMO)) {
      open(HEX_STORE).wait({ session: hook.session_id, by: new Date().toISOString(), thread: HEX_THREAD })
      const log = openSync(join(HEX_STORE, 'observe.log'), 'a')
      spawn(process.execPath, [import.meta.path], { detached: true, stdio: ['ignore', 'ignore', log], env: { ...process.env, HEX_PASS: '1' } }).unref()
    }
  }
}
