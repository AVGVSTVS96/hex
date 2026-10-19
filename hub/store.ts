import { Database } from 'bun:sqlite'
import { appendFileSync, mkdirSync, watch, type FSWatcher } from 'fs'
import { join } from 'path'
import { parseArgs } from 'util'

// One message as hex keeps it: anything that wakes a thread (the owner's message in an app, a
// schedule's slot, a job's end), word for word, under its sender's own id for it. taken: the
// session that took it into its conversation.
export type Row = { key: string; to: string; from: string; body: string; at: string; meta?: Record<string, string>; taken?: { by: string; at: string } }
export type NewRow = Omit<Row, 'at' | 'taken'>
type Stored = { key: string; to: string; from: string; body: string; at: string; meta: string | null; taken_by: string | null; taken_at: string | null }

// Migration n takes the database from user_version n to n + 1. Append; never edit one that has
// shipped. Times are UTC the way toISOString() writes them, so they sort as text. A key starts with
// its sender, so a key hex makes for a schedule's slot or a job's end can't be one an app sent.
const UTC = "glob '????-??-??T??:??:??.???Z'"
const migrations = [
  `create table messages (
    n integer primary key,
    key text not null unique check (substr(key, 1, length("from") + 1) = "from" || ':'),
    "to" text not null,
    "from" text not null,
    body text not null,
    meta text check (json_valid(meta)),
    at text not null check (at ${UTC}),
    taken_by text,
    taken_at text check (taken_at ${UTC}),
    check ((taken_by is null) = (taken_at is null))
  );
  create index untaken on messages ("to") where taken_at is null;
  create table scheduler (one integer primary key check (one = 1), checked integer not null);`,
]

const now = () => new Date().toISOString()

