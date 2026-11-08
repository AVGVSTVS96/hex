import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { dirname, join } from 'path'
import { above } from '../../hub/fit.ts'
import type { Question as Asked } from '../../hub/ledger.ts'
import { open as store, shown, type Row, type Store } from '../../hub/store.ts'
import type { Answer, CheckResult, Curated, Ref, Source } from './questions.ts'
import { generalOf, nameOf } from './activity.ts'
import { relay } from './relay.ts'
import { T3, type Stuck } from './t3.ts'

type Verdict = Pick<CheckResult, 'asks' | 'fixed' | 'flagged' | 'stuck'> & { settle: (Ref & { note: string })[] }
type Known = { threads: Record<string, string>; calls: { id: string }[]; answered?: Record<string, Pick<Answer, 'label' | 'at'>> }

const MODEL = process.env.HEX_CHECK_MODEL ?? 'opus'
const CALLS = join(homedir(), '.claude', 'channels', 'voice', 'calls')
const RECENT = 3 * 24 * 60 * 60_000
const LONG = 2400

// hex's check: an Opus pass over everything waiting on the owner, started by real events (a pinned
// post changed, a T3 run ended, a call ended, Tasks opened after a change). It rewrites the raw
// questions into one list (repeats merged, its pick, what each unblocks), settles the questions the
// records show are already decided or done, and flags what it can't settle. It answers nothing for
// them. One runs at a time in a process of its own, so it outlives the voice session that started
// it. Events that land while it runs leave one mark, so a burst of them costs one more pass at
// most, and a pass whose records haven't changed since the last one skips Opus.
export class Check {
  private dir: string

  constructor(private state: string) {
    this.dir = join(state, 'voice', 'check')
    mkdirSync(this.dir, { recursive: true })
  }

  get running() {
    const pid = Number(read(join(this.dir, 'lock')))
    return !!pid && alive(pid)
  }

  start(why: string) {
    writeFileSync(join(this.dir, 'next'), why)
    if (!this.running) spawn(process.execPath, [import.meta.path, this.state], { detached: true, stdio: 'ignore' }).unref()
  }
}

// Whoever holds the lock runs a pass per mark until none is left; a mark left in the moment the
// lock is let go is picked up again, by this process or the one that took the lock.
async function run(state: string) {
  const dir = join(state, 'voice', 'check')
  while (existsSync(join(dir, 'next')) && hold(join(dir, 'lock'))) {
    try {
      for (let why = take(join(dir, 'next')); why; why = take(join(dir, 'next'))) {
        await pass(state, why).then(
          () => rmSync(join(dir, 'error'), { force: true }),
          error => failed(state, `${new Date().toISOString()} ${why}: ${error instanceof Error ? error.message : error}`),
        )
      }
    } finally {
      rmSync(join(dir, 'lock'), { force: true })
    }
  }
}

// A failed pass leaves its error in check/error until one succeeds, and General hears of the first
// in a run of them, since until then the owner's list goes stale with nothing settled.
export function failed(state: string, error: string) {
  const file = join(state, 'voice', 'check', 'error')
  const first = !existsSync(file)
  writeFileSync(file, `${error}\n`)
  const general = first && generalOf(store(state).threads())
  if (general) store(state).deliver({ key: `check:failed:${createHash('sha256').update(error).digest('hex').slice(0, 12)}`, to: general.thread, from: 'check', author: 'prompt', body: `[check] hex's question check failed, so nothing on the owner's Needs you list settles until it runs again: ${clip(error, 600)}. Its next failures stay in ${file} until a pass succeeds.`, meta: { user: 'check' } })
}

function hold(lock: string): boolean {
  try {
    writeFileSync(lock, String(process.pid), { flag: 'wx' })
    return true
  } catch {
    if (alive(Number(read(lock)))) return false
    rmSync(lock, { force: true })
    return hold(lock)
  }
}

