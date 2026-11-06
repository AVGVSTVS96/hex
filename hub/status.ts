import { clip, fit, HEADINGS } from './fit.ts'
import type { MessageId, Store, Task } from './store.ts'

// Where the app shows a thread's message, when it has a link for one.
export type Link = (thread: string, message: MessageId) => string | undefined

// A thread's status post: the session's note, then what's waiting on the owner (hex's questions,
// each linked to where it was asked, and theirs hex answered, linked to the answer), its open tasks
// and ideas (each linked to the owner's latest words for it in the thread, to reply to with more)
// and the last few done (linked to their proof when it has a link), each from hex.db, in the room
// the app gives one message. A list with nothing in it is left out, and a note too long to leave
// the lists room is cut.
export function statusPost(store: Store, thread: string, note: string, room: number, link: Link = () => undefined): string {
  const linked = (text: string, url: string | undefined) => (url ? `[${text.replace(/[[\]]/g, '')}](${url})` : text)
  const waiting = store
    .questions({ thread, waiting: true })
    .map(question => `- ${question.asker ? linked(`Answered: ${clip(question.text, 110)}`, link(thread, question.answer!.message ?? question.message)) : linked(clip(question.text, 120), link(thread, question.message))}`)
  const tasks = (status: 'open' | 'idea') => store.tasks({ owner: thread, status: [status] }).map(task => `- ${linked(clip(task.title, 120), latest(store, thread, task, link))}`)
  const done = store.lastDone(thread, 5).map(task => `- ${linked(clip(task.title, 120), url(task.proof!))}`)
  const sections = ([[HEADINGS[0], waiting], [HEADINGS[1], tasks('open')], [HEADINGS[2], tasks('idea')], [HEADINGS[3], done]] as const)
    .filter(([, lines]) => lines.length)
    .map(([header, lines]) => ({ header: `**${header}**`, items: lines.map(line => [line]), gap: '\n' }))
  const space = room - fit(sections, 0).length - 2
  const trimmed = note.trim()
  const head = trimmed.length > space ? `${trimmed.slice(0, Math.max(0, space - 1))}…` : trimmed
  return [head, fit(sections, room - (head ? head.length + 2 : 0))].filter(Boolean).join('\n\n')
}

// Where the owner last asked for a task in this thread.
function latest(store: Store, thread: string, task: Task, link: Link) {
  const row = task.words.map(words => store.message(words.message)).findLast(row => row?.to === thread)
  return row ? link(thread, row.meta?.message_id ?? row.key.slice(row.key.lastIndexOf(':') + 1)) : undefined
}

// The first link in a proof, without the markdown or punctuation around it.
function url(proof: string) {
  let found = proof.match(/https?:\/\/[^\s<>[\]"'`]+/)?.[0]
  while (found && (/[*_!?.,;:]$/.test(found) || (found.endsWith(')') && found.split(')').length > found.split('(').length))) found = found.slice(0, -1)
  return found
}
