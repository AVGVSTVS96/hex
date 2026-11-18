import { z } from "zod";

import { eachVariable, onlyReading } from "./db.ts";
import type { Core } from "./db.ts";
import { domains, migrate, OffersJson, unmet } from "./domains.ts";
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
  .object({ version: z.number(), tenure: z.number(), served: z.number(), lease: z.number() })
  .optional();

const Claim = z.object({
  claimant: z.string().min(1).max(100),
  needs: OffersJson.optional(),
  lease: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});

const Claimed = z.object({ tenure: z.number() }).optional();

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The claims kept, so one that arrives again (a retry, or a request the network held back) is known by its claimant; older ones go.
const CLAIMS_KEPT = 100;

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

type Step = { id: string; step: number };

type Moved =
  | boolean
  | number
  | { arrived: boolean; served: boolean; version: number | null; moving: Step | null };

const Moving = z.object({ id: z.string(), step: z.number() }).optional();

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A Durable Object binds every number as a double, where Bun binds a whole one as an integer, so a whole number is cast back, and a record keeps one type in either home: the move compares them.
function bindable(text: string, values: unknown[]): [string, unknown[]] {
  const { text: cast } = eachVariable(text, (index) =>
    Number.isSafeInteger(values[index - 1]) ? `cast(?${index} as integer)` : `?${index}`,
  );

  return [
    cast,
    values.map((value) =>
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a closed union; this picks the two members a Durable Object's SQL refuses
      typeof value === "boolean" || typeof value === "bigint" ? Number(value) : value,
    ),
  ];
}

const exec = (sql: Storage["sql"], text: string, values: unknown[]) => {
  const [cast, bind] = bindable(text, values);

  return values.length === 0 ? sql.exec(text) : sql.exec(cast, ...bind);
};

type Run = (
  text: string,
  ...values: unknown[]
) => ReturnType<ReturnType<Storage["sql"]["exec"]>["toArray"]>;

type HomeNow = NonNullable<z.infer<typeof HomeRow>>;

