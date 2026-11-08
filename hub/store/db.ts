import type { Database } from "bun:sqlite";

import { z } from "zod";

export type Write = <T>(fn: () => T) => T;

export type Core = { db: Database; write: Write };

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
