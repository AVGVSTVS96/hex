import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  watch,
} from "node:fs";
import type { FSWatcher } from "node:fs";
import { basename, join } from "node:path";

import { z } from "zod";

import { above } from "./fit.ts";

const AuthorColumn = z.enum(["owner", "hex", "prompt", "call", "other"]);

export type Author = z.infer<typeof AuthorColumn>;

export type Row = {
  key: string;
  to: string;
  from: string;
  author: Author;
  body: string;
  at: string;
  meta?: Record<string, string>;
  taken?: { by: string; at: string };
};

export type NewRow = Omit<Row, "at" | "taken">;

export type Status = "idea" | "open" | "done" | "dropped";

export type Words = { message: string; text: string; who: Author; at: string };

export type Task = {
  id: string;
  title: string;
  owner: string;
  status: Status;
  words: Words[];
  at: string;
  project?: string;
  doneWhen?: string;
  proof?: string;
  mergedInto?: string;
  closed?: string;
};

export type NewTask = {
  title: string;
  message: string;
  quote?: string | undefined;
  owner: string;
  status?: "idea" | "open" | undefined;
  project?: string | undefined;
  doneWhen?: string | undefined;
};

export type TaskChange = {
  title?: string | undefined;
  status?: Status | undefined;
  proof?: string | undefined;
  doneWhen?: string | undefined;
  project?: string | undefined;
  owner?: string | undefined;
  doneIn?: string | undefined;
};

export type Held = { thread: string; ended?: string; ending?: string; woke?: string };

export type Hold = {
  id: string;
  by: string;
  why: string;
  message?: string;
  until?: string;
  at: string;
  threads: Held[];
};

export type NewHold = {
  threads: string[];
  by: string;
  why: string;
  message?: string | undefined;
  until?: string | undefined;
};

export type MessageId = number | string;

export type Answer = { label: string; at: string; via: string; message?: MessageId; kept?: true };

export type Question = {
  asker?: "owner";
  app: string;
  thread: string;
  message: MessageId;
  text: string;
  options: string[];
  at: string;
  poll?: string;
  multiple?: boolean;
  shots?: string[];
  answer?: Answer;
  settled?: { note: string; at: string };
};

export type LaunchStamp = string;

export type Thread = {
  app: string;
  thread: string;
  name: string;
  open: boolean;
  session?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  launched?: LaunchStamp;
  fork?: string;
  link?: string;
};

export type Kept = Omit<Thread, "app" | "thread" | "open">;

export type Pin = {
  app: string;
  thread: string;
  message: MessageId;
  text: string;
  at: string;
  note: string;
};

export type NewQuestion = Omit<Question, "at"> & { at?: string };

type Beat = { began: string; until?: string; after?: string };

export const waits = (question: Question) =>
  !question.settled && (question.asker === "owner") === !!question.answer;

export const isAuthor = (value: unknown): value is Author => AuthorColumn.safeParse(value).success;

function fromJson<T>(schema: z.ZodType<T>, text: string): T {
  return schema.parse(JSON.parse(text));
}

const MessageIdColumn = z.union([z.number(), z.string()]);
const TextOrNull = z.string().nullable();

const TextOrAbsent = TextOrNull.transform((text) =>
  text === null || text === "" ? undefined : text,
);

const Meta = z.record(z.string(), z.string());
const Labels = z.array(z.string());

const MessageRow = z
  .object({
    key: z.string(),
    to: z.string(),
    from: z.string(),
    author: AuthorColumn,
    body: z.string(),
    at: z.string(),
    meta: TextOrNull,
    taken_by: TextOrNull,
    taken_at: TextOrNull,
  })
  .transform((row): Row => ({
    key: row.key,
    to: row.to,
    from: row.from,
    author: row.author,
    body: row.body,
    at: row.at,
    ...(row.meta !== null && row.meta !== "" && { meta: fromJson(Meta, row.meta) }),
    ...(row.taken_by !== null &&
      row.taken_by !== "" &&
      row.taken_at !== null && { taken: { by: row.taken_by, at: row.taken_at } }),
  }));

const MessageRows = z.array(MessageRow);

const AnswerJson: z.ZodType<Answer> = z.object({
  label: z.string(),
  at: z.string(),
  via: z.string(),
  message: MessageIdColumn.exactOptional(),
  kept: z.literal(true).exactOptional(),
});

const SettledJson = z.object({ note: z.string(), at: z.string() });

const QuestionRow = z
  .object({
    asker: z.enum(["hex", "owner"]).default("hex"),
    app: z.string(),
    thread: z.string(),
    message: MessageIdColumn,
    text: z.string(),
    options: z.string(),
    at: z.string(),
    poll: TextOrAbsent,
    multiple: z.number(),
    shots: TextOrAbsent.optional(),
    answer: TextOrAbsent,
    settled: TextOrAbsent,
  })
  .transform((row): Question => ({
    ...(row.asker === "owner" && { asker: "owner" as const }),
    app: row.app,
    thread: row.thread,
    message: row.message,
    text: row.text,
    options: fromJson(Labels, row.options),
    at: row.at,
    ...(row.poll !== undefined && { poll: row.poll }),
    ...(row.multiple !== 0 && { multiple: true }),
    ...(row.shots !== undefined && { shots: fromJson(Labels, row.shots) }),
    ...(row.answer !== undefined && { answer: fromJson(AnswerJson, row.answer) }),
    ...(row.settled !== undefined && { settled: fromJson(SettledJson, row.settled) }),
  }));

const QuestionRows = z.array(QuestionRow);

const TaskRow = z.object({
  n: z.number(),
  title: z.string(),
  owner: z.string(),
  status: z.enum(["idea", "open", "done", "dropped"]),
  project: TextOrAbsent,
  done_when: TextOrAbsent,
  proof: TextOrAbsent,
  merged_into: z.number().nullable(),
  at: z.string(),
  closed: TextOrAbsent,
});

type StoredTask = z.infer<typeof TaskRow>;

const TaskRows = z.array(TaskRow);

const WordsRows: z.ZodType<Words[]> = z.array(
  z.object({ message: z.string(), text: z.string(), who: AuthorColumn, at: z.string() }),
);

const ThreadRows = z.array(
  z
    .object({
      app: z.string(),
      thread: z.string(),
      name: z.string(),
      open: z.number(),
      session: TextOrNull,
      cwd: TextOrNull,
      model: TextOrNull,
      effort: TextOrNull,
      launched: TextOrNull,
      fork: TextOrNull,
      link: TextOrNull,
    })
    .transform(
      ({
        app,
        thread,
        name,
        open: isOpen,
        session,
        cwd,
        model,
        effort,
        launched,
        fork,
        link,
      }): Thread => ({
        app,
        thread,
        name,
        ...(session !== null && { session }),
        ...(cwd !== null && { cwd }),
        ...(model !== null && { model }),
        ...(effort !== null && { effort }),
        ...(launched !== null && { launched }),
        ...(fork !== null && { fork }),
        ...(link !== null && { link }),
        open: isOpen !== 0,
      }),
    ),
);

const PinRow: z.ZodType<Pin> = z.object({
  app: z.string(),
  thread: z.string(),
  message: MessageIdColumn,
  text: z.string(),
  at: z.string(),
  note: z.string(),
});

const PinRows = z.array(PinRow);

const HoldRows = z.array(
  z.object({
    n: z.number(),
    by: z.string(),
    why: z.string(),
    message: TextOrAbsent,
    until: TextOrAbsent,
    at: z.string(),
  }),
);

const HeldRows = z.array(
  z
    .object({ thread: z.string(), ended: TextOrNull, ending: TextOrNull, woke: TextOrNull })
    .transform(({ thread, ended, ending, woke }): Held => ({
      thread,
      ...(ended !== null && { ended }),
      ...(ending !== null && { ending }),
      ...(woke !== null && { woke }),
    })),
);

const FreedRows = z.array(
  z.object({ id: z.string(), thread: z.string(), why: z.string(), ending: z.string() }),
);

const BeatRows = z.array(
  z.object({ session: z.string(), began: z.string(), until: TextOrAbsent, after: TextOrAbsent }),
);

const TurnRow = z
  .object({ began: TextOrAbsent, ended: TextOrAbsent, handled: TextOrAbsent })
  .transform(({ began, ended, handled }) => ({
    ...(began !== undefined && { began }),
    ...(ended !== undefined && { ended }),
    ...(handled !== undefined && { handled }),
  }));

const UnfinishedTurnRows = z.array(z.object({ session: z.string(), handled: TextOrNull }));

const RelayRows = z.array(
  z.object({ from: z.string(), thread: z.string(), run: z.string(), at: z.string() }),
);

const ProfileRows = z.array(z.object({ at: z.string(), body: z.string() }));

const BodyRow = z.object({ body: z.string() }).nullable();
const RecordRow = z.object({ record: z.string() }).nullable();
const HolderRow = z.object({ holder: z.string() });
const CheckedRow = z.object({ checked: z.number() }).nullable();
const OperationRow = z.object({ input: z.string(), result: TextOrNull });
const PassRow = z.object({ n: z.number(), pass: z.string() }).nullable();
const PassJson = z.record(z.string(), z.string());
const TakenAtRow = z.object({ at: TextOrNull });
const TakerRow = z.object({ taken_by: z.string(), taken_at: z.string() }).nullable();
const LastRow = z.object({ last: z.number().nullable() });
const UntakenRow = z.object({ untaken: z.number() });
const WakingRow = z.object({ count: z.number(), oldest: TextOrAbsent });
const TaskNumberRow = z.object({ n: z.number() }).nullable();
const DoneInRows = z.array(z.object({ done_in: z.string() }));
const ThreadColumnRows = z.array(z.object({ thread: z.string() }));
const WordRows = z.array(z.object({ rowid: z.number(), text: z.string() }));

