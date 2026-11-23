import { Database } from "bun:sqlite";
import { renameSync, rmSync } from "node:fs";

import { z } from "zod";

const ROWS_AT_ONCE = 500;
const BYTES_AT_ONCE = 4_000_000;

const Objects = z.array(z.object({ type: z.string(), name: z.string(), sql: z.string() }));
const Columns = z.array(z.object({ name: z.string(), type: z.string(), pk: z.number() }));
const Counters = z.array(z.object({ name: z.string().regex(/^\w+$/u), seq: z.number().int() }));
const Version = z.object({ version: z.number().int() });
const Cell = z.union([z.string(), z.number(), z.null()]);
const Rows = z.array(z.record(z.string(), Cell));
const Sizes = z.array(z.object({ rowid: z.number(), size: z.number() }));

export type Read = (text: string) => Promise<unknown[]>;

type Row = z.infer<typeof Rows>[number];

type Table = { name: string; sql: string; columns: string[]; carried: string[] };

const quoted = (names: string[]) => names.map((name) => `"${name}"`).join(", ");

const references = (sql: string, name: string) =>
  new RegExp(`references\\s+"?${name}"?\\s*\\(`, "iu").test(sql);

function referencingFirst<T extends { name: string; sql: string }>(made: T[]): T[] {
  const ordered: T[] = [];
  const left = [...made];

  while (left.length > 0) {
    const next =
      left.find((table) =>
        left.every((other) => other === table || !references(other.sql, table.name)),
      ) ?? left[0];

    if (next === undefined) {
      break;
    }

    ordered.push(next);
    left.splice(left.indexOf(next), 1);
  }

  return ordered;
}

export async function layout(read: Read) {
  const objects = Objects.parse(
    await read(
      "select type, name, sql from sqlite_master where sql is not null and name not like 'sqlite_%' and substr(name, 1, 1) <> '_' order by rowid",
    ),
  );

  const made = objects.filter(({ type }) => type === "table");
  const tables: Table[] = [];

  for (const { name, sql } of referencingFirst(made)) {
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
  const sizes = Sizes.parse(
    await read(
      `select rowid as "rowid", ${columns
        .filter((column) => column !== "rowid")
        .map((column) => `coalesce(length(cast("${column}" as blob)), 0)`)
        .join(
          " + ",
        )} as size from "${name}" where rowid > ${after} order by rowid limit ${ROWS_AT_ONCE}`,
    ),
  );

  let bytes = 0;
  let upTo: number | undefined;

  for (const { rowid, size } of sizes) {
    if (upTo !== undefined && bytes + size > BYTES_AT_ONCE) {
      break;
    }

    bytes += size;
    upTo = rowid;
  }

  if (upTo === undefined) {
    return { rows: [], last: undefined };
  }

  const rows = Rows.parse(
    await read(
      `select ${columns.map((column) => (column === "rowid" ? 'rowid as "rowid"' : `"${column}"`)).join(", ")} from "${name}" where rowid > ${after} and rowid <= ${upTo} order by rowid`,
    ),
  );

  return { rows, last: upTo };
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

export async function bring(read: Read, to: string) {
  const part = `${to}.part`;
  rmSync(part, { force: true });
  const db = new Database(part, { create: true, strict: true });

  try {
    const { tables } = await layout(read);

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

    const { indexesAndTriggers, setCounters: countersReadAfterTheRows } = await layout(read);

    for (const statement of [...countersReadAfterTheRows, ...indexesAndTriggers]) {
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

    db.close();
    renameSync(part, to);
  } catch (error) {
    db.close();
    rmSync(part, { force: true });

    throw error;
  }
}

export async function difference(
  here: Read,
  there: Read,
  say: (line: string) => void,
): Promise<string | undefined> {
  const mine = await layout(here);
  const theirs = await layout(there);

  const schema = ({ tables, indexesAndTriggers }: typeof mine) =>
    JSON.stringify([tables.map(({ sql }) => sql), indexesAndTriggers]);

  if (schema(mine) !== schema(theirs)) {
    return "the tables, indexes or triggers differ";
  }

  for (const table of mine.tables) {
    let same = 0;
    const its = pages(there, table);

    for await (const rows of pages(here, table)) {
      const theirRows = await its.next();

      if (JSON.stringify(rows) !== JSON.stringify(theirRows.value)) {
        return `${table.name} differs after ${same} rows`;
      }

      same += rows.length;
    }

    if ((await its.next()).done !== true) {
      return `${table.name} has more rows in one than the other`;
    }

    const typesPerColumn = `select ${table.columns.map((column) => `typeof("${column}")`).join(" || ',' || ")} as types, count(*) as n from "${table.name}" group by 1 order by 1`;

    if (
      JSON.stringify(await here(typesPerColumn)) !== JSON.stringify(await there(typesPerColumn))
    ) {
      return `${table.name} holds values of other types`;
    }

    say(`${table.name}: ${same} rows the same`);
  }

  if (JSON.stringify(mine.counters) !== JSON.stringify(theirs.counters)) {
    return "the autoincrement counters differ";
  }
}
