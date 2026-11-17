import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";

import { z } from "zod";

const ROWS_AT_ONCE = 500;
const BYTES_AT_ONCE = 4_000_000;

const Objects = z.array(z.object({ type: z.string(), name: z.string(), sql: z.string() }));
const Columns = z.array(z.object({ name: z.string(), type: z.string(), pk: z.number() }));
const Counters = z.array(z.object({ name: z.string().regex(/^\w+$/u), seq: z.number().int() }));
const Version = z.object({ version: z.number().int() });
const Cell = z.union([z.string(), z.number(), z.null()]);
const Rows = z.array(z.record(z.string(), Cell));

export type Read = (text: string) => Promise<unknown[]>;

type Row = z.infer<typeof Rows>[number];

type Table = { name: string; sql: string; columns: string[]; carried: string[] };

const quoted = (names: string[]) => names.map((name) => `"${name}"`).join(", ");

const references = (sql: string, name: string) =>
  new RegExp(`references\\s+"?${name}"?\\s*\\(`, "iu").test(sql);

const before = (a: { name: string; sql: string }, b: { name: string; sql: string }) =>
  Number(references(b.sql, a.name) && a.name !== b.name) -
  Number(references(a.sql, b.name) && a.name !== b.name);

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A database's tables as they travel, a table before any it references, so a copy made while hex writes never holds a row naming one that came after its table was read. Rows keep their rowid, which words' and task_agents' triggers and every autoincrement count on.
export async function layout(read: Read) {
  const objects = Objects.parse(
    await read(
      "select type, name, sql from sqlite_master where sql is not null and name not like 'sqlite_%' and substr(name, 1, 1) <> '_' order by rowid",
    ),
  );

  const made = objects.filter(({ type }) => type === "table");
  const names = made.map(({ name }) => name);

  const tables: Table[] = [];

  for (const { name, sql } of made.toSorted(
    (a, b) => before(a, b) || names.indexOf(a.name) - names.indexOf(b.name),
  )) {
    if (/without\s+rowid/iu.test(sql)) {
      throw new Error(`${name} has no rowid, which rows travel by`);
    }

    const columns = Columns.parse(await read(`pragma table_info("${name}")`));
    const keys = columns.filter(({ pk }) => pk > 0);
    const rowidIsAColumn = keys.length === 1 && keys[0]?.type.toLowerCase() === "integer";
    const carried = [...(rowidIsAColumn ? [] : ["rowid"]), ...columns.map((column) => column.name)];

    tables.push({
      name,
      sql,
      columns: ["rowid", ...columns.map((column) => column.name)],
      carried,
    });
  }

  const counters = made.some(({ sql }) => /autoincrement/iu.test(sql))
    ? Counters.parse(await read("select name, seq from sqlite_sequence order by name"))
    : [];

  return {
    tables,
    counters,
    indexesAndTriggers: objects.filter(({ type }) => type !== "table").map(({ sql }) => sql),
    setCounters: [
      ...(counters.length > 0 ? ["delete from sqlite_sequence"] : []),
      ...counters.map(
        ({ name, seq }) => `insert into sqlite_sequence (name, seq) values ('${name}', ${seq})`,
      ),
    ],
  };
}

async function page(read: Read, { name, columns }: Table, after: number) {
  const rows = Rows.parse(
    await read(
      `select ${columns.map((column) => (column === "rowid" ? 'rowid as "rowid"' : `"${column}"`)).join(", ")} from "${name}" where rowid > ${after} order by rowid limit ${ROWS_AT_ONCE}`,
    ),
  );

  return { rows, last: z.number().optional().parse(rows.at(-1)?.rowid) };
}

export async function* pages(read: Read, table: Table) {
  for (let after: number | undefined = 0; after !== undefined;) {
    const { rows, last } = await page(read, table, after);

    if (rows.length > 0) {
      yield rows;
    }

    after = last;
  }
}

export const carriedOf = ({ carried }: Table, row: Row) =>
  carried.map((column) => row[column] ?? null);

const insertInto = ({ name, carried }: Table) =>
  `insert into "${name}" (${quoted(carried)}) values (${carried.map(() => "?").join(", ")})`;

export function batches<T>(rows: T[]): T[][] {
  const out: T[][] = [[]];
  let bytes = 0;

  for (const row of rows) {
    const size = JSON.stringify(row).length;

    if (bytes + size > BYTES_AT_ONCE && out.at(-1)?.length !== 0) {
      out.push([]);
      bytes = 0;
    }

    out.at(-1)?.push(row);
    bytes += size;
  }

  return out.filter((batch) => batch.length > 0);
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Writes the records a store's home holds as a SQLite file a hex can run on: the nightly backup of a store that lives in an object, and the way back from one.
export async function bring(read: Read, to: string) {
  rmSync(to, { force: true });
  const db = new Database(to, { create: true, strict: true });

  try {
    const { tables, indexesAndTriggers, setCounters } = await layout(read);

    for (const { sql } of tables) {
      db.run(sql);
    }

    for (const table of tables) {
      const insert = db.query(insertInto(table));

      for await (const rows of pages(read, table)) {
        db.transaction(() => {
          for (const row of rows) {
            insert.run(...carriedOf(table, row));
          }
        })();
      }
    }

    for (const statement of [...setCounters, ...indexesAndTriggers]) {
      db.run(statement);
    }

    const [{ version } = { version: 0 }] = z
      .array(Version)
      .parse(await read("select version from _home"));

    db.run(`pragma user_version = ${version}`);

    const broken = db.query("pragma foreign_key_check").all();

    if (broken.length > 0) {
      throw new Error(`${broken.length} rows of the copy name a row that isn't in it`);
    }
  } finally {
    db.close();
  }
}
