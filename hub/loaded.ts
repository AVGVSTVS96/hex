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
// lists, and the flags hex's launcher (bin/session, and what it runs) works out for it. A restart or
// resume reads them again; compacting doesn't.
export const STARTUP = { hooks: 'plugin/hooks/hooks.json', skills: 'plugin/skills', launcher: ['bin/session', 'bin/identity', 'bin/instructions', 'bin/chat', 'hub/loaded.ts', 'hub/fit.ts'] }
export type Startup = keyof typeof STARTUP

// hex's updates as git records them (the reflog), read once. Its times are whole seconds, so an
// update in the second a session started counts as after it; a start older than the record, or
// unknown, has no commit, since git can't say what that session started on. Without git, it knows nothing.
export function history(hex: string) {
  const git = (...args: string[]) => {
    try {
      return Bun.spawnSync(['git', '-C', hex, '-c', 'core.quotePath=false', ...args], { stderr: 'ignore' }).stdout.toString().trim()
    } catch {
      return ''
    }
  }
  const moves = [...git('log', '-g', '--format=%H %gd', '--date=unix', 'HEAD').matchAll(/^(\w+) HEAD@\{(\d+)\}$/gm)]
  const head = moves.length ? git('rev-parse', 'HEAD') : ''
  const diffs = new Map<string, Startup[]>()
  return {
    head,
    on: (started?: number) => (started ? moves.find(([, , at]) => (Number(at) + 1) * 1000 <= started)?.[1] : undefined),
    changed(from: string): Startup[] {
      if (!diffs.has(from)) {
        const names = git('diff', '--name-only', from, head, '--', ...Object.values(STARTUP).flat()).split('\n')
        diffs.set(from, (Object.keys(STARTUP) as Startup[]).filter(key => [STARTUP[key]].flat().some(path => names.some(name => name === path || name.startsWith(`${path}/`)))))
      }
      return diffs.get(from)!
    },
  }
}
