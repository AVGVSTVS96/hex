import { Database } from "bun:sqlite";
import { existsSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { batches, carriedOf, layout, pages } from "./carry.ts";
import type { Read } from "./carry.ts";
import { CONTRACT } from "./domains.ts";
import { UnreachedError } from "./errors.ts";
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

const CHECKPOINT_WITHIN = 2000;

const TheirContract = z.object({ contract: z.string() });

const MoveState = z.object({
  arrived: z.boolean(),
  served: z.boolean(),
  version: z.number().nullable(),
  moving: z.object({ id: z.string(), step: z.number() }).nullable(),
});

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Cloudflare's edge can answer for the object with a page of its own, as it did with a 404 in the first minute after a Worker's first deploy; a move waits that out, a minute or two in all, before it gives up.
const TIMES = {
  answerWithin: 120_000,
  firstRetry: 1000,
  longestRetry: 15_000,
  giveUpAfter: 180_000,
};

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Moves a folder's hex.db into the Durable Object `name` behind url, and proves every row arrived before the folder's store.json points hex there. hex is stopped first, and the move holds the file's write lock, so no process writes a row the object never gets. As the lock is let go the file refuses every write, so a process that opened it before the move, like a hook waiting on the lock, fails instead of keeping a record no hex reads; it then stays under another name. Until a hub has used the object, the same move run again finishes one whose last reply was lost, by comparing again, or starts it over.
export async function move(dir: string, to: Away, say: (line: string) => void, times = TIMES) {
  const away = StoreJson.parse(to);

  if (existsSync(awayFile(dir))) {
    throw new Error(`${awayFile(dir)} is there already: this folder's records have moved`);
  }

  const file = join(dir, "hex.db");
  const db = new Database(file, { strict: true });
  db.run("pragma busy_timeout = 30000");

  const id = crypto.randomUUID();
  let steps = 0;

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // One request, answered by the object, or rejected with UnreachedError when the answer isn't the object's own (none, a page of Cloudflare's, a 5xx or 429).
  const reply = async (route: string, body?: Posted, mark?: string) => {
    let response: Response;
    let text: string;

    try {
      response = await fetch(at(away, route), {
        method: "POST",
        headers: {
          authorization: `Bearer ${away.key}`,
          ...(mark !== undefined && { "hex-move": mark }),
        },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(times.answerWithin),
      });
      text = await response.text();
    } catch (error) {
      throw new UnreachedError(`the object didn't answer: ${String(error)}`);
    }

    if (response.status >= 500 || response.status === 429 || !text.startsWith("{")) {
      throw new UnreachedError(`the object answered ${response.status}: ${text.slice(0, 200)}`);
    }

    return text;
  };

  const once = async (route: string, body?: Posted, mark?: string) =>
    decode(await reply(route, body, mark));

  const waitedOut = async <T>(work: () => Promise<T>): Promise<T> => {
    const started = Date.now();

    for (let wait = times.firstRetry; ; wait = Math.min(wait * 2, times.longestRetry)) {
      try {
        return await work();
      } catch (error) {
        if (!(error instanceof UnreachedError) || Date.now() - started >= times.giveUpAfter) {
          throw error;
        }

        say(`${error.message}; trying again in ${wait / 1000} s`);
        await Bun.sleep(wait);
      }
    }
  };

  const post = async (route: string, body?: Posted) => await waitedOut(() => once(route, body));
  const state = async () => MoveState.parse(await post("move/state"));

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A step that changes the object carries its mark, so one whose answer was lost is asked after rather than sent again, and the object takes it once even if the network held a copy back.
  const step = async (route: string, body?: Posted) => {
    steps += 1;
    const mine = steps;

    await waitedOut(async () => {
      try {
        await once(route, body, `${id}:${mine}`);
      } catch (error) {
        if (error instanceof UnreachedError) {
          const { moving } = await state();

          if (moving?.id === id && moving.step >= mine) {
            return;
          }
        }

        throw error;
      }
    });
  };

  const there: Read = async (text) => z.array(z.unknown()).parse(await post("sql", { text }));
  const here = reader(db);

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

      // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
      // JSON reads 7 and 7.0 alike, so each column's types are counted too.
      const types = `select ${table.columns.map((column) => `typeof("${column}")`).join(" || ',' || ")} as types, count(*) as n from "${table.name}" group by 1 order by 1`;

      if (JSON.stringify(await here(types)) !== JSON.stringify(await there(types))) {
        return `${table.name} holds values of other types in the object`;
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

    const { contract } = TheirContract.parse(JSON.parse(await waitedOut(() => reply("version"))));

    if (contract !== CONTRACT) {
      throw new Error(
        `the Worker runs another hex's store (${contract}, this hex's is ${CONTRACT}): deploy this checkout's with hex store deploy, then move`,
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
      await send(step, here, version, say);
      const difference = await differs();

      if (difference !== undefined) {
        throw new Error(
          `${difference}: nothing points hex there, and the next move starts it over`,
        );
      }

      await step("move/arrived", { version });
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
    db.run(`pragma busy_timeout = ${CHECKPOINT_WITHIN}`);
    db.run("pragma wal_checkpoint(truncate)");
    db.close();
    renameSync(file, join(dir, MOVED));

    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // A process that still reads hex.db, like a backup streaming it, keeps the last writes from reaching the file, so they go with it in its WAL.
    if (existsSync(`${file}-wal`) && statSync(`${file}-wal`).size > 0) {
      renameSync(`${file}-wal`, join(dir, `${MOVED}-wal`));
    }

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
