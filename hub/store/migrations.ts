import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { z } from "zod";

import { above } from "../fit.ts";
import { fromJson, MessageIdColumn } from "./db.ts";
import { AuthorColumn } from "./messages.ts";
import type { Messages } from "./messages.ts";
import type { Pins } from "./pins.ts";
import { AnswerJson, SettledJson } from "./questions.ts";
import type { Questions } from "./questions.ts";
import type { Relays } from "./relays.ts";

type Migrating = {
  dir: string;
  db: Database;
  messages: Messages;
  questions: Questions;
  pins: Pins;
  relays: Relays;
};

const UnnotedPinRows = z.array(
  z.object({ app: z.string(), thread: z.string(), message: MessageIdColumn, text: z.string() }),
);

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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The rows these triggers write count in Bun's `.changes` of the statement that set them off, unlike sqlite3_changes(), so a check on these tables counts what the statement returns.
const STATUS_INPUTS = [
  { table: "tasks", thread: (row: string) => `${row}.owner` },
  { table: "questions", thread: (row: string) => `${row}.thread` },
  { table: "words", thread: (row: string) => `(select owner from tasks where n = ${row}.task)` },
];

function sql(text: string) {
  return ({ db }: Migrating) => {
    db.run(text);
  };
}

export const appendOnlyMigrations: ((store: Migrating) => void)[] = [
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
  ({ dir }: Migrating) => {
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
  ({ db }: Migrating) => {
    if (
      db.query("select 1 from pragma_table_info('turns') where name = 'handled'").get() !== null
    ) {
      return;
    }

    db.run(`alter table turns add column handled text check (handled ${SORTABLE_UTC})`);
    db.run("update turns set handled = strftime('%Y-%m-%dT%H:%M:%fZ')");
  },
  ({ db }: Migrating) => {
    if (
      db.query("select 1 from pragma_table_info('questions') where name = 'asker'").get() === null
    ) {
      db.run(
        `alter table questions add column asker text not null default 'hex' check (asker in ('hex', 'owner'))`,
      );
    }
  },
  ({ db }: Migrating) => {
    if (
      db.query("select 1 from pragma_table_info('turns') where name = 'waiting'").get() === null
    ) {
      db.run(`alter table turns add column waiting text check (waiting ${SORTABLE_UTC})`);
    }
  },
  ({ db }: Migrating) => {
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
  ({ db }: Migrating) => {
    if (
      db.query("select 1 from pragma_table_info('questions') where name = 'shots'").get() === null
    ) {
      db.run(
        "alter table questions add column shots text check (json_valid(shots) and json_type(shots) = 'array')",
      );
    }
  },
  sql(`update messages set author = 'prompt' where "from" = 'terminal' and author = 'owner' and "to" = json_extract(meta, '$.session')
    and exists (select 1 from messages opener where opener."to" = messages."to" and opener."from" = 'terminal' and opener.author = 'prompt' and opener.n < messages.n)`),
  ({ db }: Migrating) => {
    if (
      db.query("select 1 from pragma_table_info('threads') where name = 'project'").get() === null
    ) {
      db.run("alter table threads add column project text");
    }
  },
  sql(`create table if not exists changed (thread text primary key, n integer not null);
  create index if not exists changed_in_order on changed (n);
  ${STATUS_INPUTS.map(statusChangeTriggers).join("\n")}`),
];

function statusChangeTriggers({ table, thread }: (typeof STATUS_INPUTS)[number]) {
  const touch = (row: string) =>
    `insert into changed (thread, n) values (${thread(row)}, (select coalesce(max(n), 0) + 1 from changed)) on conflict (thread) do update set n = excluded.n;`;

  return [
    ["insert", touch("new")],
    ["update", touch("old") + touch("new")],
    ["delete", touch("old")],
  ]
    .map(
      ([event, body]) =>
        `create trigger if not exists ${table}_${event}_changes after ${event} on ${table} begin ${body} end;`,
    )
    .join("\n");
}

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

function carryThreadsJson({ db, dir }: Migrating) {
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

function carryLedgers(store: Migrating) {
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
          store.pins.unpinned(app, thread, old?.message);
        }, old);
      } else if (
        pin.message !== old?.message ||
        store.pins.get(app, thread)?.message === old.message
      ) {
        keep(() => {
          store.pins.pinned({ ...pin, note: pin.note, app, thread });
        }, pin);
      }
    }

    const carried = new Set((was?.asks ?? []).map((question) => JSON.stringify(question)));

    for (const question of book.asks) {
      if (!carried.has(JSON.stringify(question))) {
        keep(() => {
          store.questions.ask({ app, ...question });
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

function carryRelays(store: Migrating) {
  for (const [app, folder] of apps(store.dir)) {
    const file = stillOrMoved(join(folder, "relays.jsonl"));

    if (file === undefined) {
      continue;
    }

    for (const line of readFileSync(file, "utf-8").split("\n")) {
      try {
        const { at, from, thread, run } = fromJson(RelayLine, line);
        store.relays.relayed(`${app}:${from}`, thread, run, at);
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

function everyPinIsAStatusPost(store: Migrating) {
  const pins = UnnotedPinRows.parse(
    store.db.query("select app, thread, message, text from pins where note is null").all(),
  );

  for (const { app, thread, message, text } of pins) {
    const telegramChat = app === "telegram" ? `${thread.split(":")[0] ?? ""}:` : "";
    const author = store.messages.get(`${app}:${telegramChat}${message}`)?.author;

    const hexCanRewriteIt =
      text !== "" &&
      store.questions.get(app, thread, message) === null &&
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

function carryProfile(store: Migrating) {
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
