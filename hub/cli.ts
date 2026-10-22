import { realpathSync } from 'fs'
import { dirname, join } from 'path'
import { parseArgs } from 'util'
import { holds, keysOf, problems, verdict } from './notes.ts'
import { running, serving } from './running.ts'
import { entry, render, waiting } from './tasks.ts'
import { zoneOf } from './schedule.ts'
import { asked, open, type Row, type Status, type Task } from './store.ts'

const USAGE = `usage:
  hex deliver <from>:<id> --to <thread> [--user <name>] <words…>
  hex task new <message key> --title '<what the owner wants, in a few plain words>' [--quote <part of it>] [--owner <thread>] [--project <name>] [--done-when <outcome>] [--idea]
  hex task add <task> <message key> [--quote <part of it>]
  hex task quote <task> <message key> --quote <part of it>
  hex task done <task> --proof <link or fact>
  hex task drop <task> [--into <task it repeats>]
  hex task open <task>
  hex task edit <task> [--title '<title>'] [--owner <thread>] [--project <name>] [--done-when <outcome>]
  hex task <task> [--json]
  hex tasks [--owner <thread> | --all] [--status open,idea,done,dropped] [--json]
  hex questions [--thread <thread> | --all] [--json]
  hex pins [--thread <thread> | --all] [--json]
  hex threads [--json]
  hex running [--json]
  hex message <key>
  hex profile [--all] [--json]
  hex log [<thread, by name or id, or a terminal session's id>] [--since <date>] [--last <n>] [--taken] [--room <characters>] [--json]
  hex recall <regex>`

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    to: { type: 'string' },
    user: { type: 'string' },
    title: { type: 'string' },
    quote: { type: 'string' },
    owner: { type: 'string' },
    thread: { type: 'string' },
    project: { type: 'string' },
    'done-when': { type: 'string' },
    idea: { type: 'boolean' },
    proof: { type: 'string' },
    into: { type: 'string' },
    status: { type: 'string' },
    all: { type: 'boolean' },
    json: { type: 'boolean' },
    since: { type: 'string' },
    last: { type: 'string' },
    taken: { type: 'boolean' },
    room: { type: 'string' },
  },
})
const [state, command, ...args] = positionals
if (!state || !command) usage()
// How many words each command takes before its flags; a word past them is a flag's value left
// unquoted, which would otherwise be cut short without a word.
const takes = command === 'task' ? ({ add: 3, quote: 3, new: 2, done: 2, drop: 2, open: 2, edit: 2 } as Record<string, number>)[args[0] ?? ''] ?? 1 : ({ deliver: Infinity, message: 1, recall: 1, log: 1 } as Record<string, number>)[command] ?? 0
if (args.length > takes) {
  console.error(`hex: ${stray(args[takes]!)}`)
  process.exit(1)
}
const store = open(state)
// A thread named the way every --json output names it, <app>:<key>, is the bare key hex.db's
// messages, tasks, questions and pins keep.
for (const flag of ['owner', 'thread', 'to'] as const) flags[flag] &&= keyOf(flags[flag])

function usage(): never {
  console.error(USAGE)
  process.exit(2)
}

// One task in full, with the owner's words; a list as one clean entry per task.
function show(tasks: Task[], full = true) {
  if (flags.json) return json(withThread(tasks, task => task.owner))
  const named = store.names()
  console.log(tasks.map(task => (full ? render(task, named) : entry(task, named))).join(full ? '\n\n' : '\n') || 'no tasks')
}

