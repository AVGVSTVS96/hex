import { statusPost, type Link } from './status.ts'
import { open, stateDir, type MessageId, type Pin, type Question, type Store } from './store.ts'

export type { Answer, MessageId, Pin, Question } from './store.ts'

// How an app shows a status post: the room one message has, how it puts new words in place (false
// when it can't yet, like in a closed thread), where it shows a thread's message, and what it does
// before the post is built (like fetching the thread the links name).
export type Post = {
  room: number
  edit: (thread: string, message: MessageId, text: string) => Promise<boolean | void>
  link: Link
  ready?: (thread: string) => Promise<unknown>
}

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
  // its note). It's rewritten before it's pinned, and gets its words back if the pin fails, so a
  // message the app won't edit or pin stays as it was.
  post(thread: string, message: MessageId, words: string, post: Post, pin: () => Promise<unknown>): Promise<void> {
    return this.turn(thread, async () => {
      const was = this.pin(thread)
      const same = String(was?.message) === String(message) ? was : undefined
      const note = same?.note ?? words
      const text = await this.render(thread, note, post)
      if (text !== same?.text && (await post.edit(thread, message, text)) === false) throw new Error("the thread is closed, so its post can't change now")
      await pin().catch(async error => {
        if (!same) await post.edit(thread, message, words).catch(() => {})
        throw error
      })
      this.store.pinned({ app: this.app, thread, message, text, note })
    })
  }

  // Rewrites the thread's status post if what it should say changed: a new note, or its questions
  // and tasks in hex.db. A pin made while the app was editing stands.
  rewrite(thread: string, post: Post, note?: string): Promise<void> {
    return this.turn(thread, async () => {
      const pin = this.pin(thread)
      if (!pin) return
      const said = note ?? pin.note
      const text = await this.render(thread, said, post)
      if (text === pin.text && said === pin.note) return
      const shown = text === pin.text || (await post.edit(thread, pin.message, text)) !== false
      this.store.write(() => {
        const still = this.pin(thread)
        if (still?.message !== pin.message || still.note !== pin.note) return
        this.store.pinned({ app: this.app, thread, message: pin.message, text: shown ? text : pin.text, note: said })
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