const AgentTaskRows = z.array(
  z.object({ agent: z.string(), n: z.number(), owner: z.string(), project: TextOrAbsent }),
);

const UnnotedPinRows = z.array(
  z.object({ app: z.string(), thread: z.string(), message: MessageIdColumn, text: z.string() }),
);

const KeyValues = z.array(z.tuple([z.string()]));
const NumberValues = z.array(z.tuple([z.number()]));
const UserVersionRow = z.object({ user_version: z.number() });
const DataVersionRow = z.object({ data_version: z.number() });
const ChangesRow = z.object({ n: z.number() });
const LedgerBodyRow = z.object({ body: z.string() }).nullable();

const SORTABLE_UTC = "glob '????-??-??T??:??:??.???Z'";

const AUTHOR_BEFORE_HEX_KEPT_AUTHORS = `case
    when "from" = 'buzz' and json_extract(meta, '$.user_id') is not null then 'buzz:' || json_extract(meta, '$.user_id')
    when json_extract(meta, '$.user_id') is not null then 'owner'
    when json_extract(meta, '$.user') in ('hex app', 'hex call') then 'owner'
    when json_extract(meta, '$.user') = 'hex' then 'prompt'
    when "from" = 'voice' and json_extract(meta, '$.callee') is null and (json_extract(meta, '$.delegation_id') is not null or json_extract(meta, '$.ended') is not null) then 'call'
    when "from" = 't3' and json_extract(meta, '$.user') is null then 'owner'
    else coalesce(json_extract(meta, '$.user'), "from") end`;

const AUTHORS = `(${AuthorColumn.options.map((author) => `'${author}'`).join(", ")})`;

function sql(text: string) {
  return ({ db }: Store) => {
    db.run(text);
  };
}

const appendOnlyMigrations: ((store: Store) => void)[] = [
  sql(`create table messages (
    n integer primary key,
    key text not null unique check (substr(key, 1, length("from") + 1) = "from" || ':'),
    "to" text not null,
    "from" text not null,
    body text not null,
    meta text check (json_valid(meta)),
    at text not null check (at ${SORTABLE_UTC}),
    taken_by text,
    taken_at text check (taken_at ${SORTABLE_UTC}),
    check ((taken_by is null) = (taken_at is null))
  );
  create index untaken on messages ("to") where taken_at is null;
  create table scheduler (one integer primary key check (one = 1), checked integer not null);`),
  sql(`create trigger kept_body before update of body on messages begin select raise(abort, 'a message keeps its words'); end;
  create table tasks (
    n integer primary key autoincrement,
    owner text not null,
    status text not null check (status in ('idea', 'open', 'done', 'dropped')),
    project text,
    done_when text,
    proof text,
    merged_into integer references tasks (n),
    at text not null check (at ${SORTABLE_UTC}),
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
  create table shown (session text primary key, digest text not null);`),
  sql(`create table questions (
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
    at text not null check (at ${SORTABLE_UTC}),
    unique (app, thread, message)
  );
  create trigger labels before insert on questions when exists (select 1 from json_each(new.options) where type <> 'text')
    begin select raise(abort, 'each option is a label'); end;
  create trigger kept_labels before update of options on questions when exists (select 1 from json_each(new.options) where type <> 'text')
    begin select raise(abort, 'each option is a label'); end;
  create index waiting on questions (thread) where answer is null and settled is null;
  create index polls on questions (app, poll) where poll is not null;`),
  sql(`alter table tasks add column closed text check (closed ${SORTABLE_UTC});
  update tasks set closed = at where status in ('done', 'dropped');`),
  sql(
    `create table threads (app text not null, thread text not null, name text not null, primary key (app, thread));`,
  ),
  sql(`alter table messages add column observing_at text check (observing_at ${SORTABLE_UTC});
  alter table messages add column observed_at text check (observed_at ${SORTABLE_UTC});
  update messages set observed_at = coalesce(taken_at, at);`),
  sql(`create index taken on messages (taken_by, taken_at) where taken_by is not null;
  create index sessions on messages ("to", taken_by) where taken_by is not null;`),
  sql(`drop trigger kept_words;
  create trigger kept_words before update on words when new.rowid <> old.rowid or new.task <> old.task or new.message <> old.message or instr(old.text, new.text) = 0 or length(new.text) = 0
    begin select raise(abort, 'words are only ever cut down to the part that asks'); end;
  drop trigger kept_words_delete;
  create trigger kept_words_delete before delete on words when not exists (select 1 from words w join messages m on m.key = w.message where w.task = old.task and w.message = old.message and w.rowid <> old.rowid and w.text = m.body and instr(w.text, old.text) > 0)
    begin select raise(abort, 'words are added, never taken away'); end;`),
  sql(`create table leases (name text primary key, holder text not null, until text not null check (until ${SORTABLE_UTC}));
  create table passes (n integer primary key autoincrement, pass text not null check (json_valid(pass)));`),
  sql(`alter table tasks add column title text;`),
  sql(
    `update tasks set title = coalesce(nullif(trim(substr(replace((select text from words where task = tasks.n order by rowid limit 1), char(10), ' '), 1, 80)), ''), 'Task ' || n) where title is null;`,
  ),
  sql(`alter table messages add column author text not null default '';
  update messages set author = ${AUTHOR_BEFORE_HEX_KEPT_AUTHORS};
  create index said on messages ("to", at);
  create index unauthored on messages (n) where author = '';`),
  sql(`create table seen (session text not null, kind text not null, record text not null, primary key (session, kind));
  insert into seen (session, kind, record) select session, 'tasks', digest from shown;`),
  sql(`create table profiles (n integer primary key, at text not null check (at ${SORTABLE_UTC}), body text not null check (length(trim(body)) > 0));
  create trigger kept_profile before update on profiles begin select raise(abort, 'a profile is added, never rewritten'); end;
  create trigger kept_profiles before delete on profiles begin select raise(abort, 'a profile is added, never taken away'); end;`),
  carryProfile,
  sql(`update messages set author = ${AUTHOR_BEFORE_HEX_KEPT_AUTHORS} where author = '';
  update messages set meta = json_set(coalesce(meta, '{}'), '$.user', author) where author not in ${AUTHORS} and json_extract(meta, '$.user') is null;
  update messages set author = case when author like 'buzz:%' or author in ('t3', 'discord') or ("from" = 'voice' and json_extract(meta, '$.callee') is not null) then 'other' else 'prompt' end where author not in ${AUTHORS};
  drop index unauthored;`),
  sql(`alter table threads add column open integer not null default 0 check (open in (0, 1));
  alter table threads add column session text;
  alter table threads add column cwd text;
  alter table threads add column model text;
  alter table threads add column effort text;
  alter table threads add column launched text;
  alter table threads add column fork text;
  alter table threads add column link text;`),
  carryThreadsJson,
  sql(`create table pins (
    app text not null,
    thread text not null,
    message not null,
    text text not null,
    note text,
    at text not null check (at ${SORTABLE_UTC}),
    primary key (app, thread)
  );
  create table files (name text primary key, body text not null);`),
  carryLedgers,
  sql(`drop table files;
  drop table shown;
  delete from seen where session not in (select session from seen where kind = 'rules');
  alter table seen add column at text not null default '1970-01-01T00:00:00.000Z' check (at ${SORTABLE_UTC});
  update seen set at = strftime('%Y-%m-%dT%H:%M:%fZ');
  update messages set "from" = 't3', key = 't3' || substr(key, 2) where "from" = 't' and key not in (select message from words) and 't3' || substr(key, 2) not in (select key from messages);`),
  sql(`create table turns (session text primary key, began text check (began ${SORTABLE_UTC}), ended text check (ended ${SORTABLE_UTC}));
  create table relays ("from" text not null, thread text not null, run text not null, at text not null check (at ${SORTABLE_UTC}), primary key ("from", thread));`),
  carryRelays,
  sql(`delete from threads where exists (select 1 from threads other where other.thread = threads.thread and (other.open, other.rowid) > (threads.open, threads.rowid));
  create unique index if not exists threads_key on threads (thread);`),
  ({ dir }: Store) => {
    for (const [app, folder] of apps(dir)) {
      if (app === "telegram") {
        rename(join(folder, "bot.json"));
      }
    }
  },
  everyPinIsAStatusPost,
  sql(`create table if not exists beats (session text not null, began text not null check (began ${SORTABLE_UTC}), until text check (until ${SORTABLE_UTC}), after text check (after ${SORTABLE_UTC}));
  create index if not exists beats_session on beats (session, began);`),
  sql("create index if not exists owned on tasks (owner, status, closed);"),
  sql('create index if not exists thread on messages ("to", n);'),
  sql(
    `create table if not exists operations (scope text not null, id text not null, input text not null, result text, primary key (scope, id));`,
  ),
  sql(
    `create table if not exists task_agents (agent text primary key, task integer not null references tasks (n), at text not null check (at ${SORTABLE_UTC}));`,
  ),
  ({ db }: Store) => {
    if (
      db.query("select 1 from pragma_table_info('turns') where name = 'handled'").get() !== null
    ) {
      return;
    }

    db.run(`alter table turns add column handled text check (handled ${SORTABLE_UTC})`);
    db.run("update turns set handled = strftime('%Y-%m-%dT%H:%M:%fZ')");
  },
  ({ db }: Store) => {
    if (
      db.query("select 1 from pragma_table_info('questions') where name = 'asker'").get() === null
    ) {
      db.run(
        `alter table questions add column asker text not null default 'hex' check (asker in ('hex', 'owner'))`,
      );
    }
  },
  ({ db }: Store) => {
    if (
      db.query("select 1 from pragma_table_info('turns') where name = 'waiting'").get() === null
    ) {
      db.run(`alter table turns add column waiting text check (waiting ${SORTABLE_UTC})`);
    }
  },
  ({ db }: Store) => {
    if (
      db.query("select 1 from pragma_table_info('tasks') where name = 'done_in'").get() === null
    ) {
      db.run("alter table tasks add column done_in text");
    }

    if (
      db.query("select 1 from pragma_table_info('task_agents') where name = 'thread'").get() ===
      null
    ) {
      db.run("alter table task_agents add column thread text");
    }
  },
  sql(`create table if not exists holds (n integer primary key, by text not null, why text not null, message text, until text check (until ${SORTABLE_UTC}), at text not null check (at ${SORTABLE_UTC}));
  create table if not exists held (hold integer not null references holds (n), thread text not null, ended text check (ended ${SORTABLE_UTC}), ending text, woke text, settled text check (settled ${SORTABLE_UTC}), primary key (hold, thread));`),
  ({ db }: Store) => {
    if (
      db.query("select 1 from pragma_table_info('questions') where name = 'shots'").get() === null
    ) {
      db.run(
        "alter table questions add column shots text check (json_valid(shots) and json_type(shots) = 'array')",
      );
    }
  },
];

