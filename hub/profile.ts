import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clip, fit } from './fit.ts'
import { open, type Question, type Task } from './store.ts'

// The owner's profile, which the memory agent keeps current after every turn. bin/wake puts it in front
// of the memory every session starts with.
export const profilePath = (state: string) => join(state, 'profile.md')
export const profileOf = (state: string) => (existsSync(profilePath(state)) ? readFileSync(profilePath(state), 'utf8').trim() : '')

// Each thread's name, as hex.db keeps it after the thread closes.
export function names(state: string): Record<string, string> {
  return Object.fromEntries(open(state).threads().map(({ thread, name }) => [thread, name]))
}

// Claude Code swaps a hook's output past 10,000 characters for a file path and a preview it
// doesn't ask Claude to read (https://code.claude.com/docs/en/hooks#json-output), so the list
// stays under it, with room for the lines that say what didn't fit.
const ROOM = 9_000

export const PROFILE = 6_500

// A task's title, or its first words when it has none.
export const titleOf = (task: Task, room: number) => clip(task.title ?? task.words[0]?.text ?? '', room)

function facts(task: Task, named: Record<string, string>) {
  const facts = [task.status, named[task.owner] ?? task.owner, task.project && `project ${task.project}`, task.mergedInto && `merged into ${task.mergedInto}`]
  return `${task.id} (${facts.filter(Boolean).join(', ')})`
}

// A task as `hex task` shows it: its title and facts on one line, then each of the owner's words in
// full, under the key of the message they came from.
export function render(task: Task, named: Record<string, string> = {}): string {
  const lines = [task.title ? `${facts(task, named)}: ${task.title}` : facts(task, named)]
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
  const line = `${facts(task, named)}: ${task.title ? clip(task.title, 150) : `(no title yet: \`.hex/bin/hex task ${task.id}\`)`}`
  return done && task.doneWhen ? `${line}\n  done when: ${clip(task.doneWhen, 200)}` : line
}

// A question as a session reads it: where it was asked, its first line, and its buttons.
export function waiting(question: Question, named: Record<string, string> = {}): string {
  return `- ${question.app} · ${named[question.thread] ?? question.thread} · message ${question.message} · ${question.at.slice(0, 16).replace('T', ' ')}Z: ${clip(question.text, 200)} [${question.options.join(' | ')}]`
}

// What a session should have before it acts: the questions still waiting on the owner, then the open
// tasks it serves, newest first, each as its clean entry, and a digest of all of it, so a change to an entry that didn't
// fit still counts. Main sees every thread's; a thread sees its own.
export function profile(state: string, thread?: string, room = ROOM): { text: string; digest: string } {
  const store = open(state)
  const tasks = store.tasks({ owner: thread, status: ['open'] }).sort((a, b) => b.at.localeCompare(a.at))
  const questions = store.questions({ thread, waiting: true })
  const named = names(state)
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
  const text = fit(sections, room)
  const whole = tasks.map(task => [task.id, task.title, task.doneWhen])
  return { text, digest: text && Bun.hash(JSON.stringify([sections, whole])).toString(36) }
}

// The UserPromptSubmit and SessionStart hook: a session gets the list whenever it changed since it
// last saw it, and again once a compaction or a clear took it away.
if (import.meta.main) {
  const { HEX_STORE, HEX_THREAD, HEX_MAIN } = process.env
  if (HEX_STORE) {
    try {
      const { session_id, source } = JSON.parse((await Bun.stdin.text()) || '{}') as { session_id?: string; source?: string }
      if (session_id) {
        const store = open(HEX_STORE)
        if (source === 'compact' || source === 'clear') store.unshow(session_id)
        const thread = HEX_MAIN || !HEX_THREAD ? undefined : HEX_THREAD
        const { text, digest } = profile(HEX_STORE, thread)
        if (store.show(session_id, digest)) console.log(text || 'No open tasks or questions waiting on me now.')
      }
    } catch (error) {
      console.error(`hex couldn't read its tasks: ${error}`)
    }
  }
}
