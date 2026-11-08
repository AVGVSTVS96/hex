import { spoken } from "./store.ts";
import type { Row, Store } from "./store.ts";

export const keysOf = (note: string) =>
  [...note.matchAll(/\[([a-z0-9]+:[^\]\s]+)\]/gu)].map(([, key = ""]) => key);

export const quotesOf = (note: string) =>
  [...note.matchAll(/["“]([^"“”]+)["”]/gu)].map(([, words = ""]) => words);

const asTyped = (text: string) =>
  text
    .toLowerCase()
    .replaceAll(/[‘’ʼ]/gu, "'")
    .replaceAll(/[“”]/gu, '"')
    .replaceAll(/\s+/gu, " ")
    .trim();

const ELLIPSIS = /\s*(?:\.\.\.|…)\s*/u;

const matchesAlmostAnyMessage = (words: string) => !/[\p{L}\p{N}]/u.test(words);

function quotes(body: string, words: string) {
  if (matchesAlmostAnyMessage(words)) {
    return false;
  }

  const parts = asTyped(words).split(ELLIPSIS).filter(Boolean);

  if (!parts.length) {
    return false;
  }

  let at = 0;

  for (const part of parts) {
    at = asTyped(body).indexOf(part, at);

    if (at < 0) {
      return false;
    }

    at += part.length;
  }

  return true;
}

export type Verdict = { keys: Row[]; unknown: string[]; unquoted: string[]; quoted: boolean };

export function verdict(note: string, store: Store): Verdict {
  const keys = keysOf(note);
  const found = keys.map((key) => store.messages.get(key)).filter((row): row is Row => !!row);
  const words = quotesOf(note);

  return {
    keys: found,
    unknown: keys.filter((key) => !found.some((row) => row.key === key)),
    unquoted: words.filter((each) => !found.some((row) => quotes(spoken(row) || row.body, each))),
    quoted: words.length > 0,
  };
}

export const holds = (v: Verdict) =>
  v.keys.length > 0 && !v.unknown.length && !v.unquoted.length && v.quoted;

export function problems(v: Verdict, withWords = true): string[] {
  const shown = v.keys.map((row) => `[${row.key}] says:\n${cutKeepingEveryLine(row.body, 1500)}`);

  return [
    ...v.unknown.map(
      (key) =>
        `[${key}] isn't a message hex keeps. A message's key is the \`key\` on its channel tag.`,
    ),
    ...v.unquoted.map((words) =>
      matchesAlmostAnyMessage(words)
        ? `"${words}" holds no words; a quote is the owner's words.`
        : `"${words}" isn't in ${v.keys.map((row) => `[${row.key}]`).join(" or ") || "any message the note names"} as written.`,
    ),
    ...(v.keys.length && !v.quoted ? ["The note names a message without quoting it."] : []),
    ...(withWords && (v.unquoted.length || !v.quoted) ? shown : []),
  ];
}

export const owners = (rows: Row[]) => rows.filter((row) => spoken(row));

const cutKeepingEveryLine = (text: string, maxLength: number) =>
  text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;

export { cutKeepingEveryLine as cut };
