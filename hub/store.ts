import { Database } from 'bun:sqlite'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, watch, type FSWatcher } from 'fs'
import { basename, join } from 'path'

// One message as hex keeps it: anything said in a thread, word for word, under the app's own id for
// it. from: the app it was said in. author: who said it, set once by whatever kept it: the owner,
// hex (a reply, a session's turn), a prompt (what hex itself tells a session: a job's end, a
// schedule, another thread, the hub), a call's transcript, or someone other than the owner (another
// person in a shared app, T3 Code itself); meta.user names the sender. taken: the session that has
// it in its conversation, which for hex's own words is the one that wrote them, so nothing wakes on
// them. A message no session has taken is what wakes a thread.
export type Author = 'owner' | 'hex' | 'prompt' | 'call' | 'other'
export type Row = { key: string; to: string; from: string; author: Author; body: string; at: string; meta?: Record<string, string>; taken?: { by: string; at: string } }
export type NewRow = Omit<Row, 'at' | 'taken'>
type Stored = { key: string; to: string; from: string; author: Author; body: string; at: string; meta: string | null; taken_by: string | null; taken_at: string | null }

// One thing the owner wants done: a short title in plain words that keeps their intent, and their
// own words, each quoted from a message they sent, under its key, with who sent it and when. Words
// are only ever added. A task merged into another
// is dropped, and its words live on in the one it went into.
export type Status = 'idea' | 'open' | 'done' | 'dropped'
export type Words = { message: string; text: string; who: Author; at: string }
export type Task = { id: string; title: string; owner: string; status: Status; words: Words[]; at: string; project?: string; doneWhen?: string; proof?: string; mergedInto?: string; closed?: string }
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
// A thread of one app, by that app's id for it: its name, the Claude Code session that serves it and
// the folder it runs in, its settings, the hash of what its session started with (hub.ts stamp()),
// the session a new thread forks from at its first start, and where its app opens it.
export type Thread = { app: string; thread: string; name: string; open: boolean; session?: string; cwd?: string; model?: string; effort?: string; launched?: string; fork?: string; link?: string }
export type Kept = Omit<Thread, 'app' | 'thread' | 'open'>
// A thread's pinned post in its app, as last written. A pin with a note is the thread's status post:
// hex writes it as the note over the thread's questions and tasks (status.ts).
export type Pin = { app: string; thread: string; message: MessageId; text: string; at: string; note?: string }
type StoredPin = Omit<Pin, 'note'> & { note: string | null }
export type NewQuestion = Omit<Question, 'at'> & { at?: string }
type StoredQuestion = { app: string; thread: string; message: MessageId; text: string; options: string; at: string; poll: string | null; multiple: number; answer: string | null; settled: string | null }
type StoredTask = { n: number; title: string; owner: string; status: Status; project: string | null; done_when: string | null; proof: string | null; merged_into: number | null; at: string; closed: string | null }

// Migration n takes the database from user_version n to n + 1: SQL, or a step that needs more than
// SQL can do, run in the same transaction. Append; never edit one that has shipped. Times are UTC the way toISOString() writes them, so they sort as text. A key starts with
// its sender, so a key hex makes for a schedule's slot or a job's end can't be one an app sent.
const UTC = "glob '????-??-??T??:??:??.???Z'"
// Who wrote each message kept before hex kept authors: one with a chat app's user_id is the owner's
// (Telegram and Discord let only them in), and so is what they typed or tapped in the hex app; in Buzz,
// which is shared, it's the sender's key; a call's transcript is a call; what hex itself sent a session
// is a prompt; any other is its user's.
const AUTHOR = `case
    when "from" = 'buzz' and json_extract(meta, '$.user_id') is not null then 'buzz:' || json_extract(meta, '$.user_id')
    when json_extract(meta, '$.user_id') is not null then 'owner'
    when json_extract(meta, '$.user') in ('hex app', 'hex call') then 'owner'
    when json_extract(meta, '$.user') = 'hex' then 'prompt'
    when "from" = 'voice' and json_extract(meta, '$.callee') is null and (json_extract(meta, '$.delegation_id') is not null or json_extract(meta, '$.ended') is not null) then 'call'
    when "from" = 't3' and json_extract(meta, '$.user') is null then 'owner'
    else coalesce(json_extract(meta, '$.user'), "from") end`
