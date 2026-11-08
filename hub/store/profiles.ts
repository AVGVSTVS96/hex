import type { Database } from "bun:sqlite";

import { z } from "zod";

import { now } from "./db.ts";
import type { Core, Write } from "./db.ts";

const ProfileRows = z.array(z.object({ at: z.string(), body: z.string() }));

const BodyRow = z.object({ body: z.string() }).nullable();

export class Profiles {
  private readonly db: Database;
  private readonly write: Write;

  constructor({ db, write }: Core) {
    this.db = db;
    this.write = write;
  }

  current(): string {
    return (
      BodyRow.parse(this.db.query("select body from profiles order by n desc limit 1").get())
        ?.body ?? ""
    );
  }

  list(): { at: string; body: string }[] {
    return ProfileRows.parse(this.db.query("select at, body from profiles order by n desc").all());
  }

  profiled(before: string, body: string, at = now()): boolean {
    return this.write(() => {
      if (this.current() !== before.trim()) {
        return false;
      }

      if (body.trim() === before.trim()) {
        return true;
      }

      this.db.query("insert into profiles (at, body) values (?, ?)").run(at, body.trim());

      return true;
    });
  }
}