async function pass(state: string, why: string) {
  const started = new Date().toISOString()
  const records = gather(state)
  const inputs = digest(records)
  if (records.previous?.inputs === inputs) return
  const hexDir = dirname(state)
  const verdict = vet(await claude(prompt(records, hexDir), hexDir, state), records.ledgers, { threads: records.threads, calls: records.calls, answered: records.answered })
  for (const ref of verdict.settle) await relay(state, ref.app, { type: 'settle', thread: ref.thread, message: ref.message, note: ref.note }).catch(error => process.stderr.write(`voice: check: ${error}\n`))
  const result: CheckResult = {
    at: started,
    why,
    read: {
      'pinned posts': records.pins.length,
      questions: records.open.length,
      'T3 items': records.t3.stuck.length + records.t3.fresh.length,
      calls: records.calls.length,
    },
    asks: verdict.asks,
    fixed: verdict.fixed,
    flagged: verdict.flagged,
    stuck: verdict.stuck,
    inputs,
  }
  const file = join(state, 'voice', 'check.json')
  writeFileSync(`${file}.tmp`, JSON.stringify(result, null, 1) + '\n')
  renameSync(`${file}.tmp`, file)
}

function gather(state: string) {
  const now = Date.now()
  const recent = new Date(now - RECENT).toISOString()
  const names: Record<string, string> = {}
  const pins: { pin: Ref; topic: string; text: string }[] = []
  const questions = store(state).questions({ asker: 'hex' })
  const threads = store(state).threads()
  const general = generalOf(threads)
  for (const thread of threads) if (thread.app !== 'voice') names[`${thread.app}:${thread.thread}`] = nameOf(thread, general)
  const ledgers = Object.groupBy(questions.filter(question => question.app !== 'voice' && question.options.length), question => question.app) as Record<string, Asked[]>
  for (const pin of store(state).pins()) if (pin.note) pins.push({ pin: { app: pin.app, thread: pin.thread, message: pin.message }, topic: names[`${pin.app}:${pin.thread}`] ?? pin.thread, text: clip(pin.note, LONG) })
  const shown = (app: string, question: Asked) => ({
    ref: { app, thread: question.thread, message: question.message },
    topic: names[`${app}:${question.thread}`] ?? question.thread,
    at: question.at,
    text: clip(question.text, 700),
    options: question.options,
    ...(question.poll && { poll: true }),
    ...(question.answer && { answer: question.answer }),
    ...(question.settled && { settled: question.settled }),
  })
  const open = Object.entries(ledgers).flatMap(([app, questions]) => questions.filter(question => !question.answer && !question.settled).map(question => ({ ...shown(app, question), before: before(store(state), app, question) })))
  const closed = Object.entries(ledgers).flatMap(([app, questions]) => questions.filter(question => (question.answer || question.settled) && question.at > recent).map(question => shown(app, question)))
  const t3 = new T3(() => {})
  const t3Now = t3.query(now)
  t3.close()
  const calls = list(CALLS)
    .filter(file => file.endsWith('.json') && statSync(join(CALLS, file)).mtimeMs > now - RECENT)
    .map(file => json(join(CALLS, file)))
    .filter(call => call?.ended && (call.summary || call.waiting?.length))
    .map(call => ({ id: call.id, title: call.title, ended: call.ended, summary: call.summary, waiting: call.waiting ?? [] }))
  const answers: Record<string, Answer> = json(join(state, 'voice', 'marks.json'))?.answers ?? {}
  const answered = Object.fromEntries(Object.entries(answers).flatMap(([id, answer]) => (final(answer) ? [[id, { label: answer.label, at: answer.at, ...(answer.question && { question: answer.question }), ...(answer.told && { told: answer.told }) }]] : [])))
  return { now: new Date(now).toISOString(), threads: names, open, closed, answered, pins, calls, t3: t3Now, previous: json(join(state, 'voice', 'check.json')), ledgers }
}

