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
  "ignore_check_constraints",
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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A statement with each of its variables (?, ?NNN) written as `as` says, numbered as SQLite numbers them, and the highest number.
export function eachVariable(statement: string, as: (index: number) => string) {
  let text = "";
  let from = 0;
  let most = 0;

  for (const variable of bare(statement).matchAll(/\?(\d*)/gu)) {
    const index = variable[1] === "" ? most + 1 : Number(variable[1]);
    most = Math.max(most, index);
    text += `${statement.slice(from, variable.index)}${as(index)}`;
    from = variable.index + variable[0].length;
  }

  return { text: `${text}${statement.slice(from)}`, most };
}

const PRAGMA = /^pragma\s+(?:\w+\s*\.\s*)?(\w+)\s*(\([^()]*\))?$/iu;
const READS = new Set(["select", "with", "values"]);

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A query for `hex sql`, refused unless it only reads: one statement, a select (with or values) or a pragma that reads, either of them explained or not. A home undoes whatever a query writes, but a pragma's setting outlives that.
export function onlyReading(text: string): string {
  const statements = bare(text)
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");

  if (statements.length !== 1) {
    throw new Error("hex sql takes one statement");
  }

  const [statement = ""] = statements;
  const asked = statement.replace(/^explain\s+(query\s+plan\s+)?/iu, "");
  const first = /^\w+/u.exec(asked)?.[0].toLowerCase() ?? "";

  if (first === "pragma") {
    const [, name = "", argument] = PRAGMA.exec(asked) ?? [];
    const lower = name.toLowerCase();

    if (!PRAGMAS_THAT_READ.has(lower) || (argument !== undefined && !TABLE_PRAGMAS.has(lower))) {
      throw new Error(
        "hex sql can change nothing, so it takes only a pragma that reads, like table_info(<table>)",
      );
    }
  } else if (!READS.has(first) || /\b(insert|update|delete|replace)\b/iu.test(asked)) {
    throw new Error("hex sql can change nothing, so it takes a select, or a pragma that reads");
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
