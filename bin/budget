#!/usr/bin/env bun
import { readFileSync, realpathSync } from 'fs'
import { join, relative, resolve } from 'path'
import { loaded } from './identity'

// The user's AGENTS.md and the files it imports outside .hex/ load into every prompt and every
// subagent, and each session that hears a rule is tempted to add a line for it. HEX_RULES_WORDS caps
// them: an edit that would take them past it is refused unless it also makes them shorter, so a new
// rule has to be worked into an existing line or paid for with a cut.

const home = resolve(import.meta.dir, '../..')
const budget = Number(process.env.HEX_RULES_WORDS || 2500)

const real = (file: string) => {
  try {
    return realpathSync(file)
  } catch {
    return resolve(file)
  }
}
const words = (text: string) => text.split(/\s+/).filter(Boolean).length
const hex = real(join(home, '.hex')) + '/'
const rules = (read?: (file: string) => string) => loaded(join(home, 'AGENTS.md'), new Set(), 0, read).filter(([file]) => !real(file).startsWith(hex))
const total = (files: [string, string][]) => files.reduce((sum, [, text]) => sum + words(text), 0)
const names = (files: [string, string][]) => new Intl.ListFormat('en').format(files.map(([file]) => relative(home, file)))
const fix = `Work the change into the line it belongs to, or cut words that say less, so they stay within ${budget}.`

function replace(text: string, old: string, next: string, all?: boolean) {
  if (all) return text.split(old).join(next)
  const at = text.indexOf(old)
  return at < 0 ? text : text.slice(0, at) + next + text.slice(at + old.length)
}

const { tool_name, tool_input } = JSON.parse(readFileSync(0, 'utf8'))
const before = rules()
const now = total(before)

if (tool_name === 'Bash') {
  const touched = before.some(([file]) => String(tool_input?.command ?? '').includes(relative(home, file)))
  if (touched && now > budget) console.log(JSON.stringify({ decision: 'block', reason: `${names(before)} are now ${now} words, over the ${budget} set by HEX_RULES_WORDS. ${fix}` }))
} else {
  const target = real(resolve(home, tool_input?.file_path ?? ''))
  const read = (file: string) => readFileSync(file, 'utf8')
  const proposed = (file: string) => tool_name === 'Write' ? tool_input.content : (tool_input.edits ?? [tool_input]).reduce((t: string, e: any) => replace(t, e.old_string, e.new_string, e.replace_all), read(file))
  const after = rules(file => real(file) === target ? proposed(file) : read(file))
  const size = total(after)
  if (size > budget && size > now) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `This edit takes ${names(after)} from ${now} to ${size} words, over the ${budget} set by HEX_RULES_WORDS. ${fix}` } }))
}