function claimed(run: Run, now: HomeNow, claimant: string, lease: number | undefined) {
  const before = Claimed.parse(run("select tenure from _claims where claimant = ?", claimant)[0]);

  if (before !== undefined) {
    return before.tenure === now.tenure
      ? { tenure: now.tenure }
      : { lost: `tenure ${before.tenure} no longer holds hex: tenure ${now.tenure} does` };
  }

  if (lease === undefined && now.lease > 0) {
    return {
      lost: `hex runs under lease ${now.lease}: start it with HEX_STORE_LEASE, or end the lease with hex store lease clear`,
    };
  }

  if (lease !== undefined && lease < now.lease) {
    return { lost: `lease ${lease} no longer holds hex: lease ${now.lease} does` };
  }

  const tenure = now.tenure + 1;
  run("update _home set tenure = ?, lease = ?, served = 1", tenure, lease ?? 0);
  run("insert into _claims (claimant, tenure) values (?, ?)", claimant, tenure);
  run("delete from _claims where tenure <= ?", tenure - CLAIMS_KEPT);

  return { tenure };
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A step that arrives again, sent again after its answer was lost or held back by the network, has landed already.
const landedBefore = (moving: Step | null, mark: Step | undefined) =>
  mark !== undefined && moving?.id === mark.id && mark.step <= moving.step;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Each step of a move lands whole with the mark that says it did; foreign keys are set outside it, since SQLite ignores the pragma inside a transaction.
function landingOf(storage: Storage, mark: Step | undefined) {
  return <T>(work: () => T): T =>
    storage.transactionSync(() => {
      const done = work();

      if (mark !== undefined) {
        exec(
          storage.sql,
          "insert into _moving (one, id, step) values (1, ?, ?) on conflict (one) do update set id = excluded.id, step = excluded.step",
          [mark.id, mark.step],
        ).toArray();
      }

      return done;
    });
}

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
          exec(sql, text, bound).toArray();

          return {
            changes: count("total_changes()") - before,
            lastInsertRowid: count("last_insert_rowid()"),
          };
        },
        get: (...values) => exec(sql, text, values).toArray()[0] ?? null,
        all: (...values) => exec(sql, text, values).toArray(),
        values: (...values) => [...exec(sql, text, values).raw()],
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

  const run = (text: string, ...values: unknown[]) => exec(sql, text, values).toArray();
  const home = () => HomeRow.parse(run("select version, tenure, served, lease from _home")[0]);
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
    answer = answering(made, true);
  };

  run(
    "create table if not exists _home (one integer primary key check (one = 1), version integer not null, tenure integer not null default 0, served integer not null default 0, lease integer not null default 0)",
  );

  run(
    "create table if not exists _moving (one integer primary key check (one = 1), id text not null, step integer not null)",
  );
  run(
    "create table if not exists _claims (claimant text primary key, tenure integer not null unique)",
  );

  for (const column of ["served", "lease"]) {
    if (run("select 1 from pragma_table_info('_home') where name = ?", column).length === 0) {
      run(`alter table _home add column ${column} integer not null default 0`);
    }
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
    // A hub sends the tenure the object gave it when it claimed hex. Only the last one given holds: a hub on any other lost hex, whether or not it knows yet, so nothing it sends is taken. What isn't one the object gave is never kept.
    lostTo(tenure: string | undefined): string | undefined {
      const seen = home()?.tenure ?? 0;

      if (tenure === undefined || tenure === String(seen)) {
        return;
      }

      const said = JSON.stringify(tenure.slice(0, 20));

      return /^\d{1,15}$/u.test(tenure) && Number(tenure) < seen
        ? `tenure ${tenure} no longer holds hex: tenure ${seen} does`
        : `tenure ${said} isn't one hex's store gave out: tenure ${seen} holds hex`;
    },

    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // A hub taking over gets the next tenure, so every hub that claimed before it is refused from then on. A process's claim that arrives again gets its tenure again while it still holds hex, and is refused once another has claimed since, so a claim the network held back never takes hex from a later one. A lease tool's number, when one passes hex between machines, can't go back: a hub on a lower lease than one seen is refused, one on the same lease (its machine's hub restarted) isn't. A hub with no lease runs hex outside any lease from then on, so a hex can stop using a lease tool.
    claim(
      body: string,
    ): { tenure: number } | { lost: string } | { empty: string } | { other: string } {
      const { claimant, lease, needs } = Claim.parse(JSON.parse(body));
      const now = home();
      const lacking = needs === undefined ? undefined : unmet(needs);

      if (lacking !== undefined) {
        return {
          other: `hex's store runs an older hex's code than this one: ${lacking}. Deploy this hex's with hex store deploy`,
        };
      }

      if (now === undefined || records === undefined) {
        return { empty: "hex's store is empty: hex store move brings a hex.db into it" };
      }

      return claimed(run, now, claimant, lease);
    },

    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // The owner ends hex's lease, for a hex that no longer runs under a lease tool: a hub with no lease can claim it from then on.
    unlease() {
      run("update _home set lease = 0");
    },

    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // Each call is one write: one that fails leaves nothing of itself behind.
    call(text: string): Called {
      if (answer === undefined) {
        return {
          reply: {
            error: "hex's store is empty: hex store move brings a hex.db into it",
            every: true,
          },
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
          rows = sql.exec(text, ...bound).toArray();

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
    moved(step: string, body: string, mark?: Step): Moved {
      const { served = 0, version } = home() ?? {};
      const moving = Moving.parse(run("select id, step from _moving")[0]) ?? null;

      if (step === "state") {
        return {
          arrived: records !== undefined,
          served: served === 1,
          version: version ?? null,
          moving,
        };
      }

      if (served === 1) {
        throw new Error(
          "hex's store has served a hub, so nothing moves into it: move into an object of a new name",
        );
      }

      if (landedBefore(moving, mark)) {
        return true;
      }

      const landing = landingOf(storage, mark);

      if (step !== "begin" && records !== undefined) {
        throw new Error("hex's store has records already: a move starts over from move/begin");
      }

      run("pragma foreign_keys = off");

      if (step === "begin") {
        landing(drop);

        return true;
      }

      if (step === "schema") {
        landing(() => {
          for (const statement of Statements.parse(JSON.parse(body)).statements) {
            run(statement);
          }
        });

        return true;
      }

      if (step === "rows") {
        const { table, columns, rows } = Rows.parse(JSON.parse(body));
        const insert = `insert into "${table}" (${columns.map((column) => `"${column}"`).join(", ")}) values (${columns.map(() => "?").join(", ")})`;

        landing(() => {
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

        landing(() => run("insert into _home (one, version) values (1, ?)", reached));
        ready();

        return true;
      }

      throw new Error(`hex's store has no move/${step}`);
    },
  };
}