// What hex said in a thread in the hour before it asked a question there, where its explanation
// usually is: its last two messages there, oldest first. Left out are the rows the owner never read
// as hex's words there (failed sends, edits, permission prompts, files without a caption, forwards, status posts), the
// thread's questions, and the question's own earlier parts, sent with it a moment before.
export function before(store: Store, app: string, question: Asked, max = 700) {
  const rows = store.said(question.thread, -1, question.at, new Date(Date.parse(question.at) - 60 * 60_000).toISOString())
  const id = (row: Row) => row.key.slice(row.key.lastIndexOf(':') + 1)
  const asked = Date.parse(rows.find(row => id(row) === String(question.message))?.at ?? question.at)
  const questions = new Set(store.questions({ app, thread: question.thread }).map(other => String(other.message)))
  const part = (row: Row) => !!bare(row.body) && Date.parse(row.at) > asked - 60_000 && bare(question.text).includes(bare(row.body))
  return rows
    .filter(row => row.from === app && row.author === 'hex' && shown(row) && !/^\(file: .*\)$/.test(row.body) && !row.meta?.forwarded && above(row.body) === row.body.trim())
    .filter(row => !questions.has(id(row)) && !part(row))
    .slice(-2)
    .map(row => clip(row.body, max))
}

// A message's words without the code fences a long message gains where it's cut into parts.
function bare(text: string) {
  return text.replace(/^```.*$/gm, '').trim()
}

// What a pass reads, as one fingerprint: the same records give the same verdict.
export function digest({ open, closed, answered, pins, calls, t3 }: ReturnType<typeof gather>) {
  return createHash('sha256').update(JSON.stringify({ open, closed, answered, pins, calls, t3 })).digest('hex')
}

function prompt({ ledgers, ...records }: ReturnType<typeof gather>, hexDir: string) {
  return `You're hex's check. hex is a personal assistant (its owner, and their rules, are in ${hexDir}/AGENTS.md): it works for its owner in many threads at once (Telegram topics, Discord threads, T3 Code threads, calls with its voice app), and each thread asks them things: questions with buttons, polls, the "waiting on you" part of its pinned status post, and the waiting lines of a call's wrap-up. They pile up in dozens of places and many go stale. Your pass turns them into one honest list in their voice app, where they answer each in place.

It's there so the owner can manage their tasks with hex: by going through the transcripts, gathering, auditing and checking on work other agents did, including older work from a day or two ago that might not be done, it shows what needs to get done so they can ship more and get unblocked.

The records are below as JSON: every open question asked with buttons or a poll (open, each with its ref and before: what hex said in its thread just before asking), the ones answered or settled lately (closed), the asks they answered in the app or on a call (answered, by id: their answer, when, the question and the threads told), each thread's pinned post (pins, each with its own ref), calls' wrap-ups (calls, each with its id), what T3 Code shows as stuck or newly finished (t3; the app lists those already), and your previous pass (previous). To confirm something before you settle it, read their records: every message hex.db holds in messages.md in your folder (one heading per message: author, app, thread, time, key; rg it), every thread hex has had in threads.json in your folder (app, thread, name, open, session, cwd, link), session transcripts under ~/.claude/projects/, project notes under ${hexDir}/projects/. In a transcript, the owner's messages arrive as <channel source="..." chat_id="..." message_id="..."> and hex's own replies come back as "sent (id: N)", so a question asked in plain words has a message id there.

Return:
- asks: one entry per decision or action that is still theirs, however many places asked it. from lists every place that asked it, so they can open each one: an open question (copy its ref), a pinned post (copy the pin's ref), a plain message you found ({app, thread, message} with its id, or {app, thread} when you can't find the id), or a call ({app: "voice", call: its id}); thread is a key of threads without its "<app>:" prefix. Leave none out: an ask from a pinned post and a call has both. id is "check:" plus a short slug, the same slug as in your previous pass for the same thing, never one in answered. task is the thread it belongs to ("<app>:<thread id>", from threads). question is one short plain line (60 characters at most). context is a few short plain sentences they can follow cold, without opening the thread: what the thing is, what its terms mean, and what each option means for them, in words rather than message numbers. options are their possible answers, as short labels, each one telling the thread something; mark the thread's own pick with pick (one at most, only where the thread made one); when an option stands for a button, value is that button's exact text from the first open question in from. links are the pages it points to, never answers: label names the page in one to three words without a verb ("Apple Store", "PR #2", "Paper file"), url opens it. kind is pick (one of several), yesno (two ways), do (only their hands can do it, like a sign-in, a purchase, a recording: options like Done and Later, its page in links) or look (something to watch or read: options like Seen and Later, its page in links). tag is "money" when an option spends money, or "unblocks N" when N other things wait on it. Order: what unblocks the most first, even when it costs money, then the quickest; other money and anything sent in their name last. An ask's task is the thread it belongs to, even when only a pinned post or a call asked it.
- settle: open questions the records show are already decided or done: decided in a conversation or a call, replaced by a later question, or the thing already happened. note is what the question's buttons in Telegram or Discord will say instead, like "Settled: Pro is on" (40 characters at most). Settle only what the records show; anything you're unsure of stays an ask.
- fixed: what you settled or merged, the way they'd read it: title (the thing), text (the evidence in plain words: who said or did what, and when), did (what you did, in a few words).
- flagged: what they should look at that you can't settle yourself, like the same thing asked with different options, or a question days old whose work has stalled: title and text.
- stuck: work stopped with nobody moving it that the t3 list doesn't already show, like a failing service a pinned post mentions: id (a short slug), title, why (one sentence), action (one or two words, like Restore or Look), mark (paused or failed), at, and request: what hex should do when they tap the action, as a message to hex.

Every answer is theirs: an ask stays open until they answer it. One in answered is answered: leave it out. Anything new, and a thread asking it again after the answer, gets an id that isn't in answered. Leave health details and phone numbers out of everything you write.

${JSON.stringify(records)}`
}

const NOTE = { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string' }, did: { type: 'string' } }, required: ['title', 'text'] }
const REF = { type: 'object', properties: { app: { type: 'string' }, thread: { type: 'string' }, message: { type: ['number', 'string'] } }, required: ['app', 'thread', 'message'] }
const SOURCE = { type: 'object', properties: { ...REF.properties, call: { type: 'string' } }, required: ['app'] }
const SCHEMA = {
  type: 'object',
  properties: {
    asks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          kind: { enum: ['pick', 'yesno', 'do', 'look'] },
          task: { type: 'string' },
          at: { type: 'string' },
          question: { type: 'string' },
          context: { type: 'string' },
          options: {
            type: 'array',
            items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' }, pick: { type: 'boolean' } }, required: ['label'] },
          },
          links: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, url: { type: 'string' } }, required: ['label', 'url'] } },
          tag: { type: 'string' },
          from: { type: 'array', items: SOURCE },
        },
        required: ['id', 'kind', 'task', 'at', 'question', 'options', 'from'],
      },
    },
    settle: { type: 'array', items: { ...REF, properties: { ...REF.properties, note: { type: 'string' } }, required: [...REF.required, 'note'] } },
    fixed: { type: 'array', items: NOTE },
    flagged: { type: 'array', items: NOTE },
    stuck: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, title: { type: 'string' }, why: { type: 'string' }, action: { type: 'string' }, mark: { enum: ['paused', 'failed'] }, at: { type: 'string' }, request: { type: 'string' } },
        required: ['id', 'title', 'why', 'action', 'mark', 'at'],
      },
    },
  },
  required: ['asks', 'settle', 'fixed', 'flagged', 'stuck'],
}

function messages(hexDir: string) {
  try {
    const run = Bun.spawnSync([join(hexDir, '.hex', 'bin', 'hex'), 'log'])
    return run.success ? run.stdout : `The messages couldn't be read: ${run.stderr}`
  } catch (error) {
    return `The messages couldn't be read: ${error}`
  }
}

