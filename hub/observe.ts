import { spawn } from 'child_process'
import { existsSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { holds, keysOf, owners, problems, verdict } from './notes.ts'
import { names, PROFILE, profileOf, profilePath } from './profile.ts'
import { zoneOf } from './schedule.ts'
import { open, type Row, type Store } from './store.ts'

// hex's memory agent, the observer from https://dhravya.dev/writing/memory-on-the-harness-level/:
// after a session's turn, a model reads the owner's messages it took that no note names yet, with
// the reply they got, the newest notes and the owner's profile. It writes the notes worth keeping in
// the owner's own words, and keeps the profile (state/profile.md) one consolidated, current account
// of them: what's always true, what's going on now, a changed fact replaced rather than stacked.
// Sessions still write their own notes as they work. Every note and profile line that names a
// message is held to the check a session's note is, against the words it quotes.

const MODEL = 'sonnet'
const BYTES = 280
const NEWEST = 40
const CALL = 5 * 60_000
const hexDir = process.env.HEX_DIR ?? resolve(import.meta.dir, '../..')
const MEMO = join(import.meta.dir, '..', 'vendor', 'memo')

const SYSTEM = `You are the memory agent of hex, the owner's personal assistant. A session just finished a turn. You get the owner's profile, the newest memories, and the owner's messages from that turn that no memory names yet, with the reply the session gave. You keep two things.

Memories: one line each, appended forever. Write the ones worth keeping from those messages: what the owner decided, asked for, corrected, taught, or said about their life, their work or how they want things done, and anything of lasting effect that happened. Most turns need one memory or none; a message that only answers the turn, like "ok" or "go", needs none. Each is at most ${BYTES} bytes, written like the newest memories: the owner's local time, then what happened in plain words, the words it rests on quoted in double quotes exactly as the owner wrote them ("…" skips a part), and the message's key in brackets at the end. When the owner corrects or changes something a memory says, the new line starts with "Correction:". A memory that's already there doesn't need writing again.

The profile: a small markdown file every session will read, the current truth about the owner. Under "# Always" goes what stays true: who they are, their people, their work, how they want things done. Under "# Now" goes what's in motion: what they're asking for and waiting on, the projects that are live, what was just decided or settled. When a message changes something the profile says, rewrite that line so only the current truth stays; drop what's done or no longer matters. Keep it under ${PROFILE} characters. A line that rests on the owner's words quotes them exactly and names the message's key in brackets. Return the whole profile when it changes, or null when this turn changes nothing in it.

In both, quote the words that carry what the owner meant; anger and curses stay in the log. If you need what a message answers, the whole conversation is in the log file named with the turn.`

const SCHEMA = {
  type: 'object',
  properties: { notes: { type: 'array', items: { type: 'string' } }, profile: { type: ['string', 'null'] } },
  required: ['notes', 'profile'],
}
type Answer = { notes: string[]; profile: string | null }

type Hook = { session_id?: string; last_assistant_message?: string }
type Pass = { session: string; reply: string; by: string; thread?: string }

export async function observe(state: string, session: string, reply: string, { ask = claude, memo = MEMO, by = new Date().toISOString(), thread = undefined as string | undefined } = {}) {
  const recall = (pattern: string) => Bun.spawnSync([memo, 'recall', pattern], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString()
  const named = (rows: Row[]) => (rows.length ? recall(rows.map(row => `\\[${escape(row.key)}\\]`).join('|')) : '')
  const store = open(state)
  const taken = store.observe(session, by, thread)
  const rows = owners(taken)
  try {
    const noted = named(rows)
    const fresh = rows.filter(row => !noted.includes(`[${row.key}]`))
    const written: string[] = []
    if (fresh.length) {
      const zone = zoneOf(hexDir) ?? Temporal.Now.timeZoneId()
      const threads = names(state)
      const turn = [
        `<turn thread="${threads[fresh[0]!.to] ?? fresh[0]!.to}" log="${logOf(session) ?? 'none'}">`,
        ...fresh.map(row => said(row, zone)),
        `The session's reply:\n${reply.trim() || '(none)'}`,
        '</turn>',
      ].join('\n\n')
      const ours = new Set(fresh.map(row => row.key))
      // A profile that misquotes the owner goes back with what's wrong, and another pass may
      // rewrite the profile while this one thinks: either way it thinks again, so no change is lost.
      let wrong = ''
      for (let tries = 0; tries < 3; tries++) {
        const before = profileOf(state)
        const answer = await ask(`<profile>\n${before || '(none yet)'}\n</profile>\n\n<newest memories>\n${newest(recall('.'))}\n</newest memories>\n\n${turn}${wrong}`)
        const now = named(fresh)
        for (const note of answer.notes.map(line).filter(Boolean)) {
          const keys = keysOf(note)
          if (Buffer.byteLength(note) > BYTES || !keys.every(key => ours.has(key) && !now.includes(`[${key}]`)) || !holds(verdict(note, store))) continue
          if (Bun.spawnSync([memo, 'note', note], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0) written.push(note)
        }
        if (answer.profile === null) break
        const bad = misquoted(answer.profile, store)
        wrong = bad.length ? `\n\nYour last profile wasn't kept. It must stay under ${PROFILE} characters, and a line that names a message must quote it as written:\n${bad.join('\n')}` : ''
        if (wrong || profileOf(state) !== before) continue
        writeFileSync(`${profilePath(state)}.new`, `${answer.profile.trim()}\n`)
        renameSync(`${profilePath(state)}.new`, profilePath(state))
        break
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

// The first profile, built once from the whole wake and the owner's messages of the last two
// weeks, by the strongest model, since every later pass starts from it.
export async function seed(state: string, { ask = (input: string) => claude(input, 'opus'), wake = '' } = {}) {
  const store = open(state)
  const zone = zoneOf(hexDir) ?? Temporal.Now.timeZoneId()
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString()
  const said = owners(store.since(since)).map(row => `[${row.key}] ${clock(row.meta?.ts ?? row.at, zone)}: ${row.body.replace(/\s+/g, ' ').slice(0, 600)}`)
  const input = `<profile>\n(none yet: build the first one from all of the below)\n</profile>\n\n<memories>\n${wake}\n</memories>\n\n<the owner's messages of the last two weeks>\n${said.join('\n').slice(-120_000)}\n</the owner's messages of the last two weeks>`
  let wrong = ''
  for (let tries = 0; tries < 3; tries++) {
    const { profile } = await ask(input + wrong)
    const bad = misquoted(profile, store)
    if (!bad.length) {
      writeFileSync(profilePath(state), `${profile!.trim()}\n`)
      return profile!
    }
    wrong = `\n\nYour last profile wasn't kept. It must stay under ${PROFILE} characters, and a line that names a message must quote it as written:\n${bad.join('\n')}`
  }
  throw new Error(`the first profile wasn't kept:${wrong}`)
}


// What keeps a profile from being kept: too long, empty, or a line that names a message without
// quoting it as written.
function misquoted(profile: string | null, store: Store): string[] {
  if (!profile?.trim()) return ['(empty)']
  if (profile.length > PROFILE) return [`(${profile.length} characters)`]
  return profile
    .split('\n')
    .filter(each => keysOf(each).length && !holds(verdict(each, store)))
    .map(each => `${each}\n  ${problems(verdict(each, store), false).join('\n  ')}`)
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

// One read-only call: the model may open the turn's log, and its only effect is what it returns.
// It ends well inside the pass's lease, so a hung call fails rather than racing the next pass.
async function claude(input: string, model = MODEL): Promise<Answer> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HEX_') && !name.startsWith('CLAUDECODE')))
  const run = Bun.spawn(
    ['claude', '-p', '--safe-mode', '--model', model, '--effort', 'high', '--tools', 'Read,Grep', '--system-prompt', SYSTEM, '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA), '--no-session-persistence'],
    { cwd: join(hexDir, 'log'), env, stdin: new Blob([input]), stdout: 'pipe', stderr: 'pipe', timeout: CALL },
  )
  const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
  const result = JSON.parse(out || '{}')
  if (code !== 0 || result.is_error || !result.structured_output) throw new Error(`claude exited ${code}: ${result.result ?? err.slice(-500)}`)
  return result.structured_output
}

// The Stop hook hands the turn to a pass of its own and returns, since Claude Code ends a hook still
// running when its session exits, and a hex session often exits right after a turn (a restart, an
// update, a call that ended). The pass takes only what the session had taken by then, not the
// next turn's message, and what an earlier pass in its thread left unfinished. Its errors go to
// state/observe.log.
if (import.meta.main) {
  const { HEX_STORE, MEMORY_DIR, HEX_PASS, HEX_THREAD } = process.env
  if (process.argv[2] === 'seed') {
    const wake = Bun.spawnSync([join(import.meta.dir, '..', 'bin', 'wake'), 'all'], { stdout: 'pipe' }).stdout.toString()
    console.log(await seed(HEX_STORE ?? join(hexDir, 'state'), { wake }))
  } else if (HEX_PASS) {
    const { session, reply, by, thread } = JSON.parse(await Bun.stdin.text()) as Pass
    await observe(HEX_STORE!, session, reply, { by, thread })
  } else if (HEX_STORE && MEMORY_DIR && existsSync(MEMO)) {
    const hook = JSON.parse((await Bun.stdin.text()) || '{}') as Hook
    const pass: Pass = { session: hook.session_id ?? '', reply: hook.last_assistant_message ?? '', by: new Date().toISOString(), thread: HEX_THREAD }
    if (pass.session) {
      const log = openSync(join(HEX_STORE, 'observe.log'), 'a')
      const child = spawn(process.execPath, [import.meta.path], { detached: true, stdio: ['pipe', 'ignore', log], env: { ...process.env, HEX_PASS: '1' } })
      child.stdin!.end(JSON.stringify(pass))
      child.unref()
    }
  }
}
