import { Database } from 'bun:sqlite'
import { existsSync, readFileSync, watch } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { MessageId } from '../../hub/ledger.ts'
import { open, type Relay } from '../../hub/store.ts'
import type { Item } from './activity.ts'

// Work a hex thread handed to another T3 Code thread with delegate_task: the child thread, the task
// that runs it, and how it went. parent is the hex thread that handed it off, as <app>:<key>; hex
// is the child's own hex thread, when it runs on hex; latest, that it was handed off since the
// thread was last asked something (T3 Code wakes a thread when its delegations finish with a
// message of its own, which doesn't count).
// A relay is a message any hex thread sent a T3 thread (hub/relayed.ts keeps them): the task is
// the run it started, and latest says that run is still the thread's newest, so the thread's work
// is the relay's until something else asks it.
export type Delegation = {
  id: string
  task: string
  parent: string
  title: string
  model?: string
  status: string
  since?: string
  end?: string
  result?: string
  hex?: string
  link?: string
  latest: boolean
  relay?: boolean
}

const T3_HOME = join(homedir(), '.t3', 'userdata')
const DATABASE = 'statev2.sqlite'
const REFRESH = 500
const ITEMS = 40
const SHOWN = ['command_execution', 'web_search', 'file_change', 'dynamic_tool', 'reasoning', 'assistant_message', 'subagent', 'error']

// What T3 Code's own database, read only, says of hex's T3 threads: what each is called there, what
// it handed off, and the turns of those that don't run on hex, read when asked and again whenever T3
// Code writes. Where a thread opens in its own app is hex.db's (Thread.link): linkAt only adds a message.
// T3_APP_SCHEME is the T3 Code app's URL scheme: t3code, t3code-preview or t3code-dev.
export class Links {
  private threads = new Map<string, { thread: string; title: string }>()
  private handed: Delegation[] = []
  private relays: Relay[] = []
  private items = new Map<string, Item[]>()
  private titles = new Map<string, string | undefined>()
  private environment?: string
  private db?: Database
  private watcher?: ReturnType<typeof watch>
  private pending?: ReturnType<typeof setTimeout>

  constructor(
    private state: string,
    private changed: () => void,
    private t3 = T3_HOME,
    private scheme = process.env.T3_APP_SCHEME || 't3code',
  ) {
    const database = join(t3, DATABASE)
    if (!existsSync(database)) return
    this.environment = word(readFile(join(t3, 'environment-id'))?.trim())
    this.db = new Database(database, { readonly: true })
    this.watcher = watch(t3, (_, file) => file?.startsWith(DATABASE) && this.schedule())
    this.read()
  }

  close() {
    clearTimeout(this.pending)
    this.watcher?.close()
    this.db?.close()
  }

  // hex.db's relays, newest per thread pair; read again whenever the threads are.
  load() {
    this.relays = open(this.state).relays()
    if (this.db) this.read()
  }

  // What the thread is called in its own app, where hex knows it by another name: T3 Code's title.
  title(app: string, id: string): string | undefined {
    return app === 't3' ? word(this.threads.get(id)?.title) : undefined
  }

  // What a hex thread handed off, oldest first.
  delegations(app: string, id: string) {
    return this.handed.filter(one => one.parent === `${app}:${id}`)
  }

  // Whether a hex T3 thread is work another hex thread handed off, so it shows under that one, as
  // long as that one shows: two T3 threads that send each other work would otherwise both hide.
  delegated(app: string, id: string) {
    return app === 't3' && this.owners(id).some(owner => this.shows(owner, new Set([`t3:${id}`])))
  }

  private owners(id: string) {
    return this.handed.filter(one => one.hex === id && (!one.relay || one.latest)).map(one => one.parent)
  }

  // Whether a thread shows: on its own, or under an owner that does without coming back through it.
  private shows(thread: string, passed: Set<string>): boolean {
    if (passed.has(thread)) return false
    const owners = thread.startsWith('t3:') ? this.owners(thread.slice(3)) : []
    return !owners.length || owners.some(owner => this.shows(owner, new Set([...passed, thread])))
  }

  // A T3 task or thread's title, by either id.
  name(id: string) {
    const one = this.handed.find(one => one.task === id || one.id === id)
    if (one) return one.title
    if (!this.titles.has(id))
      this.titles.set(id, word(this.db?.query<{ title: string }, [string]>('select title from orchestration_v2_projection_threads where thread_id = ?').get(id)?.title))
    return this.titles.get(id)
  }

  // A T3 thread's newest turn items that read as steps, newest first.
  turns(thread: string) {
    let items = this.items.get(thread)
    if (!items) {
      items = (this.db
        ?.query<{ id: string; type: string; status: string; payload: string }, [string]>(
          `select turn_item_id id, type, status, payload_json payload from orchestration_v2_projection_turn_items
           where thread_id = ? and type in (${SHOWN.map(type => `'${type}'`).join(', ')}) order by ordinal desc limit ${ITEMS}`,
        )
        .all(thread) ?? []).map(item => ({ ...item, payload: JSON.parse(item.payload) }))
      this.items.set(thread, items)
    }
    return items
  }

