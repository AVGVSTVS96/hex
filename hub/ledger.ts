import { readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { open, storeDir, type MessageId, type Question, type Store } from './store.ts'

export type { Answer, MessageId } from './store.ts'
export type Ask = Question
export type Pin = { message: MessageId; text: string; at: string }
type Book = { pins: Record<string, Pin>; asks?: Omit<Ask, 'app'>[] }

// One app's questions, which hex.db keeps (store.ts) so every reader sees the same answer, and
// each thread's pinned status post as last written, in the app's ledger.json. The client that
// sends and edits the messages keeps it.
export class Ledger {
  private book: Book
  private readonly store: Store

  constructor(
    private file: string,
    private readonly app: string,
  ) {
    this.store = open(storeDir(dirname(file)))
    this.book = read(file)
    // The questions an older hex kept in this file move into hex.db, once.
    if (this.book.asks) {
      const asks = this.book.asks
      this.store.write(() => {
        for (const ask of asks) {
          try {
            this.store.ask({ app: this.app, ...ask })
          } catch (error) {
            process.stderr.write(`hub: left out a question ${file} kept that hex.db refuses (${error}): ${JSON.stringify(ask)}\n`)
          }
        }
      })
      delete this.book.asks
      this.save()
    }
  }

  get asks(): readonly Ask[] {
    return this.store.questions({ app: this.app })
  }

  pin(thread: string): Pin | undefined {
    return this.book.pins[thread]
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

  answered(thread: string, message: MessageId, label: string, via: string) {
    this.store.answered(this.app, thread, message, label, via)
  }

  settled(thread: string, message: MessageId, note: string) {
    this.store.settled(this.app, thread, message, note)
  }

  reopened(thread: string, message: MessageId) {
    this.store.reopened(this.app, thread, message)
  }

  // A pinned post's latest status. A question stays open through an edit: it's settled only by
  // saying so.
  edited(thread: string, message: MessageId, text: string) {
    if (this.book.pins[thread]?.message !== message) return
    this.book.pins[thread] = { message, text, at: now() }
    this.save()
  }

  pinned(thread: string, message: MessageId, text = '') {
    this.book.pins[thread] = { message, text, at: now() }
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