function apps(dir: string): [string, string][] {
  const ownFolderOutsideAHex: [string, string] = [basename(dir), dir];

  return [
    ownFolderOutsideAHex,
    ...readdirSync(dir).flatMap((app): [string, string][] =>
      statSync(join(dir, app), { throwIfNoEntry: false })?.isDirectory() === true
        ? [[app, join(dir, app)]]
        : [],
    ),
  ];
}

const movedPath = (path: string) => `${path}.moved-to-hex.db`;
const stillOrMoved = (path: string) => [path, movedPath(path)].find((each) => existsSync(each));

function rename(path: string) {
  if (existsSync(path)) {
    renameSync(path, movedPath(path));
  }
}

const StringOrNull = z.string().nullable().catch(null);

const SavedThread = z.object({
  name: z.string(),
  session: StringOrNull,
  cwd: StringOrNull,
  model: StringOrNull,
  effort: StringOrNull,
  launched: StringOrNull,
  from: StringOrNull,
});

const SavedThreads = z.record(z.string(), SavedThread.nullable().catch(null)).catch({});

function carryThreadsJson({ db, dir }: Store) {
  const keep = db.query(
    `insert into threads (app, thread, name, open, session, cwd, model, effort, launched, fork) values (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
    on conflict (app, thread) do update set name = excluded.name, open = 1, session = excluded.session, cwd = excluded.cwd, model = excluded.model, effort = excluded.effort, launched = excluded.launched, fork = excluded.fork`,
  );

  for (const [app, folder] of apps(dir)) {
    const file = join(folder, "threads.json");

    if (!existsSync(file)) {
      continue;
    }

    let saved: z.infer<typeof SavedThreads>;

    try {
      saved = fromJson(SavedThreads, readFileSync(file, "utf-8"));
    } catch (error) {
      process.stderr.write(`hex.db left out ${file}, which is unreadable: ${String(error)}\n`);
      continue;
    }

    for (const [thread, known] of Object.entries(saved)) {
      if (known !== null) {
        const { name, session, cwd, model, effort, launched, from } = known;
        keep.run(app, thread, name, session, cwd, model, effort, launched, from);
      }
    }
  }
}

const LedgerPin = z.object({
  message: MessageIdColumn,
  text: z.string(),
  at: z.string().exactOptional(),
  note: z.string().exactOptional(),
});

const LedgerQuestion = z.object({
  asker: z.literal("owner").exactOptional(),
  thread: z.string(),
  message: MessageIdColumn,
  text: z.string(),
  options: z.array(z.string()),
  at: z.string().exactOptional(),
  poll: z.string().exactOptional(),
  multiple: z.boolean().exactOptional(),
  answer: AnswerJson.exactOptional(),
  settled: SettledJson.exactOptional(),
});

type CarriedPin = z.infer<typeof LedgerPin>;

type CarriedQuestion = z.infer<typeof LedgerQuestion>;

type Ledger = { pins: Map<string, CarriedPin>; asks: CarriedQuestion[] };

const LedgerJson = z
  .object({
    pins: z.record(z.string(), z.unknown()).catch({}),
    asks: z.array(z.unknown()).catch([]),
  })
  .catch({ pins: {}, asks: [] });

function carryLedgers(store: Store) {
  for (const [app, folder] of apps(store.dir)) {
    rename(join(folder, "threads.json"));
    const file = stillOrMoved(join(folder, "ledger.json"));

    if (file === undefined) {
      continue;
    }

    const before =
      LedgerBodyRow.parse(
        store.db.query("select body from files where name = ?").get(`${app}/ledger.json`),
      )?.body ?? "{}";

    const [book, was] = [() => readFileSync(file, "utf-8"), () => before].map((text) =>
      ledgerOf(text, file),
    );

    if (book === undefined) {
      continue;
    }

    const keep = (take: () => void, kept: CarriedPin | CarriedQuestion | undefined) => {
      try {
        take();
      } catch (error) {
        process.stderr.write(
          `hex.db left out ${JSON.stringify(kept)} from ${file}, which it refuses: ${String(error)}\n`,
        );
      }
    };

    for (const thread of new Set([...book.pins.keys(), ...(was?.pins.keys() ?? [])])) {
      const [pin, old] = [book.pins.get(thread), was?.pins.get(thread)];

      if (JSON.stringify(pin) === JSON.stringify(old)) {
        continue;
      }

      if (pin === undefined) {
        keep(() => {
          store.unpinned(app, thread, old?.message);
        }, old);
      } else if (pin.message !== old?.message || store.pin(app, thread)?.message === old.message) {
        keep(() => {
          store.pinned({ ...pin, note: pin.note, app, thread });
        }, pin);
      }
    }

    const carried = new Set((was?.asks ?? []).map((question) => JSON.stringify(question)));

    for (const question of book.asks) {
      if (!carried.has(JSON.stringify(question))) {
        keep(() => {
          store.ask({ app, ...question });
        }, question);
      }
    }

    rename(join(folder, "ledger.json"));
  }
}

const RelayLine = z.object({
  at: z.string().min(1),
  from: z.string().min(1),
  thread: z.string().min(1),
  run: z.string().min(1),
});

function carryRelays(store: Store) {
  for (const [app, folder] of apps(store.dir)) {
    const file = stillOrMoved(join(folder, "relays.jsonl"));

    if (file === undefined) {
      continue;
    }

    for (const line of readFileSync(file, "utf-8").split("\n")) {
      try {
        const { at, from, thread, run } = fromJson(RelayLine, line);
        store.relayed(`${app}:${from}`, thread, run, at);
      } catch {
        continue;
      }
    }

    rename(join(folder, "relays.jsonl"));
  }
}

function ledgerOf(text: () => string, file: string): Ledger | undefined {
  try {
    const ledger = fromJson(LedgerJson, text());

    return {
      pins: new Map(
        Object.entries(ledger.pins).flatMap(([thread, value]): [string, CarriedPin][] => {
          const pin = LedgerPin.safeParse(value);

          return pin.success ? [[thread, pin.data]] : [];
        }),
      ),
      asks: ledger.asks.flatMap((value) => {
        const question = LedgerQuestion.safeParse(value);

        return question.success ? [question.data] : [];
      }),
    };
  } catch (error) {
    process.stderr.write(`hex.db left out ${file}, which is unreadable: ${String(error)}\n`);
  }
}

function everyPinIsAStatusPost(store: Store) {
  const pins = UnnotedPinRows.parse(
    store.db.query("select app, thread, message, text from pins where note is null").all(),
  );

  for (const { app, thread, message, text } of pins) {
    const telegramChat = app === "telegram" ? `${thread.split(":")[0] ?? ""}:` : "";
    const author = store.message(`${app}:${telegramChat}${message}`)?.author;

    const hexCanRewriteIt =
      text !== "" &&
      store.question(app, thread, message) === null &&
      (author === undefined || author === "hex");

    if (hexCanRewriteIt) {
      store.db
        .query("update pins set note = ? where app = ? and thread = ?")
        .run(above(text), app, thread);
    } else {
      store.db.query("delete from pins where app = ? and thread = ?").run(app, thread);
    }
  }
}

const now = () => new Date().toISOString();

function holdNumber(id: string) {
  const n = /^h-(\d+)$/u.exec(id)?.[1];

  if (n === undefined) {
    throw new Error(`${id} isn't a hold's id, like h-3`);
  }

  return Number(n);
}

const TASKS_RECORD_KEPT_UNCHANGED = 2 * 24 * 60 * 60 * 1000;
const TURNS = 30 * 24 * 60 * 60 * 1000;
const BEATS = 7 * 24 * 60 * 60 * 1000;

const ReplacedProfile = z
  .object({
    at: z
      .string()
      .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u)
      .optional()
      .catch(undefined),
    profile: z.string().catch(""),
  })
  .catch({ profile: "" });

const modified = (path: string) => statSync(path).mtime.toISOString();

