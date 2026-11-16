import type { Database } from "bun:sqlite";

import { z } from "zod";

import type { Core, Write } from "./db.ts";
import { MessageRows } from "./messages.ts";
import type { Messages, Row } from "./messages.ts";

const CheckedRow = z.object({ checked: z.number() }).nullable();

const SIGNAL = "signal:";

export const signalTo = (name: string) => `${SIGNAL}${name}`;

export const signalOf = (address: string) =>
  address.startsWith(SIGNAL) ? address.slice(SIGNAL.length) : undefined;

export class Scheduler {
  private readonly db: Database;
  private readonly write: Write;
  private readonly messages: Messages;

  constructor({ db, write }: Core, messages: Messages) {
    this.db = db;
    this.write = write;
    this.messages = messages;
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

    return this.messages.deliver({
      key: `schedule:${schedule}@${slot}Z`,
      to,
      from: "schedule",
      author: "prompt",
      body,
      meta: { user: "schedule", schedule, ...(late && { late: "true" }) },
    });
  }

  signal(name: string, why: string, id: string = crypto.randomUUID()): boolean {
    return this.messages.deliver({
      key: `${signalTo(name)}@${id}`,
      to: signalTo(name),
      from: "signal",
      author: "prompt",
      body: why,
      meta: { user: "signal" },
    });
  }

  signals(): Row[] {
    return MessageRows.parse(
      this.db
        .query(
          `select * from messages indexed by untaken where taken_at is null and "to" >= ?1 and "to" < ?2 order by n`,
        )
        .all(SIGNAL, "signal;"),
    );
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A run of the schedule waits to be taken, or the session that took one is still in its turn.
  running(schedule: string, alive: string[]): boolean {
    return (
      this.db
        .query(
          `select 1 from messages m where m.key >= ?1 and m.key < ?2 and (m.taken_at is null
             or m.taken_by in (select value from json_each(?3)) and exists (select 1 from turns t where t.session = m.taken_by
               and (t.began is not null and t.ended is null or t.waiting is not null))) limit 1`,
        )
        .get(`schedule:${schedule}@`, `schedule:${schedule}@~`, JSON.stringify(alive)) !== null
    );
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // One run for every signal heard since the schedule last ran, each taken by it.
  fireOn(schedule: string, heard: Row[], to: string, body: string): boolean {
    const [first] = heard;

    if (first === undefined) {
      return false;
    }

    const key = `schedule:${schedule}@${first.key}`;

    return this.write(() => {
      const fired = this.messages.deliver({
        key,
        to,
        from: "schedule",
        author: "prompt",
        body,
        meta: { user: "schedule", schedule },
      });

      for (const row of heard) {
        this.messages.take(row.key, key);
      }

      return fired;
    });
  }
}
