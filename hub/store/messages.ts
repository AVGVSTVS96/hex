import type { Database } from "bun:sqlite";

import { z } from "zod";

import { fromJson, now, TextOrNull } from "./db.ts";
import type { Core, MessageId, Write } from "./db.ts";

export const AuthorColumn = z.enum(["owner", "hex", "prompt", "call", "other"]);

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

export const isAuthor = (value: unknown): value is Author => AuthorColumn.safeParse(value).success;

const Meta = z.record(z.string(), z.string());

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

export const MessageRows = z.array(MessageRow);

const withColumns = <Columns extends z.ZodObject>(columns: Columns) =>
  z.array(
    z
      .record(z.string(), z.unknown())
      .transform((raw) => ({ row: MessageRow.parse(raw), ...columns.parse(raw) })),
  );

const BesideRows = withColumns(z.object({ beside: z.string(), resume: TextOrNull }));
const JobRows = withColumns(z.object({ job: TextOrNull }));

const TakenAtRow = z.object({ at: TextOrNull });
const TakerRow = z.object({ taken_by: z.string(), taken_at: z.string() }).nullable();
const LastRow = z.object({ last: z.number().nullable() });
const UntakenRow = z.object({ untaken: z.number() });

export class Messages {
  private readonly db: Database;
  private readonly write: Write;

