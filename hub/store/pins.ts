import type { Database } from "bun:sqlite";

import { z } from "zod";

import { MessageIdColumn, now } from "./db.ts";
import type { Core, MessageId, Write } from "./db.ts";

export type Pin = {
  app: string;
  thread: string;
  message: MessageId;
  text: string;
  at: string;
  note: string;
};

const PinRow: z.ZodType<Pin> = z.object({
  app: z.string(),
  thread: z.string(),
  message: MessageIdColumn,
  text: z.string(),
  at: z.string(),
  note: z.string(),
});

const PinRows = z.array(PinRow);

export class Pins {
  private readonly db: Database;
  private readonly write: Write;

  constructor({ db, write }: Core) {
    this.db = db;
    this.write = write;
  }

  get(app: string, thread: string): Pin | null {
    return PinRow.nullable().parse(
      this.db.query("select * from pins where app = ? and thread = ?").get(app, thread),
    );
  }

  list({ app, thread }: { app?: string | undefined; thread?: string | undefined } = {}): Pin[] {
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
}