function carryProfile(store: Store) {
  const file = join(store.dir, "profile.md");
  const history = join(store.dir, "profile.md.history");
  const current = stillOrMoved(file);

  if (current === undefined || readFileSync(current, "utf-8").trim() === "") {
    return;
  }

  const before = stillOrMoved(history);

  const replaced =
    before === undefined
      ? []
      : readFileSync(before, "utf-8")
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            try {
              const { at, profile } = fromJson(ReplacedProfile, line);

              return { replacedAt: at ?? modified(before), body: profile.trim() };
            } catch {
              return { replacedAt: modified(before), body: "" };
            }
          });

  const lastReplaced = replaced.at(-1)?.replacedAt ?? "";
  const currentSince = modified(current);

  const versions = [
    ...replaced.map(({ replacedAt, body }, n, all) => ({
      putInPlace: all[n - 1]?.replacedAt ?? replacedAt,
      body,
    })),
    {
      putInPlace: lastReplaced > currentSince ? lastReplaced : currentSince,
      body: readFileSync(current, "utf-8").trim(),
    },
  ];

  const keep = store.db.query("insert into profiles (at, body) values (?, ?)");
  let last = "";

  for (const { putInPlace, body } of versions) {
    if (body !== "" && body !== last) {
      last = body;
      keep.run(putInPlace, body);
    }
  }

  rename(file);
  rename(history);
}

export class Store {
  readonly dir: string;
  readonly db: Database;
  private readonly bell: string;
  private writing = false;
  private readonly listeners = new Set<() => void>();
  private watcher: FSWatcher | undefined;
  private heard = "";

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.bell = join(dir, "hex.bell");
    appendFileSync(this.bell, "");
    this.db = new Database(join(dir, "hex.db"), { create: true, strict: true });
    this.db.run("pragma busy_timeout = 30000");
    retryWhileBusy(() => this.db.run("pragma journal_mode = wal"));
    this.db.run("pragma synchronous = full");
    this.db.run("pragma foreign_keys = on");