  constructor({ db, write }: Core) {
    this.db = db;
    this.write = write;
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A message held for a session's turn waits for that session's next tool call, which takes it (takeHeld), or for the turn's end, which lets it go (letHeldGo).
  hold(key: string, session: string): boolean {
    return this.write(
      () =>
        this.db
          .query("update messages set held_for = ? where key = ? and taken_at is null")
          .run(session, key).changes === 1,
    );
  }

  takeHeld(thread: string, session: string): Row[] {
    const at = now();

    return this.write(() => {
      this.db
        .query(
          'update messages set taken_by = ?1, taken_at = ?2 where "to" = ?3 and held_for = ?1 and taken_at is null',
        )
        .run(session, at, thread);

      return MessageRows.parse(
        this.db
          .query(
            'select * from messages where "to" = ? and held_for = ? and taken_at = ? order by n',
          )
          .all(thread, session, at),
      );
    });
  }

  letHeldGo(thread: string): Row[] {
    const held = 'from messages where "to" = ? and held_for is not null and taken_at is null';

    return this.write(() => {
      const rows = MessageRows.parse(this.db.query(`select * ${held} order by n`).all(thread));
      this.db
        .query(`update messages set held_for = null where key in (select key ${held})`)
        .run(thread);

      return rows;
    });
  }

  get(key: string): Row | null {
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
    const named = this.get(key);
    const editOf = named?.meta?.edited === "true" ? named.meta.message_id : undefined;
    const isEdit = editOf !== undefined && editOf !== "";
    const id = editOf ?? key.slice(key.lastIndexOf(":") + 1);
    const prefix = key.slice(app.length + 1, Math.max(app.length + 1, key.lastIndexOf(":")));

    const chat =
      prefix === "" && isEdit && named !== null ? (named.to.split(":")[0] ?? "") : prefix;

    const original = isEdit ? this.get(`${app}:${prefix === "" ? "" : `${prefix}:`}${id}`) : named;

    const edit = MessageRow.nullable().parse(
      this.db
        .query(
          `select * from messages where "from" = ?1 and json_extract(meta, '$.edited') = 'true'
           and (json_extract(meta, '$.message_id') = ?2 and (?3 = '' or "to" = ?3 or "to" like ?3 || ':%')
             or ?3 != '' and json_extract(meta, '$.message_id') = ?1 || ':' || ?3 || ':' || ?2)
           order by at desc, n desc limit 1`,
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

  taken(session: string, last: number): Row[] {
    return MessageRows.parse(
      this.db
        .query(
          "select * from (select * from messages where taken_by = ? order by taken_at desc, n desc limit ?) order by taken_at, n",
        )
        .all(session, last),
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

  readdress(key: string, to: string): boolean {
    return this.write(
      () =>
        this.db
          .query('update messages set "to" = ? where key = ? and taken_at is null')
          .run(to, key).changes === 1,
    );
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Untaken rows for sessions beside threads: to a beside address, for a new session, or to a session that took one, which takes it as it resumes.
  beside(addresses: string[]): (Row & { beside: string; resume?: string })[] {
    const rows = BesideRows.parse(
      this.db
        .query(
          `select * from (
             select m.*, iif(beside.value is null, (select b."to" from messages b indexed by taken where b.taken_by = m."to" and b."to" in (select value from json_each(?1)) limit 1), m."to") as beside,
               iif(beside.value is null, m."to", null) as resume
             from messages m indexed by untaken left join json_each(?1) beside on beside.value = m."to"
             where m.taken_at is null
           ) where beside is not null order by n`,
        )
        .all(JSON.stringify(addresses)),
    );

    return rows.map(({ row, beside, resume }) => ({
      ...row,
      beside,
      ...(resume !== null && { resume }),
    }));
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // When a session of the thread other than this one last took a message there.
  lastTakenIn(thread: string, session: string): string | undefined {
    return (
      TakenAtRow.parse(
        this.db
          .query(
            `select max(taken_at) as at from messages indexed by sessions where "to" = ? and taken_by is not null and taken_by <> ? and author <> 'hex'`,
          )
          .get(thread, session),
      ).at ?? undefined
    );
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A timed job catches up only its newest slot, so a stalled run of it beside a thread is left to a newer one, taken by the hub.
  supersede(addresses: string[], at = now()) {
    this.write(() => {
      this.db
        .query(
          `update messages set taken_by = 'hub', taken_at = ?2 where key in (
             select m.key from messages m indexed by untaken join json_each(?1) a on a.value = m."to"
             where m.taken_at is null and json_extract(m.meta, '$.stalled') is not null
             and exists (select 1 from messages n where n."to" = m."to" and n.n > m.n and json_extract(n.meta, '$.schedule') = json_extract(m.meta, '$.schedule'))
           )`,
        )
        .run(JSON.stringify(addresses), at);
    });
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // What hex said in the thread's chat since a time from sessions that aren't the thread's own (they took none of its messages), newest first, each with the job its writer ran beside the thread, if any.
  saidByOthers(thread: string, session: string, since = ""): (Row & { job?: string })[] {
    return JobRows.parse(
      this.db
        .query(
          `select m.*, (select coalesce(json_extract(b.meta, '$.schedule'), json_extract(b.meta, '$.job'), json_extract(b.meta, '$.user')) from messages b indexed by taken where b.taken_by = m.taken_by and b."to" like 'beside:%' order by b.n limit 1) as job
           from messages m indexed by said where m."to" = ?1 and m.at > ?3 and m.author = 'hex' and m.taken_by is not ?2
           and json_extract(m.meta, '$.unsent') is null and json_extract(m.meta, '$.failed') is null
           and not exists (select 1 from messages t indexed by sessions where t."to" = ?1 and t.taken_by = m.taken_by and t.author <> 'hex')
           order by m.at desc, m.n desc limit 200`,
        )
        .all(thread, session, since),
    ).map(({ row, job }) => ({ ...row, ...(job !== null && { job }) }));
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // What the earlier runs of a timed job beside a thread said in its chat, and the last words each ended with, newest first.
  saidByEarlierRuns(beside: string, thread: string, schedule: string, session: string): Row[] {
    return MessageRows.parse(
      this.db
        .query(
          `select * from messages indexed by taken where author = 'hex'
           and taken_by in (select taken_by from messages indexed by sessions where "to" = ?1 and taken_by is not null and taken_by <> ?4 and json_extract(meta, '$.schedule') = ?3)
           and ("to" = taken_by or "to" = ?2 and json_extract(meta, '$.unsent') is null and json_extract(meta, '$.failed') is null)
           order by at desc, n desc limit 50`,
        )
        .all(beside, thread, schedule, session),
    );
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The row a session beside a thread was first started for.
  ranFor(session: string): Row | null {
    return MessageRow.nullable().parse(
      this.db
        .query(
          `select * from messages indexed by taken where taken_by = ? and "to" like 'beside:%' order by taken_at limit 1`,
        )
        .get(session),
    );
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
