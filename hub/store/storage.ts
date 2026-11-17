import { z } from "zod";

import { onlyReading } from "./db.ts";
import type { Bound, Core } from "./db.ts";
import { domains, migrate } from "./domains.ts";
import type { Domains } from "./domains.ts";
import { answering } from "./wire.ts";
import type { Reply } from "./wire.ts";

// The part of a Durable Object's storage the store runs on: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- rows as SQLite gives them, which each domain parses where it reads them */
export type Storage = {
  readonly sql: {
    exec: (
      query: string,
      ...bound: unknown[]
    ) => { toArray: () => Record<string, unknown>[]; raw: () => Iterable<unknown[]> };
  };
  transactionSync: <T>(closure: () => T) => T;
};
/* oxlint-enable anti-slop/no-unsafe-dictionary-type -- end of SQLite's rows */

const HomeRow = z
  .object({ version: z.number(), tenure: z.number(), served: z.number() })
  .optional();

const Count = z.object({ n: z.number() });
const Statements = z.object({ statements: z.array(z.string()) });

const Rows = z.object({
  table: z.string().regex(/^\w+$/u),
  columns: z.array(z.string().regex(/^\w+$/u)).min(1),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
});

const Leftovers = z.array(
  z.object({ type: z.enum(["table", "trigger", "index"]), name: z.string() }),
);

const Arrived = z.object({ version: z.number().int().nonnegative() });
const Query = z.object({ text: z.string(), bound: z.array(z.unknown()).default([]) });

class UndoneError extends Error {
  override name = "UndoneError";
}

type Called = { reply: Reply; wrote: boolean };

type Moved = boolean | number | { arrived: boolean; served: boolean; version: number | null };