// Every line memo recalls, with the words of each message a note names by its [key] under it, what
// doesn't hold when the note misquotes them, and a count of how many notes keep the owner's words.
async function recall(pattern: string) {
  const memo = Bun.spawn([join(dirname(import.meta.dir), 'vendor', 'memo'), 'recall', pattern], { stdout: 'pipe', stderr: 'inherit' })
  let notes = 0, keyed = 0, kept = 0
  for (const line of (await new Response(memo.stdout).text()).split('\n')) {
    console.log(line)
    if (!/^#\d+ /.test(line)) continue
    notes++
    const v = verdict(line, store)
    if (!keysOf(line).length) continue
    keyed++
    if (holds(v)) kept++
    else console.log(problems(v, false).map(why => `    ✗ ${why}`).join('\n'))
    for (const said of v.keys) console.log(said.body.split('\n').map(words => `    ${words}`).join('\n'))
  }
  if (notes) console.log(`${notes} notes: ${keyed} name a message, ${kept} quote it as written.`)
  process.exitCode = await memo.exited
}

// Every --json output names a thread one way, as <app>:<key>: a thread's id, and the threadId of what
// belongs to one (a task's owner, a message's thread, a question, a pin), where hex.db knows the app.
function json(value: unknown) {
  console.log(JSON.stringify(value, null, 1))
}

function withThread<T>(rows: T[], key: (row: T) => string) {
  const ids = store.ids()
  return rows.map(row => ({ ...row, ...(ids[key(row)] && { threadId: ids[key(row)] }) }))
}

function keyOf(id: string) {
  const split = id.indexOf(':')
  return split > 0 && store.threads({ app: id.slice(0, split) }).some(({ thread }) => thread === id.slice(split + 1)) ? id.slice(split + 1) : id
}

function stray(word: string) {
  return `"${word}" isn't a flag's value: quote every value that has spaces, like --title 'Fix the login page'`
}

// A thread by its id, or by its name the way the hub finds one: any case, and only one thread.
function threadOf(named: string) {
  const nameOrThread = keyOf(named)
  const threads = store.threads()
  if (threads.some(({ thread }) => thread === nameOrThread)) return nameOrThread
  const wanted = nameOrThread.trim().toLowerCase()
  const matches = [...new Set(threads.filter(({ name }) => name.toLowerCase() === wanted).map(({ thread }) => thread))]
  if (matches.length > 1) throw new Error(`more than one thread is named "${nameOrThread}": ${matches.join(', ')}`)
  if (matches[0]) return matches[0]
  if (store.said(nameOrThread, 1).length) return nameOrThread
  throw new Error(`no thread named "${nameOrThread}"`)
}

// Messages as markdown, one heading each, in the owner's time zone, for rg to search. Within room,
// the newest whole messages that fit, or the newest's heading and the end of its words when none does.
function log(rows: Row[]) {
  const room = flags.room === undefined ? Infinity : Number(flags.room)
  if (!(room === Infinity || (Number.isInteger(room) && room > 0)) || (flags.room !== undefined && flags.json)) usage()
  if (flags.json) return json(withThread(rows, row => row.to))
  const zone = zoneOf(dirname(state!)) ?? Temporal.Now.timeZoneId()
  const named = open(state!).names()
  const entries = rows.map(row => {
    const at = Temporal.Instant.from(row.at).toZonedDateTimeISO(zone).toPlainDateTime().toString().slice(0, 16).replace('T', ' ')
    const failed = row.meta?.failed ? ` · failed: ${row.meta.failed}` : ''
    const body = row.from === 't3' && row.author === 'owner' ? asked(row.body) : row.body
    const thread = named[row.to] ? `${named[row.to]} (${row.to})` : row.to
    const id = row.meta?.message_id ? ` · message ${row.meta.message_id}` : ''
    const who = row.meta?.user && (row.author === 'prompt' || row.author === 'other') ? `${row.author} (${row.meta.user})` : row.author
    return `## ${who} · ${row.from} · ${thread} · ${at} · [${row.key}]${id}${failed}\n\n${body}\n`
  })
  let start = entries.length
  for (let size = 0; start && (size += entries[start - 1]!.length + 1) <= room; ) start--
  for (const entry of start < entries.length || !entries.length ? entries.slice(start) : [end(entries.at(-1)!, room)]) console.log(entry)
}

function end(entry: string, room: number) {
  const head = entry.slice(0, entry.indexOf('\n\n') + 2)
  let from = Math.max(head.length, entry.length - Math.max(0, room - head.length - 2))
  if (/[\uDC00-\uDFFF]/.test(entry[from] ?? '')) from++
  return `${head}…${entry.slice(from)}`
}

function task(verb: string | undefined, id: string | undefined, key: string | undefined) {
  const thread = process.env.HEX_THREAD
  switch (verb) {
    case 'new': {
      const said = id && store.message(id)
      if (!said) throw new Error(id ? `no message ${id}` : 'name the message the task comes from by its key')
      return show([store.createTask({ title: flags.title!, message: id!, quote: flags.quote, owner: flags.owner ?? thread ?? said.to, project: flags.project, doneWhen: flags['done-when'], status: flags.idea ? 'idea' : 'open' })])
    }
    case 'add':
      if (!id || !key) usage()
      return show([store.addWords(id, key, flags.quote)])
    case 'quote':
      if (!id || !key || !flags.quote) usage()
      return show([store.requote(id, key, flags.quote)])
    case 'done':
      if (!id || !flags.proof) throw new Error('a task is done with --proof: a link or a fact that shows it')
      return show([store.editTask(id, { status: 'done', proof: flags.proof })])
    case 'drop':
      if (!id) usage()
      return show([flags.into ? store.mergeTasks(flags.into, id) : store.editTask(id, { status: 'dropped' })])
    case 'open':
      if (!id) usage()
      return show([store.editTask(id, { status: 'open' })])
    case 'edit':
      if (!id) usage()
      return show([store.editTask(id, { title: flags.title, owner: flags.owner, project: flags.project, doneWhen: flags['done-when'] })])
    default: {
      const found = verb && store.task(verb)
      if (!found) throw new Error(verb ? `no task ${verb}` : USAGE)
      return show([found])
    }
  }
}

try {
  switch (command) {
    case 'deliver': {
      const [key, ...words] = args
      const from = key?.split(':')[0]
      if (!from || from === key || !flags.to || !words.length) usage()
      store.deliver({ key: key!, to: flags.to, from, author: 'prompt', body: words.join(' '), meta: { user: flags.user ?? from } })
      break
    }
    case 'task':
      task(args[0], args[1], args[2])
      break
    case 'tasks':
      show(store.tasks({ owner: flags.owner ?? (flags.all || process.env.HEX_MAIN ? undefined : process.env.HEX_THREAD), status: (flags.status?.split(',') ?? ['open']) as Status[] }), false)
      break
    case 'questions': {
      const questions = store.questions({ thread: flags.thread ?? (flags.all || process.env.HEX_MAIN ? undefined : process.env.HEX_THREAD), waiting: true })
      if (flags.json) json(questions.map(question => ({ ...question, threadId: `${question.app}:${question.thread}` })))
      else console.log(questions.map(question => waiting(question, store.names())).join('\n') || 'no questions waiting')
      break
    }
    case 'pins': {
      const pins = store.pins({ thread: flags.thread ?? (flags.all || process.env.HEX_MAIN ? undefined : process.env.HEX_THREAD) })
      const names = new Map(store.threads().map(({ app, thread, name }) => [`${app}:${thread}`, name]))
      if (flags.json) json(pins.map(pin => ({ ...pin, threadId: `${pin.app}:${pin.thread}` })))
      else console.log(pins.map(pin => `${pin.app} · ${names.get(`${pin.app}:${pin.thread}`) ?? pin.thread} · message ${pin.message} · ${(pin.note || pin.text).trim().split('\n')[0]}`).join('\n') || 'no pins')
      break
    }
    case 'threads': {
      const threads = store.threads()
      if (flags.json) json(threads.map(thread => ({ id: `${thread.app}:${thread.thread}`, ...thread })))
      else console.log(threads.map(({ app, thread, name, open }) => `${app} ${thread} ${name}${open ? '' : ' (closed)'}`).join('\n'))
      break
    }
    case 'profile': {
      // The owner's profile as it is now, or with --all every version, newest first.
      const versions = flags.all ? store.profiles() : store.profiles().slice(0, 1)
      if (flags.json) console.log(JSON.stringify(flags.all ? versions : (versions[0] ?? null), null, 1))
      else console.log(versions.map(({ at, body }) => (flags.all ? `--- ${at}\n${body}\n` : body)).join('\n') || 'no profile yet')
      break
    }
    case 'running': {
      const threads = store.threads({ open: true })
      const held = new Map(threads.flatMap(({ app, thread, session }) => (session ? [[session, `${app}:${thread}`] as [string, string]] : [])))
      const names = new Map(threads.map(({ app, thread, name }) => [`${app}:${thread}`, name]))
      const sessions = running()
      const home = realpathSync(dirname(state!))
      const rows = [...sessions.values()].map(session => ({ ...session, thread: serving(session, sessions, held) }))
      if (flags.json) console.log(JSON.stringify(rows, null, 1))
      else console.log(rows.map(({ id, status, name, cwd, thread, state, detail, needs }) => {
        const now = (state === 'blocked' && needs) || detail
        return `${status} ${id.slice(0, 8)} ${name ?? ''}${cwd && cwd !== home ? ` in ${cwd}` : ''}${thread ? ` · ${names.get(thread) ?? thread} (${thread})` : ''}${state ? ` · ${state}${now ? `: ${now.replace(/\s+/g, ' ')}` : ''}` : ''}`
      }).join('\n') || 'nothing running')
      break
    }
    case 'message': {
      const said = args[0] && store.message(args[0])
      if (!said) throw new Error(`no message ${args[0] ?? ''}`)
      console.log(flags.json ? JSON.stringify(said, null, 1) : said.body)
      break
    }
    case 'log': {
      const zone = zoneOf(dirname(state!)) ?? Temporal.Now.timeZoneId()
      const since = flags.since ? new Date(Temporal.PlainDateTime.from(flags.since).toZonedDateTime(zone).epochMilliseconds).toISOString() : ''
      if (args.length && !args[0]) {
        console.error("hex log: name the thread, by its name or id")
        process.exit(2)
      }
      const thread = args[0] && threadOf(args[0])
      const rows = thread ? store.said(thread, flags.last ? Number(flags.last) : -1) : store.since(since)
      log(rows.filter(row => row.at > since && (!flags.taken || row.taken)))
      break
    }
    case 'recall':
      if (!args[0]) usage()
      await recall(args[0])
      break
    default:
      usage()
  }
} catch (error) {
  console.error(`hex: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}
