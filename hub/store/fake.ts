import { Database } from "bun:sqlite";

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

const SEVERAL_STATEMENTS = /;\s*\S/u;

// A Durable Object's storage, as far as the store uses it, over a SQLite file, for tests: Cloudflare's runtime is the same SQLite behind this API (https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), with foreign keys on.
export function objectStorage(file = ":memory:"): Storage {
  const db = new Database(file, { create: true });
  db.run("pragma foreign_keys = on");

  const ILLEGAL =
    "Illegal invocation: function called with incorrect `this` reference. See https://developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors for details.";

  const sql: Storage["sql"] = {
    exec(query, ...bound) {
      if (this !== sql) {
        throw new TypeError(ILLEGAL);
      }

      for (const [refused, why] of REFUSED) {
        if (refused.test(query)) {
          throw new Error(why);
        }
      }

      if (bound.length === 0 && SEVERAL_STATEMENTS.test(query)) {
        db.run(query);

        return { toArray: () => [], raw: () => [] };
      }

      // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- rows as SQLite gives them, which each domain parses where it reads them
      const statement = db.query<Record<string, unknown>, never[]>(query);
      // SAFETY: what the store binds is what SQLite takes
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what the store binds is what SQLite takes
      const values = bound as never[];
      const rows = statement.all(...values);

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
