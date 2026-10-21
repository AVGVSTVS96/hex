import type { Row, Store } from './store.ts'

// A note about something the owner said keeps their words: the ones it rests on in double quotes,
// copied from their message, and the message's key in brackets. hex.db keeps every message word
// for word, so whether a note quotes or rewords them can be checked rather than trusted.

export const keysOf = (note: string) => [...note.matchAll(/\[([a-z0-9]+:[^\]\s]+)\]/g)].map(([, key]) => key!)
export const quotesOf = (note: string) => [...note.matchAll(/["“]([^"“”]+)["”]/g)].map(([, words]) => words!)

// Typing turns curly quotes straight and wraps lines, and a quote may leave words out with an ellipsis.
const plain = (text: string) => text.toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim()
function quotes(body: string, words: string) {
  const parts = plain(words).split(/\s*(?:\.\.\.|…)\s*/).filter(part => /[\p{L}\p{N}]/u.test(part))
  if (!parts.length) return false
  let at = 0
  for (const part of parts) {
    at = plain(body).indexOf(part, at)
    if (at < 0) return false
    at += part.length
  }
  return true
}

export type Verdict = { keys: Row[]; unknown: string[]; unquoted: string[]; quoted: boolean }

export function verdict(note: string, store: Store): Verdict {
  const keys = keysOf(note)
  const found = keys.map(key => store.message(key)).filter((row): row is Row => !!row)
  const words = quotesOf(note)
  return {
    keys: found,
    unknown: keys.filter(key => !found.some(row => row.key === key)),
    unquoted: words.filter(each => !found.some(row => quotes(row.body, each))),
    quoted: words.length > 0,
  }
}

export const holds = (v: Verdict) => v.keys.length > 0 && !v.unknown.length && !v.unquoted.length && v.quoted

// Why a keyed note doesn't hold, said so the session can fix it in its next call.
export function problems(v: Verdict, withWords = true): string[] {
  const shown = v.keys.map(row => `[${row.key}] says:\n${clip(row.body, 1500)}`)
  return [
    ...v.unknown.map(key => `[${key}] isn't a message hex keeps. A message's key is the \`key\` on its channel tag.`),
    ...v.unquoted.map(words => `"${words}" isn't in ${v.keys.map(row => `[${row.key}]`).join(' or ') || 'any message the note names'} as written.`),
    ...(v.keys.length && !v.quoted ? ['The note names a message without quoting it.'] : []),
    ...(withWords && (v.unquoted.length || !v.quoted) ? shown : []),
  ]
}

// The owner's messages: from a chat app with their user id, typed or answered in the hex app or on a
// call, and a call's transcript, which carries the call's delegation_id.
export const owners = (rows: Row[]) =>
  rows.filter(row => row.meta?.user_id || /^hex (app|call)$/.test(row.meta?.user ?? '') || (row.from === 'voice' && row.meta?.delegation_id))

export const clip = (text: string, size: number) => (text.length > size ? `${text.slice(0, size)}…` : text)
