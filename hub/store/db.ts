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

export function clause(terms: (false | [string, ...string[]])[]): [string, string[]] {
  const kept = terms.filter((term) => term !== false);

  return [
    kept.length > 0 ? `where ${kept.map(([condition]) => condition).join(" and ")}` : "",
    kept.flatMap(([, ...values]) => values),
  ];
}
