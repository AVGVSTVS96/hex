import { Database } from 'bun:sqlite'
import { appendFileSync, mkdirSync, watch, type FSWatcher } from 'fs'
import { join } from 'path'

// One message as hex keeps it: anything that wakes a thread (the owner's message in an app, a
// schedule's slot, a job's end), word for word, under its sender's own id for it. taken: the
// session that took it into its conversation.
export type Row = { key: string; to: string; from: string; body: string; at: string; meta?: Record<string, string>; taken?: { by: string; at: string } }
export type NewRow = Omit<Row, 'at' | 'taken'>
type Stored = { key: string; to: string; from: string; body: string; at: string; meta: string | null; taken_by: string | null; taken_at: string | null }

// One thing the owner wants done, in their own words: each one quoted from a message they sent,
// under its key, with who sent it and when. Words are only ever added. A task merged into another
// is dropped, and its words live on in the one it went into.
export type Status = 'idea' | 'open' | 'done' | 'dropped'
export type Words = { message: string; text: string; who: string; at: string }
export type Task = { id: string; owner: string; status: Status; words: Words[]; at: string; project?: string; doneWhen?: string; proof?: string; mergedInto?: string }
export type NewTask = { message: string; quote?: string; owner: string; status?: 'idea' | 'open'; project?: string; doneWhen?: string }
export type TaskChange = { status?: Status; proof?: string; doneWhen?: string; project?: string; owner?: string }
type StoredTask = { n: number; owner: string; status: Status; project: string | null; done_when: string | null; proof: string | null; merged_into: number | null; at: string }

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
  `create trigger kept_body before update of body on messages begin select raise(abort, 'a message keeps its words'); end;
  create table tasks (
    n integer primary key autoincrement,
    owner text not null,
    status text not null check (status in ('idea', 'open', 'done', 'dropped')),
    project text,
    done_when text,
    proof text,
    merged_into integer references tasks (n),
    at text not null check (at ${UTC}),
    check (status <> 'done' or proof is not null),
    check (merged_into is null or (status = 'dropped' and merged_into <> n))
  );
  create index live on tasks (owner) where status in ('idea', 'open');
  create table words (
    task integer not null references tasks (n),
    message text not null references messages (key),
    text text not null check (length(text) > 0),
    unique (task, message, text)
  );
  create trigger verbatim before insert on words when not exists (select 1 from messages where key = new.message and instr(body, new.text) > 0)
    begin select raise(abort, 'words are quoted from their message character for character'); end;
  create trigger kept_key before insert on messages when exists (select 1 from messages where key = new.key) begin select raise(ignore); end;
  create trigger kept_rowid before insert on words when exists (select 1 from words where rowid = new.rowid)
    begin select raise(abort, 'words are added, never rewritten'); end;
  create trigger kept_words before update on words begin select raise(abort, 'words are added, never rewritten'); end;
  create trigger kept_words_delete before delete on words begin select raise(abort, 'words are added, never taken away'); end;
  create table shown (session text primary key, digest text not null);`,
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
    this.db.run('pragma foreign_keys = on')
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

  // A task from the owner's message under key: all of it, or the part quote names, which has to be
  // in the message as written. A session points at what was said; it can't retype it.
  createTask({ message, quote, owner, status = 'open', project, doneWhen }: NewTask): Task {
    return this.write(() => {
      const { lastInsertRowid } = this.db
        .query('insert into tasks (owner, status, project, done_when, at) values (?, ?, ?, ?, ?)')
        .run(owner, status, project ?? null, doneWhen ?? null, now())
      const id = `t-${lastInsertRowid}`
      this.quote(id, message, quote)
      return this.task(id)!
    })
  }

  // More of the owner's words for a task, as they come: a task merged away passes them on to the
  // one it went into.
  addWords(id: string, message: string, quote?: string): Task {
    return this.write(() => {
      const live = this.live(id)
      this.quote(live, message, quote)
      return this.task(live)!
    })
  }

  editTask(id: string, change: TaskChange): Task {
    return this.write(() => {
      const task = this.task(id)
      if (!task) throw new Error(`no task ${id}`)
      const next = { ...task, ...Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined)) }
      this.db
        .query('update tasks set owner = ?, status = ?, project = ?, done_when = ?, proof = ? where n = ?')
        .run(next.owner, next.status, next.project ?? null, next.doneWhen ?? null, next.proof ?? null, number(id))
      return this.task(id)!
    })
  }

  // Folds a duplicate into the task it repeats: its words follow into's, and it's dropped.
  mergeTasks(into: string, from: string): Task {
    return this.write(() => {
      if (number(into) === number(from)) throw new Error(`${into} can't be merged into itself`)
      for (const id of [into, from]) {
        const status = this.task(id)?.status
        if (!status) throw new Error(`no task ${id}`)
        if (status !== 'idea' && status !== 'open') throw new Error(`${id} is ${status}; only idea and open tasks merge`)
      }
      this.db.query('insert or ignore into words (task, message, text) select ?, message, text from words where task = ? order by rowid').run(number(into), number(from))
      this.db.query("update tasks set status = 'dropped', merged_into = ? where n = ?").run(number(into), number(from))
      return this.task(into)!
    })
  }

  task(id: string): Task | null {
    const row = this.db.query('select * from tasks where n = ?').get(number(id)) as StoredTask | null
    return row && this.toTask(row)
  }

  // Oldest first: every task, or one owner's, or those in some states.
  tasks({ owner, status }: { owner?: string; status?: Status[] } = {}): Task[] {
    const rows = this.db
      .query('select * from tasks where (?1 is null or owner = ?1) and (?2 is null or status in (select value from json_each(?2))) order by n')
      .all(owner ?? null, status ? JSON.stringify(status) : null) as StoredTask[]
    return rows.map(row => this.toTask(row))
  }

  // Whether what a session was last shown differs from digest, noting digest as shown.
  show(session: string, digest: string): boolean {
    return this.write(() => {
      const shown = this.db.query('select digest from shown where session = ?').get(session) as { digest: string } | null
      if ((shown?.digest ?? '') === digest) return false
      this.db.query('insert into shown (session, digest) values (?, ?) on conflict (session) do update set digest = excluded.digest').run(session, digest)
      return true
    })
  }

  // The session's context lost what it was shown (a compaction, a clear), so its next show is in full.
  unshow(session: string) {
    this.write(() => this.db.query('delete from shown where session = ?').run(session))
  }

  private quote(task: string, message: string, quote?: string) {
    const said = this.message(message)
    if (!said) throw new Error(`no message ${message}`)
    const text = quote ?? said.body
    if (!text) throw new Error(quote === undefined ? `${message} has no words to quote` : 'a quote needs words from the message')
    if (!said.body.includes(text)) throw new Error(`"${text}" isn't in ${message} as written; quote it character for character, or leave the quote out for the whole message`)
    this.db.query('insert into words (task, message, text) values (?, ?, ?) on conflict (task, message, text) do nothing').run(number(task), message, text)
  }

  // The task id's words belong to: id itself, or the end of the merges it went through.
  private live(id: string): string {
    const row = this.db
      .query(
        `with recursive chain (n, next) as (
           select n, merged_into from tasks where n = ?
           union select tasks.n, tasks.merged_into from tasks join chain on tasks.n = chain.next
         )
         select n from chain where next is null`,
      )
      .get(number(id)) as { n: number } | null
    if (!row) throw new Error(`no task ${id}`)
    return `t-${row.n}`
  }

  private toTask(row: StoredTask): Task {
    const words = this.db
      .query(
        `select words.message, words.text, coalesce(json_extract(messages.meta, '$.user'), messages."from") as who, messages.at
         from words join messages on messages.key = words.message where words.task = ? order by words.rowid`,
      )
      .all(row.n) as Words[]
    return {
      id: `t-${row.n}`,
      owner: row.owner,
      status: row.status,
      words,
      at: row.at,
      ...(row.project && { project: row.project }),
      ...(row.done_when && { doneWhen: row.done_when }),
      ...(row.proof && { proof: row.proof }),
      ...(row.merged_into && { mergedInto: `t-${row.merged_into}` }),
    }
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

function number(id: string): number {
  const n = Number(id.replace(/^t-/, ''))
  if (!Number.isInteger(n)) throw new Error(`${id} isn't a task id, like t-12`)
  return n
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