    while (this.version() < appendOnlyMigrations.length) {
      this.write(() => {
        const version = this.version();
        const step = appendOnlyMigrations[version];

        if (step === undefined) {
          return;
        }

        step(this);
        this.db.run(`pragma user_version = ${version + 1}`);
      });
    }
  }

  write<T>(fn: () => T): T {
    if (this.writing) {
      return fn();
    }

    const before = this.changes();

    const result = retryWhileBusy(() => {
      this.writing = true;

      try {
        return this.db.transaction(fn).immediate();
      } finally {
        this.writing = false;
      }
    });

    if (this.changes() !== before) {
      appendFileSync(this.bell, ".");
    }

    return result;
  }

  watch(listener: () => void): () => void {
    this.listeners.add(listener);
    this.watcher ??= watch(this.bell, () => {
      this.rang();
    });

    return () => {
      this.listeners.delete(listener);

      if (this.listeners.size > 0) {
        return;
      }

      this.watcher?.close();
      this.watcher = undefined;
    };
  }

  // Bun's fs.watch on Linux drops a change within about a millisecond of the last: https://github.com/oven-sh/bun/issues/45954
  private rang(again = false) {
    const moved = this.moved();

    if (moved !== this.heard) {
      this.heard = moved;

      for (const each of this.listeners) {
        try {
          each();
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
      }
    } else if (again) {
      return;
    }

    setTimeout(() => {
      if (this.watcher !== undefined) {
        this.rang(true);
      }
    }, 5);
  }

  deliver({ key, to, from, author, body, meta }: NewRow, by?: string): boolean {
    if (!isAuthor(author)) {
      throw new Error(
        `${key}'s author is ${JSON.stringify(author) ?? "missing"}: a message's author is owner, hex, prompt, call or other`,
      );
    }

    const at = now();
    const takenBy = by !== undefined && by !== "" ? by : undefined;

    return this.write(
      () =>
        this.db
          .query(
            'insert into messages (key, "to", "from", author, body, meta, at, taken_by, taken_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (key) do nothing',
          )
          .run(
            key,
            to,
            from,
            author,
            body,
            meta === undefined ? null : JSON.stringify(meta),
            at,
            by ?? null,
            takenBy === undefined ? null : at,
          ).changes > 0,
    );
  }

  operation(
    scope: string,
    id: string,
    input: string,
  ): { fresh: boolean; input: string; result: string | null } {
    return this.write(() => {
      const fresh =
        this.db
          .query(
            "insert into operations (scope, id, input) values (?, ?, ?) on conflict do nothing",
          )
          .run(scope, id, input).changes > 0;

      const kept = OperationRow.parse(
        this.db
          .query("select input, result from operations where scope = ? and id = ?")
          .get(scope, id),
      );

      return { fresh, ...kept };
    });
  }

  finishOperation(scope: string, id: string, result: string) {
    this.write(() =>
      this.db
        .query("update operations set result = ? where scope = ? and id = ?")
        .run(result, scope, id),
    );
  }

  past(rows: [NewRow, string][], by: string): string[] {
    return this.write(() => {
      const at = this.db.query(
        "update messages set at = ?2, taken_at = ?2, observed_at = ?2 where key = ?1",
      );

      return rows.flatMap(([row, when]) => {
        if (!this.deliver(row, by)) {
          return [];
        }

        at.run(row.key, when);

        return [row.key];
      });
    });
  }

  take(key: string, by: string): boolean {
    return this.write(
      () =>
        this.db
          .query(
            "update messages set taken_by = ?, taken_at = ? where key = ? and taken_at is null",
          )
          .run(by, now(), key).changes === 1,
    );
  }

  message(key: string): Row | null {
    return MessageRow.nullable().parse(
      this.db.query("select * from messages where key = ?").get(key),
    );
  }

  since(after = ""): Row[] {
    return MessageRows.parse(
      this.db.query("select * from messages where at > ? order by at, n").all(after),
    );
  }

  latest(key: string): Row | null {
    const app = key.slice(0, key.indexOf(":"));
    const named = this.message(key);
    const editOf = named?.meta?.edited === "true" ? named.meta.message_id : undefined;
    const isEdit = editOf !== undefined && editOf !== "";
    const id = editOf ?? key.slice(key.lastIndexOf(":") + 1);
    const prefix = key.slice(app.length + 1, Math.max(app.length + 1, key.lastIndexOf(":")));

    const chat =
      prefix === "" && isEdit && named !== null ? (named.to.split(":")[0] ?? "") : prefix;

    const original = isEdit
      ? this.message(`${app}:${prefix === "" ? "" : `${prefix}:`}${id}`)
      : named;

    const edit = MessageRow.nullable().parse(
      this.db
        .query(
          `select * from messages where "from" = ?1 and json_extract(meta, '$.edited') = 'true' and json_extract(meta, '$.message_id') = ?2
           and (?3 = '' or "to" = ?3 or "to" like ?3 || ':%') order by at desc, n desc limit 1`,
        )
        .get(app, id, chat),
    );

    if (edit === null) {
      return original ?? named;
    }

    return original === null
      ? edit
      : { ...original, body: edit.body, meta: { ...original.meta, edit: edit.key } };
  }

  said(thread: string, last = -1, before = "9", after = ""): Row[] {
    return MessageRows.parse(
      this.db
        .query(
          'select * from (select * from messages where "to" = ? and at < ? and at > ? order by at desc, n desc limit ?) order by at, n',
        )
        .all(thread, before, after, last),
    );
  }

  find(thread: string, message: MessageId): Row | null {
    return MessageRow.nullable().parse(
      this.db
        .query(
          `select * from messages where "to" = ?1 and substr(key, -length(?2) - 1) = ':' || ?2 order by at desc, n desc limit 1`,
        )
        .get(thread, String(message)),
    );
  }

  lastTaken(session: string): string | undefined {
    return (
      TakenAtRow.parse(
        this.db
          .query(`select max(taken_at) as at from messages where taken_by = ? and author <> 'hex'`)
          .get(session),
      ).at ?? undefined
    );
  }

  taker(thread: string, key: string, value: string): { by: string; at: string } | undefined {
    const row = TakerRow.parse(
      this.db
        .query(
          `select taken_by, taken_at from messages where "to" = ? and json_extract(meta, '$.' || ?) = ? and taken_by is not null order by n desc limit 1`,
        )
        .get(thread, key, value),
    );

    return row === null ? undefined : { by: row.taken_by, at: row.taken_at };
  }

  observe(session: string, by: string, thread?: string, lease = 10 * 60_000): Row[] {
    return this.write(() => {
      const rows = MessageRows.parse(
        this.db
          .query(
            'select * from messages where (taken_by = ? or "to" = ?) and taken_at <= ? and observed_at is null and (observing_at is null or observing_at < ?) order by taken_at',
          )
          .all(session, thread ?? null, by, new Date(Date.now() - lease).toISOString()),
      );

      this.db
        .query("update messages set observing_at = ? where key in (select value from json_each(?))")
        .run(now(), JSON.stringify(rows.map((row) => row.key)));

      return rows;
    });
  }

  observed(keys: string[], done = true) {
    const set = done ? `observed_at = '${now()}'` : "observing_at = null";
    this.write(() =>
      this.db
        .query(`update messages set ${set} where key in (select value from json_each(?))`)
        .run(JSON.stringify(keys)),
    );
  }

  took(session: string): boolean {
    return this.db.query("select 1 from messages where taken_by = ? limit 1").get(session) !== null;
  }

  untaken(thread?: string | string[]): Row[] {
    const rows =
      thread === undefined
        ? this.db.query("select * from messages where taken_at is null order by n").all()
        : this.db
            .query(
              'select * from messages where taken_at is null and "to" in (select value from json_each(?)) order by n',
            )
            .all(JSON.stringify([thread].flat()));

    return MessageRows.parse(rows);
  }

  mark(thread: string): string {
    const { last } = LastRow.parse(
      this.db.query('select max(n) as last from messages where "to" = ?').get(thread),
    );

    const { untaken } = UntakenRow.parse(
      this.db
        .query(
          'select count(*) as untaken from messages indexed by untaken where taken_at is null and "to" = ?',
        )
        .get(thread),
    );

    return `${String(last)}:${untaken}`;
  }

  lease(name: string, holder: string, ms: number): boolean {
    return this.write(() => {
      this.db.query("delete from leases where name = ? and until < ?").run(name, now());
      const until = new Date(Date.now() + ms).toISOString();
      this.db
        .query(
          "insert into leases (name, holder, until) values (?, ?, ?) on conflict (name) do update set until = excluded.until where holder = excluded.holder",
        )
        .run(name, holder, until);

      return (
        HolderRow.parse(this.db.query("select holder from leases where name = ?").get(name))
          .holder === holder
      );
    });
  }

  release(name: string, holder: string) {
    this.write(() =>
      this.db.query("delete from leases where name = ? and holder = ?").run(name, holder),
    );
  }

  wait(pass: Record<string, string | undefined>) {
    this.write(() =>
      this.db.query("insert into passes (pass) values (?)").run(JSON.stringify(pass)),
    );
  }

  waiting(): { n: number; pass: Record<string, string> } | undefined {
    const row = PassRow.parse(this.db.query("select n, pass from passes order by n limit 1").get());

    return row === null ? undefined : { n: row.n, pass: fromJson(PassJson, row.pass) };
  }

  passed(n: number) {
    this.write(() => this.db.query("delete from passes where n = ?").run(n));
  }

  checked(): number | undefined {
    return CheckedRow.parse(this.db.query("select checked from scheduler").get())?.checked;
  }

  check(minute: number) {
    this.write(() =>
      this.db
        .query(
          "insert into scheduler (one, checked) values (1, ?) on conflict (one) do update set checked = excluded.checked",
        )
        .run(minute),
    );
  }

  fire(schedule: string, minute: number, to: string, body: string, late = false): boolean {
    const slot = new Date(minute * 60_000).toISOString().slice(0, 16);

    return this.deliver({
      key: `schedule:${schedule}@${slot}Z`,
      to,
      from: "schedule",
      author: "prompt",
      body,
      meta: { user: "schedule", schedule, ...(late && { late: "true" }) },
    });
  }

  hold({ threads, by, why, message, until }: NewHold): Hold {
    const reason = why.trim();
    const others = [...new Set(threads)].filter((thread) => thread !== by);

    if (others.length === 0) {
      throw new Error("a hold names the threads it holds, other than the one holding them");
    }

    if (reason === "") {
      throw new Error("a hold says why");
    }

    if (message !== undefined && message !== "" && this.message(message) === null) {
      throw new Error(`no message ${message}`);
    }

    if (until !== undefined && !(Date.parse(until) > Date.now())) {
      throw new Error(`${until} has passed, so that hold would end as it starts`);
    }

    return this.write(() => {
      const { lastInsertRowid } = this.db
        .query("insert into holds (by, why, message, until, at) values (?, ?, ?, ?, ?)")
        .run(by, reason, message ?? null, until ?? null, now());

      for (const thread of others) {
        this.db.query("insert into held (hold, thread) values (?, ?)").run(lastInsertRowid, thread);
      }

      const id = `h-${lastInsertRowid}`;

      return found(this.holdOf(id), id);
    });
  }

  holdOf(id: string): Hold | null {
    return this.holds({ id, all: true }).at(0) ?? null;
  }

  holds({ id, all = false }: { id?: string | undefined; all?: boolean | undefined } = {}): Hold[] {
    const rows = HoldRows.parse(
      this.db
        .query(
          "select * from holds where (?1 is null or n = ?1) and (?2 or exists (select 1 from held where hold = n and ended is null)) order by n desc",
        )
        .all(id === undefined ? null : holdNumber(id), all),
    );

    return rows.map(({ n, message, until, ...hold }) => ({
      id: `h-${n}`,
      ...hold,
      ...(message !== undefined && { message }),
      ...(until !== undefined && { until }),
      threads: HeldRows.parse(
        this.db
          .query("select thread, ended, ending, woke from held where hold = ? order by rowid")
          .all(n),
      ),
    }));
  }

  unhold(id: string, ending: string, threads?: string[], at = now()): string[] {
    const hold = this.holdOf(id);

    if (hold === null) {
      throw new Error(`no hold ${id}`);
    }

    if (ending.trim() === "") {
      throw new Error("say why the hold ends");
    }

    const stray = threads?.filter((thread) => !hold.threads.some((held) => held.thread === thread));

    if (stray !== undefined && stray.length > 0) {
      throw new Error(`${id} doesn't hold ${stray.join(", ")}`);
    }

    return this.write(() =>
      KeyValues.parse(
        this.db
          .query(
            "update held set ended = ?, ending = ? where hold = ? and ended is null and (?4 is null or thread in (select value from json_each(?4))) returning thread",
          )
          .values(
            at,
            ending.trim(),
            holdNumber(id),
            threads === undefined ? null : JSON.stringify(threads),
          ),
      ).map(([thread]) => thread),
    );
  }

  due(at = now()): string[] {
    return this.write(() =>
      NumberValues.parse(
        this.db
          .query(
            "select n from holds where until <= ? and exists (select 1 from held where hold = n and ended is null)",
          )
          .values(at),
      ).flatMap(([n]) => this.unhold(`h-${n}`, "its time came", undefined, at)),
    );
  }

  freed(): { id: string; thread: string; why: string; ending: string }[] {
    return FreedRows.parse(
      this.db
        .query(`select 'h-' || hold as id, thread, why, ending from held join holds on n = hold
        where ended is not null and woke is null and not exists (select 1 from held other where other.thread = held.thread and other.ended is null)
          and (exists (select 1 from messages where key = 'hold:h-' || hold || '@' || thread) or exists (select 1 from messages where "to" = held.thread and taken_at >= holds.at and taken_at <= held.ended))
        order by (select max(ended) from held other where other.thread = held.thread), (select min(rowid) from held other where other.thread = held.thread), ended desc`)
        .all(),
    );
  }

  woke(thread: string, key: string) {
    this.write(() =>
      this.db
        .query("update held set woke = ? where thread = ? and ended is not null and woke is null")
        .run(key, thread),
    );
  }

  waking(patience: number, at = now()): { count: number; until?: string } {
    return this.write(() => {
      this.db
        .query(`update held set settled = ?1 where woke is not null and settled is null and (
          not exists (select 1 from threads where thread = held.thread and open = 1)
          or exists (select 1 from messages m join turns t on t.session = m.taken_by where m.key = held.woke and t.ended >= m.taken_at)
          or exists (select 1 from messages m where m.key = held.woke and m.at < ?2))`)
        .run(at, new Date(Date.parse(at) - patience).toISOString());

      const { count, oldest } = WakingRow.parse(
        this.db
          .query(
            "select count(distinct thread) as count, min(m.at) as oldest from held join messages m on m.key = held.woke where settled is null",
          )
          .get(),
      );

      return {
        count,
        ...(oldest !== undefined && {
          until: new Date(Date.parse(oldest) + patience).toISOString(),
        }),
      };
    });
  }

  createTask({ title, message, quote, owner, status = "open", project, doneWhen }: NewTask): Task {
    const line = oneLine(title);

    if (line === "") {
      throw new Error("a task needs a title: what the owner wants done, in a few plain words");
    }

    return this.write(() => {
      const { lastInsertRowid } = this.db
        .query(
          "insert into tasks (title, owner, status, project, done_when, at) values (?, ?, ?, ?, ?, ?)",
        )
        .run(line, owner, status, project ?? null, doneWhen ?? null, now());

      const id = `t-${lastInsertRowid}`;
      this.quote(id, message, quote);

      return found(this.task(id), id);
    });
  }

  addWords(id: string, message: string, quote?: string): Task {
    return this.write(() => {
      const live = this.live(id);
      this.quote(live, message, quote);

      return found(this.task(live), live);
    });
  }

  requote(id: string, message: string, quote: string): Task {
    return this.write(() => {
      const live = this.live(id);
      const said = this.message(message);

      if (said === null) {
        throw new Error(`no message ${message}`);
      }

      const rows = WordRows.parse(
        this.db
          .query("select rowid, text from words where task = ? and message = ? order by rowid")
          .all(number(live), message),
      );

      const pieces = said.from === "t3" ? sent(said.body) : [];

      const whole =
        rows.find((row) => row.text === said.body) ??
        rows.find((row) => pieces.includes(row.text) && row.text.includes(quote));

      const held = rows.find((row) => row.text === quote);

      if (whole === undefined) {
        if (held !== undefined) {
          return found(this.task(live), live);
        }

        throw new Error(`${live} holds no whole message ${message} to cut "${quote}" from`);
      }

      if (whole === held) {
        return found(this.task(live), live);
      }

      if (
        !whole.text.includes(quote) ||
        (said.from === "t3" && !pieces.some((piece) => piece.includes(quote)))
      ) {
        throw new Error(`"${quote}" isn't in what ${live} holds from ${message}`);
      }

      if (held !== undefined && whole.text !== said.body) {
        return found(this.task(live), live);
      }

      const others =
        whole.text === said.body
          ? rows.filter(
              (row) => row === held || (pieces.includes(row.text) && row.text.includes(quote)),
            )
          : [];

      for (const extra of others.filter((row) => row !== whole)) {
        this.db.query("delete from words where rowid = ?").run(extra.rowid);
      }

      this.db.query("update words set text = ? where rowid = ?").run(quote, whole.rowid);

      return found(this.task(live), live);
    });
  }

  editTask(id: string, change: TaskChange): Task {
    const title = change.title === undefined ? undefined : oneLine(change.title);

    if (title === "") {
      throw new Error("a task's title can't be empty");
    }

    return this.write(() => {
      const task = this.task(id);

      if (task === null) {
        throw new Error(`no task ${id}`);
      }

      const status = change.status ?? task.status;
      const liveAgain = status === "open" || status === "idea";
      const proofItWasClosedWith = liveAgain ? undefined : task.proof;

      const closed =
        status === "done" || status === "dropped"
          ? status === task.status
            ? task.closed
            : now()
          : undefined;

      this.db
        .query(
          "update tasks set title = ?, owner = ?, status = ?, project = ?, done_when = ?, proof = ?, closed = ? where n = ?",
        )
        .run(
          title ?? task.title,
          change.owner ?? task.owner,
          status,
          change.project ?? task.project ?? null,
          change.doneWhen ?? task.doneWhen ?? null,
          change.proof ?? proofItWasClosedWith ?? null,
          closed ?? null,
          number(id),
        );

      if (change.doneIn !== undefined && change.doneIn !== "") {
        this.db.query("update tasks set done_in = ? where n = ?").run(change.doneIn, number(id));
      }

      return found(this.task(id), id);
    });
  }

  addAgents(id: string, agents: string[], thread?: string): Task {
    return this.write(() => {
      const short = agents.find((agent) => !/^[\w-]{8,}$/u.test(agent));

      if (short !== undefined && short !== "") {
        throw new Error(
          `"${short}" isn't an agent or session id: use the id it was started with, 8 characters or more`,
        );
      }

      const live = this.live(id);

      const add = this.db.query(
        "insert into task_agents (agent, task, at, thread) values (?, ?, ?, ?) on conflict (agent) do update set task = excluded.task, at = excluded.at, thread = excluded.thread",
      );

      for (const agent of agents) {
        add.run(agent, number(live), now(), thread ?? null);
      }

      return found(this.task(live), live);
    });
  }

  worked(id: string): string[] {
    const closed = DoneInRows.parse(
      this.db
        .query("select done_in from tasks where n = ? and done_in is not null")
        .all(number(id)),
    );

    const linked = ThreadColumnRows.parse(
      this.db
        .query(
          "select thread from task_agents where task = ? and thread is not null order by at desc",
        )
        .all(number(id)),
    );

    return [...closed.map((row) => row.done_in), ...linked.map((row) => row.thread)];
  }

  agentTasks(): Record<string, Pick<Task, "id" | "owner" | "project">> {
    const rows = AgentTaskRows.parse(
      this.db
        .query(
          "select a.agent, t.n, t.owner, t.project from task_agents a join tasks t on t.n = a.task",
        )
        .all(),
    );

    return Object.fromEntries(
      rows.map((row) => [
        row.agent,
        {
          id: `t-${row.n}`,
          owner: row.owner,
          ...(row.project !== undefined && { project: row.project }),
        },
      ]),
    );
  }

  mergeTasks(into: string, from: string): Task {
    return this.write(() => {
      if (number(into) === number(from)) {
        throw new Error(`${into} can't be merged into itself`);
      }

      for (const id of [into, from]) {
        const status = this.task(id)?.status;

        if (status === undefined) {
          throw new Error(`no task ${id}`);
        }

        if (status !== "idea" && status !== "open") {
          throw new Error(`${id} is ${status}; only idea and open tasks merge`);
        }
      }

      this.db
        .query(
          "insert or ignore into words (task, message, text) select ?, message, text from words where task = ? order by rowid",
        )
        .run(number(into), number(from));
      this.db
        .query("update tasks set status = 'dropped', merged_into = ?, closed = ? where n = ?")
        .run(number(into), now(), number(from));
      this.db
        .query("update task_agents set task = ? where task = ?")
        .run(number(into), number(from));

      return found(this.task(into), into);
    });
  }

  task(id: string): Task | null {
    const row = TaskRow.nullable().parse(
      this.db.query("select * from tasks where n = ?").get(number(id)),
    );

    return row === null ? null : this.toTask(row);
  }

  tasks(filter?: {
    owner?: string | undefined;
    status?: Status[] | undefined;
    words?: true;
  }): Task[];
  tasks(filter: {
    owner?: string | undefined;
    status?: Status[] | undefined;
    words: false;
  }): Omit<Task, "words">[];
  tasks({
    owner,
    status,
    words = true,
  }: {
    owner?: string | undefined;
    status?: Status[] | undefined;
    words?: boolean;
  } = {}): Omit<Task, "words">[] {
    const [where, params] = clause([
      owner !== undefined && ["owner = ?", owner],
      status !== undefined && [
        "status in (select value from json_each(?))",
        JSON.stringify(status),
      ],
    ]);

    const rows = TaskRows.parse(
      this.db.query(`select * from tasks ${where} order by at desc, n desc`).all(...params),
    );

    return rows.map((row) => (words ? this.toTask(row) : toLine(row)));
  }

  lastDone(owner: string, count: number): Omit<Task, "words">[] {
    return TaskRows.parse(
      this.db
        .query(
          "select * from tasks where owner = ? and status = 'done' order by closed desc, n desc limit ?",
        )
        .all(owner, count),
    ).map(toLine);
  }

  finished(since: string): Omit<Task, "words">[] {
    return TaskRows.parse(
      this.db
        .query(
          "select * from tasks where status = 'done' and closed >= ? order by closed desc, n desc",
        )
        .all(since),
    ).map(toLine);
  }

  keepThreads(app: string, openNow: Record<string, Kept>) {
    this.write(() => {
      this.db
        .query(
          "update threads set open = 0 where app = ? and open = 1 and thread not in (select value from json_each(?))",
        )
        .run(app, JSON.stringify(Object.keys(openNow)));

      const keep = this.db.query(
        `insert into threads (app, thread, name, open, session, cwd, model, effort, launched, fork, link) values (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
        on conflict (thread) do update set app = excluded.app, name = excluded.name, open = 1, session = excluded.session, cwd = excluded.cwd, model = excluded.model,
          effort = excluded.effort, launched = excluded.launched, fork = excluded.fork, link = coalesce(excluded.link, link)
        where (app, name, open, session, cwd, model, effort, launched, fork) is not (excluded.app, excluded.name, 1, excluded.session, excluded.cwd, excluded.model, excluded.effort, excluded.launched, excluded.fork)
          or coalesce(excluded.link, link) is not link`,
      );

      for (const [
        thread,
        { name, session, cwd, model, effort, launched, fork, link },
      ] of Object.entries(openNow)) {
        keep.run(
          app,
          thread,
          name,
          session ?? null,
          cwd ?? null,
          model ?? null,
          effort ?? null,
          launched ?? null,
          fork ?? null,
          link ?? null,
        );
      }
    });
  }

  threads({ app, open: isOpen }: { app?: string; open?: boolean } = {}): Thread[] {
    return ThreadRows.parse(
      this.db
        .query(
          "select * from threads where (?1 is null or app = ?1) and (?2 is null or open = ?2) order by app, thread",
        )
        .all(app ?? null, isOpen === undefined ? null : Number(isOpen)),
    );
  }

  names(): Record<string, string> {
    const names = Object.fromEntries(this.threads().map(({ thread, name }) => [thread, name]));
    Object.setPrototypeOf(names, null);

    return names;
  }

  ids(): Record<string, string> {
    const ids = Object.fromEntries(
      this.threads().map(({ app, thread }) => [thread, `${app}:${thread}`]),
    );

    Object.setPrototypeOf(ids, null);

    return ids;
  }

  key(id: string): string {
    const split = id.indexOf(":");

    return split > 0 &&
      this.db.query("select 1 from threads where app = ? limit 1").get(id.slice(0, split)) !== null
      ? id.slice(split + 1)
      : id;
  }

  ask({
    asker,
    app,
    thread,
    message,
    text,
    options,
    poll,
    multiple,
    shots,
    at = now(),
    answer,
    settled,
  }: NewQuestion) {
    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // An older hex's questions, brought in by steps before the asker and shots columns exist, are hex's and fill only the columns they had.
    const row = {
      ...(asker !== undefined && { asker }),
      app,
      thread,
      message,
      text,
      options: JSON.stringify(options),
      poll: poll ?? null,
      multiple: multiple === true ? 1 : 0,
      ...(shots !== undefined && shots.length > 0 && { shots: JSON.stringify(shots) }),
      answer: answer === undefined ? null : JSON.stringify(answer),
      settled: settled === undefined ? null : JSON.stringify(settled),
      at,
    } satisfies Record<string, SQLQueryBindings>;

    const columns = Object.keys(row);

    this.write(() =>
      this.db
        .query(
          `insert into questions (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")}) on conflict do nothing`,
        )
        .run(...Object.values(row)),
    );
  }

  question(app: string, thread: string, message: MessageId): Question | null {
    return QuestionRow.nullable().parse(
      this.db
        .query("select * from questions where app = ? and thread = ? and message = ?")
        .get(app, thread, message),
    );
  }

  poll(app: string, poll: string): Question | null {
    return QuestionRow.nullable().parse(
      this.db.query("select * from questions where app = ? and poll = ?").get(app, poll),
    );
  }

  questions({
    app,
    thread,
    asker,
    waiting,
  }: {
    app?: string | undefined;
    thread?: string | undefined;
    asker?: "hex" | "owner" | undefined;
    waiting?: boolean | undefined;
  } = {}): Question[] {
    const [where, params] = clause([
      app !== undefined && ["app = ?", app],
      thread !== undefined && ["thread = ?", thread],
      asker !== undefined && ["asker = ?", asker],
      waiting === true && [
        `settled is null and (asker = 'hex' and answer is null or asker = 'owner' and answer is not null)`,
      ],
    ]);

    return QuestionRows.parse(
      this.db.query(`select * from questions ${where} order by n`).all(...params),
    );
  }

  replied(app: string, thread: string, answer: Answer, to?: MessageId) {
    const which = to === undefined ? `json_extract(answer, '$.kept') is null` : "message = ?";
    this.write(() =>
      this.db
        .query(
          `update questions set answer = ? where asker = 'owner' and app = ? and thread = ? and settled is null and ${which}`,
        )
        .run(
          JSON.stringify(to === undefined ? answer : { ...answer, kept: true }),
          app,
          thread,
          ...(to === undefined ? [] : [to]),
        ),
    );
  }

  returned(app: string, thread: string) {
    this.write(() =>
      this.db
        .query(
          `update questions set answer = json_set(answer, '$.kept', json('true')) where asker = 'owner' and app = ? and thread = ? and answer is not null and settled is null`,
        )
        .run(app, thread),
    );
  }

  answered(
    app: string,
    thread: string,
    message: MessageId,
    label: string,
    via: string,
    again = false,
  ): boolean {
    return this.write(
      () =>
        this.db
          .query(
            "update questions set answer = ?, settled = null where app = ? and thread = ? and message = ? and (? or answer is null)",
          )
          .run(JSON.stringify({ label, at: now(), via }), app, thread, message, again).changes ===
        1,
    );
  }

  reworded(app: string, thread: string, message: MessageId, text: string) {
    this.write(() =>
      this.db
        .query("update questions set text = ? where app = ? and thread = ? and message = ?")
        .run(text, app, thread, message),
    );
  }

  settled(app: string, thread: string, message: MessageId, note: string) {
    this.write(() =>
      this.db
        .query("update questions set settled = ? where app = ? and thread = ? and message = ?")
        .run(JSON.stringify({ note, at: now() }), app, thread, message),
    );
  }

  reopened(app: string, thread: string, message: MessageId): boolean {
    return this.write(
      () =>
        this.db
          .query(
            "update questions set answer = null, settled = null where app = ? and thread = ? and message = ? and (answer is not null or settled is not null)",
          )
          .run(app, thread, message).changes === 1,
    );
  }

  unask(app: string, thread: string, message?: MessageId) {
    this.write(() =>
      this.db
        .query(
          "delete from questions where app = ? and thread = ? and (?3 is null or message = ?3)",
        )
        .run(app, thread, message ?? null),
    );
  }

  profile(): string {
    return (
      BodyRow.parse(this.db.query("select body from profiles order by n desc limit 1").get())
        ?.body ?? ""
    );
  }

  profiles(): { at: string; body: string }[] {
    return ProfileRows.parse(this.db.query("select at, body from profiles order by n desc").all());
  }

  profiled(before: string, body: string, at = now()): boolean {
    return this.write(() => {
      if (this.profile() !== before.trim()) {
        return false;
      }

      if (body.trim() === before.trim()) {
        return true;
      }

      this.db.query("insert into profiles (at, body) values (?, ?)").run(at, body.trim());

      return true;
    });
  }

  pin(app: string, thread: string): Pin | null {
    return PinRow.nullable().parse(
      this.db.query("select * from pins where app = ? and thread = ?").get(app, thread),
    );
  }

  pins({ app, thread }: { app?: string | undefined; thread?: string | undefined } = {}): Pin[] {
    return PinRows.parse(
      this.db
        .query(
          "select * from pins where (?1 is null or app = ?1) and (?2 is null or thread = ?2) order by app, thread",
        )
        .all(app ?? null, thread ?? null),
    );
  }

  pinned({
    app,
    thread,
    message,
    text,
    note,
    at = now(),
  }: Omit<Pin, "at" | "note"> & { note: string | undefined; at?: string | undefined }) {
    this.write(() =>
      this.db
        .query(
          "insert into pins (app, thread, message, text, note, at) values (?, ?, ?, ?, ?, ?) on conflict (app, thread) do update set message = excluded.message, text = excluded.text, note = excluded.note, at = excluded.at",
        )
        .run(app, thread, message, text, note ?? null, at),
    );
  }

  unpinned(app: string, thread?: string, message?: MessageId) {
    this.write(() =>
      this.db
        .query(
          "delete from pins where app = ?1 and (?2 is null or thread = ?2) and (?3 is null or message = ?3)",
        )
        .run(app, thread ?? null, message ?? null),
    );
  }

  seen(session: string, kind: string): string {
    return (
      RecordRow.parse(
        this.db.query("select record from seen where session = ? and kind = ?").get(session, kind),
      )?.record ?? ""
    );
  }

  show(session: string, kind: string, record: string, at = now()) {
    this.write(() => {
      this.db
        .query(
          "insert into seen (session, kind, record, at) values (?, ?, ?, ?) on conflict (session, kind) do update set record = excluded.record, at = excluded.at",
        )
        .run(session, kind, record, at);
      this.db
        .query("delete from seen where kind not in ('rules', 'hex') and at < ?")
        .run(new Date(Date.parse(at) - TASKS_RECORD_KEPT_UNCHANGED).toISOString());
    });
  }

  unshow(session: string, kind: string) {
    this.write(() =>
      this.db.query("delete from seen where session = ? and kind = ?").run(session, kind),
    );
  }

  turned(session: string, busy: boolean, at = now(), heartbeat = false, flipped?: number) {
    this.write(() => {
      const { began, ended } = this.turn(session);
      const heartbeatOpensATurn = heartbeat && (began === undefined || ended !== undefined);

      // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
      // Claude Code can record a turn before hex's hook runs, so the hook's own time can be late.
      const claudeCodeMarkedItBusyFirst =
        heartbeatOpensATurn &&
        flipped !== undefined &&
        flipped <= Date.parse(at) &&
        (ended === undefined || flipped > Date.parse(ended));

      const heartbeatBegan =
        claudeCodeMarkedItBusyFirst && flipped !== undefined ? new Date(flipped).toISOString() : at;

      if (busy && !heartbeat) {
        this.db.query("delete from beats where session = ? and began > ?").run(session, at);
      }

      if ((!heartbeat && (busy || began === undefined || at >= began)) || heartbeatOpensATurn) {
        this.db
          .query("update beats set until = ? where session = ? and until is null and began <= ?")
          .run(at, session, at);
      }

      if (busy && !heartbeat) {
        this.db
          .query("update beats set after = ? where session = ? and after is null")
          .run(at, session);
      }

      if (heartbeatOpensATurn) {
        this.db
          .query("insert into beats (session, began) values (?, ?)")
          .run(session, heartbeatBegan);
      }

      this.db
        .query(
          "delete from beats where coalesce(after, until, began) < ? and (after is not null or rowid > (select min(rowid) from beats run where run.session = beats.session and run.after is null))",
        )
        .run(new Date(Date.parse(at) - BEATS).toISOString());

      if (busy) {
        this.db
          .query(
            "insert into turns (session, began, handled) values (?1, ?2, ?2) on conflict (session) do update set began = excluded.began, ended = null, handled = coalesce(handled, excluded.began)",
          )
          .run(session, at);
      } else {
        this.db
          .query(
            "insert into turns (session, ended) values (?, ?) on conflict (session) do update set ended = iif(began is null or excluded.ended >= began, excluded.ended, ended)",
          )
          .run(session, at);
      }

      this.db
        .query("delete from turns where coalesce(ended, began) < ?")
        .run(new Date(Date.parse(at) - TURNS).toISOString());
    });
  }

  beats(session: string): Beat[] {
    return this.everyBeat().get(session) ?? [];
  }

  everyBeat(): Map<string, Beat[]> {
    const beats = new Map<string, Beat[]>();

    const rows = BeatRows.parse(
      this.db.query("select session, began, until, after from beats order by began").all(),
    );

    for (const { session, began, until, after } of rows) {
      const beat: Beat = {
        began,
        ...(until !== undefined && { until }),
        ...(after !== undefined && { after }),
      };

      beats.set(session, [...(beats.get(session) ?? []), beat]);
    }

    return beats;
  }

  beaten(): string {
    return JSON.stringify(
      this.db
        .query(
          "select max(rowid), count(*), count(until), count(after), (select max(coalesce(ended, began)) from turns where session in (select session from beats)) from beats",
        )
        .values(),
    );
  }

  handled(session: string, at = now()) {
    this.write(() => {
      const { began, ended } = this.turn(session);

      if (began !== undefined && ended === undefined) {
        this.turned(session, false, at);
      }

      this.db
        .query(
          "insert into turns (session, ended, handled) values (?1, ?2, ?2) on conflict (session) do update set handled = max(coalesce(handled, ?2), ?2), waiting = null",
        )
        .run(session, at);
    });
  }

  waitsOnAgents(session: string, at = now()) {
    this.db.query("update turns set waiting = ? where session = ?").run(at, session);
  }

  cut(thread: string, session?: string, at = now()): string[] {
    return this.write(() => {
      const diedMidTurn = UnfinishedTurnRows.parse(
        this.db
          .query(
            `select session, handled from turns where (began is not null and ended is null or waiting is not null) and (session = ?2 or session in (select distinct taken_by from messages indexed by sessions where "to" = ?1 and taken_by is not null))`,
          )
          .all(thread, session ?? null),
      );

      return diedMidTurn.flatMap(({ session: died, handled }) => {
        this.turned(died, false, at);
        this.db.query("update turns set waiting = null where session = ?").run(died);

        return KeyValues.parse(
          this.db
            .query(
              `update messages set taken_by = null, taken_at = null where taken_by = ? and author <> 'hex' and "from" <> 'terminal' and taken_at > ? returning key`,
            )
            .values(died, handled),
        ).map(([key]) => key);
      });
    });
  }

  midTurn(thread: string): boolean {
    return (
      this.db
        .query(
          `select 1 from turns where (began is not null and ended is null or waiting is not null) and session in (select distinct taken_by from messages indexed by sessions where "to" = ? and taken_by is not null) limit 1`,
        )
        .get(thread) !== null
    );
  }

  atWork(session: string): boolean {
    return (
      this.db
        .query(
          "select 1 from turns where session = ? and (began is not null and ended is null or waiting is not null)",
        )
        .get(session) !== null
    );
  }

  turn(session: string): { began?: string; ended?: string; handled?: string } {
    return (
      TurnRow.nullable().parse(
        this.db.query("select began, ended, handled from turns where session = ?").get(session),
      ) ?? {}
    );
  }

  relayed(from: string, thread: string, run: string, at = now()) {
    this.write(() =>
      this.db
        .query(
          'insert into relays ("from", thread, run, at) values (?, ?, ?, ?) on conflict ("from", thread) do update set run = excluded.run, at = excluded.at where excluded.at >= relays.at',
        )
        .run(from, thread, run, at),
    );
  }

  relays() {
    return RelayRows.parse(
      this.db.query('select "from", thread, run, at from relays order by at').all(),
    );
  }

  private quote(task: string, message: string, quote?: string) {
    const said = this.message(message);

    if (said === null) {
      throw new Error(`no message ${message}`);
    }

    const pieces = quote === undefined && said.from === "t3" ? sent(said.body) : [];

    if (
      quote === undefined &&
      this.db
        .query("select 1 from words where task = ? and message = ?")
        .get(number(task), message) !== null
    ) {
      return;
    }

    const texts =
      quote === undefined
        ? said.from === "t3"
          ? pieces
          : said.author === "call"
            ? spoken(said).split("\n")
            : [said.body]
        : [quote];

    if (texts.length === 0) {
      throw new Error(`${message} has no words to quote`);
    }

    if (spoken(said) === "") {
      throw new Error(
        `${message} is ${said.author}'s, not the owner's; a task holds the owner's words`,
      );
    }

    for (const text of texts) {
      if (text === "") {
        throw new Error(
          quote === undefined
            ? `${message} has no words to quote`
            : "a quote needs words from the message",
        );
      }

      if (!spoken(said).includes(text)) {
        const edited = this.latest(message);
        const editKey = edited?.meta?.edit;

        if (
          edited !== null &&
          editKey !== undefined &&
          editKey !== "" &&
          spoken(edited).includes(text)
        ) {
          throw new Error(
            `"${text}" is in ${editKey}, the owner's edit of ${message}: quote it under that key`,
          );
        }

        throw new Error(
          `"${text}" isn't in ${message} as written; quote it character for character, or leave the quote out for all it asks`,
        );
      }

      this.db
        .query(
          "insert into words (task, message, text) values (?, ?, ?) on conflict (task, message, text) do nothing",
        )
        .run(number(task), message, text);
    }
  }

  private live(id: string): string {
    const row = TaskNumberRow.parse(
      this.db
        .query(
          `with recursive chain (n, next) as (
           select n, merged_into from tasks where n = ?
           union select tasks.n, tasks.merged_into from tasks join chain on tasks.n = chain.next
         )
         select n from chain where next is null`,
        )
        .get(number(id)),
    );

    if (row === null) {
      throw new Error(`no task ${id}`);
    }

    return `t-${row.n}`;
  }

  private toTask(row: StoredTask): Task {
    const words = WordsRows.parse(
      this.db
        .query(
          `select words.message, words.text, messages.author as who, messages.at
         from words join messages on messages.key = words.message where words.task = ? order by words.rowid`,
        )
        .all(row.n),
    );

    return { ...toLine(row), words };
  }

  private version() {
    return UserVersionRow.parse(this.db.query("pragma user_version").get()).user_version;
  }

  private moved() {
    const { data_version: otherProcessesCommits } = DataVersionRow.parse(
      this.db.query("pragma data_version").get(),
    );

    return `${otherProcessesCommits}:${this.changes()}`;
  }

  private changes() {
    return ChangesRow.parse(this.db.query("select total_changes() as n").get()).n;
  }
}

