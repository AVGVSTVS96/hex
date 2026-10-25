import { above } from './fit.ts'
import { statusPost, type Link } from './status.ts'
import { open, stateDir, type MessageId, type Pin, type Question, type Store } from './store.ts'

export type { Answer, MessageId, Pin, Question } from './store.ts'

// How an app shows a status post: the room one message has, where it shows a thread's message,
// what it does before the post is built (like fetching the thread the links name), and how it
// sends, edits, pins and unpins one. edit returns false when it can't edit yet (a closed thread),
// and null when it never will (a deleted message).
export type Post = {
  room: number
  link: Link
  ready?: (thread: string) => Promise<unknown>
  send: (thread: string, text: string) => Promise<MessageId>
  edit: (thread: string, message: MessageId, text: string) => Promise<boolean | null | void>
  pin: (thread: string, message: MessageId) => Promise<unknown>
  unpin: (thread: string, message: MessageId) => Promise<unknown>
}

// One app's questions and each thread's pinned post, which hex.db keeps (store.ts) so every reader
// sees the same ones. The client that sends and edits the messages keeps them.
export class Ledger {
  private readonly store: Store
  private turns = new Map<string, Promise<unknown>>()

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

  // Sends the thread's status post, the note over its lines, and pins it in place of the last one;
  // if it can't be pinned, it's left a plain message and the last post stays. A note copied from a
  // post keeps only its words above the post's lines.
  post(thread: string, note: string, post: Post): Promise<MessageId> {
    return this.turn(thread, async () => {
      const was = this.pin(thread)
      const words = above(note)
      const text = await this.render(thread, words, post)
      const message = await post.send(thread, text)
      await post.pin(thread, message)
      this.store.pinned({ app: this.app, thread, message, text, note: words })
      if (was) await post.unpin(thread, was.message).catch(() => {})
      return message
    })
  }

  // Rewrites the thread's status post if what it should say changed: a new note for the post that
  // message is, or its questions and tasks in hex.db. A closed thread's post waits for the next
  // change, a deleted one stops being the post, and a pin made while the app was editing stands.
  rewrite(thread: string, post: Post, note?: string, message?: MessageId): Promise<void> {
    return this.turn(thread, async () => {
      const pin = this.pin(thread)
      if (message !== undefined && String(pin?.message) !== String(message)) throw new Error('that message is no longer the status post')
      if (!pin) return
      const said = note === undefined ? pin.note : above(note)
      const text = await this.render(thread, said, post)
      if (text === pin.text && said === pin.note) return
      const shown = text === pin.text || (await post.edit(thread, pin.message, text))
      if (shown === null) {
        this.store.unpinned(this.app, thread, pin.message)
        await post.unpin(thread, pin.message).catch(() => {})
      }
      if (shown === null || shown === false) {
        if (note !== undefined) throw new Error(shown === null ? 'the status post is gone; post a new one with pin' : "the thread is closed, so its status post can't change now")
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
  private turn<T>(thread: string, change: () => Promise<T>): Promise<T> {
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

  // Unpins a message, by default the thread's status post, in the app and then in hex.db, in the
  // thread's turn: the message it unpinned, if any.
  unpin(thread: string, post: Post, message?: MessageId): Promise<MessageId | undefined> {
    return this.turn(thread, async () => {
      const target = message ?? this.pin(thread)?.message
      if (target === undefined) return
      await post.unpin(thread, target)
      this.store.unpinned(this.app, thread, target)
      return target
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