const bind = (bound: Bound[]) =>
  bound.map((value) =>
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Bound is a closed union; this picks the two members a Durable Object's SQL refuses
    typeof value === "boolean" || typeof value === "bigint" ? Number(value) : value,
  );

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The store's SQL over a Durable Object's: a statement's changes count the rows its triggers wrote, as Bun's do, and a write inside a write joins it.
export function sqlOver(storage: Storage): Core {
  const { sql } = storage;
  const count = (what: string) => Count.parse(sql.exec(`select ${what} as n`).toArray()[0]).n;
  let writing = false;

  return {
    db: {
      query: (text) => ({
        run: (...bound) => {
          const before = count("total_changes()");
          sql.exec(text, ...bind(bound)).toArray();

          return {
            changes: count("total_changes()") - before,
            lastInsertRowid: count("last_insert_rowid()"),
          };
        },
        get: (...bound) => sql.exec(text, ...bind(bound)).toArray()[0] ?? null,
        all: (...bound) => sql.exec(text, ...bind(bound)).toArray(),
        values: (...bound) => [...sql.exec(text, ...bind(bound)).raw()],
      }),
      run: (text) => {
        sql.exec(text).toArray();
      },
    },
    write: (fn) => {
      if (writing) {
        return fn();
      }

      writing = true;

      try {
        return storage.transactionSync(fn);
      } finally {
        writing = false;
      }
    },
  };
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// hex's records in a Durable Object's storage. It starts empty and takes its records from a hex.db once (store/move.ts); from then on it migrates itself as a file does, counting its migrations in a table, since an object refuses pragma user_version.
export function recordsIn(storage: Storage, dir = "") {
  const { sql } = storage;
  const core = sqlOver(storage);
  let records: Domains | undefined;
  let answer: ReturnType<typeof answering> | undefined;

  const run = (text: string, ...bound: unknown[]) => sql.exec(text, ...bound).toArray();
  const home = () => HomeRow.parse(run("select version, tenure, served from _home")[0]);
  const changes = () => Count.parse(run("select total_changes() as n")[0]).n;

  const ready = () => {
    const made = domains(core);

    migrate(
      core,
      made,
      {
        get: () => home()?.version ?? 0,
        set: (version) => {
          run("update _home set version = ?", version);
        },
      },
      dir,
    );

    records = made;
    answer = answering(made);
  };

  run(
    "create table if not exists _home (one integer primary key check (one = 1), version integer not null, tenure integer not null default 0, served integer not null default 0)",
  );

  if (run("select 1 from pragma_table_info('_home') where name = 'served'").length === 0) {
    run("alter table _home add column served integer not null default 0");
  }

  if (home() !== undefined) {
    ready();
  }

  const drop = () => {
    for (const { type, name } of Leftovers.parse(
      run(
        "select type, name from sqlite_master where name not like 'sqlite_%' and substr(name, 1, 1) <> '_' and type in ('table', 'trigger', 'index') and sql is not null order by type = 'table'",
      ),
    )) {
      run(`drop ${type} if exists "${name}"`);
    }

    run("delete from _home");
    records = undefined;
    answer = undefined;
  };

  return {
    core,
    records: () => records,
    migrations: () => home()?.version ?? null,

    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // A hub says which tenure of its lease it runs on. One on an older tenure than the object has seen lost hex to another machine, whether or not it knows yet, so nothing it sends is taken.
    lostTo(tenure: number | undefined): string | undefined {
      const seen = home()?.tenure ?? 0;

      if (tenure === undefined || tenure === seen) {
        return;
      }

      if (tenure < seen) {
        return `tenure ${tenure} no longer holds hex: tenure ${seen} does`;
      }

      run("update _home set tenure = ?", tenure);
    },

    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // Each call is one write: one that fails leaves nothing of itself behind.
    call(text: string): Called {
      if (answer === undefined) {
        return {
          reply: { error: "hex's store is empty: hex store move brings a hex.db into it" },
          wrote: false,
        };
      }

      if (home()?.served === 0) {
        run("update _home set served = 1");
      }

      const answered = answer;
      const before = changes();
      let reply: Reply = { error: "the call didn't run" };

      try {
        core.write(() => {
          reply = answered(text);

          if ("error" in reply) {
            throw new UndoneError();
          }
        });
      } catch (error) {
        if (!(error instanceof UndoneError)) {
          throw error;
        }

        return { reply, wrote: false };
      }

      return { reply, wrote: changes() !== before };
    },

    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // A query whose every change is undone, so an agent can read the records with SQL and never write them.
    read(body: string): unknown[] {
      const { text, bound } = Query.parse(JSON.parse(body));
      onlyReading(text);
      let rows: unknown[] = [];

      try {
        storage.transactionSync(() => {
          rows = run(text, ...bound);

          throw new UndoneError();
        });
      } catch (error) {
        if (!(error instanceof UndoneError)) {
          throw error;
        }
      }

      return rows;
    },

    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // A hex.db arrives in steps: its tables, then their rows as they are, then its indexes and triggers, so no trigger fires on a row that was already written, and last the migration it had reached. Rows arrive table by table with foreign keys off, and arrived checks them all. Until a hub has made a call, a move can start over (begin), or tell what it left (state), so one whose last reply was lost is finished by comparing again; after that nothing empties the object.
    moved(step: string, body: string): Moved {
      const { served = 0, version } = home() ?? {};

      if (step === "state") {
        return { arrived: records !== undefined, served: served === 1, version: version ?? null };
      }

      if (served === 1) {
        throw new Error(
          "hex's store has served a hub, so nothing moves into it: move into an object of a new name",
        );
      }

      if (step === "begin") {
        run("pragma foreign_keys = off");
        drop();

        return true;
      }

      if (records !== undefined) {
        throw new Error("hex's store has records already: a move starts over from move/begin");
      }

      run("pragma foreign_keys = off");

      if (step === "schema") {
        for (const statement of Statements.parse(JSON.parse(body)).statements) {
          run(statement);
        }

        return true;
      }

      if (step === "rows") {
        const { table, columns, rows } = Rows.parse(JSON.parse(body));
        const insert = `insert into "${table}" (${columns.map((column) => `"${column}"`).join(", ")}) values (${columns.map(() => "?").join(", ")})`;

        storage.transactionSync(() => {
          for (const row of rows) {
            run(insert, ...row);
          }
        });

        return rows.length;
      }

      if (step === "arrived") {
        const { version: reached } = Arrived.parse(JSON.parse(body));
        run("pragma foreign_keys = on");
        const broken = run("pragma foreign_key_check");

        if (broken.length > 0) {
          throw new Error(
            `${broken.length} rows name a row that isn't there: ${JSON.stringify(broken[0])}`,
          );
        }

        run("insert into _home (one, version) values (1, ?)", reached);
        ready();

        return true;
      }

      throw new Error(`hex's store has no move/${step}`);
    },
  };
}
