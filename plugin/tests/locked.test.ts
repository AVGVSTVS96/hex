import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const HOOK = join(import.meta.dir, '../../bin/locked')

let dir: string

// lsattr stands in for the filesystem: it reports the immutable flag on files named locked-*.
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'locked-'))
  writeFileSync(join(dir, 'lsattr'), '#!/bin/sh\ncase $(basename "$3") in locked-*) flags=----i---------e-------;; *) flags=--------------e-------;; esac\necho "$flags $3"\n')
  chmodSync(join(dir, 'lsattr'), 0o755)
  for (const name of ['locked-AGENTS.md', 'notes.md']) writeFileSync(join(dir, name), 'text\n')
})
afterEach(() => rmSync(dir, { recursive: true }))

function hook(tool_name: string, tool_input: object) {
  const run = Bun.spawnSync([HOOK], { stdin: Buffer.from(JSON.stringify({ tool_name, tool_input })), env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } })
  expect(run.exitCode).toBe(0)
  const out = run.stdout.toString()
  return out ? JSON.parse(out) : null
}

test('an edit to a locked file is refused with the way its changes get in', () => {
  const out = hook('Edit', { file_path: join(dir, 'locked-AGENTS.md'), old_string: 'text', new_string: 'more' })
  expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
  expect(out.hookSpecificOutput.permissionDecisionReason).toContain('bin/lock')
  expect(out.hookSpecificOutput.permissionDecisionReason).toContain('--because')
})

test('a file that is not locked, or not there yet, edits as usual', () => {
  expect(hook('Write', { file_path: join(dir, 'notes.md'), content: 'x' })).toBeNull()
  expect(hook('Write', { file_path: join(dir, 'new.md'), content: 'x' })).toBeNull()
})
