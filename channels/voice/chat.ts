import { randomUUID } from 'crypto'
import { watch } from 'fs'
import { join } from 'path'
import { history, type Turn } from '../../hub/hub.ts'
import { open as store } from '../../hub/store.ts'
import { Changes } from './changes.ts'
import { relay } from './relay.ts'

export type Sent = { key: string; text: string; at: string }
export type Chat = { version: number; turns: Turn[]; waiting: Sent[] }

// A thread's chat as the app shows it: what the owner said and hex replied, read from the
// session's log (bin/log), and what the owner sent that the session hasn't taken in yet. It
// changes when a log is written or a session takes a message.
export class Chats extends Changes {
  private stops: (() => void)[]

  constructor(
    private state: string,
    private hexDir: string,
  ) {
    super()
    const changed = () => this.changed()
    this.stops = [watchDir(join(hexDir, 'log'), changed), watchDir(join(hexDir, 'log', 'threads'), changed), store(state).watch(changed)]
  }

  of(thread: string, session: string | undefined): Chat {
    const waiting = store(this.state)
      .untaken(thread)
      .map(({ key, body, at }) => ({ key, text: body, at }))
    return { version: this.version, turns: session ? history(this.hexDir, session) : [], waiting }
  }

  // The owner's words, typed in the app, go to the thread the way a chat app's would.
  async send(app: string, thread: string, text: string) {
    const key = `app-${randomUUID()}`
    await relay(this.state, app, { type: 'inbound', thread, key, content: text, meta: { user_id: 'owner', via: 'hex app' } })
    return `${app}:${key}`
  }

  // The owner's stop, as their chat app's stop would.
  stop(app: string, thread: string) {
    return relay(this.state, app, { type: 'stop', thread })
  }

  close() {
    for (const stop of this.stops) stop()
  }
}

function watchDir(dir: string, changed: () => void) {
  try {
    const watcher = watch(dir, changed)
    return () => watcher.close()
  } catch {
    return () => {}
  }
}
