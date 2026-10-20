import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clip, fit } from './fit.ts'
import { open, type Question, type Task } from './store.ts'

// The owner's profile, which the memory agent keeps current after every turn.
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

// The profile takes most of that room, leaving the rest for tasks and questions.
export const PROFILE = 6_500

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
export function profile(state: string, thread?: string, room = ROOM): { text: string; digest: string } {
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
  const text = fit(sections, room)
  return { text, digest: text && Bun.hash(JSON.stringify(sections)).toString(36) }
}

// The profile as a session should see it: whole the first time, then only the lines that changed
// since the version it saw, so a rewrite after every turn costs a line or two, not the whole file.
export function about(before: string, now: string): string {
  if (!now) return ''
  if (!before) return `Who I am and what's going on now, kept current by the memory agent from my own words:\n\n${now}`
  const lines = (text: string) => new Set(text.split('\n').filter(each => each.trim()))
  const was = lines(before)
  const is = lines(now)
  const added = [...is].filter(each => !was.has(each))
  const gone = [...was].filter(each => !is.has(each))
  const changed = [
    "My profile changed, as the memory agent keeps it current from my own words:",
    ...added,
    ...(gone.length ? ['No longer in it:', ...gone] : []),
  ].join('\n')
  return changed.length < now.length ? changed : about('', now)
}

// The UserPromptSubmit and SessionStart hook: a session gets the profile and the list whenever they
// changed since it last saw them, so it's in context without riding along on every prompt, and again in full once a
// compaction or a clear took it away.
if (import.meta.main) {
  const { HEX_STORE, HEX_THREAD, HEX_MAIN } = process.env
  if (HEX_STORE) {
    try {
      const { session_id, source } = JSON.parse((await Bun.stdin.text()) || '{}') as { session_id?: string; source?: string }
      if (session_id) {
        const store = open(HEX_STORE)
        const mine = `${session_id}:profile`
        if (source === 'compact' || source === 'clear') for (const each of [session_id, mine]) store.unshow(each)
        const now = profileOf(HEX_STORE).slice(0, PROFILE)
        const before = store.seen(mine)
        const told = store.show(mine, now) ? about(before, now) : ''
        const thread = HEX_MAIN || !HEX_THREAD ? undefined : HEX_THREAD
        const { text, digest } = profile(HEX_STORE, thread, Math.max(0, ROOM - told.length))
        const lists = store.show(session_id, digest) ? text || 'No open tasks or questions waiting on me now.' : ''
        if (told && lists && text !== profile(HEX_STORE, thread).text) store.unshow(session_id)
        const out = [told, lists].filter(Boolean).join('\n\n')
        if (out) console.log(out)
      }
    } catch (error) {
      console.error(`hex couldn't read its tasks: ${error}`)
    }
  }
}
