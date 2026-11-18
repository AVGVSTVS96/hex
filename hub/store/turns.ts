import { z } from "zod";

import { KeyValues, now, TextOrAbsent, TextOrNull } from "./db.ts";
import type { Core, Sql, Write } from "./db.ts";
import { MessageRows } from "./messages.ts";
import type { Messages, Row } from "./messages.ts";

const TurnRow = z
  .object({ began: TextOrAbsent, ended: TextOrAbsent, handled: TextOrAbsent })
  .transform(({ began, ended, handled }) => ({
    ...(began !== undefined && { began }),
    ...(ended !== undefined && { ended }),
    ...(handled !== undefined && { handled }),
  }));

const UnfinishedTurnRows = z.array(
  z.object({ session: z.string(), handled: TextOrNull, waiting: TextOrNull }),
);

const RepliesRow = z.object({ replies: z.number() });

const TURNS = 30 * 24 * 60 * 60 * 1000;

export class Turns {
  private readonly db: Sql;
  private readonly write: Write;
  private readonly messages: Messages;

  constructor({ db, write }: Core, messages: Messages) {
    this.db = db;
    this.write = write;
    this.messages = messages;
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A session takes the message its turn began with and the turn is recorded in one write, so both land or neither does.
  took(key: string, session: string, busy: boolean, at = now()): boolean {
    return this.write(() => {
      if (!this.messages.take(key, session)) {
        return false;
      }

      if (session !== "") {
        this.turned(session, busy, at);
      }

      return true;
    });
  }

  recorded(session: string, busy: boolean, at = now(), answered?: "handled" | "waitsOnAgents") {
    this.write(() => {
      this.turned(session, busy, at);

      if (answered !== undefined) {
        this[answered](session, at);
      }
    });
  }

  turned(session: string, busy: boolean, at = now()) {
    this.write(() => {
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

  handled(session: string, at = now()) {
    this.write(() => {
      const { began, ended } = this.get(session);

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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A turn that ended with agents still working answered what it took, as any turn that ends does, so a session cut short gives back only what it took since, however often it is cut. waited: one of them had started agents, and any still working ended with it.
  cut(thread: string, session?: string, at = now()): { given: string[]; waited: boolean } {
    return this.write(() => {
      const cutShort = UnfinishedTurnRows.parse(
        this.db
          .query(
            `select session, handled, waiting from turns where (began is not null and ended is null or waiting is not null) and (session = ?2 or session in (select distinct taken_by from messages indexed by sessions where "to" = ?1 and taken_by is not null and author <> 'hex'))`,
          )
          .all(thread, session ?? null),
      );

      const given = cutShort.flatMap(({ session: died, handled, waiting }) => {
        const lastTurnEnded =
          waiting !== null && (handled === null || waiting > handled) ? waiting : handled;

        this.turned(died, false, at);

        this.db
          .query("update turns set waiting = null, handled = ? where session = ?")
          .run(lastTurnEnded, died);

        return KeyValues.parse(
          this.db
            .query(
              `update messages set taken_by = null, taken_at = null where taken_by = ? and author <> 'hex' and "from" <> 'terminal' and taken_at > ? returning key`,
            )
            .values(died, lastTurnEnded),
        ).map(([key]) => key);
      });

      return { given, waited: cutShort.some(({ waiting }) => waiting !== null) };
    });
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A session beside a thread that ended without seeing its turn through gives back what it took, and its start row if it never took it: each waits for a turn to go through anywhere (stalled), and one that waited already is left, taken by the hub. A run cut off with the machine (stall false) gives its rows back to run again as they are.
  besideEnded(
    session: string,
    start?: string,
    at = now(),
    stall = true,
  ): { given: Row[]; left: Row[] } {
    return this.write(() => {
      const { handled } = this.get(session);

      const rows = MessageRows.parse(
        this.db
          .query(
            `select * from messages where taken_by = ?1 and author <> 'hex' and "from" <> 'terminal' and taken_at >= ?2 or key = ?3 and taken_at is null order by n`,
          )
          .all(session, handled ?? null, start ?? null),
      );

      const left = rows.filter((row) => stall && row.meta?.stalled !== undefined);
      const given = rows.filter((row) => !left.includes(row));

      for (const row of left) {
        this.db
          .query("update messages set taken_by = 'hub', taken_at = ? where key = ?")
          .run(at, row.key);
      }

      for (const row of given) {
        this.db
          .query(
            `update messages set taken_by = null, taken_at = null, meta = iif(?2, json_set(coalesce(meta, '{}'), '$.stalled', ?3), meta) where key = ?1`,
          )
          .run(row.key, stall, at);
      }

      this.handled(session, at);

      return { given, left };
    });
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Sessions beside any thread whose last turn didn't go through and that no longer run.
  unfinishedBeside(running: string[]): string[] {
    return KeyValues.parse(
      this.db
        .query(
          `select session from turns where (began is not null and (ended is null or coalesce(handled, '') <= began) or waiting is not null)
           and session in (select taken_by from messages indexed by sessions where "to" >= 'beside:' and "to" < 'beside;' and taken_by is not null)
           and session not in (select value from json_each(?1))`,
        )
        .values(JSON.stringify(running)),
    ).map(([session]) => session);
  }

  midTurn(thread: string): boolean {
    return (
      this.db
        .query(
          `select 1 from turns where (began is not null and ended is null or waiting is not null) and session in (select distinct taken_by from messages indexed by sessions where "to" = ? and taken_by is not null and author <> 'hex') limit 1`,
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // What the owner said to a session since its last turn ended, when it outnumbers the replies the session sent since.
  unanswered(session: string): Row[] {
    const { handled } = this.get(session);

    if (handled === undefined) {
      return [];
    }

    const owners = MessageRows.parse(
      this.db
        .query(
          `select * from messages where taken_by = ?1 and author = 'owner' and "from" <> 'terminal' and taken_at > ?2 and json_extract(meta, '$.reaction') is null order by taken_at`,
        )
        .all(session, handled),
    );

    const { replies } = RepliesRow.parse(
      this.db
        .query(
          `select count(*) as replies from messages where taken_by = ?1 and author = 'hex' and at > ?2 and json_extract(meta, '$.unsent') is null`,
        )
        .get(session, handled),
    );

    return owners.length > replies ? owners : [];
  }

  get(session: string): { began?: string; ended?: string; handled?: string } {
    return (
      TurnRow.nullable().parse(
        this.db.query("select began, ended, handled from turns where session = ?").get(session),
      ) ?? {}
    );
  }
}
