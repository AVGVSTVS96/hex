import { clip, fit } from './fit.ts'
import type { MessageId, Store } from './store.ts'

// Where the app shows a thread's message, when it has a link for one.
export type Link = (thread: string, message: MessageId) => string | undefined

// A thread's status post: the session's note, then what's blocked on the owner (its waiting
// questions, each linked to its buttons), what's pending (its open tasks) and the last few done
// (linked to their proof when it has a link), each line from hex.db, in the room the app gives one
// message. A note too long to leave the lines room is cut.
export function statusPost(store: Store, thread: string, note: string, room: number, link: Link = () => undefined): string {
  const linked = (text: string, url: string | undefined) => (url ? `[${text.replace(/[[\]]/g, '')}](${url})` : text)
  const waiting = store.questions({ thread, waiting: true }).map(question => `- ${linked(clip(question.text, 120), link(thread, question.message))}`)
  const open = store.tasks({ owner: thread, status: ['open'] }).map(task => `- ${clip(task.title, 120)}`)
  const done = store.lastDone(thread, 5).map(task => `- ${linked(clip(task.title, 120), task.proof!.match(/https?:\/\/[^\s)]+/)?.[0]?.replace(/[.,;:]+$/, ''))}`)
  const section = (header: string, lines: string[]) => ({ header: lines.length ? `**${header}**` : `**${header}:** nothing`, items: lines.map(line => [line]), gap: '\n' })
  const sections = [section('🔴 Blocked on you', waiting), section('🟡 Pending', open), section('🟢 Done', done)]
  const space = room - fit(sections, 0).length - 2
  const trimmed = note.trim()
  const head = trimmed.length > space ? `${trimmed.slice(0, Math.max(0, space - 1))}…` : trimmed
  return [head, fit(sections, room - (head ? head.length + 2 : 0))].filter(Boolean).join('\n\n')
}
