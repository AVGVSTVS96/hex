import { readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { statusPost } from './status.ts'
import { open, storeDir, type MessageId, type Question, type Store } from './store.ts'

export type { Answer, MessageId, Question } from './store.ts'
// A pin with a note is the thread's status post: hex writes it as the note over the thread's
// questions and tasks (status.ts).
export type Pin = { message: MessageId; text: string; at: string; note?: string }

// What a pin says in its session's own words: a status post's note, or all of a pin written by hand.
export const noteOf = (pin: Pin) => pin.note ?? pin.text
type Book = { pins: Record<string, Pin>; asks?: Omit<Question, 'app'>[] }
type Edit = (thread: string, message: MessageId, text: string) => Promise<unknown>

// One app's questions, which hex.db keeps (store.ts) so every reader sees the same answer, and
// each thread's pinned status post as last written, in the app's ledger.json. The client that
// sends and edits the messages keeps it.
export class Ledger {
  private book: Book
  private readonly store: Store
  private rewriting = new Map<string, Promise<void>>()

  constructor(
    private file: string,
    private readonly app: string,
  ) {
    this.store = open(storeDir(dirname(file)))
    this.book = read(file)
    // The questions an older hex kept in this file move into hex.db, once.
    if (this.book.asks) {
      const kept = this.book.asks
      this.store.write(() => {
        for (const question of kept) {
          try {
            this.store.ask({ app: this.app, ...question })
          } catch (error) {
            process.stderr.write(`hub: left out a question ${file} kept that hex.db refuses (${error}): ${JSON.stringify(question)}\n`)
          }
        }
      })
      delete this.book.asks
      this.save()
    }
  }

  get questions(): readonly Question[] {
    return this.store.questions({ app: this.app })
  }

  pin(thread: string): Pin | undefined {
    return this.book.pins[thread]
  }

  // The threads whose pin is their status post.
  posts(): string[] {
    return Object.entries(this.book.pins).flatMap(([thread, pin]) => (pin.note === undefined ? [] : [thread]))
  }

  // Rewrites the thread's status post if what it should say changed: a new note, or its questions
  // and tasks in hex.db. One rewrite at a time per thread, so two changes can't race, and a pin
  // made while the app was editing stands.
  rewrite(thread: string, room: number, edit: Edit, note?: string): Promise<void> {
    const next = (this.rewriting.get(thread) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const pin = this.book.pins[thread]
        const said = note ?? pin?.note
        if (!pin || said === undefined) return
        const text = statusPost(this.store, thread, said, room)
        if (text === pin.text && said === pin.note) return
        if (text !== pin.text) await edit(thread, pin.message, text)
        const still = this.book.pins[thread]
        if (still?.message !== pin.message || still.note !== pin.note) return
        this.book.pins[thread] = { message: pin.message, text, at: now(), note: said }
        this.save()
      })
    this.rewriting.set(thread, next)
    return next
  }

  // Keeps every status post current: now, and after each change to hex.db from any process.
  keep(room: number, edit: Edit, failed: (thread: string, error: unknown) => void): () => void {
    const all = () => {
      for (const thread of this.posts()) this.rewrite(thread, room, edit).catch(error => failed(thread, error))
    }
    all()
    return this.store.watch(all)
  }

  find(thread: string, message: MessageId) {
    return this.store.question(this.app, thread, message) ?? undefined
  }

  byPoll(poll: string) {
    return this.store.poll(this.app, poll) ?? undefined
  }

  ask(thread: string, message: MessageId, text: string, options: string[], poll?: string, multiple = false) {
    this.store.ask({ app: this.app, thread, message, text, options, poll, multiple })
  }

  answered(thread: string, message: MessageId, label: string, via: string, again = false) {
    return this.store.answered(this.app, thread, message, label, via, again)
  }

  settled(thread: string, message: MessageId, note: string) {
    this.store.settled(this.app, thread, message, note)
  }

  reopened(thread: string, message: MessageId) {
    return this.store.reopened(this.app, thread, message)
  }

  // A question's or a pinned post's latest words. A question stays open through an edit: it's
  // settled only by saying so.
  edited(thread: string, message: MessageId, text: string) {
    this.store.reworded(this.app, thread, message, text)
    const pin = this.book.pins[thread]
    if (pin?.message !== message) return
    this.book.pins[thread] = { ...pin, text, at: now() }
    this.save()
  }

  pinned(thread: string, message: MessageId, text = '', note?: string) {
    this.book.pins[thread] = { message, text, at: now(), ...(note !== undefined && { note }) }
    this.save()
  }

  unpinned(thread: string, message: MessageId) {
    if (this.book.pins[thread]?.message !== message) return
    delete this.book.pins[thread]
    this.save()
  }

  deleted(thread: string, message: MessageId) {
    this.store.unask(this.app, thread, message)
    if (this.book.pins[thread]?.message !== message) return
    delete this.book.pins[thread]
    this.save()
  }

  forget(thread: string) {
    this.store.unask(this.app, thread)
    delete this.book.pins[thread]
    this.save()
  }

  private save() {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.book, null, 1) + '\n')
    renameSync(`${this.file}.tmp`, this.file)
  }
}

function read(file: string): Book {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { pins: {} }
  }
  try {
    const book = JSON.parse(text)
    return { pins: book.pins ?? {}, ...(Array.isArray(book.asks) && { asks: book.asks }) }
  } catch (error) {
    const aside = `${file}.corrupt-${Date.now()}`
    renameSync(file, aside)
    process.stderr.write(`hub: ${file} is unreadable (${error}), moved it to ${aside} and started a new ledger\n`)
    return { pins: {} }
  }
}

function now() {
  return new Date().toISOString()
}
