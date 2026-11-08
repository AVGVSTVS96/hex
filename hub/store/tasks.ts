import type { Database } from "bun:sqlite";

import { z } from "zod";

import { clause, found, now, TextOrAbsent } from "./db.ts";
import type { Core, Write } from "./db.ts";
import { AuthorColumn, sent, spoken } from "./messages.ts";
import type { Author, Messages } from "./messages.ts";

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

const TaskNumberRow = z.object({ n: z.number() }).nullable();
const DoneInRows = z.array(z.object({ done_in: z.string() }));
const ThreadColumnRows = z.array(z.object({ thread: z.string() }));
const WordRows = z.array(z.object({ rowid: z.number(), text: z.string() }));

const AgentTaskRows = z.array(
  z.object({ agent: z.string(), n: z.number(), owner: z.string(), project: TextOrAbsent }),
);

const oneLine = (text: string) => text.replaceAll(/\s+/gu, " ").trim();

function number(id: string): number {
  const n = Number(id.replace(/^t-/u, ""));

  if (Number.isInteger(n)) {
    return n;
  }

  throw new Error(`${id} isn't a task id, like t-12`);
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

export class Tasks {
  private readonly db: Database;
  private readonly write: Write;
  private readonly messages: Messages;

  constructor({ db, write }: Core, messages: Messages) {
    this.db = db;
    this.write = write;
    this.messages = messages;
  }

  create({ title, message, quote, owner, status = "open", project, doneWhen }: NewTask): Task {
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

      return found(this.get(id), id);
    });
  }

  addWords(id: string, message: string, quote?: string): Task {
    return this.write(() => {
      const live = this.live(id);
      this.quote(live, message, quote);

      return found(this.get(live), live);
    });
  }

  requote(id: string, message: string, quote: string): Task {
    return this.write(() => {
      const live = this.live(id);
      const said = this.messages.get(message);

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
          return found(this.get(live), live);
        }

        throw new Error(`${live} holds no whole message ${message} to cut "${quote}" from`);
      }

      if (whole === held) {
        return found(this.get(live), live);
      }

      if (
        !whole.text.includes(quote) ||
        (said.from === "t3" && !pieces.some((piece) => piece.includes(quote)))
      ) {
        throw new Error(`"${quote}" isn't in what ${live} holds from ${message}`);
      }

      if (held !== undefined && whole.text !== said.body) {
        return found(this.get(live), live);
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

      return found(this.get(live), live);
    });
  }

  edit(id: string, change: TaskChange): Task {
    const title = change.title === undefined ? undefined : oneLine(change.title);

    if (title === "") {
      throw new Error("a task's title can't be empty");
    }

    return this.write(() => {
      const task = this.get(id);

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

      return found(this.get(id), id);
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

      return found(this.get(live), live);
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

  merge(into: string, from: string): Task {
    return this.write(() => {
      if (number(into) === number(from)) {
        throw new Error(`${into} can't be merged into itself`);
      }

      for (const id of [into, from]) {
        const status = this.get(id)?.status;

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

      return found(this.get(into), into);
    });
  }

  get(id: string): Task | null {
    const row = TaskRow.nullable().parse(
      this.db.query("select * from tasks where n = ?").get(number(id)),
    );

    return row === null ? null : this.toTask(row);
  }

  list(filter?: {
    owner?: string | undefined;
    status?: Status[] | undefined;
    words?: true;
  }): Task[];
  list(filter: {
    owner?: string | undefined;
    status?: Status[] | undefined;
    words: false;
  }): Omit<Task, "words">[];
  list({
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

  private quote(task: string, message: string, quote?: string) {
    const said = this.messages.get(message);

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
        const edited = this.messages.latest(message);
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
}