// A read-only pass: it reads files and searches, its own folder holding every message (messages.md,
// as `hex log` prints them) and every thread (threads.json), and its only effect is the JSON it returns.
function claude(input: string, hexDir: string, state: string) {
  const args = ['-p', '--model', MODEL, '--effort', 'medium', '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA), '--tools', 'Read,Grep,Glob', '--safe-mode', '--no-session-persistence', '--add-dir', hexDir, join(homedir(), '.claude', 'projects')]
  const cwd = mkdtempSync(join(tmpdir(), 'hex-check-'))
  writeFileSync(join(cwd, 'messages.md'), messages(hexDir))
  writeFileSync(join(cwd, 'threads.json'), JSON.stringify(store(state).threads(), null, 1))
  return new Promise<Verdict>((resolve, reject) => {
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HEX_') && !name.startsWith('CLAUDECODE'))), CLAUDE_CODE_ENTRYPOINT: 'hex', HEX_HELPER: 'check' }
    const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.stderr.on('data', chunk => (err += chunk))
    child.on('error', reject)
    child.on('close', code => {
      rmSync(cwd, { recursive: true, force: true })
      try {
        const result = JSON.parse(out)
        if (result.is_error || !result.structured_output) throw new Error(result.result ?? 'no result')
        resolve(result.structured_output)
      } catch (error) {
        reject(new Error(`the check's claude exited ${code}: ${error} ${err.slice(-500)}`))
      }
    })
    child.stdin.end(input)
  })
}

// What the pass returned, held to the records: its places are real threads, questions and calls (a
// closed thread's question still is), the open questions among them are its refs, a value is a
// real button, a link opens a page or an app, and a question it settles isn't also one it lists. An
// answered ask it lists again without buttons is flagged for them to look at, not listed, since the
// app hides an answered id for good.
export function vet(verdict: Verdict, ledgers: Record<string, Asked[]>, { threads, calls, answered = {} }: Known): Verdict {
  const find = (ref: Ref) => ledgers[ref.app]?.find(question => question.thread === ref.thread && String(question.message) === String(ref.message))
  const open = (ref: Ref) => {
    const question = find(ref)
    return !!question && !question.answer && !question.settled
  }
  const real = (source: Source) =>
    source.call ? calls.some(call => call.id === source.call) : !!source.thread && (`${source.app}:${source.thread}` in threads || !!find(source as Ref))
  const curated: Curated[] = verdict.asks.map(({ from = [], ...question }) => {
    const places: Source[] = from.filter(real).map(({ app, thread, message, call }) => (call ? { app: 'voice', call } : { app, thread, ...(message !== undefined && { message }) }))
    const refs: Ref[] = places.flatMap(({ app, thread, message }) => (thread && message !== undefined && open({ app, thread, message }) ? [{ app, thread, message }] : []))
    const buttons = refs[0] ? find(refs[0])!.options : []
    return {
      ...question,
      id: question.id.startsWith('check:') ? question.id : `check:${question.id}`,
      options: question.options.map(({ value, ...option }) => ({ ...option, ...(value && buttons.includes(value) && { value }) })),
      ...(question.links && { links: question.links.filter(link => opens(link.url)) }),
      from: places,
      refs,
    }
  })
  const again = (question: Curated) => !!answered[question.id] && !question.refs?.length
  const listed = new Set(curated.flatMap(question => question.refs ?? []).map(ref => `${ref.app} ${ref.thread} ${ref.message}`))
  return {
    asks: curated.filter(question => !again(question)),
    settle: verdict.settle.filter(ref => open(ref) && !listed.has(`${ref.app} ${ref.thread} ${ref.message}`)).map(ref => ({ ...ref, note: ref.note.slice(0, 60) })),
    fixed: verdict.fixed,
    flagged: [
      ...verdict.flagged,
      ...curated.filter(again).map(question => ({ title: question.question, text: `You answered this "${answered[question.id]!.label}" on ${answered[question.id]!.at.slice(0, 10)}, and the check found it asked again.` })),
    ],
    stuck: verdict.stuck.map((item: Omit<Stuck, 'app'>) => ({ ...item, id: item.id.startsWith('check-') ? item.id : `check-${item.id}` })),
  }
}

// An answer that went through and had no buttons to answer: nothing but its mark keeps its ask
// answered, so it's kept for good and the check is told of it.
export function final(answer: Answer) {
  return !answer.refs?.length && !answer.missed?.length && !answer.undoing
}

// What a link may open on the phone: a web page, or a chat app's own link to a place in it.
export function opens(url: string) {
  return /^(?:https?|tg|buzz|t3code(?:-[a-z]+)?):\/\/\S/i.test(url)
}

function take(file: string) {
  const why = read(file)
  rmSync(file, { force: true })
  return why || undefined
}

function read(file: string) {
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

function json(file: string) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {}
}

function list(dir: string) {
  return existsSync(dir) ? readdirSync(dir) : []
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '').trimEnd()}…` : text
}

function alive(pid: number) {
  try {
    return process.kill(pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

if (import.meta.main) await run(process.argv[2]!)
