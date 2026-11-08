#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { ROOM } from '../hub/fit.ts'
import { WAKE } from '../hub/loaded.ts'
import { loaded } from './identity'

// The instruction files Claude Code loads into a hex session, rendered the way it
// renders them. A DM or voice turn carries them at the end of its system prompt,
// where the cache reads them, and has Claude Code skip them (claudeMdExcludes),
// which also keeps them from its subagents, so SubagentStart hands them over here,
// a hook-sized part per hook, split at line ends.

const home = resolve(import.meta.dir, '../..')
const intro = 'The user\'s instruction files are below. Follow them as written; they take precedence over default behavior.'

export const files = () => [
  ...loaded(join(homedir(), '.claude/CLAUDE.md')).map(([path, text]) => ({ path, text, kind: "user's private global instructions for all projects" })),
  ...loaded(join(home, 'AGENTS.md')).map(([path, text]) => ({ path, text, kind: 'project instructions, checked into the codebase' })),
]

export const rules = () => Object.fromEntries(files().map(file => [file.path, file.text]))

const section = (file: { path: string; text: string; kind: string }) => `Contents of ${file.path} (${file.kind}):\n\n${file.text.trim()}`

export function rendered() {
  const all = files()
  return all.length ? [intro, ...all.map(section)].join('\n\n') : ''
}

// A hub thread's session loads these files and the wake from a copy in its own folder, written as
// it starts and as it compacts: Claude Code sends a file again whole on every resume once it has
// changed, and the wake changes after every turn. rules.json has the rules as the session last saw
// them, so bin/rules shows it what changed since, as a diff.
export function hold(dir: string) {
  const wake = join(home, WAKE)
  const memory = existsSync(wake) ? [{ path: wake, text: readFileSync(wake, 'utf8'), kind: 'memory' }] : []
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'CLAUDE.md'), `${[...files(), ...memory].map(section).join('\n\n')}\n`)
  writeFileSync(join(dir, 'rules.json'), JSON.stringify(rules()))
}

function parts(text: string) {
  const parts = ['']
  for (const line of text.split('\n')) {
    if (parts.at(-1) && parts.at(-1)!.length + line.length + 1 > ROOM) parts.push('')
    parts[parts.length - 1] += `${line}\n`
  }
  return parts
}

function subagent(n: number, last: boolean) {
  const all = parts(rendered())
  if (!all[n - 1]?.trim()) return
  const lead = all.length > 1 ? `Your instruction files, part ${n} of ${all.length}; read the parts in order.` : 'Your instruction files.'
  const more = last && all.length > n ? `\nThat's all the hooks can show. Read the files themselves and follow them: ${files().map(file => file.path).join(', ')}.\n` : ''
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: `${lead}\n\n${all[n - 1]}${more}` } }))
}

if (import.meta.main) {
  const [command, flag] = process.argv.slice(2)
  if (command === 'paths') console.log(JSON.stringify(files().map(file => file.path)))
  else if (command === 'hold') hold(flag!)
  else if (!command) console.log(rendered())
  else if (process.env.HEX_FRESH && process.env.HEX_THREAD) subagent(Number(command), flag === 'last')
}
