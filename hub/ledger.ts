import { statusPost, type Link } from './status.ts'
import { open, stateDir, type MessageId, type Pin, type Question, type Store } from './store.ts'

export type { Answer, MessageId, Pin, Question } from './store.ts'

// How an app shows a status post: the room one message has, how it puts new words in place (false
// when it can't yet, like in a closed thread; null when it never can, like someone else's message
// or a deleted one), where it shows a thread's message, and what it does before the post is built
// (like fetching the thread the links name).
export type Post = {
  room: number
  edit: (thread: string, message: MessageId, text: string) => Promise<boolean | null | void>
  link: Link
  ready?: (thread: string) => Promise<unknown>
}

const CLOSED = "the thread is closed, so its status post can't change now"

// One app's questions and each thread's pinned post, which hex.db keeps (store.ts) so every reader
// sees the same ones. The client that sends and edits the messages keeps them.
export class Ledger {
  private readonly store: Store
  private turns = new Map<string, Promise<void>>()

  // dir: the app's state folder, whose hex.db it is outside a hex.
  constructor(
    dir: string,
    private readonly app: string,
  ) {
    this.store = open(stateDir(dir))
  }

  get questions(): readonly Question[] {
    return this.store.questions({ app: this.app })
  }

  pin(thread: string): Pin | undefined {
    return this.store.pin(this.app, thread) ?? undefined
  }

  // Makes the message the thread's status post, its words the note (pinning the post again keeps
  // its note), and unpins the post it replaces. An edit the app refuses leaves the message as it
  // was, and unpinned again.
  post(thread: string, message: MessageId, words: string, post: Post, pin: () => Promise<unknown>, unpin: (message: MessageId) => Promise<unknown>): Promise<void> {
    return this.turn(thread, async () => {
      const was = this.pin(thread)
      const same = String(was?.message) === String(message) ? was : undefined
      const note = same?.note ?? words
      const text = await this.render(thread, note, post)
      await pin()
      try {
        const shown = text === same?.text || (await post.edit(thread, message, text))
        if (shown === false) throw new Error(CLOSED)
        if (shown === null) throw new Error("the app won't let hex edit that message, so it can't be a status post")
      } catch (error) {
        if (!same) await unpin(message).catch(() => {})
        throw error
      }
      this.store.pinned({ app: this.app, thread, message, text, note })
      if (was && !same) await unpin(was.message).catch(() => {})
    })
  }

  // Rewrites the thread's status post if what it should say changed: a new note for the post that
  // message is, or its questions and tasks in hex.db. A closed thread's post waits for the first
  // change after it opens again, one the app will never let hex edit stops being the post, and a
  // pin made while the app was editing stands.
  rewrite(thread: string, post: Post, note?: string, message?: MessageId): Promise<void> {
    return this.turn(thread, async () => {
      const pin = this.pin(thread)
      if (message !== undefined && String(pin?.message) !== String(message)) throw new Error('that message is no longer the status post')
      if (!pin) return
      const said = note ?? pin.note
      const text = await this.render(thread, said, post)
      if (text === pin.text && said === pin.note) return
      const shown = text === pin.text || (await post.edit(thread, pin.message, text))
      if (shown === null) return this.store.unpinned(this.app, thread, pin.message)
      if (shown === false) {
        if (note !== undefined) throw new Error(CLOSED)
        return
      }
      this.store.write(() => {
        const still = this.pin(thread)
        if (still?.message !== pin.message || still.note !== pin.note) return
        this.store.pinned({ app: this.app, thread, message: pin.message, text, note: said })
      })
    })
  }

  // One change to a thread's status post at a time, so two can't race.
  private turn(thread: string, change: () => Promise<void>): Promise<void> {
    const next = (this.turns.get(thread) ?? Promise.resolve()).catch(() => {}).then(change)
    this.turns.set(thread, next)
    return next
  }

  private async render(thread: string, note: string, post: Post) {
    await post.ready?.(thread)
    return statusPost(this.store, thread, note, post.room, post.link)
  }

  // Keeps every status post current: now, and after each change to hex.db from any process.
  keep(post: Post, failed: (thread: string, error: unknown) => void): () => void {
    const all = () => {
      for (const { thread } of this.store.pins({ app: this.app })) this.rewrite(thread, post).catch(error => failed(thread, error))
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

  // A question's latest words. A question stays open through an edit: it's settled only by saying so.
  edited(thread: string, message: MessageId, text: string) {
    this.store.reworded(this.app, thread, message, text)
  }

  // Unpins the message in the app, then in hex.db, in the thread's turn, so a pin still running
  // finishes first.
  unpinned(thread: string, message: MessageId, unpin: () => Promise<unknown>): Promise<void> {
    return this.turn(thread, async () => {
      await unpin()
      this.store.unpinned(this.app, thread, message)
    })
  }

  // A deleted message's questions and pin go now, and again after a pin still running, which could
  // have recorded it.
  deleted(thread: string, message: MessageId): Promise<void> {
    this.store.write(() => {
      this.store.unask(this.app, thread, message)
      this.store.unpinned(this.app, thread, message)
    })
    return this.turn(thread, async () => this.store.unpinned(this.app, thread, message))
  }

  forget(thread: string): Promise<void> {
    this.store.write(() => {
      this.store.unask(this.app, thread)
      this.store.unpinned(this.app, thread)
    })
    return this.turn(thread, async () => this.store.unpinned(this.app, thread))
  }
}
