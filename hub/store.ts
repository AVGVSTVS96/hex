import { Database } from 'bun:sqlite'
import { appendFileSync, mkdirSync, watch, type FSWatcher } from 'fs'
import { join } from 'path'

// One message as hex keeps it: anything that wakes a thread (the owner's message in an app, a
// schedule's slot, a job's end), word for word, under its sender's own id for it. taken: the
// session that took it into its conversation.
export type Row = { key: string; to: string; from: string; body: string; at: string; meta?: Record<string, string>; taken?: { by: string; at: string } }
export type NewRow = Omit<Row, 'at' | 'taken'>
type Stored = { key: string; to: string; from: string; body: string; at: string; meta: string | null; taken_by: string | null; taken_at: string | null }

// One thing the owner wants done: a short title in plain words that keeps their intent, and their
// own words, each quoted from a message they sent, under its key, with who sent it and when. Words
// are only ever added. A task merged into another
// is dropped, and its words live on in the one it went into.
export type Status = 'idea' | 'open' | 'done' | 'dropped'
export type Words = { message: string; text: string; who: string; at: string }
export type Task = { id: string; title?: string; owner: string; status: Status; words: Words[]; at: string; project?: string; doneWhen?: string; proof?: string; mergedInto?: string; closed?: string }
export type NewTask = { title: string; message: string; quote?: string; owner: string; status?: 'idea' | 'open'; project?: string; doneWhen?: string }
export type TaskChange = { title?: string; status?: Status; proof?: string; doneWhen?: string; project?: string; owner?: string }
// A call that's the owner's: a question a thread asked with buttons or a poll, in one app's
// thread, under that app's id for the message. via: where the answer came from (the chat app's own
// buttons, hex's voice app, a call). A message id is Telegram's number or Discord's snowflake.
export type MessageId = number | string
export type Answer = { label: string; at: string; via: string }
export type Question = {
  app: string
  thread: string
  message: MessageId
  text: string
  options: string[]
  at: string
  poll?: string
  // Asked with a menu where any number of options can be picked, so a reopen puts the menu back.
  multiple?: boolean
  answer?: Answer
  settled?: { note: string; at: string }
}
export type NewQuestion = Omit<Question, 'at'> & { at?: string }
type StoredQuestion = { app: string; thread: string; message: MessageId; text: string; options: string; at: string; poll: string | null; multiple: number; answer: string | null; settled: string | null }
type StoredTask = { n: number; title: string | null; owner: string; status: Status; project: string | null; done_when: string | null; proof: string | null; merged_into: number | null; at: string; closed: string | null }

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
  `create table questions (
    n integer primary key autoincrement,
    app text not null,
    thread text not null,
    message not null,
    text text not null check (typeof(text) = 'text'),
    options text not null check (json_valid(options) and json_type(options) = 'array'),
    poll text,
    multiple integer not null default 0 check (multiple in (0, 1)),
    answer text check (json_valid(answer)),
    settled text check (json_valid(settled)),
    at text not null check (at ${UTC}),
    unique (app, thread, message)
  );
  create trigger labels before insert on questions when exists (select 1 from json_each(new.options) where type <> 'text')
    begin select raise(abort, 'each option is a label'); end;
  create trigger kept_labels before update of options on questions when exists (select 1 from json_each(new.options) where type <> 'text')
    begin select raise(abort, 'each option is a label'); end;
  create index waiting on questions (thread) where answer is null and settled is null;
  create index polls on questions (app, poll) where poll is not null;`,
  `alter table tasks add column closed text check (closed ${UTC});
  update tasks set closed = at where status in ('done', 'dropped');`,
  `create table threads (app text not null, thread text not null, name text not null, primary key (app, thread));`,
  `alter table messages add column observing_at text check (observing_at ${UTC});
  alter table messages add column observed_at text check (observed_at ${UTC});
  update messages set observed_at = coalesce(taken_at, at);`,
  `create index taken on messages (taken_by, taken_at) where taken_by is not null;
  create index sessions on messages ("to", taken_by) where taken_by is not null;`,
  `drop trigger kept_words;
  create trigger kept_words before update on words when new.rowid <> old.rowid or new.task <> old.task or new.message <> old.message or instr(old.text, new.text) = 0 or length(new.text) = 0
    begin select raise(abort, 'words are only ever cut down to the part that asks'); end;
  drop trigger kept_words_delete;
  create trigger kept_words_delete before delete on words when not exists (select 1 from words w join messages m on m.key = w.message where w.task = old.task and w.message = old.message and w.rowid <> old.rowid and w.text = m.body and instr(w.text, old.text) > 0)
    begin select raise(abort, 'words are added, never taken away'); end;`,
  `create table leases (name text primary key, holder text not null, until text not null check (until ${UTC}));
  create table passes (n integer primary key autoincrement, pass text not null check (json_valid(pass)));`,
  `alter table tasks add column title text;`,
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

  // Every message kept after a time, oldest first.
  since(after: string): Row[] {
    return (this.db.query('select * from messages where at > ? order by at').all(after) as Stored[]).map(toRow)
  }

  // What one session took into its conversation after a time, oldest first.
  took(session: string, after = ''): Row[] {
    return (this.db.query('select * from messages where taken_by = ? and taken_at > ? order by taken_at').all(session, after) as Stored[]).map(toRow)
  }

  // Every session that took a thread's messages, in the order each first did.
  sessions(thread: string): string[] {
    return (this.db.query('select taken_by from messages where "to" = ? and taken_by is not null group by taken_by order by min(taken_at)').all(thread) as { taken_by: string }[]).map(row => row.taken_by)
  }

  // What a session, or another in its thread, took by a time that no pass has looked over for
  // memories yet, oldest first, leased to the pass that asks: two passes never write about the same
  // message, and one that failed or died midway hands its messages to the next in the thread.
  observe(session: string, by: string, thread?: string, lease = 10 * 60_000): Row[] {
    return this.write(() => {
      const rows = this.db
        .query('select * from messages where (taken_by = ? or "to" = ?) and taken_at <= ? and observed_at is null and (observing_at is null or observing_at < ?) order by taken_at')
        .all(session, thread ?? null, by, new Date(Date.now() - lease).toISOString()) as Stored[]
      this.db.query('update messages set observing_at = ? where key in (select value from json_each(?))').run(now(), JSON.stringify(rows.map(row => row.key)))
      return rows.map(toRow)
    })
  }

  // A pass is over: its messages are looked over, or, when it failed, free for the next pass.
  observed(keys: string[], done = true) {
    const set = done ? `observed_at = '${now()}'` : 'observing_at = null'
    this.write(() => this.db.query(`update messages set ${set} where key in (select value from json_each(?))`).run(JSON.stringify(keys)))
  }

  // What no session has taken yet, oldest first: every thread's, or one thread's.
  untaken(thread?: string): Row[] {
    const rows =
      thread === undefined
        ? this.db.query('select * from messages where taken_at is null order by n').all()
        : this.db.query('select * from messages where taken_at is null and "to" = ? order by n').all(thread)
    return (rows as Stored[]).map(toRow)
  }

  // Holds name for holder until it's released or ms pass, whichever comes first; false while another holds it.
  lease(name: string, holder: string, ms: number): boolean {
    return this.write(() => {
      this.db.query('delete from leases where name = ? and until < ?').run(name, now())
      const until = new Date(Date.now() + ms).toISOString()
      this.db.query('insert into leases (name, holder, until) values (?, ?, ?) on conflict (name) do update set until = excluded.until where holder = excluded.holder').run(name, holder, until)
      return (this.db.query('select holder from leases where name = ?').get(name) as { holder: string }).holder === holder
    })
  }

  release(name: string, holder: string) {
    this.write(() => this.db.query('delete from leases where name = ? and holder = ?').run(name, holder))
  }

  // A finished turn waiting for the memory agent, oldest first.
  wait(pass: object) {
    this.write(() => this.db.query('insert into passes (pass) values (?)').run(JSON.stringify(pass)))
  }

  waiting(): { n: number; pass: unknown } | undefined {
    const row = this.db.query('select n, pass from passes order by n limit 1').get() as { n: number; pass: string } | null
    return row ? { n: row.n, pass: JSON.parse(row.pass) } : undefined
  }

  passed(n: number) {
    this.write(() => this.db.query('delete from passes where n = ?').run(n))
  }

  // The last minute since the epoch the scheduler checked, none before its first check.
  checked(): number | undefined {
    return (this.db.query('select checked from scheduler').get() as { checked: number } | null)?.checked
  }

  check(minute: number) {
    this.write(() => this.db.query('insert into scheduler (one, checked) values (1, ?) on conflict (one) do update set checked = excluded.checked').run(minute))
  }

  // A schedule's slot becomes a message to its thread once, whether or not its last one was taken
  // yet: a job runs each time it comes due until the owner stops it.
  fire(schedule: string, minute: number, to: string, body: string, late = false): boolean {
    const slot = new Date(minute * 60_000).toISOString().slice(0, 16)
    return this.deliver({ key: `schedule:${schedule}@${slot}Z`, to, from: 'schedule', body, meta: { user: 'schedule', schedule, ...(late && { late: 'true' }) } })
  }

  // A task from the owner's message under key: all of it, or the part quote names, which has to be
  // in the message as written. A session points at what was said; it can't retype it.
  createTask({ title, message, quote, owner, status = 'open', project, doneWhen }: NewTask): Task {
    title = oneLine(title ?? '')
    if (!title) throw new Error('a task needs a title: what the owner wants done, in a few plain words')
    return this.write(() => {
      const { lastInsertRowid } = this.db
        .query('insert into tasks (title, owner, status, project, done_when, at) values (?, ?, ?, ?, ?, ?)')
        .run(title, owner, status, project ?? null, doneWhen ?? null, now())
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

  // The whole message a task holds, or the whole of what a T3 prompt asked, cut down in place to
  // the part that asks. Quotes picked on purpose are left as they are.
  requote(id: string, message: string, quote: string): Task {
    return this.write(() => {
      const live = this.live(id)
      const said = this.message(message)
      if (!said) throw new Error(`no message ${message}`)
      const rows = this.db.query('select rowid, text from words where task = ? and message = ? order by rowid').all(number(live), message) as { rowid: number; text: string }[]
      const pieces = said.from === 't3' ? sent(said.body) : []
      const whole = rows.find(row => row.text === said.body) ?? rows.find(row => pieces.includes(row.text) && row.text.includes(quote))
      const held = rows.find(row => row.text === quote)
      if (!whole) {
        if (held) return this.task(live)!
        throw new Error(`${live} holds no whole message ${message} to cut "${quote}" from`)
      }
      if (whole === held) return this.task(live)!
      if (!whole.text.includes(quote) || (said.from === 't3' && !pieces.some(piece => piece.includes(quote)))) throw new Error(`"${quote}" isn't in what ${live} holds from ${message}`)
      if (held && whole.text !== said.body) return this.task(live)!
      const others = whole.text === said.body ? rows.filter(row => row === held || (pieces.includes(row.text) && row.text.includes(quote))) : []
      for (const row of others.filter(row => row !== whole)) this.db.query('delete from words where rowid = ?').run(row.rowid)
      this.db.query('update words set text = ? where rowid = ?').run(quote, whole.rowid)
      return this.task(live)!
    })
  }

  editTask(id: string, change: TaskChange): Task {
    const title = change.title === undefined ? undefined : oneLine(change.title)
    if (title === '') throw new Error("a task's title can't be empty")
    return this.write(() => {
      const task = this.task(id)
      if (!task) throw new Error(`no task ${id}`)
      const next = { ...task, ...Object.fromEntries(Object.entries({ ...change, title }).filter(([, value]) => value !== undefined)) }
      const closed = next.status === 'done' || next.status === 'dropped' ? (next.status === task.status ? task.closed : now()) : undefined
      this.db
        .query('update tasks set title = ?, owner = ?, status = ?, project = ?, done_when = ?, proof = ?, closed = ? where n = ?')
        .run(next.title ?? null, next.owner, next.status, next.project ?? null, next.doneWhen ?? null, next.proof ?? null, closed ?? null, number(id))
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
      this.db.query('update tasks set title = coalesce(title, (select title from tasks where n = ?)) where n = ?').run(number(from), number(into))
      this.db.query("update tasks set status = 'dropped', merged_into = ?, closed = ? where n = ?").run(number(into), now(), number(from))
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

  // The owner's last finished tasks, newest first.
  lastDone(owner: string, count: number): Task[] {
    const rows = this.db.query("select * from tasks where owner = ? and status = 'done' order by closed desc, n desc limit ?").all(owner, count) as StoredTask[]
    return rows.map(row => this.toTask(row))
  }

  // Each thread's name as its app's hub last saved it, kept after the thread closes.
  named(app: string, names: Record<string, string>) {
    this.write(() => {
      const keep = this.db.query('insert into threads (app, thread, name) values (?, ?, ?) on conflict (app, thread) do update set name = excluded.name where name is not excluded.name')
      for (const [thread, name] of Object.entries(names)) keep.run(app, thread, name)
    })
  }

  threads(): { app: string; thread: string; name: string }[] {
    return this.db.query('select app, thread, name from threads order by app, thread').all() as { app: string; thread: string; name: string }[]
  }
  // Each thread's name by its id, as threads() keeps them.
  names(): Record<string, string> {
    return Object.fromEntries(this.threads().map(({ thread, name }) => [thread, name]))
  }


  // A new question; at, answer and settled come only with one an older hex kept elsewhere.
  ask({ app, thread, message, text, options, poll, multiple, at = now(), answer, settled }: NewQuestion) {
    this.write(() =>
      this.db
        .query('insert into questions (app, thread, message, text, options, poll, multiple, answer, settled, at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing')
        .run(app, thread, message, text, JSON.stringify(options), poll ?? null, multiple ? 1 : 0, answer ? JSON.stringify(answer) : null, settled ? JSON.stringify(settled) : null, at),
    )
  }

  question(app: string, thread: string, message: MessageId): Question | null {
    const row = this.db.query('select * from questions where app = ? and thread = ? and message = ?').get(app, thread, message) as StoredQuestion | null
    return row && toQuestion(row)
  }

  poll(app: string, poll: string): Question | null {
    const row = this.db.query('select * from questions where app = ? and poll = ?').get(app, poll) as StoredQuestion | null
    return row && toQuestion(row)
  }

  // Oldest first: every app's, or one app's or thread's, and only those still waiting on an answer.
  questions({ app, thread, waiting }: { app?: string; thread?: string; waiting?: boolean } = {}): Question[] {
    const rows = this.db
      .query('select * from questions where (?1 is null or app = ?1) and (?2 is null or thread = ?2) and (?3 is null or (answer is null and settled is null)) order by n')
      .all(app ?? null, thread ?? null, waiting ? 1 : null) as StoredQuestion[]
    return rows.map(toQuestion)
  }

  // The owner's answer, unless one stands already: the first tap wins, and a later one changes
  // nothing. again: a poll vote, which replaces the one before it. Whether this answer stands now.
  answered(app: string, thread: string, message: MessageId, label: string, via: string, again = false): boolean {
    return this.write(
      () =>
        this.db
          .query('update questions set answer = ?, settled = null where app = ? and thread = ? and message = ? and (? or answer is null)')
          .run(JSON.stringify({ label, at: now(), via }), app, thread, message, again).changes === 1,
    )
  }

  // The message asking it was edited: the question is what it says now.
  reworded(app: string, thread: string, message: MessageId, text: string) {
    this.write(() => this.db.query('update questions set text = ? where app = ? and thread = ? and message = ?').run(text, app, thread, message))
  }

  settled(app: string, thread: string, message: MessageId, note: string) {
    this.write(() => this.db.query('update questions set settled = ? where app = ? and thread = ? and message = ?').run(JSON.stringify({ note, at: now() }), app, thread, message))
  }

  // Whether the question had an answer or a settle to take back.
  reopened(app: string, thread: string, message: MessageId): boolean {
    return this.write(
      () =>
        this.db
          .query('update questions set answer = null, settled = null where app = ? and thread = ? and message = ? and (answer is not null or settled is not null)')
          .run(app, thread, message).changes === 1,
    )
  }

  // The message that asked it is gone: one message's question, or a whole thread's.
  unask(app: string, thread: string, message?: MessageId) {
    this.write(() => this.db.query('delete from questions where app = ? and thread = ? and (?3 is null or message = ?3)').run(app, thread, message ?? null))
  }

  // What a session was last shown ('' when nothing yet) when it differs from digest, noting digest
  // as shown, or null when it's the same: one step, so two hooks never diff against a stale record.
  swap(session: string, digest: string): string | null {
    return this.write(() => {
      const was = (this.db.query('select digest from shown where session = ?').get(session) as { digest: string } | null)?.digest ?? ''
      if (was === digest) return null
      this.db.query('insert into shown (session, digest) values (?, ?) on conflict (session) do update set digest = excluded.digest').run(session, digest)
      return was
    })
  }

  // Whether what a session was last shown differs from digest, noting digest as shown.
  show(session: string, digest: string): boolean {
    return this.swap(session, digest) !== null
  }

  // The session's context lost what it was shown (a compaction, a clear), so its next show is in full.
  unshow(session: string) {
    this.write(() => this.db.query('delete from shown where session = ?').run(session))
  }

  private quote(task: string, message: string, quote?: string) {
    const said = this.message(message)
    if (!said) throw new Error(`no message ${message}`)
    const pieces = quote === undefined && said.from === 't3' ? sent(said.body) : []
    if (quote === undefined && this.db.query('select 1 from words where task = ? and message = ?').get(number(task), message)) return
    const texts = quote !== undefined ? [quote] : said.from === 't3' ? pieces : [said.body]
    if (!texts.length) throw new Error(`${message} has no words to quote`)
    for (const text of texts) {
      if (!text) throw new Error(quote === undefined ? `${message} has no words to quote` : 'a quote needs words from the message')
      if (!said.body.includes(text)) throw new Error(`"${text}" isn't in ${message} as written; quote it character for character, or leave the quote out for all it asks`)
      this.db.query('insert into words (task, message, text) values (?, ?, ?) on conflict (task, message, text) do nothing').run(number(task), message, text)
    }
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
      ...(row.title && { title: row.title }),
      owner: row.owner,
      status: row.status,
      words,
      at: row.at,
      ...(row.project && { project: row.project }),
      ...(row.done_when && { doneWhen: row.done_when }),
      ...(row.proof && { proof: row.proof }),
      ...(row.merged_into && { mergedInto: `t-${row.merged_into}` }),
      ...(row.closed && { closed: row.closed }),
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

// Where an app's hub keeps hex.db: the hex's own state/, or the app's state folder outside a hex.
const hexState = process.env.HEX_DIR && join(process.env.HEX_DIR, 'state')
export const storeDir = (stateDir: string) => hexState || stateDir

// The store in dir (a hex's state/), one per process.
export function open(dir: string): Store {
  let store = stores.get(dir)
  if (!store) stores.set(dir, (store = new Store(dir)))
  return store
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

function number(id: string): number {
  const n = Number(id.replace(/^t-/, ''))
  if (!Number.isInteger(n)) throw new Error(`${id} isn't a task id, like t-12`)
  return n
}

function toQuestion(row: StoredQuestion): Question {
  return {
    app: row.app,
    thread: row.thread,
    message: row.message,
    text: row.text,
    options: JSON.parse(row.options),
    at: row.at,
    ...(row.poll && { poll: row.poll }),
    ...(row.multiple && { multiple: true }),
    ...(row.answer && { answer: JSON.parse(row.answer) }),
    ...(row.settled && { settled: JSON.parse(row.settled) }),
  }
}

// T3 Code sends a message with its own context around it: the owner's words are its user_request,
// or what's left without T3's blocks.
export function asked(text: string) {
  return (text.match(/<user_request>\n?([\s\S]*?)\n?<\/user_request>/)?.[1] ?? text.replace(/^<([a-z0-9_]+)>[\s\S]*?<\/\1>$/gm, '')).trim()
}

// What the owner sent in a T3 prompt, piece by piece: the prompt without T3's own blocks, with the
// request unwrapped, and anything sent with it, like an attachment, as a piece of its own.
function sent(body: string) {
  const request = body.match(/<user_request>\n?([\s\S]*?)\n?<\/user_request>/)
  const around = (text: string) => text.split(/^<(t3_code_instructions|runtime_info|pull_request_linking)>[\s\S]*?<\/\1>$/m).filter((_, i) => i % 2 === 0)
  const pieces = request ? [...around(body.slice(0, request.index)), request[1]!, ...around(body.slice(request.index! + request[0].length))] : around(body)
  return pieces.map(piece => piece.trim()).filter(Boolean)
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
