import type { Database } from "bun:sqlite";

import { z } from "zod";

import { KeyValues, now, TextOrAbsent, TextOrNull } from "./db.ts";
import type { Core, Write } from "./db.ts";
import { MessageRows } from "./messages.ts";
import type { Row } from "./messages.ts";

type Beat = { began: string; until?: string; after?: string };

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

const RepliesRow = z.object({ replies: z.number() });

const TURNS = 30 * 24 * 60 * 60 * 1000;
const BEATS = 7 * 24 * 60 * 60 * 1000;

export class Turns {
  private readonly db: Database;
  private readonly write: Write;

  constructor({ db, write }: Core) {
    this.db = db;
    this.write = write;
  }

  turned(session: string, busy: boolean, at = now(), heartbeat = false, flipped?: number) {
    this.write(() => {
      const { began, ended } = this.get(session);
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

  cut(thread: string, session?: string, at = now()): string[] {
    return this.write(() => {
      const diedMidTurn = UnfinishedTurnRows.parse(
        this.db
          .query(
            `select session, handled from turns where (began is not null and ended is null or waiting is not null) and (session = ?2 or session in (select distinct taken_by from messages indexed by sessions where "to" = ?1 and taken_by is not null and author <> 'hex'))`,
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
  // What the owner said to a session since its last turn ended, when it outnumbers the replies the session sent since: Claude Code passes on a chat message that arrives mid-turn as one from outside, not the user, so the turn can end without answering it.
  unanswered(session: string, more = 0): Row[] {
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

    return owners.length > replies + more ? owners : [];
  }

  get(session: string): { began?: string; ended?: string; handled?: string } {
    return (
      TurnRow.nullable().parse(
        this.db.query("select began, ended, handled from turns where session = ?").get(session),
      ) ?? {}
    );
  }
}