// state/hex.db, the records every hex process shares: the hub, each session's hooks, the hex
// command. In WAL mode with synchronous=full, a write() that returned survives a crash or a power
// cut, and each one lands whole or not at all. Every commit that changed something adds a byte to
// hex.bell, so a process watching it hears of the change as it happens.
export class Store {
  readonly db: Database
  private readonly bell: string
  private writing = false
  private readonly listeners = new Set<() => void>()
  private watcher?: FSWatcher

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true })
    this.bell = join(dir, 'hex.bell')
    appendFileSync(this.bell, '')
    this.db = new Database(join(dir, 'hex.db'), { create: true, strict: true })
    this.db.run('pragma busy_timeout = 30000')
    retry(() => this.db.run('pragma journal_mode = wal'))
    this.db.run('pragma synchronous = full')
    while (this.version() < migrations.length) {
      this.write(() => {
        const version = this.version()
        if (version === migrations.length) return
        this.db.run(migrations[version]!)
        this.db.run(`pragma user_version = ${version + 1}`)
      })
    }
  }

  // Runs fn as one transaction that holds the write lock from its first statement (BEGIN
  // IMMEDIATE), so what fn reads can't change before it commits; a write() inside it joins it.
  // Keep fn short and local: every other process's writes wait for it.
  write<T>(fn: () => T): T {
    if (this.writing) return fn()
    const before = this.changes()
    const result = retry(() => {
      this.writing = true
      try {
        return this.db.transaction(fn).immediate()
      } finally {
        this.writing = false
      }
    })
    if (this.changes() !== before) appendFileSync(this.bell, '.')
    return result
  }

  // Calls back after each change any process commits, until the stop it returns is called.
  watch(listener: () => void): () => void {
    this.listeners.add(listener)
    this.watcher ??= watch(this.bell, () => {
      for (const each of this.listeners) each()
    })
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size) return
      this.watcher?.close()
      this.watcher = undefined
    }
  }

  // Keeps a new message. A key that's kept already is its sender sending it again: false.
  deliver({ key, to, from, body, meta }: NewRow): boolean {
    return this.write(
      () =>
        this.db
          .query('insert into messages (key, "to", "from", body, meta, at) values (?, ?, ?, ?, ?, ?) on conflict (key) do nothing')
          .run(key, to, from, body, meta ? JSON.stringify(meta) : null, now()).changes === 1,
    )
  }

  // A session took the message into its conversation. False when one already had, or it isn't kept.
  take(key: string, by: string): boolean {
    return this.write(() => this.db.query('update messages set taken_by = ?, taken_at = ? where key = ? and taken_at is null').run(by, now(), key).changes === 1)
  }

  message(key: string): Row | null {
    const row = this.db.query('select * from messages where key = ?').get(key) as Stored | null
    return row && toRow(row)
  }

  // What no session has taken yet, oldest first: every thread's, or one thread's.
  untaken(thread?: string): Row[] {
    const rows =
      thread === undefined
        ? this.db.query('select * from messages where taken_at is null order by n').all()
        : this.db.query('select * from messages where taken_at is null and "to" = ? order by n').all(thread)
    return (rows as Stored[]).map(toRow)
  }

  // The last minute since the epoch the scheduler checked, none before its first check.
  checked(): number | undefined {
    return (this.db.query('select checked from scheduler').get() as { checked: number } | null)?.checked
  }

  check(minute: number) {
    this.write(() => this.db.query('insert into scheduler (one, checked) values (1, ?) on conflict (one) do update set checked = excluded.checked').run(minute))
  }

  // A schedule's slot becomes a message to its thread once, and never while the schedule's last
  // one still waits to be taken, so a thread that's away comes back to one, not a pile.
  fire(schedule: string, minute: number, to: string, body: string, late = false): boolean {
    return this.write(() => {
      const waiting = this.db.query(`select 1 from messages where taken_at is null and "from" = 'schedule' and json_extract(meta, '$.schedule') = ?`).get(schedule)
      const slot = new Date(minute * 60_000).toISOString().slice(0, 16)
      return !waiting && this.deliver({ key: `schedule:${schedule}@${slot}Z`, to, from: 'schedule', body, meta: { user: 'schedule', schedule, ...(late && { late: 'true' }) } })
    })
  }

  private version() {
    return (this.db.query('pragma user_version').get() as { user_version: number }).user_version
  }

  private changes() {
    return (this.db.query('select total_changes() as n').get() as { n: number }).n
  }
}

const stores = new Map<string, Store>()

// The store in dir (a hex's state/), one per process.
export function open(dir: string): Store {
  let store = stores.get(dir)
  if (!store) stores.set(dir, (store = new Store(dir)))
  return store
}

function toRow(row: Stored): Row {
  return {
    key: row.key,
    to: row.to,
    from: row.from,
    body: row.body,
    at: row.at,
    ...(row.meta && { meta: JSON.parse(row.meta) }),
    ...(row.taken_by && { taken: { by: row.taken_by, at: row.taken_at! } }),
  }
}

// SQLITE_BUSY can still surface past busy_timeout when writers never pause; a write is safe to run
// again, since it either committed or left nothing behind.
function retry<T>(fn: () => T): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn()
    } catch (error: any) {
      if (!String(error?.code ?? error?.message).includes('SQLITE_BUSY') || attempt === 5) throw error
      Bun.sleepSync(20 * attempt)
    }
  }
}

// hex deliver <from>:<id> --to <thread> [--user <name>] <words…>, from a shell, a job or any agent:
// keeps the message, and the hub that serves the thread delivers it.
if (import.meta.main) {
  const {
    values: { to, user },
    positionals: [dir, key, ...words],
  } = parseArgs({ options: { to: { type: 'string' }, user: { type: 'string' } }, allowPositionals: true })
  const from = key?.split(':')[0]
  if (!dir || !from || from === key || !to || !words.length) {
    console.error('usage: hex deliver <from>:<id> --to <thread> [--user <name>] <words…>')
    process.exit(2)
  }
  open(dir).deliver({ key, to, from, body: words.join(' '), meta: { user: user ?? from } })
}
