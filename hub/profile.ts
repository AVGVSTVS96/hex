import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { open, type Task } from './store.ts'

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

// A task as a session reads it: the facts on one line, then each of the owner's words in full,
// under the key of the message they came from.
export function render(task: Task, named: Record<string, string> = {}): string {
  const facts = [task.status, named[task.owner] ?? task.owner, task.project && `project ${task.project}`, task.mergedInto && `merged into ${task.mergedInto}`].filter(Boolean)
  const lines = [`${task.id} (${facts.join(', ')})`]
  if (task.doneWhen) lines.push(`  done when: ${task.doneWhen}`)
  if (task.proof) lines.push(`  proof: ${task.proof}`)
  for (const words of task.words) {
    lines.push(`  [${words.message} · ${words.who} · ${words.at.slice(0, 16).replace('T', ' ')}Z]`)
    lines.push(...words.text.split('\n').map(line => `    ${line}`))
  }
  return lines.join('\n')
}

// What a session should have before it acts: the open tasks it serves, each in the owner's own
// words. Main sees every thread's; a thread sees its own.
export function profile(state: string, thread?: string): string {
  const tasks = open(state).tasks({ owner: thread, status: ['open'] })
  if (!tasks.length) return ''
  const named = names(state)
  const whose = thread ? 'This thread' : 'Every thread'
  return [`${whose}'s open tasks, each with my words as I said them (\`.hex/bin/hex task\` adds to them and closes them):`, ...tasks.map(task => render(task, named))].join('\n\n')
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
        const text = profile(HEX_STORE, HEX_MAIN || !HEX_THREAD ? undefined : HEX_THREAD)
        if (store.show(session_id, text && Bun.hash(text).toString(36))) console.log(text || 'No open tasks now.')
      }
    } catch (error) {
      console.error(`hex couldn't read its tasks: ${error}`)
    }
  }
}