const authors = new Set<string>(['owner', 'hex', 'prompt', 'call', 'other'] satisfies Author[])
export const isAuthor = (value: unknown): value is Author => authors.has(value as string)
const AUTHORS = `(${[...authors].map(author => `'${author}'`).join(', ')})`
const migrations: (string | ((store: Store) => void))[] = [
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
  `update tasks set title = coalesce(nullif(trim(substr(replace((select text from words where task = tasks.n order by rowid limit 1), char(10), ' '), 1, 80)), ''), 'Task ' || n) where title is null;`,
  `alter table messages add column author text not null default '';
  update messages set author = ${AUTHOR};
  create index said on messages ("to", at);
  create index unauthored on messages (n) where author = '';`,
  `create table seen (session text not null, kind text not null, record text not null, primary key (session, kind));
  insert into seen (session, kind, record) select session, 'tasks', digest from shown;`,
  `create table profiles (n integer primary key, at text not null check (at ${UTC}), body text not null check (length(trim(body)) > 0));
  create trigger kept_profile before update on profiles begin select raise(abort, 'a profile is added, never rewritten'); end;
  create trigger kept_profiles before delete on profiles begin select raise(abort, 'a profile is added, never taken away'); end;`,
  carryProfile,
  `update messages set author = ${AUTHOR} where author = '';
  update messages set meta = json_set(coalesce(meta, '{}'), '$.user', author) where author not in ${AUTHORS} and json_extract(meta, '$.user') is null;
  update messages set author = case when author like 'buzz:%' or author in ('t3', 'discord') or ("from" = 'voice' and json_extract(meta, '$.callee') is not null) then 'other' else 'prompt' end where author not in ${AUTHORS};
  drop index unauthored;`,
  `alter table threads add column open integer not null default 0 check (open in (0, 1));
  alter table threads add column session text;
  alter table threads add column cwd text;
  alter table threads add column model text;
  alter table threads add column effort text;
  alter table threads add column launched text;
  alter table threads add column fork text;
  alter table threads add column link text;`,
  // Each app's threads.json, as its hub last wrote it, becomes that app's open threads: in a hex's
  // state/<app>/, or in the app's own state folder outside a hex, named for the app. The file stays
  // where it is, read by nothing newer, so an older hex rolled back to still has it.
  ({ db, dir }: Store) => {
    const keep = db.query(
      `insert into threads (app, thread, name, open, session, cwd, model, effort, launched, fork) values (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
      on conflict (app, thread) do update set name = excluded.name, open = 1, session = excluded.session, cwd = excluded.cwd, model = excluded.model, effort = excluded.effort, launched = excluded.launched, fork = excluded.fork`,
    )
    const text = (value: unknown) => (typeof value === 'string' ? value : null)
    for (const [app, file] of [[basename(dir), join(dir, 'threads.json')], ...readdirSync(dir).map(app => [app, join(dir, app, 'threads.json')])] as const) {
      if (!existsSync(file)) continue
      let saved: Record<string, any>
      try {
        saved = JSON.parse(readFileSync(file, 'utf8')) ?? {}
      } catch (error) {
        process.stderr.write(`hex.db left out ${file}, which is unreadable: ${error}\n`)
        continue
      }
      for (const [thread, known] of Object.entries(saved))
        if (typeof known?.name === 'string') keep.run(app, thread, known.name, text(known.session), text(known.cwd), text(known.model), text(known.effort), text(known.launched), text(known.from))
    }
  },
  `create table pins (
    app text not null,
    thread text not null,
    message not null,
    text text not null,
    note text,
    at text not null check (at ${UTC}),
    primary key (app, thread)
  );
  create table files (name text primary key, body text not null);`,
]