const stores = new Map<string, Store>();

const nonEmptyEnv = (name: string) => {
  const value = process.env[name];

  return value === "" ? undefined : value;
};

export const hexDir = () => nonEmptyEnv("HEX_DIR") ?? join(import.meta.dir, "..", "..");

export function stateDir(appFolder?: string) {
  if (appFolder !== undefined && appFolder !== "") {
    const hex = nonEmptyEnv("HEX_DIR");

    return hex === undefined ? appFolder : join(hex, "state");
  }

  return nonEmptyEnv("HEX_STORE") ?? join(hexDir(), "state");
}

export function open(dir: string): Store {
  const kept = stores.get(dir);

  if (kept !== undefined) {
    return kept;
  }

  const store = new Store(dir);
  stores.set(dir, store);

  return store;
}

const oneLine = (text: string) => text.replaceAll(/\s+/gu, " ").trim();

function number(id: string): number {
  const n = Number(id.replace(/^t-/u, ""));

  if (Number.isInteger(n)) {
    return n;
  }

  throw new Error(`${id} isn't a task id, like t-12`);
}

function found<T>(value: T | null, id: string): T {
  if (value === null) {
    throw new Error(`no ${id}`);
  }

  return value;
}

function toLine(row: StoredTask): Omit<Task, "words"> {
  return {
    id: `t-${row.n}`,
    title: row.title,
    owner: row.owner,
    status: row.status,
    at: row.at,
    ...(row.project !== undefined && { project: row.project }),
    ...(row.done_when !== undefined && { doneWhen: row.done_when }),
    ...(row.proof !== undefined && { proof: row.proof }),
    ...(row.merged_into !== null && { mergedInto: `t-${row.merged_into}` }),
    ...(row.closed !== undefined && { closed: row.closed }),
  };
}

