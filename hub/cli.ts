import { dirname, join } from 'path'
import { parseArgs } from 'util'
import { names, render, waiting } from './profile.ts'
import { open, type Status, type Task } from './store.ts'

const USAGE = `usage:
  hex deliver <from>:<id> --to <thread> [--user <name>] <words…>
  hex task new <message key> [--quote <part of it>] [--owner <thread>] [--project <name>] [--done-when <outcome>] [--idea]
  hex task add <task> <message key> [--quote <part of it>]
  hex task done <task> --proof <link or fact>
  hex task drop <task> [--into <task it repeats>]
  hex task open <task>
  hex task edit <task> [--owner <thread>] [--project <name>] [--done-when <outcome>]
  hex task <task> [--json]
  hex tasks [--owner <thread> | --all] [--status open,idea,done,dropped] [--json]
  hex questions [--thread <thread> | --all] [--json]
  hex threads [--json]
  hex message <key>
  hex recall <regex>`

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    to: { type: 'string' },
    user: { type: 'string' },
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
  },
})
const [state, command, ...args] = positionals
if (!state || !command) usage()
const store = open(state)

function usage(): never {
  console.error(USAGE)
  process.exit(2)
}

function show(tasks: Task[]) {
  if (flags.json) return console.log(JSON.stringify(tasks, null, 1))
  const named = names(state!)
  console.log(tasks.map(task => render(task, named)).join('\n\n') || 'no tasks')
}

// Every line memo recalls, with the words of each message a note names by its [key] under it.
async function recall(pattern: string) {
  const memo = Bun.spawn([join(dirname(import.meta.dir), 'vendor', 'memo'), 'recall', pattern], { stdout: 'pipe', stderr: 'inherit' })
  for (const line of (await new Response(memo.stdout).text()).split('\n')) {
    console.log(line)
    for (const [, key] of line.matchAll(/\[([a-z0-9]+:[^\]\s]+)\]/g)) {
      const said = store.message(key!)
      if (said) console.log(said.body.split('\n').map(words => `    ${words}`).join('\n'))
    }
  }
  process.exitCode = await memo.exited
}

function task(verb: string | undefined, id: string | undefined, key: string | undefined) {
  const thread = process.env.HEX_THREAD
  switch (verb) {
    case 'new': {
      const said = id && store.message(id)
      if (!said) throw new Error(id ? `no message ${id}` : 'name the message the task comes from by its key')
      return show([store.createTask({ message: id!, quote: flags.quote, owner: flags.owner ?? thread ?? said.to, project: flags.project, doneWhen: flags['done-when'], status: flags.idea ? 'idea' : 'open' })])
    }
    case 'add':
      if (!id || !key) usage()
      return show([store.addWords(id, key, flags.quote)])
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
      return show([store.editTask(id, { owner: flags.owner, project: flags.project, doneWhen: flags['done-when'] })])
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
      store.deliver({ key: key!, to: flags.to, from, body: words.join(' '), meta: { user: flags.user ?? from } })
      break
    }
    case 'task':
      task(args[0], args[1], args[2])
      break
    case 'tasks':
      show(store.tasks({ owner: flags.owner ?? (flags.all || process.env.HEX_MAIN ? undefined : process.env.HEX_THREAD), status: (flags.status?.split(',') ?? ['open']) as Status[] }))
      break
    case 'questions': {
      const questions = store.questions({ thread: flags.thread ?? (flags.all || process.env.HEX_MAIN ? undefined : process.env.HEX_THREAD), waiting: true })
      if (flags.json) console.log(JSON.stringify(questions, null, 1))
      else console.log(questions.map(question => waiting(question, names(state!))).join('\n') || 'no questions waiting')
      break
    }
    case 'threads': {
      const threads = store.threads()
      console.log(flags.json ? JSON.stringify(threads, null, 1) : threads.map(({ app, thread, name }) => `${app} ${thread} ${name}`).join('\n'))
      break
    }
    case 'message': {
      const said = args[0] && store.message(args[0])
      if (!said) throw new Error(`no message ${args[0] ?? ''}`)
      console.log(flags.json ? JSON.stringify(said, null, 1) : said.body)
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
