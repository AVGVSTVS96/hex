import { clip, fit, ROOM } from './fit.ts'
import { open, stateDir, type Question, type Task } from './store.ts'

function facts(task: Task, named: Record<string, string>, said?: string) {
  const facts = [task.status, named[task.owner] ?? task.owner, task.project && `project ${task.project}`, task.mergedInto && `merged into ${task.mergedInto}`, said]
  return `${task.id} (${facts.filter(Boolean).join(', ')})`
}

// A task as `hex task` shows it: its title and facts on one line, then each of the owner's words in
// full, under the key of the message they came from.
export function render(task: Task, named: Record<string, string> = {}): string {
  const lines = [`${facts(task, named)}: ${task.title}`]
  if (task.doneWhen) lines.push(`  done when: ${task.doneWhen}`)
  if (task.proof) lines.push(`  proof: ${task.proof}`)
  for (const words of task.words) {
    lines.push(`  [${words.message} · ${words.who} · ${words.at.slice(0, 16).replace('T', ' ')}Z]`)
    lines.push(...words.text.split('\n').map(line => `    ${line}`))
  }
  return lines.join('\n')
}

// A task as a session's prompt carries it: the clean entry, its title and what done looks like. The
// owner's words stay in hex.db, for `hex task` to show in full.
export function entry(task: Task, named: Record<string, string>, done = true) {
  const messages = new Set(task.words.map(words => words.message)).size
  const line = `${facts(task, named, messages > 1 ? `${messages} messages` : undefined)}: ${clip(task.title, 150)}`
  if (!done) return line
  return [line, task.doneWhen && `  done when: ${clip(task.doneWhen, 200)}`, task.status === 'done' && task.proof && `  proof: ${clip(task.proof, 200)}`].filter(Boolean).join('\n')
}

// A question as a session reads it: where it was asked, its first line, and its buttons.
export function waiting(question: Question, named: Record<string, string> = {}): string {
  return `- ${question.app} · ${named[question.thread] ?? question.thread} · message ${question.message} · ${question.at.slice(0, 16).replace('T', ' ')}Z: ${clip(question.text, 200)} [${question.options.join(' | ')}]`
}

// What a session should have before it acts: the questions still waiting on the owner, then the open
// tasks it serves, newest first, each as its clean entry. seen holds every entry by its id, those
// that didn't fit too, so the next push can say only what changed. Main sees every thread's; a
// thread sees its own.
export function pending(state: string, thread?: string, room = ROOM): { text: string; seen: Record<string, string> } {
  const store = open(state)
  const tasks = store.tasks({ owner: thread, status: ['open'] })
  const questions = store.questions({ thread, waiting: true })
  const named = store.names()
  const whose = thread ? 'This thread' : 'Every thread'
  const sections = [
    {
      header: `${whose}'s questions still waiting on my answer (edit_message with settled: true closes one that no longer stands):`,
      items: questions.map(question => [waiting(question, named)]),
      gap: '\n',
      rest: '`.hex/bin/hex questions` lists them all',
    },
    {
      header: `${whose}'s open tasks (\`.hex/bin/hex task <id>\` has my words in full, adds to them and closes them):`,
      items: tasks.map(task => [entry(task, named), entry(task, named, false)]),
      gap: '\n',
      rest: '`.hex/bin/hex tasks` lists them all',
    },
  ]
  const seen = Object.fromEntries([
    ...questions.map(question => [`${question.app}:${question.thread}:${question.message}`, waiting(question, named)]),
    ...tasks.map(task => [task.id, entry(task, named)]),
  ])
  return { text: fit(sections, room), seen }
}

// What changed between two pushes: each new or edited entry in full, and a line for each one that
// left.
export function changes(before: Record<string, string>, now: Record<string, string>): string {
  const fresh = Object.entries(now).filter(([id, line]) => before[id] !== line).map(([, line]) => line)
  const gone = Object.entries(before).filter(([id]) => !(id in now)).map(([, line]) => line.split('\n')[0]!.replace(/^- /, ''))
  return [
    fresh.length && `New or changed since you last saw the list:\n${fresh.join('\n')}`,
    gone.length && `No longer open or waiting:\n${gone.map(line => `- ${line}`).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

// The UserPromptSubmit and SessionStart hook: a session gets the whole list the first time and once a
// compaction or a clear took it away, and after that only what changed.
if (import.meta.main) {
  const { HEX_THREAD, HEX_MAIN, HEX_OWNER } = process.env
  try {
    const { session_id, source } = JSON.parse((await Bun.stdin.text()) || '{}') as { session_id?: string; source?: string }
    if (session_id) {
      const store = open(stateDir())
      if (source === 'compact' || source === 'clear') store.unshow(session_id, 'tasks')
      // A job's session works for the thread that started it (HEX_OWNER is <app>:<thread>).
      const thread = HEX_MAIN ? undefined : HEX_THREAD || (HEX_OWNER?.includes(':') ? HEX_OWNER.slice(HEX_OWNER.indexOf(':') + 1) : undefined)
      const { text, seen } = pending(stateDir(), thread)
      // Diffs since the last whole list add up in sent; once they'd pass its length, the whole list
      // goes again, so a session that lost a push catches up.
      const whole = text || 'No open tasks or questions waiting on me now.'
      const last = store.seen(session_id, 'tasks')
      const before = last.startsWith('{') ? (JSON.parse(last) as { seen: Record<string, string>; sent: number }) : null
      const diff = before && changes(before.seen, seen)
      const out = diff && before.sent + diff.length < whole.length ? diff : whole
      const record = Object.keys(seen).length ? JSON.stringify({ seen, sent: out === diff ? before!.sent + diff.length : 0 }) : ''
      if (before ? diff : record !== last) {
        store.show(session_id, 'tasks', record)
        console.log(out)
      }
    }
  } catch (error) {
    console.error(`hex couldn't read its tasks: ${error}`)
  }
}
