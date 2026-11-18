import { Database } from "bun:sqlite";
import { existsSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { batches, carriedOf, difference, layout, pages } from "./carry.ts";
import type { Read } from "./carry.ts";
import { OFFERS, OffersJson, unmet } from "./domains.ts";
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

const TheirOffers = z.object({ offers: OffersJson });

const MoveState = z.object({
  arrived: z.boolean(),
  served: z.boolean(),
  version: z.number().nullable(),
  moving: z.object({ id: z.string(), step: z.number() }).nullable(),
});

// WARNING: for about a minute after a Worker's first deploy, Cloudflare's edge can answer for it with a 404 page of its own.
const TIMES = {
  answerWithin: 120_000,
  firstRetry: 1000,
  longestRetry: 15_000,
  giveUpAfter: 180_000,
};

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

  const differs = async () =>
    await difference(here, there, (line) => {
      say(`${line} in the object`);
    });

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

    const { offers } = TheirOffers.parse(JSON.parse(await waitedOut(() => reply("version"))));
    const lacking = unmet(OFFERS, offers);

    if (lacking !== undefined) {
      throw new Error(
        `the Worker runs an older hex's store than this one: ${lacking}. Deploy this checkout's with hex store deploy, then move`,
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
        ? await differs().then((differing) => {
            say(
              differing === undefined
                ? `the object ${away.name} has every row from a move whose last reply was lost`
                : `the object ${away.name} holds another move (${differing}): it starts over`,
            );

            return differing === undefined;
          })
        : false;

    if (!done) {
      await send(step, here, version, say);
      const differing = await differs();

      if (differing !== undefined) {
        throw new Error(`${differing}: nothing points hex there, and the next move starts it over`);
      }

      await step("move/arrived", { version });
    }

    writeFileSync(`${awayFile(dir)}.part`, `${JSON.stringify(away, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${awayFile(dir)}.part`, awayFile(dir));

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
    setAside(dir);
    renameSync(file, join(dir, MOVED));

    // WARNING: a reader still on hex.db, like a backup streaming it, keeps the checkpoint from emptying the WAL: https://www.sqlite.org/wal.html#bigwal
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

// WARNING: a database opened beside another file's WAL or shm reads them as its own and corrupts: https://www.sqlite.org/howtocorrupt.html#_mispairing_database_files_and_hot_journals_
function setAside(dir: string) {
  const kept = join(dir, MOVED);
  const stamp = new Date().toISOString().replaceAll(/\D/gu, "").slice(0, 14);

  for (const [from, to] of [
    [kept, `${kept}.${stamp}`],
    [`${kept}-wal`, `${kept}.${stamp}-wal`],
  ] as const) {
    if (existsSync(from)) {
      renameSync(from, to);
    }
  }

  rmSync(`${kept}-shm`, { force: true });
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
