import { dirname } from 'path'
import { statusPost } from './status.ts'
import { open, storeDir, type MessageId, type Pin, type Question, type Store } from './store.ts'

export type { Answer, MessageId, Pin, Question } from './store.ts'

// What a pin says in its session's own words: a status post's note, or all of a pin written by hand.
export const noteOf = (pin: Pin) => pin.note ?? pin.text
type Edit = (thread: string, message: MessageId, text: string) => Promise<unknown>

// One app's questions and each thread's pinned post, which hex.db keeps (store.ts) so every reader
// sees the same ones. The client that sends and edits the messages keeps them.
export class Ledger {
  private readonly store: Store
  private rewriting = new Map<string, Promise<void>>()

  // file: the app's ledger.json, where an older hex kept these. Whenever it says something else than
  // when hex.db last took it in, what it changed since (the older hex's doing) comes in: each pin it
  // set or took away, and each question it added.
  constructor(
    file: string,
    private readonly app: string,
  ) {
    this.store = open(storeDir(dirname(file)))
    this.store.takeIn(`${app}/ledger.json`, file, (now, before) => {
      const [book, was] = [now, before ?? '{}'].map(text => read(text, file))
      if (!book) return
      for (const thread of new Set([...Object.keys(book.pins), ...Object.keys(was?.pins ?? {})])) {
        const pin = book.pins[thread]
        if (JSON.stringify(pin) === JSON.stringify(was?.pins[thread])) continue
        if (pin) keep(() => this.store.pinned({ ...pin, app, thread }), pin)
        else this.store.unpinned(app, thread)
      }
      const asked = new Set((was?.asks ?? []).map(question => JSON.stringify(question)))
      for (const question of book.asks) if (!asked.has(JSON.stringify(question))) keep(() => this.store.ask({ app, ...question }), question)
    })

    function keep(take: () => unknown, kept: unknown) {
      try {
        take()
      } catch (error) {
        process.stderr.write(`hub: left out ${JSON.stringify(kept)} from ${file}, which hex.db refuses: ${error}\n`)
      }
    }
  }

  get questions(): readonly Question[] {
    return this.store.questions({ app: this.app })
  }

  pin(thread: string): Pin | undefined {
    return this.store.pin(this.app, thread) ?? undefined
  }

  // The threads whose pin is their status post.
  posts(): string[] {
    return this.store.pins({ app: this.app }).flatMap(pin => (pin.note === undefined ? [] : [pin.thread]))
  }

  // Rewrites the thread's status post if what it should say changed: a new note, or its questions
  // and tasks in hex.db. One rewrite at a time per thread, so two changes can't race, and a pin
  // made while the app was editing stands.
  rewrite(thread: string, room: number, edit: Edit, note?: string): Promise<void> {
    const next = (this.rewriting.get(thread) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const pin = this.pin(thread)
        const said = note ?? pin?.note
        if (!pin || said === undefined) return
        const text = statusPost(this.store, thread, said, room)
        if (text === pin.text && said === pin.note) return
        if (text !== pin.text) await edit(thread, pin.message, text)
        this.store.write(() => {
          const still = this.pin(thread)
          if (still?.message !== pin.message || still.note !== pin.note) return
          this.store.pinned({ app: this.app, thread, message: pin.message, text, note: said })
        })
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
    this.store.write(() => {
      this.store.reworded(this.app, thread, message, text)
      const pin = this.pin(thread)
      if (pin?.message === message) this.store.pinned({ app: this.app, thread, message, text, note: pin.note })
    })
  }

  pinned(thread: string, message: MessageId, text = '', note?: string) {
    this.store.pinned({ app: this.app, thread, message, text, note })
  }

  unpinned(thread: string, message: MessageId) {
    this.store.unpinned(this.app, thread, message)
  }

  deleted(thread: string, message: MessageId) {
    this.store.write(() => {
      this.store.unask(this.app, thread, message)
      this.store.unpinned(this.app, thread, message)
    })
  }

  forget(thread: string) {
    this.store.write(() => {
      this.store.unask(this.app, thread)
      this.store.unpinned(this.app, thread)
    })
  }
}

type Book = { pins: Record<string, Omit<Pin, 'app' | 'thread'>>; asks: Omit<Question, 'app'>[] }

function read(text: string, file: string): Book | undefined {
  try {
    const book = JSON.parse(text) ?? {}
    return { pins: book.pins && typeof book.pins === 'object' ? book.pins : {}, asks: Array.isArray(book.asks) ? book.asks : [] }
  } catch (error) {
    process.stderr.write(`hub: ${file} is unreadable, so hex.db left it out: ${error}\n`)
  }
}
