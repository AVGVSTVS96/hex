import { z } from "zod";

export type Bound = string | number | bigint | boolean | null;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The SQLite a store's home gives it: a file through bun:sqlite, or a Durable Object's own (store/object.ts). changes counts the rows a statement's triggers wrote too, as Bun's does.
/* oxlint-disable anti-slop/no-unknown-returns -- rows as SQLite gives them, which each domain parses where it reads them */
export type Sql = {
  query: (text: string) => {
    run: (...bound: Bound[]) => { changes: number; lastInsertRowid: number | bigint };
    get: (...bound: Bound[]) => unknown;
    all: (...bound: Bound[]) => unknown[];
    values: (...bound: Bound[]) => unknown[][];
  };
  run: (text: string) => void;
};
/* oxlint-enable anti-slop/no-unknown-returns -- end of SQLite's rows */

export type Write = <T>(fn: () => T) => T;

export type Core = { db: Sql; write: Write };

export type MessageId = number | string;

export function fromJson<T>(schema: z.ZodType<T>, text: string): T {
  return schema.parse(JSON.parse(text));
}

export const MessageIdColumn = z.union([z.number(), z.string()]);
export const TextOrNull = z.string().nullable();

export const TextOrAbsent = TextOrNull.transform((text) =>
  text === null || text === "" ? undefined : text,
);

export const KeyValues = z.array(z.tuple([z.string()]));

export const now = () => new Date().toISOString();

export function found<T>(value: T | null, id: string): T {
  if (value === null) {
    throw new Error(`no ${id}`);
  }

  return value;
}

const QUOTED = new Map([
  ["'", /'(?:[^']|'')*'?/suy],
  ['"', /"(?:[^"]|"")*"?/suy],
  ["`", /`(?:[^`]|``)*`?/suy],
  ["[", /\[[^\]]*\]?/suy],
]);

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// SQL as SQLite reads its words and punctuation: what its strings, quoted names and comments say is blanked, every character keeping its place.
export function bare(text: string): string {
  let out = "";

  for (let at = 0; at < text.length;) {
    const opening = text.charAt(at);
    const quoted = QUOTED.get(opening);

    if (quoted !== undefined) {
      quoted.lastIndex = at;
      const [whole = opening] = quoted.exec(text) ?? [];
      out +=
        whole.length < 2 ? whole : `${opening}${" ".repeat(whole.length - 2)}${whole.at(-1) ?? ""}`;
      at += whole.length;
    } else if (text.startsWith("--", at) || text.startsWith("/*", at)) {
      const end = text.startsWith("--", at) ? text.indexOf("\n", at) : text.indexOf("*/", at + 2);
      const stop = end === -1 ? text.length : end + (text.startsWith("--", at) ? 0 : 2);
      out += " ".repeat(stop - at);
      at = stop;
    } else {
      out += opening;
      at += 1;
    }
  }

  return out;
}

const TABLE_PRAGMAS = new Set([
  "table_info",
  "table_xinfo",
  "index_list",
  "index_info",
  "index_xinfo",
  "foreign_key_list",
  "foreign_key_check",
  "table_list",
]);

const PRAGMAS_THAT_READ = new Set([
  ...TABLE_PRAGMAS,
  "foreign_keys",
  "defer_foreign_keys",
  "recursive_triggers",
  "data_version",
  "schema_version",
  "application_id",
  "freelist_count",
  "compile_options",
  "function_list",
  "pragma_list",
  "collation_list",
  "database_list",
  "module_list",
]);

const PRAGMA = /^\s*pragma\s+(?:\w+\s*\.\s*)?(\w+)\s*(\([^()]*\))?\s*;?\s*$/iu;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A query for `hex sql`, refused unless it can change nothing that outlives it: one statement, no pragma that sets anything (a pragma's setting outlives the transaction a home undoes the rest in), and no other database file.
export function onlyReading(text: string): string {
  const code = bare(text);

  if (code.split(";").filter((statement) => statement.trim() !== "").length !== 1) {
    throw new Error("hex sql takes one statement");
  }

  const first = /^\s*(\w+)/u.exec(code)?.[1]?.toLowerCase();

  if (first === "attach" || first === "detach" || first === "vacuum") {
    throw new Error(`hex sql can change nothing, so it takes no ${first}`);
  }

  if (first === "pragma") {
    const [, name = "", argument] = PRAGMA.exec(code) ?? [];
    const lower = name.toLowerCase();

    if (!PRAGMAS_THAT_READ.has(lower) || (argument !== undefined && !TABLE_PRAGMAS.has(lower))) {
      throw new Error(
        "hex sql can change nothing, so it takes only a pragma that reads, like table_info(<table>)",
      );
    }
  }

  return text;
}

export function clause(terms: (false | [string, ...string[]])[]): [string, string[]] {
  const kept = terms.filter((term) => term !== false);

  return [
    kept.length > 0 ? `where ${kept.map(([condition]) => condition).join(" and ")}` : "",
    kept.flatMap(([, ...values]) => values),
  ];
}
