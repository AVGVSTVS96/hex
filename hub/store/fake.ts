import { Database } from "bun:sqlite";

import { z } from "zod";

import { bare, eachVariable } from "./db.ts";
import type { Storage } from "./storage.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What a Durable Object's SQLite refuses, as its runtime answers (workerd 2026-08): transactions are the storage's own, and the pragmas and functions that tell of the file under it are not for the object's code.
const REFUSED: [RegExp, string][] = [
  [
    /^\s*(begin|commit|end|rollback|savepoint|release)\b/iu,
    "To execute a transaction, please use the state.storage.transaction() or state.storage.transactionSync() APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements.",
  ],
  [
    /^\s*pragma\s+(user_version|journal_mode|integrity_check|busy_timeout|synchronous|wal_checkpoint|wal_autocheckpoint|page_count|page_size|writable_schema)\b/iu,
    "not authorized: SQLITE_AUTH",
  ],
  [/\bsqlite_version\s*\(/iu, "not authorized to use function: sqlite_version: SQLITE_ERROR"],
  [/^\s*(attach|detach|vacuum)\b/iu, "not authorized: SQLITE_AUTH"],
];

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The runtime's limits, measured on it: 100 variables in a statement, 100,000 bytes of statement, and 2,200,000 bytes in a value or a row.
const MOST_VARIABLES = 100;
const LONGEST_STATEMENT = 100_000;
const LONGEST_ROW = 2_200_000;

const ILLEGAL =
  "Illegal invocation: function called with incorrect `this` reference. See https://developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors for details.";

const Sized = z.union([z.string(), z.instanceof(Uint8Array)]);

const bytes = (sized: z.infer<typeof Sized> | undefined) =>
  sized === undefined
    ? 0
    : // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the two members of Sized
      typeof sized === "string"
      ? Buffer.byteLength(sized)
      : sized.byteLength;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Where each statement of some SQL ends: at a semicolon outside its strings and comments, and a trigger's at the end of its body.
function split(query: string): string[] {
  const code = bare(query);
  const statements: string[] = [];
  let from = 0;

  for (let at = code.indexOf(";"); at !== -1; at = code.indexOf(";", at + 1)) {
    const statement = code.slice(from, at);

    if (
      !/^\s*create\s+(temp\s+|temporary\s+)?trigger\b/iu.test(statement) ||
      /\bend\s*$/iu.test(statement)
    ) {
      statements.push(query.slice(from, at));
      from = at + 1;
    }
  }

  statements.push(query.slice(from));

  return statements.filter((statement) => bare(statement).trim() !== "");
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The runtime binds every number as a double, as JavaScript holds it, and a boolean as its word: a statement here is given the same.
function asTheRuntimeBinds(statement: string, bound: unknown[]): [string, unknown[]] {
  const { text, most } = eachVariable(statement, (index) =>
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the members of what was bound that the runtime turns into doubles
    typeof bound[index - 1] === "number" ? `cast(?${index} as real)` : `?${index}`,
  );

  if (most > MOST_VARIABLES) {
    throw new Error(`too many SQL variables at offset ${statement.length}: SQLITE_ERROR`);
  }

  if (
    bound.reduce<number>((sum, value) => sum + bytes(Sized.safeParse(value).data), 0) > LONGEST_ROW
  ) {
    throw new Error("string or blob too big: SQLITE_TOOBIG");
  }

  return [
    text,
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the member of what was bound that the runtime turns into its word
    bound.map((value) => (typeof value === "boolean" ? String(value) : value)),
  ];
}

// A Durable Object's storage, as far as the store uses it, over a SQLite file, for tests: Cloudflare's runtime is the same SQLite behind this API (https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), with foreign keys on, and refuses here what it refuses there.
export function objectStorage(file = ":memory:"): Storage {
  const db = new Database(file, { create: true });
  db.run("pragma foreign_keys = on");

  const sql: Storage["sql"] = {
    exec(query, ...bound) {
      if (this !== sql) {
        throw new TypeError(ILLEGAL);
      }

      if (Buffer.byteLength(query) > LONGEST_STATEMENT) {
        throw new Error("statement too long: SQLITE_TOOBIG");
      }

      const statements = split(query);

      for (const statement of statements) {
        for (const [refused, why] of REFUSED) {
          if (refused.test(statement)) {
            throw new Error(why);
          }
        }
      }

      const last = statements.pop() ?? "";

      if (bound.length > 0 && statements.length > 0) {
        throw new Error(
          "When executing multiple SQL statements in a single call, only the last statement can have parameters.",
        );
      }

      for (const statement of statements) {
        db.run(statement);
      }

      const [text, values] = asTheRuntimeBinds(last, bound);

      // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- rows as SQLite gives them, which each domain parses where it reads them
      const rows = db.query<Record<string, unknown>, never[]>(text).all(
        // SAFETY: what the store binds is what SQLite takes
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what the store binds is what SQLite takes
        ...(values as never[]),
      );

      return { toArray: () => rows, raw: () => rows.map((row) => Object.values(row)) };
    },
  };

  const storage: Storage = {
    sql,
    transactionSync(closure) {
      if (this !== storage) {
        throw new TypeError(ILLEGAL);
      }

      return db.transaction(closure)();
    },
  };

  return storage;
}
