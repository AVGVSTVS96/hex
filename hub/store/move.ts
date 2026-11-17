import { Database } from "bun:sqlite";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { batches, carriedOf, layout, pages } from "./carry.ts";
import type { Read } from "./carry.ts";
import { appendOnlyMigrations } from "./migrations.ts";
import { at, awayFile, StoreJson } from "./remote.ts";
import type { Away } from "./remote.ts";
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

const MoveState = z.object({
  arrived: z.boolean(),
  served: z.boolean(),
  version: z.number().nullable(),
});

const ANSWER_WITHIN = 120_000;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Moves a folder's hex.db into the Durable Object `name` behind url, and proves every row arrived before the folder's store.json points hex there. hex is stopped first, and the move holds the file's write lock, so no process writes a row the object never gets. As the lock is let go the file refuses every write, so a process that opened it before the move, like a hook waiting on the lock, fails instead of keeping a record no hex reads; it then stays under another name. Until a hub has used the object, the same move run again finishes one whose last reply was lost, by comparing again, or starts it over.
export async function move(dir: string, to: Away, say: (line: string) => void) {
  const away = StoreJson.parse(to);

  if (existsSync(awayFile(dir))) {
    throw new Error(`${awayFile(dir)} is there already: this folder's records have moved`);
  }

  const file = join(dir, "hex.db");
  const db = new Database(file, { strict: true });
  db.run("pragma busy_timeout = 30000");

  const post = async (route: string, body?: Posted) => {
    const response = await fetch(at(away, route), {
      method: "POST",
      headers: { authorization: `Bearer ${away.key}` },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(ANSWER_WITHIN),
    });

    const text = await response.text();

    if (!text.startsWith("{")) {
      throw new Error(`the object answered ${response.status}: ${text.slice(0, 200)}`);
    }

    return decode(text);
  };

  const there: Read = async (text) => z.array(z.unknown()).parse(await post("sql", { text }));
  const here = reader(db);
  const state = async () => MoveState.parse(await post("move/state"));

  const differs = async () => {
    const mine = await layout(here);
    const theirs = await layout(there);

    const schema = ({ tables, indexesAndTriggers }: typeof mine) =>
      JSON.stringify([tables.map(({ sql }) => sql), indexesAndTriggers]);

    if (schema(mine) !== schema(theirs)) {
      return "the object's tables, indexes or triggers differ from the file's";
    }

    for (const table of mine.tables) {
      let same = 0;
      const its = pages(there, table);

      for await (const rows of pages(here, table)) {
        const theirRows = await its.next();

        if (JSON.stringify(rows) !== JSON.stringify(theirRows.value)) {
          return `${table.name} differs in the object after ${same} rows`;
        }

        same += rows.length;
      }

      if ((await its.next()).done !== true) {
        return `the object has rows of ${table.name} the file doesn't`;
      }

      say(`${table.name}: ${same} rows the same in the object`);
    }

    if (JSON.stringify(mine.counters) !== JSON.stringify(theirs.counters)) {
      return "the object's autoincrement counters differ from the file's";
    }
  };

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

    const before = await state();

    if (before.served) {
      throw new Error(
        `the object ${away.name} has served a hub, so nothing moves into it: move into a new name`,
      );
    }

    const done =
      before.arrived && before.version === version
        ? await differs().then((difference) => {
            say(
              difference === undefined
                ? `the object ${away.name} has every row from a move whose last reply was lost`
                : `the object ${away.name} holds another move (${difference}): it starts over`,
            );

            return difference === undefined;
          })
        : false;

    if (!done) {
      await send(
        async (route, body) => {
          await post(route, body);
        },
        here,
        version,
        say,
      );
      const difference = await differs();

      if (difference !== undefined) {
        throw new Error(
          `${difference}: nothing points hex there, and the next move starts it over`,
        );
      }

      try {
        await post("move/arrived", { version });
      } catch (error) {
        if (!(await state()).arrived) {
          throw error;
        }
      }
    }

    writeFileSync(awayFile(dir), `${JSON.stringify(away, null, 2)}\n`, { mode: 0o600 });

    for (const { name } of (await layout(here)).tables) {
      for (const event of ["insert", "update", "delete"]) {
        db.run(
          `create trigger "moved_${name}_${event}" before ${event} on "${name}" begin select raise(abort, 'hex''s records moved to a Durable Object, and this file is kept as it was'); end`,
        );
      }
    }

    db.run("commit");
    db.run("pragma wal_checkpoint(truncate)");
    db.close();
    renameSync(file, join(dir, MOVED));
    say(
      `hex's records are in the object ${away.name} at ${away.url}; ${awayFile(dir)} points hex there, and hex.db is kept as ${MOVED}`,
    );
  } catch (error) {
    db.run("rollback");
    db.close();

    throw error;
  }
}

async function send(
  post: (route: string, body?: Posted) => Promise<void>,
  here: Read,
  version: number,
  say: (line: string) => void,
) {
  const { tables, indexesAndTriggers, setCounters } = await layout(here);

  await post("move/begin");
  await post("move/schema", { statements: tables.map(({ sql }) => sql) });

  for (const table of tables) {
    let sent = 0;

    for await (const rows of pages(here, table)) {
      for (const batch of batches(rows.map((row) => carriedOf(table, row)))) {
        await post("move/rows", { table: table.name, columns: table.carried, rows: batch });
      }

      sent += rows.length;
    }

    say(`${table.name}: ${sent} rows sent`);
  }

  await post("move/schema", { statements: [...setCounters, ...indexesAndTriggers] });
  say(`hex.db at migration ${version} sent`);
}

if (import.meta.main) {
  const [dir, url, name] = process.argv.slice(2);

  const key =
    process.env.HEX_STORE_KEY ?? (await new Response(Bun.stdin).text()).split("\n")[0] ?? "";

  if (dir === undefined || url === undefined || name === undefined) {
    throw new Error(
      "usage: hex store move <the Worker's address> <the object's name>, with the key it answers to in HEX_STORE_KEY or on stdin",
    );
  }

  await move(dir, { url, name, key }, console.log);
}
