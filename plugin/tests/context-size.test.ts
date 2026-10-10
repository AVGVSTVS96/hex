import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SCRIPT = join(import.meta.dir, '../../bin/context-size')

function hook(lines: object[], args: string[] = []) {
  const path = join(mkdtempSync(join(tmpdir(), 'context-size-')), 'transcript.jsonl')
  writeFileSync(path, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  const run = Bun.spawnSync([SCRIPT, ...args], { stdin: Buffer.from(JSON.stringify({ transcript_path: path })) })
  expect(run.exitCode).toBe(0)
  return run.stdout.toString()
}

const turn = (input: number, read: number, write: number, extra = {}) =>
  ({ type: 'assistant', message: { model: 'claude', usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write } }, ...extra })

test("counts the latest main-thread turn's input, cache reads and cache writes", () => {
  expect(hook([turn(1, 10_000, 0), turn(2, 40_000, 1_500), { type: 'user', message: { content: 'hi' } }]))
    .toBe("Context: 42k tokens (input + cache read + cache write) of this session's window.\n")
})

test('skips subagent and synthetic turns', () => {
  expect(hook([
    turn(0, 20_000, 0),
    turn(0, 90_000, 0, { isSidechain: true }),
    { type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
  ])).toContain('Context: 20k tokens')
})

test('says nothing before the first reply', () => {
  expect(hook([{ type: 'user', message: { content: 'hi' } }])).toBe('')
})

test('gives just the count to other hooks', () => {
  expect(hook([turn(2, 40_000, 1_500)], ['tokens'])).toBe('41502\n')
})
