import type { Database } from "bun:sqlite";

import { z } from "zod";

import { fromJson } from "./db.ts";
import type { Core, Write } from "./db.ts";

const PassRow = z.object({ n: z.number(), pass: z.string() }).nullable();
const PassJson = z.record(z.string(), z.string());

export class Passes {
  private readonly db: Database;
  private readonly write: Write;

  constructor({ db, write }: Core) {
    this.db = db;
    this.write = write;
  }

  wait(pass: Record<string, string | undefined>) {
    this.write(() =>
      this.db.query("insert into passes (pass) values (?)").run(JSON.stringify(pass)),
    );
  }

  waiting(): { n: number; pass: Record<string, string> } | undefined {
    const row = PassRow.parse(this.db.query("select n, pass from passes order by n limit 1").get());

    return row === null ? undefined : { n: row.n, pass: fromJson(PassJson, row.pass) };
  }

  passed(n: number) {
    this.write(() => this.db.query("delete from passes where n = ?").run(n));
  }
}
