import type { Database } from "bun:sqlite";

import { z } from "zod";

import { found, KeyValues, now, TextOrAbsent, TextOrNull } from "./db.ts";
import type { Core, Write } from "./db.ts";
import type { Messages } from "./messages.ts";

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

const WakingRow = z.object({ count: z.number(), oldest: TextOrAbsent });

const NumberValues = z.array(z.tuple([z.number()]));

function holdNumber(id: string) {
  const n = /^h-(\d+)$/u.exec(id)?.[1];

  if (n === undefined) {
    throw new Error(`${id} isn't a hold's id, like h-3`);
  }

  return Number(n);
}

export class Holds {
  private readonly db: Database;
  private readonly write: Write;
  private readonly messages: Messages;

  constructor({ db, write }: Core, messages: Messages) {
    this.db = db;
    this.write = write;
    this.messages = messages;
  }

  create({ threads, by, why, message, until }: NewHold): Hold {
    const reason = why.trim();
    const others = [...new Set(threads)].filter((thread) => thread !== by);

    if (others.length === 0) {
      throw new Error("a hold names the threads it holds, other than the one holding them");
    }

    if (reason === "") {
      throw new Error("a hold says why");
    }

    if (message !== undefined && message !== "" && this.messages.get(message) === null) {
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

      return found(this.get(id), id);
    });
  }

  get(id: string): Hold | null {
    return this.list({ id, all: true }).at(0) ?? null;
  }

  list({ id, all = false }: { id?: string | undefined; all?: boolean | undefined } = {}): Hold[] {
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
    const hold = this.get(id);

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
}
