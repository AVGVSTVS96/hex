import type { Database } from "bun:sqlite";

import { z } from "zod";

import { now } from "./db.ts";
import type { Core, Write } from "./db.ts";

const HolderRow = z.object({ holder: z.string() });

export class Leases {
  private readonly db: Database;
  private readonly write: Write;

  constructor({ db, write }: Core) {
    this.db = db;
    this.write = write;
  }

  take(name: string, holder: string, ms: number): boolean {
    return this.write(() => {
      this.db.query("delete from leases where name = ? and until < ?").run(name, now());
      const until = new Date(Date.now() + ms).toISOString();
      this.db
        .query(
          "insert into leases (name, holder, until) values (?, ?, ?) on conflict (name) do update set until = excluded.until where holder = excluded.holder",
        )
        .run(name, holder, until);

      return (
        HolderRow.parse(this.db.query("select holder from leases where name = ?").get(name))
          .holder === holder
      );
    });
  }

  release(name: string, holder: string) {
    this.write(() =>
      this.db.query("delete from leases where name = ? and holder = ?").run(name, holder),
    );
  }
}
