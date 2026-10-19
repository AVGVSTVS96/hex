import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { clip, fit } from './fit.ts'
import { open, type Question, type Task } from './store.ts'

// Each thread's name, from every app's threads.json in state.
export function names(state: string): Record<string, string> {
  const named: Record<string, string> = {}
  for (const app of readdirSync(state, { withFileTypes: true })) {
    if (!app.isDirectory()) continue
    try {
      const threads = JSON.parse(readFileSync(join(state, app.name, 'threads.json'), 'utf8')) as Record<string, { name?: string }>
      for (const [key, { name }] of Object.entries(threads)) named[key] = name ?? key
    } catch {}
  }
  return named
}

// Claude Code swaps a hook's output past 10,000 characters for a file path and a preview it
// doesn't ask Claude to read (https://code.claude.com/docs/en/hooks#json-output), so the list
// stays under it, with room for the lines that say what didn't fit.
const ROOM = 9_000

function facts(task: Task, named: Record<string, string>) {
  const facts = [task.status, named[task.owner] ?? task.owner, task.project && `project ${task.project}`, task.mergedInto && `merged into ${task.mergedInto}`]
  return `${task.id} (${facts.filter(Boolean).join(', ')})`
}

// A task as a session reads it: the facts on one line, then each of the owner's words in full,
// under the key of the message they came from.
export function render(task: Task, named: Record<string, string> = {}): string {
  const lines = [facts(task, named)]
  if (task.doneWhen) lines.push(`  done when: ${task.doneWhen}`)
  if (task.proof) lines.push(`  proof: ${task.proof}`)
  for (const words of task.words) {
    lines.push(`  [${words.message} · ${words.who} · ${words.at.slice(0, 16).replace('T', ' ')}Z]`)
    lines.push(...words.text.split('\n').map(line => `    ${line}`))
  }
  return lines.join('\n')
}

// A task in one line, for when its words don't fit, and where to read them.
function brief(task: Task, named: Record<string, string>) {
  return `${facts(task, named)}: ${clip(task.words[0]?.text ?? '', 150)} (\`.hex/bin/hex task ${task.id}\` has my words in full)`
}

// A question as a session reads it: where it was asked, its first line, and its buttons.
export function waiting(question: Question, named: Record<string, string> = {}): string {
  return `- ${question.app} · ${named[question.thread] ?? question.thread} · message ${question.message} · ${question.at.slice(0, 16).replace('T', ' ')}Z: ${clip(question.text, 200)} [${question.options.join(' | ')}]`
}

// What a session should have before it acts: the open tasks it serves, each in the owner's own
// words, the questions still waiting on the owner, and a digest of all of it, so a change to words that didn't fit still counts. Main sees
// every thread's; a thread sees its own.
export function profile(state: string, thread?: string): { text: string; digest: string } {
  const store = open(state)
  const tasks = store.tasks({ owner: thread, status: ['open'] })
  const questions = store.questions({ thread, waiting: true })
  const named = names(state)
  const whose = thread ? 'This thread' : 'Every thread'
  const sections = [
    {
      header: `${whose}'s open tasks, each with my words as I said them (\`.hex/bin/hex task\` adds to them and closes them):`,
      items: tasks.map(task => [render(task, named), brief(task, named)]),
      gap: '\n\n',
      rest: '`.hex/bin/hex tasks` lists them all',
    },
    {
      header: `${whose}'s questions still waiting on my answer (edit_message with settled: true closes one that no longer stands):`,
      items: questions.map(question => [waiting(question, named)]),
      gap: '\n',
      rest: '`.hex/bin/hex questions` lists them all',
    },
  ]
  const text = fit(sections, ROOM)
  return { text, digest: text && Bun.hash(JSON.stringify(sections)).toString(36) }
}

// The UserPromptSubmit and SessionStart hook: a session gets the list whenever it changed since it
// last saw it, so it's in context without riding along on every prompt, and again in full once a
// compaction or a clear took it away.
if (import.meta.main) {
  const { HEX_STORE, HEX_THREAD, HEX_MAIN } = process.env
  if (HEX_STORE) {
    try {
      const { session_id, source } = JSON.parse((await Bun.stdin.text()) || '{}') as { session_id?: string; source?: string }
      if (session_id) {
        const store = open(HEX_STORE)
        if (source === 'compact' || source === 'clear') store.unshow(session_id)
        const { text, digest } = profile(HEX_STORE, HEX_MAIN || !HEX_THREAD ? undefined : HEX_THREAD)
        if (store.show(session_id, digest)) console.log(text || 'No open tasks or questions waiting on me now.')
      }
    } catch (error) {
      console.error(`hex couldn't read its tasks: ${error}`)
    }
  }
}
