import type { Database } from "bun:sqlite";

import { z } from "zod";

import { now } from "./db.ts";
import type { Core, Write } from "./db.ts";

const RecordRow = z.object({ record: z.string() }).nullable();

const TASKS_RECORD_KEPT_UNCHANGED = 2 * 24 * 60 * 60 * 1000;

export class Seen {
  private readonly db: Database;
  private readonly write: Write;

  constructor({ db, write }: Core) {
    this.db = db;
    this.write = write;
  }

  get(session: string, kind: string): string {
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
}
