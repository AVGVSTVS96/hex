import { Database } from "bun:sqlite";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { batches, carriedOf, layout, pages } from "./carry.ts";
import type { Read } from "./carry.ts";
import { appendOnlyMigrations } from "./migrations.ts";
import { awayFile } from "./remote.ts";
import { decode } from "./wire.ts";

export const MOVED = "hex.db.moved";

const reader =
  (db: Database): Read =>
  (text) =>
    Promise.resolve(db.query(text).all());

type Posted =
  | { text: string }
  | { statements: string[] }
  | { table: string; columns: string[]; rows: unknown[][] }
  | { version: number };

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Moves a folder's hex.db into the Durable Object at url, once, and proves every row arrived before the folder's store.json points hex there. hex is stopped first, and the move holds the file's write lock, so no process writes a row the object never gets. The file then stays under another name, whole, so nothing writes records into a file no hex reads.
export async function move(dir: string, url: string, key: string, say: (line: string) => void) {
  if (existsSync(awayFile(dir))) {
    throw new Error(`${awayFile(dir)} is there already: this folder's records have moved`);
  }

  const file = join(dir, "hex.db");
  const db = new Database(file, { strict: true });
  db.run("pragma busy_timeout = 30000");

  const post = async (path: string, body?: Posted) => {
    const response = await fetch(new URL(path, url), {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: JSON.stringify(body ?? {}),
    });

    return decode(await response.text());
  };

  const there: Read = async (text) => z.array(z.unknown()).parse(await post("/sql", { text }));
  const here = reader(db);

  db.run("begin immediate");

  try {
    const [{ user_version: version } = { user_version: -1 }] = z
      .array(z.object({ user_version: z.number() }))
      .parse(await here("pragma user_version"));

    if (version !== appendOnlyMigrations.length) {
      throw new Error(
        `hex.db is at migration ${version} and this hex at ${appendOnlyMigrations.length}: start hex on it once, so it moves as this hex keeps it`,
      );
    }

    const { tables, counters, indexesAndTriggers, setCounters } = await layout(here);

    await post("/move/begin");
    await post("/move/schema", { statements: tables.map(({ sql }) => sql) });

    for (const table of tables) {
      let sent = 0;

      for await (const rows of pages(here, table)) {
        for (const batch of batches(rows.map((row) => carriedOf(table, row)))) {
          await post("/move/rows", { table: table.name, columns: table.carried, rows: batch });
        }

        sent += rows.length;
      }

      say(`${table.name}: ${sent} rows sent`);
    }

    await post("/move/schema", { statements: [...setCounters, ...indexesAndTriggers] });

    for (const table of tables) {
      let same = 0;
      const its = pages(there, table);

      for await (const mine of pages(here, table)) {
        const theirs = await its.next();

        if (JSON.stringify(mine) !== JSON.stringify(theirs.value)) {
          throw new Error(
            `${table.name} differs in the object after ${same} rows: nothing points hex there, and the next move starts it over`,
          );
        }

        same += mine.length;
      }

      if ((await its.next()).done !== true) {
        throw new Error(`the object has rows of ${table.name} the file doesn't`);
      }

      say(`${table.name}: ${same} rows the same in the object`);
    }

    const { counters: its } = await layout(there);

    if (JSON.stringify(counters) !== JSON.stringify(its)) {
      throw new Error("the object's autoincrement counters differ from the file's");
    }

    await post("/move/arrived", { version });
    writeFileSync(awayFile(dir), `${JSON.stringify({ url, key }, null, 2)}\n`, { mode: 0o600 });
    db.run("rollback");
    db.run("pragma wal_checkpoint(truncate)");
    db.close();
    renameSync(file, join(dir, MOVED));
    say(
      `hex's records are in the object at ${url}; ${awayFile(dir)} points hex there, and hex.db is kept as ${MOVED}`,
    );
  } catch (error) {
    db.run("rollback");
    db.close();

    throw error;
  }
}

if (import.meta.main) {
  const [dir, url] = process.argv.slice(2);
  const { HEX_STORE_KEY: key } = process.env;

  if (dir === undefined || url === undefined || key === undefined || key === "") {
    throw new Error(
      "usage: hex store move <the object's address>, with the key it answers to in HEX_STORE_KEY",
    );
  }

  await move(dir, url, key, console.log);
}
