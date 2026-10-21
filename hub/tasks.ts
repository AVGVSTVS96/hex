import { clip, fit } from './fit.ts'
import { open, type Question, type Task } from './store.ts'

// Claude Code swaps a hook's output past 10,000 characters for a file path and a preview it
// doesn't ask Claude to read (https://code.claude.com/docs/en/hooks#json-output), so the list
// stays under it, with room for the lines that say what didn't fit.
const ROOM = 9_000

function facts(task: Task, named: Record<string, string>) {
  const facts = [task.status, named[task.owner] ?? task.owner, task.project && `project ${task.project}`, task.mergedInto && `merged into ${task.mergedInto}`]
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
  const said = messages > 1 ? `, ${messages} messages` : ''
  const line = `${facts(task, named).replace(/\)$/, `${said})`)}: ${clip(task.title, 150)}`
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
// left. Whatever is shorter, this or the whole list, is what a session gets.
export function changes(before: Record<string, string>, now: Record<string, string>, whole: string): string {
  const fresh = Object.entries(now).filter(([id, line]) => before[id] !== line).map(([, line]) => line)
  const gone = Object.entries(before).filter(([id]) => !(id in now)).map(([, line]) => line.split('\n')[0]!.replace(/^- /, ''))
  const text = [
    fresh.length && `New or changed since you last saw the list:\n${fresh.join('\n')}`,
    gone.length && `No longer open or waiting:\n${gone.map(line => `- ${line}`).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n')
  return text.length < whole.length ? text : whole
}

// The UserPromptSubmit and SessionStart hook: a session gets the whole list the first time and once a
// compaction or a clear took it away, and after that only what changed.
if (import.meta.main) {
  const { HEX_STORE, HEX_THREAD, HEX_MAIN } = process.env
  if (HEX_STORE) {
    try {
      const { session_id, source } = JSON.parse((await Bun.stdin.text()) || '{}') as { session_id?: string; source?: string }
      if (session_id) {
        const store = open(HEX_STORE)
        if (source === 'compact' || source === 'clear') store.unshow(session_id)
        const thread = HEX_MAIN || !HEX_THREAD ? undefined : HEX_THREAD
        const { text, seen } = pending(HEX_STORE, thread)
        const was = store.swap(session_id, Object.keys(seen).length ? JSON.stringify(seen) : '')
        const whole = text || 'No open tasks or questions waiting on me now.'
        const before = was && (JSON.parse(was.startsWith('{') ? was : 'null') as Record<string, string> | null)
        if (was !== null) console.log(before ? changes(before, seen, whole) : whole)
      }
    } catch (error) {
      console.error(`hex couldn't read its tasks: ${error}`)
    }
  }
}