function clause(terms: (false | [string, ...string[]])[]): [string, string[]] {
  const kept = terms.filter((term) => term !== false);

  return [
    kept.length > 0 ? `where ${kept.map(([condition]) => condition).join(" and ")}` : "",
    kept.flatMap(([, ...values]) => values),
  ];
}

const T3_USER_REQUEST = /<user_request>\n?([\s\S]*?)\n?<\/user_request>/u;
const T3_BLOCK = /^<(t3_code_instructions|runtime_info|pull_request_linking)>[\s\S]*?<\/\1>$/mu;
const T3_BLOCKS = /^<(t3_code_instructions|runtime_info|pull_request_linking)>[\s\S]*?<\/\1>$/gmu;
const ANY_TAGGED_BLOCKS = /^<([a-z0-9_]+)>[\s\S]*?<\/\1>$/gmu;
const OWNERS_CALL_LINES = /^\[[\d.]+s\] you: (.*)$/gmu;

export function asked(text: string) {
  return (T3_USER_REQUEST.exec(text)?.[1] ?? text.replaceAll(ANY_TAGGED_BLOCKS, "")).trim();
}

function outsideT3Blocks(text: string) {
  return text.split(T3_BLOCK).filter((_, i) => i % 2 === 0);
}

export function sent(body: string) {
  const request = T3_USER_REQUEST.exec(body);

  const pieces = request
    ? [
        ...outsideT3Blocks(body.slice(0, request.index)),
        request[1] ?? "",
        ...outsideT3Blocks(body.slice(request.index + request[0].length)),
      ]
    : outsideT3Blocks(body);

  return pieces.map((piece) => piece.trim()).filter(Boolean);
}

export function spoken(row: Row): string {
  if (row.author === "owner") {
    return row.from === "t3" ? row.body.replaceAll(T3_BLOCKS, "") : row.body;
  }

  if (row.author !== "call") {
    return "";
  }

  return [...row.body.matchAll(OWNERS_CALL_LINES)].map(([, line]) => line).join("\n");
}

export const replied = (row: Row) => row.author === "hex";

const hiddenReplyFlags = ["failed", "edited", "permission"];

export const shown = (row: Row) =>
  !replied(row) || !hiddenReplyFlags.some((flag) => (row.meta?.[flag] ?? "") !== "");

const SqliteFailure = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
});

// SQLITE_BUSY can come back despite busy_timeout, to avoid a deadlock: https://www.sqlite.org/c3ref/busy_handler.html
// Running a busy write again is safe, since Bun rolls back a transaction that throws: https://bun.com/docs/runtime/sqlite#transactions
function retryWhileBusy<T>(fn: () => T): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (error) {
      const failure = SqliteFailure.safeParse(error).data;

      if (!String(failure?.code ?? failure?.message).includes("SQLITE_BUSY") || attempt === 5) {
        throw error;
      }

      Bun.sleepSync(20 * attempt);
    }
  }
}
