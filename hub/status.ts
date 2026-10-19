import { clip, fit } from './fit.ts'
import type { Store } from './store.ts'

const WEEK = 7 * 24 * 60 * 60_000

const thisWeek = (store: Store, thread: string, now: number) =>
  store.tasks({ owner: thread, status: ['done'] }).filter(task => task.closed && now - Date.parse(task.closed) < WEEK)

// When the next of a thread's done tasks leaves its status post, or Infinity.
export const nextLeaving = (store: Store, thread: string, now = Date.now()) =>
  Math.min(...thisWeek(store, thread, now).map(task => Date.parse(task.closed!) + WEEK))

// A thread's status post: the session's note, then what's blocked on the owner (its waiting
// questions), what's pending (its open tasks) and what's done this week, each line from hex.db,
// in the room the app gives one message. A note too long to leave the lines room is cut.
export function statusPost(store: Store, thread: string, note: string, room: number, now = Date.now()): string {
  const waiting = store.questions({ thread, waiting: true }).map((question, n) => `${n + 1}. ${clip(question.text, 120)} [${question.options.join(' | ')}]`)
  const open = store.tasks({ owner: thread, status: ['open'] }).map(task => `- ${clip(task.words[0]?.text ?? '', 120)} (${task.id})`)
  const done = thisWeek(store, thread, now)
    .sort((a, b) => b.closed!.localeCompare(a.closed!))
    .map(task => `- ${clip(task.words[0]?.text ?? '', 120)} (${task.id}) · ${clip(task.proof!, 80)}`)
  const section = (header: string, lines: string[]) => ({ header, items: (lines.length ? lines : ['- nothing']).map(line => [line]), gap: '\n' })
  const sections = [section('🔴 **Blocked on you**', waiting), section('🟡 **Pending**', open), section('🟢 **Done**', done)]
  const space = room - fit(sections, 0).length - 2
  const trimmed = note.trim()
  const head = trimmed.length > space ? `${trimmed.slice(0, Math.max(0, space - 1))}…` : trimmed
  return [head, fit(sections, room - (head ? head.length + 2 : 0))].filter(Boolean).join('\n\n')
}
