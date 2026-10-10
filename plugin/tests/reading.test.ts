import { expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SCRIPT = join(import.meta.dir, '../../bin/reading')
const env = { ...process.env, XDG_RUNTIME_DIR: mkdtempSync(join(tmpdir(), 'reading-')) }

function hook(input: object, ...args: string[]) {
  const run = Bun.spawnSync([SCRIPT, ...args], { stdin: Buffer.from(JSON.stringify(input)), env })
  expect(run.exitCode).toBe(0)
  const out = run.stdout.toString()
  return out && JSON.parse(out).hookSpecificOutput.additionalContext
}

const read = (session: string, chars: number, extra = {}) =>
  hook({ session_id: session, tool_response: 'x'.repeat(chars), ...extra })

test('adds up what each tool read this turn, in tokens', () => {
  expect(read('a', 4_000)).toStartWith('Reading this turn: 1k tokens into your own context.')
  expect(read('a', 8_000)).toStartWith('Reading this turn: 3k tokens')
  expect(read('a', 0)).toContain('Bassim: "there\'s a difference')
})

test('starts over on each new message', () => {
  read('b', 40_000)
  expect(hook({ session_id: 'b' }, 'turn')).toBe('')
  expect(read('b', 4_000)).toStartWith('Reading this turn: 1k tokens')
})

test('skips subagents', () => {
  expect(read('c', 40_000, { agent_id: 'sub' })).toBe('')
})
