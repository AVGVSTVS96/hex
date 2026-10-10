import { beforeEach, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const BIN = join(import.meta.dir, '../../bin')
const SESSION = 'addfa113-0000-4000-8000-000000000000'
const LIMIT = 10_000
const SLOTS = 6

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wake-'))
  mkdirSync(join(home, '.hex/bin'), { recursive: true })
  mkdirSync(join(home, '.hex/vendor'))
  copyFileSync(join(BIN, 'wake'), join(home, '.hex/bin/wake'))
})

function memo(parts: string[]) {
  parts.forEach((part, i) => writeFileSync(join(home, `part${i + 1}.txt`), part))
  writeFileSync(join(home, '.hex/vendor/memo'), `#!/bin/sh\n[ "$1" = wake ] && cat "${home}/part\${2:-1}.txt"\n`)
  chmodSync(join(home, '.hex/vendor/memo'), 0o755)
}

function hook(chunk: number) {
  const run = Bun.spawnSync([join(home, '.hex/bin/wake'), String(chunk), ...(chunk === SLOTS ? ['last'] : [])], {
    cwd: home,
    stdin: Buffer.from(JSON.stringify({ session_id: SESSION, source: 'startup' })),
    env: { ...process.env, CLAUDE_PROJECT_DIR: home, MEMORY_DIR: join(home, 'memory'), TMPDIR: home },
  })
  expect(run.exitCode).toBe(0)
  const out = run.stdout.toString()
  expect(out.length).toBeLessThanOrEqual(LIMIT)
  return out
}

const body = (out: string) => out.split('\n\n').slice(1).join('\n\n')
const notes = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => `#${from + i} 2026-10-06 ${'x'.repeat(180)}`).join('\n') + '\n'

test('a short wake arrives whole in the first chunk, and the other slots say nothing', () => {
  const wake = '#0 2026-10-06 First note.\nYou are awake.\n'
  memo([wake])
  expect(hook(1)).toContain('chunk 1 of 1')
  expect(body(hook(1))).toBe(wake)
  for (let n = 2; n <= SLOTS; n++) expect(hook(n)).toBe('')
})

test("follows memo's parts to the end and splits them into chunks that each fit a hook, losing no line", () => {
  const wake = [
    notes(0, 60) + 'Not awake yet. Run: /x/memo wake 2 150\n',
    'Your memory, part 2 of 2\n' + notes(60, 60) + 'You are awake.\n',
  ]
  memo(wake)
  const chunks = Array.from({ length: SLOTS }, (_, i) => hook(i + 1)).filter(Boolean)
  expect(chunks.length).toBeGreaterThan(1)
  const joined = chunks.map(body).join('')
  expect(joined).toBe(wake.join('').replace('Not awake yet. Run: /x/memo wake 2 150\n', ''))
  expect(joined.endsWith('You are awake.\n')).toBe(true)
})

test('a wake longer than every slot points the last one at the rest', () => {
  memo([notes(0, 400) + 'You are awake.\n'])
  const out = hook(SLOTS)
  const pointer = out.match(/from line (\d+) of (\S+), and/)!
  const rest = readFileSync(pointer[2], 'utf8').split('\n').slice(Number(pointer[1]) - 1).join('\n')
  expect(rest).toStartWith(`#${Number(pointer[1]) - 1} `)
  expect(rest).toEndWith('You are awake.\n')
})

test('says nothing when OptMem is not installed', () => {
  expect(hook(1)).toBe('')
})
