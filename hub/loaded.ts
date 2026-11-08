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

// What Claude Code reads from hex only as a session's process starts: which hooks run, the skills it
// lists, and the flags hex's launcher gives it. A restart or resume reads them again; compacting doesn't.
export const STARTUP = { hooks: 'plugin/hooks/hooks.json', skills: 'plugin/skills', launcher: 'bin/session' }
export type Startup = keyof typeof STARTUP

// Which of those changed since a session started (ms): the commit hex ran then, from git's record of
// each update (the reflog), against the one it runs now. Nothing when they're the same, or git can't say.
export function behind(hex: string, started: number): { from: string; to: string; changed: Startup[] } | undefined {
  const git = (...args: string[]) => Bun.spawnSync(['git', '-C', hex, ...args], { stderr: 'ignore' }).stdout.toString().trim()
  const moves = [...git('log', '-g', '--format=%H %gd', '--date=unix', 'HEAD').matchAll(/^(\w+) HEAD@\{(\d+)\}$/gm)]
  if (!moves.length) return
  const to = git('rev-parse', 'HEAD')
  const from = moves.find(([, , at]) => Number(at) * 1000 <= started)?.[1]
  // Older than git's record of hex, so older than every change it holds.
  const names = git(...(from ? ['diff', '--name-only', from, to] : ['ls-tree', '-r', '--name-only', to]), '--', ...Object.values(STARTUP)).split('\n')
  const changed = (Object.keys(STARTUP) as Startup[]).filter(key => names.some(name => name === STARTUP[key] || name.startsWith(`${STARTUP[key]}/`)))
  return changed.length ? { from: from ?? '', to, changed } : undefined
}
