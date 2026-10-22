import { readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'

// AGENTS.md as Claude Code loads it: the file, then each `@path` it imports outside code
// (relative to the importing file, `~/` for home), five levels deep at most. The wake HEX.md
// imports is memory, rewritten after every turn, not instructions: it's left out.
export const WAKE = 'state/wake/CLAUDE.md'
export function loaded(file: string, seen = new Set<string>(), depth = 0, read = (path: string) => readFileSync(path, 'utf8')): [string, string][] {
  if (seen.has(file) || depth > 5 || file.endsWith(`/${WAKE}`)) return []
  seen.add(file)
  let text
  try {
    text = read(file)
  } catch {
    return []
  }
  const prose = text.replace(/^(`{3,})[^]*?^\1`*$/gm, '').replace(/`[^`\n]*`/g, '')
  const imports = [...prose.matchAll(/(?:^|\s)@(\S+)/g)].map(([, target]) => target!.startsWith('~/') ? join(homedir(), target!.slice(2)) : resolve(dirname(file), target!))
  return [[file, text], ...imports.flatMap(target => loaded(target, seen, depth + 1, read))]
}