  private deep(thread?: string) {
    return thread && this.environment && `${this.scheme}://threads/${this.environment}/${encodeURIComponent(thread)}`
  }

  private schedule() {
    if (this.pending) return
    this.pending = setTimeout(() => {
      this.pending = undefined
      if (this.read()) this.changed()
    }, REFRESH)
  }

  // A hex thread's key is the session id the T3 Code ACP agent holds as its native thread. Turns that
  // were asked for may have moved with any write, so they're read again when next asked.
  private read() {
    try {
      const rows = this.db!
        .query<{ key: string; thread: string; title: string }, []>(
          `select json_extract(p.payload_json, '$.nativeThreadRef.nativeId') key, json_extract(p.payload_json, '$.appThreadId') thread, t.title
           from orchestration_v2_projection_provider_threads p
           join orchestration_v2_projection_threads t on t.thread_id = json_extract(p.payload_json, '$.appThreadId')
           where p.driver = 'acpRegistry' and t.deleted_at is null
           order by p.updated_at`,
        )
        .all()
      const threads = new Map(rows.map(({ key, thread, title }) => [key, { thread, title }]))
      const keys = new Map(rows.map(({ key, thread }) => [thread, key]))
      const handed = this.db!
        .query<Omit<Delegation, 'hex' | 'link' | 'latest'> & { driver: string; latest: number | null }, []>(
          `select s.child_thread_id id, s.subagent_id task, s.thread_id parent, s.driver, s.status, s.started_at since, s.completed_at "end",
             coalesce(json_extract(s.payload_json, '$.title'), 'a task') title, json_extract(s.payload_json, '$.model') model,
             substr(json_extract(s.payload_json, '$.result'), 1, 1000) result,
             s.started_at >= (select max(m.created_at) from orchestration_v2_projection_messages m
               where m.thread_id = s.thread_id and m.role = 'user' and json_extract(m.payload_json, '$.delegatedCompletion') is null) latest
           from orchestration_v2_projection_subagents s
           where s.origin = 'app_owned' and s.child_thread_id is not null
           order by s.started_at`,
        )
        .all()
        .filter(row => keys.has(row.parent))
        .map(({ driver, latest, parent, ...row }): Delegation => {
          const hex = driver === 'acpRegistry' ? keys.get(row.id) : undefined
          return omit({ ...row, parent: `t3:${keys.get(parent)}`, result: handedBack(row.result), hex, link: this.deep(row.id), latest: latest === 1 })
        })
      const run = this.db!.query<Omit<Delegation, 'id' | 'task' | 'parent' | 'hex' | 'link' | 'latest'> & { latest: number }, [string]>(
        `select t.title, r.status, r.requested_at since, r.completed_at "end",
           r.ordinal = (select max(o.ordinal) from orchestration_v2_projection_runs o where o.thread_id = r.thread_id) latest,
           (select substr(json_extract(m.payload_json, '$.text'), 1, 1000) from orchestration_v2_projection_messages m
             where m.run_id = r.run_id and m.role = 'assistant' order by m.created_at desc limit 1) result
         from orchestration_v2_projection_runs r join orchestration_v2_projection_threads t on t.thread_id = r.thread_id
         where r.run_id = ? and t.deleted_at is null`,
      )
      const relayed = this.relays.flatMap(({ from, thread, run: task }): Delegation[] => {
        const ran = run.get(task)
        const hex = keys.get(thread)
        if (!ran || from === `t3:${hex}` || handed.some(one => one.parent === from && one.id === thread)) return []
        return [omit({ ...ran, id: thread, task, parent: from, result: handedBack(ran.result), hex, link: this.deep(thread), latest: ran.latest === 1, relay: true })]
      })
      handed.push(...relayed)
      const asked = this.items.size > 0
      this.items.clear()
      this.titles.clear()
      if (!asked && JSON.stringify([[...threads], handed]) === JSON.stringify([[...this.threads], this.handed])) return false
      this.threads = threads
      this.handed = handed
      return true
    } catch (error) {
      process.stderr.write(`voice: links: couldn't read T3 Code's threads: ${error}\n`)
      return false
    }
  }
}

// What a delegation handed back; T3 Code fills in a placeholder for one that ended without a word.
function handedBack(result?: string) {
  return result && !/^Child task ended with status \w+\.$/.test(result) ? result : undefined
}

function omit<T extends object>(record: T) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value != null)) as T
}

function word(value: unknown) {
  return typeof value === 'string' && value ? value : undefined
}

function readFile(path: string) {
  try {
    return readFileSync(path, 'utf8')
  } catch {}
}

// A message's own link where its app has one (in a Telegram group or topic, or a Discord thread), else
// its thread's.
export function linkAt(app: string, link: string | undefined, message?: MessageId) {
  if (!link || message === undefined) return link
  if (app === 'discord') return `${link}/${message}`
  if (app === 'telegram' && link.startsWith('https://t.me/c/')) return `${link.replace(/\/1$/, '')}/${message}`
  return link
}
