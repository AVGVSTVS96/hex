import { mkdirSync } from 'fs'
import { join } from 'path'
import { clients, logged, type Turn } from '../../hub/hub.ts'
import { owners } from '../../hub/notes.ts'
import { open as store } from '../../hub/store.ts'
import { Changes } from './changes.ts'
import { watchDir } from './board.ts'

export type Sent = { key: string; text: string; at: string }
// turns: the chat's latest turns, out of all it has (total). sends: whether words typed in the app
// reach this thread. T3 Code shows only turns it starts, and a session no app holds has no chat to
// send through.
export type Chat = { version: number; sends: boolean; total: number; turns: Turn[]; waiting: Sent[] }
// How many of a chat's latest turns the app gets: a long thread's whole history would go to the
// phone on every change.
const SHOWN = 100
export type Where = { app: string; thread: string; session?: string }

// A thread's chat as the app shows it: what the owner said and hex replied across every session the
// thread has had, from their logs (bin/log), each followed by what the owner said that it took in
// but hasn't logged; and what the owner sent that no session has taken in yet. A wait for it ends
// when that chat changes, which a log write, a message taken or a thread moved anywhere may mean.
export class Chats {
  private changes = new Changes()
  private seen = new Map<string, { said: string; version: number }>()
  private stops: (() => void)[]

  constructor(
    private state: string,
    private hexDir: string,
  ) {
    const changed = () => this.changes.changed()
    const logs = [join(hexDir, 'log'), join(hexDir, 'log', 'threads')]
    for (const dir of logs) mkdirSync(dir, { recursive: true })
    this.stops = [...logs.map(dir => watchDir(dir, changed)), store(state).watch(changed)]
  }

  of(where: Where): Chat {
    const kept = store(this.state)
    const all = kept.sessions(where.thread)
    const current = where.session ?? all.at(-1)
    const sessions = [...all.filter(session => session !== current), ...(current ? [current] : [])]
    const turns = sessions.flatMap(session => {
      const log = logged(this.hexDir, session)
      const unlogged = owners(kept.took(session, log?.mtime.toISOString())).filter(row => row.to === where.thread)
      return [...(log?.turns ?? []), ...unlogged.map(row => ({ from: 'me', text: row.body }) as Turn)]
    })
    const waiting = owners(kept.untaken(where.thread)).map(({ key, body, at }) => ({ key, text: body, at }))
    const chat = { sends: !!sendsThrough(where), total: turns.length, turns: turns.slice(-SHOWN), waiting }
    const said = JSON.stringify(chat)
    const id = `${where.app}:${where.thread}`
    const seen = this.seen.get(id)
    const version = seen?.said === said ? seen.version : Math.max((seen?.version ?? 0) + 1, Date.now())
    this.seen.set(id, { said, version })
    return { version, ...chat }
  }

  async next(where: () => Where, after: number, wait: number) {
    const end = Date.now() + wait
    let chat = this.of(where())
    while (chat.version === after && Date.now() < end) {
      await this.changes.changes(this.changes.version, end - Date.now())
      chat = this.of(where())
    }
    return chat
  }

  changed() {
    this.changes.changed()
  }

  // The owner's words, typed in the app, go to the thread's session the way its app's would. The
  // app names each message, so sending it again after a lost answer delivers it once.
  send(where: Where, text: string, key: string) {
    const client = sendsThrough(where)
    const name = client?.hub.name(where.thread)
    if (!name) throw new Error(`Words typed here can't reach this thread; write to it in its own app.`)
    client.hub.deliver(where.thread, name, { content: text, key, meta: { user: 'hex app', ts: new Date().toISOString() } })
  }

  // The owner's stop, as the thread's own app does it.
  stop(where: Where) {
    const client = clients.get(where.app)
    if (!client?.hub.name(where.thread)) throw new Error(`No app here holds this thread, so there's nothing to stop.`)
    ;(client.stop ?? client.hub.stop)(where.thread)
  }

  close() {
    for (const stop of this.stops) stop()
  }
}

// The app holding the thread, when words typed in the hex app can reach it through it.
const sendsThrough = ({ app, thread }: Where) => {
  const client = clients.get(app)
  return client && !client.waits && client.hub.name(thread) ? client : undefined
}