const now = () => new Date().toISOString()

// The profile and its history moved into hex.db from state/profile.md and profile.md.history, where
// each version it replaced is a JSON line with when it was replaced: when the next was put in place.
// A run of the same version is kept once. The files are renamed, not deleted, so nothing still
// writing to them mistakes them for the profile; a carry that failed after renaming them reads the
// renamed ones when it runs again.
function carryProfile(store: Store) {
  const [file, history] = ['profile.md', 'profile.md.history'].map(name => join(store.dir, name))
  const moved = (path: string) => `${path}.moved-to-hex.db`
  const from = (path: string) => [path, moved(path)].find(each => existsSync(each))
  const current = from(file!)
  if (!current || !readFileSync(current, 'utf8').trim()) return
  const before = from(history!)
  const when = (at: unknown) => (typeof at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(at) ? at : statSync(before!).mtime.toISOString())
  const replaced = (before ? readFileSync(before, 'utf8').split('\n').filter(Boolean) : []).map(line => {
    try {
      const { at, profile } = JSON.parse(line)
      return { at: when(at), body: typeof profile === 'string' ? profile.trim() : '' }
    } catch {
      return { at: when(undefined), body: '' }
    }
  })
  const latest = [replaced.at(-1)?.at ?? '', statSync(current).mtime.toISOString()].sort().at(-1)!
  const versions = [...replaced.map(({ body }, n) => ({ at: replaced[n - 1]?.at ?? replaced[0]!.at, body })), { at: latest, body: readFileSync(current, 'utf8').trim() }]
  const keep = store.db.query('insert into profiles (at, body) values (?, ?)')
  let last = ''
  for (const { at, body } of versions) if (body && body !== last) keep.run(at, (last = body))
  for (const each of [file!, history!]) if (existsSync(each)) renameSync(each, moved(each))
}

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
        const step = migrations[version]!
        if (typeof step === 'string') this.db.run(step)
        else step(this)
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
    this.watcher ??= watch(this.bell, () => this.rang())
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size) return
      this.watcher?.close()
      this.watcher = undefined
    }
  }

  // Bun's fs.watch drops a change that lands within about a millisecond of the one it just reported,
  // so each ring is heard again once that has passed, if hex.db moved since.
  private rang() {
    const seen = this.moved()
    for (const each of this.listeners) each()
    setTimeout(() => this.watcher && this.moved() !== seen && this.rang(), 5)
  }

  // Keeps a new message. A key that's kept already is its sender sending it again: false. by: the
  // session that wrote it, which has it in its conversation already.
  deliver({ key, to, from, author, body, meta }: NewRow, by?: string): boolean {
    if (!isAuthor(author)) throw new Error(`${key}'s author is ${author || 'missing'}: a message's author is owner, hex, prompt, call or other`)
    const at = now()
    return this.write(
      () =>
        this.db
          .query('insert into messages (key, "to", "from", author, body, meta, at, taken_by, taken_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (key) do nothing')
          .run(key, to, from, author, body, meta ? JSON.stringify(meta) : null, at, by ?? null, by ? at : null).changes > 0,
    )
  }

  // Messages brought in from log/ (hub/past.ts) keep the time it gave them, taken and looked over then.
  past(times: [string, string][]) {
    this.write(() => {
      const at = this.db.query('update messages set at = ?2, taken_at = ?2, observed_at = ?2 where key = ?1')
      for (const [key, when] of times) at.run(key, when)
    })
  }

  // Buzz rows from before #69 that name their sender only by key became other, since the store can't
  // know the owner's key; the Buzz hub, which does, hands back the owner's.
  own(from: string, userId: string) {
    this.write(() => this.db.query(`update messages set author = 'owner' where "from" = ? and author = 'other' and json_extract(meta, '$.user_id') = ?`).run(from, userId))
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
  since(after = ''): Row[] {
    return (this.db.query('select * from messages where at > ? order by at, n').all(after) as Stored[]).map(toRow)
  }

  // A message as it reads now: the message, with its newest edit's words, or the edit alone when only
  // that was kept. An edit is kept as a row of its own in the thread that made it, naming the app's id
  // for the message, the last part of its key; a Telegram id is only unique in its chat, the part
  // before it, so its edits are the ones kept in that chat.
  latest(key: string): Row | null {
    const app = key.slice(0, key.indexOf(':'))
    const id = key.slice(key.lastIndexOf(':') + 1)
    const chat = key.slice(app.length + 1, -id.length - 1)
    const original = this.message(key)
    const edit = this.db
      .query(
        `select * from messages where "from" = ?1 and json_extract(meta, '$.edited') = 'true' and json_extract(meta, '$.message_id') = ?2
           and (?3 = '' or "to" = ?3 or "to" like ?3 || ':%') order by at desc, n desc limit 1`,
      )
      .get(app, id, chat) as Stored | null
    if (!edit) return original
    return original ? { ...original, body: edit.body } : toRow(edit)
  }

  // A thread's messages, oldest first: all of them, or its last few, or its last few before a time.
  said(thread: string, last = -1, before = '9'): Row[] {
    return (this.db.query('select * from (select * from messages where "to" = ? and at < ? order by at desc, n desc limit ?) order by at, n').all(thread, before, last) as Stored[]).map(toRow)
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
    return this.deliver({ key: `schedule:${schedule}@${slot}Z`, to, from: 'schedule', author: 'prompt', body, meta: { user: 'schedule', schedule, ...(late && { late: 'true' }) } })
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
      // A task that's live again isn't done, so the proof it was closed with goes.
      if ((next.status === 'open' || next.status === 'idea') && change.proof === undefined) delete next.proof
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
      this.db.query("update tasks set status = 'dropped', merged_into = ?, closed = ? where n = ?").run(number(into), now(), number(from))
      return this.task(into)!
    })
  }

  task(id: string): Task | null {
    const row = this.db.query('select * from tasks where n = ?').get(number(id)) as StoredTask | null
    return row && this.toTask(row)
  }

  // Newest first: every task, or one owner's, or those in some states.
  tasks({ owner, status }: { owner?: string; status?: Status[] } = {}): Task[] {
    const rows = this.db
      .query('select * from tasks where (?1 is null or owner = ?1) and (?2 is null or status in (select value from json_each(?2))) order by at desc, n desc')
      .all(owner ?? null, status ? JSON.stringify(status) : null) as StoredTask[]
    return rows.map(row => this.toTask(row))
  }

  // The owner's last finished tasks, newest first.
  lastDone(owner: string, count: number): Task[] {
    const rows = this.db.query("select * from tasks where owner = ? and status = 'done' order by closed desc, n desc limit ?").all(owner, count) as StoredTask[]
    return rows.map(row => this.toTask(row))
  }

  // An app's open threads as its hub keeps them. A thread left out has closed: it keeps its row, with
  // its name and last session, for whatever reads one.
  keepThreads(app: string, open: Record<string, Kept>) {
    this.write(() => {
      this.db.query('update threads set open = 0 where app = ? and open = 1 and thread not in (select value from json_each(?))').run(app, JSON.stringify(Object.keys(open)))
      const keep = this.db.query(
        `insert into threads (app, thread, name, open, session, cwd, model, effort, launched, fork, link) values (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
        on conflict (app, thread) do update set name = excluded.name, open = 1, session = excluded.session, cwd = excluded.cwd, model = excluded.model,
          effort = excluded.effort, launched = excluded.launched, fork = excluded.fork, link = coalesce(excluded.link, link)
        where (name, open, session, cwd, model, effort, launched, fork) is not (excluded.name, 1, excluded.session, excluded.cwd, excluded.model, excluded.effort, excluded.launched, excluded.fork)
          or coalesce(excluded.link, link) is not link`,
      )
      for (const [thread, { name, session, cwd, model, effort, launched, fork, link }] of Object.entries(open))
        keep.run(app, thread, name, session ?? null, cwd ?? null, model ?? null, effort ?? null, launched ?? null, fork ?? null, link ?? null)
    })
  }

  // Every thread hex has had, or one app's, or only those open now.
  threads({ app, open }: { app?: string; open?: boolean } = {}): Thread[] {
    const rows = this.db
      .query('select * from threads where (?1 is null or app = ?1) and (?2 is null or open = ?2) order by app, thread')
      .all(app ?? null, open === undefined ? null : Number(open)) as (Record<string, string | null> & { open: number })[]
    return rows.map(({ open, ...row }) => ({ ...(Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)) as Omit<Thread, 'open'>), open: !!open }))
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

  // The owner's profile, which the memory agent keeps: its newest version, '' when there's none yet.
  profile(): string {
    return (this.db.query('select body from profiles order by n desc limit 1').get() as { body: string } | null)?.body ?? ''
  }

  // Every version of the profile, newest first, each with when it was put in place.
  profiles(): { at: string; body: string }[] {
    return this.db.query('select at, body from profiles order by n desc').all() as { at: string; body: string }[]
  }

  // Puts body in place as the profile if the newest is still before, so two passes never both write
  // over the one they read. The one it replaced stays, as history.
  profiled(before: string, body: string, at = now()): boolean {
    return this.write(() => {
      if (this.profile() !== before.trim()) return false
      if (body.trim() === before.trim()) return true
      this.db.query('insert into profiles (at, body) values (?, ?)').run(at, body.trim())
      return true
    })
  }

  // Runs take with what an older hex keeps in a file, under a name of its own, when the file says
  // something else than when hex.db last took it in, with what it said then: the first time, and after
  // an older hex (rolled back to) wrote it again. A copy, move or touch of the same words changes
  // nothing, and words take can't read (it returns false) aren't kept as taken in.
  takeIn(name: string, file: string, take: (now: string, before?: string) => boolean | void) {
    let now: string
    try {
      now = readFileSync(file, 'utf8')
    } catch {
      return
    }
    this.write(() => {
      const before = (this.db.query('select body from files where name = ?').get(name) as { body: string } | null)?.body
      if (before === now) return
      if (take(now, before) === false) return
      this.db.query('insert into files (name, body) values (?, ?) on conflict (name) do update set body = excluded.body').run(name, now)
    })
  }

  pin(app: string, thread: string): Pin | null {
    const row = this.db.query('select * from pins where app = ? and thread = ?').get(app, thread) as StoredPin | null
    return row && toPin(row)
  }

  // Every thread's pin, or one app's or one thread's.
  pins({ app, thread }: { app?: string; thread?: string } = {}): Pin[] {
    const rows = this.db.query('select * from pins where (?1 is null or app = ?1) and (?2 is null or thread = ?2) order by app, thread').all(app ?? null, thread ?? null) as StoredPin[]
    return rows.map(toPin)
  }

  // The thread's pin is now this message; at comes only with one an older hex kept elsewhere.
  pinned({ app, thread, message, text, note, at = now() }: Omit<Pin, 'at'> & { at?: string }) {
    this.write(() =>
      this.db
        .query('insert into pins (app, thread, message, text, note, at) values (?, ?, ?, ?, ?, ?) on conflict (app, thread) do update set message = excluded.message, text = excluded.text, note = excluded.note, at = excluded.at')
        .run(app, thread, message, text, note ?? null, at),
    )
  }

  // The thread has no pin now, or none if its pin was this message; with no thread, no thread of the app has one.
  unpinned(app: string, thread?: string, message?: MessageId) {
    this.write(() => this.db.query('delete from pins where app = ?1 and (?2 is null or thread = ?2) and (?3 is null or message = ?3)').run(app, thread ?? null, message ?? null))
  }

  // What a session was last shown of one kind, like its rules or its tasks: '' when nothing yet.
  seen(session: string, kind: string): string {
    return (this.db.query('select record from seen where session = ? and kind = ?').get(session, kind) as { record: string } | null)?.record ?? ''
  }

  show(session: string, kind: string, record: string) {
    this.write(() => this.db.query('insert into seen (session, kind, record) values (?, ?, ?) on conflict (session, kind) do update set record = excluded.record').run(session, kind, record))
  }

  // The session's context lost what it was shown of a kind: a compaction, a clear, or for its rules, its end.
  unshow(session: string, kind: string) {
    this.write(() => this.db.query('delete from seen where session = ? and kind = ?').run(session, kind))
  }

  private quote(task: string, message: string, quote?: string) {
    const said = this.message(message)
    if (!said) throw new Error(`no message ${message}`)
    const pieces = quote === undefined && said.from === 't3' ? sent(said.body) : []
    if (quote === undefined && this.db.query('select 1 from words where task = ? and message = ?').get(number(task), message)) return
    const texts = quote !== undefined ? [quote] : said.from === 't3' ? pieces : said.author === 'call' ? spoken(said).split('\n') : [said.body]
    if (!texts.length) throw new Error(`${message} has no words to quote`)
    if (!spoken(said)) throw new Error(`${message} is ${said.author}'s, not the owner's; a task holds the owner's words`)
    for (const text of texts) {
      if (!text) throw new Error(quote === undefined ? `${message} has no words to quote` : 'a quote needs words from the message')
      if (!spoken(said).includes(text)) throw new Error(`"${text}" isn't in ${message} as written; quote it character for character, or leave the quote out for all it asks`)
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
        `select words.message, words.text, messages.author as who, messages.at
         from words join messages on messages.key = words.message where words.task = ? order by words.rowid`,
      )
      .all(row.n) as Words[]
    return {
      id: `t-${row.n}`,
      title: row.title,
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

  // Changes since this connection opened: its own, and other processes' commits.
  private moved() {
    return `${(this.db.query('pragma data_version').get() as { data_version: number }).data_version}:${this.changes()}`
  }

  private changes() {
    return (this.db.query('select total_changes() as n').get() as { n: number }).n
  }
}

const stores = new Map<string, Store>()

// Where an app's hub keeps hex.db: the hex's own state/, or the app's state folder outside a hex.
const hexState = process.env.HEX_DIR && join(process.env.HEX_DIR, 'state')
export const storeDir = (stateDir: string) => hexState || stateDir

// The state folder a hook or command reads: the one the hub names in HEX_STORE, or this hex's own.
export const stateDir = () => process.env.HEX_STORE || join(import.meta.dir, '..', '..', 'state')

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

function toPin({ note, ...pin }: StoredPin): Pin {
  return { ...pin, ...(note !== null && { note }) }
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

// The owner's own words in a message: all of it when they wrote it, less the context T3 Code sends
// around a prompt; their lines of a call's transcript; and nothing of anyone else's.
export function spoken(row: Row): string {
  if (row.author === 'owner') return row.from === 't3' ? row.body.replace(/^<(t3_code_instructions|runtime_info|pull_request_linking)>[\s\S]*?<\/\1>$/gm, '') : row.body
  if (row.author !== 'call') return ''
  return [...row.body.matchAll(/^\[[\d.]+s\] you: (.*)$/gm)].map(([, line]) => line).join('\n')
}

// hex's own words, as it sent them: a reply, a post, a terminal's answer. What hex tells a session is a prompt.
export const replied = (row: Row) => row.author === 'hex'
// A row of the conversation: not a reply of hex's that failed, was an edit, or asked a permission.
export const shown = (row: Row) => !replied(row) || !(row.meta?.failed || row.meta?.edited || row.meta?.permission)

function toRow(row: Stored): Row {
  return {
    key: row.key,
    to: row.to,
    from: row.from,
    author: row.author,
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
