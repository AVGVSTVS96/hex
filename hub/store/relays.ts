import type { Database } from "bun:sqlite";

import { z } from "zod";

import { now } from "./db.ts";
import type { Core, Write } from "./db.ts";

const RelayRows = z.array(
  z.object({ from: z.string(), thread: z.string(), run: z.string(), at: z.string() }),
);

export class Relays {
  private readonly db: Database;
  private readonly write: Write;

  constructor({ db, write }: Core) {
    this.db = db;
    this.write = write;
  }

  relayed(from: string, thread: string, run: string, at = now()) {
    this.write(() =>
      this.db
        .query(
          'insert into relays ("from", thread, run, at) values (?, ?, ?, ?) on conflict ("from", thread) do update set run = excluded.run, at = excluded.at where excluded.at >= relays.at',
        )
        .run(from, thread, run, at),
    );
  }

  list() {
    return RelayRows.parse(
      this.db.query('select "from", thread, run, at from relays order by at').all(),
    );
  }
}
