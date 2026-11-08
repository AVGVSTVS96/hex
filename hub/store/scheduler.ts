import type { Database } from "bun:sqlite";

import { z } from "zod";

import type { Core, Write } from "./db.ts";
import type { Messages } from "./messages.ts";

const CheckedRow = z.object({ checked: z.number() }).nullable();

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
}
