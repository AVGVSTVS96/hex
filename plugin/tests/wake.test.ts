import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { open } from '../../hub/store.ts'

const BIN = join(import.meta.dir, '../../bin')
// A hex session running these would steer the hooks under test with its own HEX_* variables.
const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HEX_') && name !== 'MEMORY_DIR'))

let home: string
let file: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wake-'))
  file = join(home, 'state/wake/CLAUDE.md')
  mkdirSync(join(home, '.hex/bin'), { recursive: true })
  mkdirSync(join(home, '.hex/vendor'))
  copyFileSync(join(BIN, 'wake'), join(home, '.hex/bin/wake'))
  symlinkSync(join(BIN, '../hub'), join(home, '.hex/hub'))
})

afterEach(() => rmSync(home, { recursive: true, force: true }))

function memo(parts: string[]) {
  parts.forEach((part, i) => writeFileSync(join(home, `part${i + 1}.txt`), part))
  writeFileSync(join(home, '.hex/vendor/memo'), `#!/bin/sh\n[ "$1" = wake ] && cat "${home}/part\${2:-1}.txt"\n`)
  chmodSync(join(home, '.hex/vendor/memo'), 0o755)
}

function wake(env: Record<string, string> = { MEMORY_DIR: join(home, 'memory') }) {
  expect(Bun.spawnSync([join(home, '.hex/bin/wake')], { cwd: home, env: { ...clean, HEX_STORE: join(home, 'state'), ...env } }).exitCode).toBe(0)
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

const body = (out: string) => out.split('\n\n').slice(1).join('\n\n').replace(/^(`{3,})\n([^]*)\n\1\n$/, '$2\n')
const LABEL = 'Your memory, oldest first:\n\n'
const header = (part: number) => `Your memory, part ${part} of 2, oldest first (120 memories).\n`
const notes = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => `#${from + i} 2026-10-06 ${'x'.repeat(180)}`).join('\n') + '\n'

test('HEX.md imports the wake file, so Claude Code loads it into every session in the hex folder', () => {
  const imports = [...readFileSync(join(BIN, '../HEX.md'), 'utf8').matchAll(/^@(\S+)$/gm)].map(([, path]) => resolve(home, '.hex', path!))
  expect(imports).toEqual([file])
})

test("the file holds every part of memo's wake in order, as long as it runs", () => {
  memo([header(1) + notes(0, 200) + 'Not awake yet. Run: /x/memo wake 2 400\n', header(2) + notes(200, 200) + 'You are awake.\n'])
  expect(body(wake()!)).toBe(LABEL + notes(0, 200) + notes(200, 200) + 'You are awake.\n')
})

test('the profile comes first, ahead of memory', () => {
  memo(['#0 2026-10-06 First note.\nYou are awake.\n'])
  open(join(home, 'state')).profiled('', '# Always\n- Ships on fridays\n')
  expect(body(wake({ MEMORY_DIR: join(home, 'memory'), HEX_STORE: join(home, 'state') })!)).toBe(
    "My profile, the current truth about me, kept by hex's memory agent from my own words:\n\n# Always\n- Ships on fridays\n\nYour memory, oldest first:\n\n#0 2026-10-06 First note.\nYou are awake.\n",
  )
})

test('memory off leaves no file, and a wake that failed or stopped for a compression keeps the last one', () => {
  memo(['#0 2026-10-06 First note.\nYou are awake.\n\nCompress memories #0-1 into one line of at most 280 bytes.\nRun: memo nap 0-1 "<your line>"\n'])
  const good = wake()!
  // A compression asked for after waking is the memory agent's.
  expect(body(good)).toBe(LABEL + '#0 2026-10-06 First note.\nYou are awake.\n')
  memo(['Cannot wake: the memory context needs #0-1, which is not compressed yet.\nCompress memories #0-1 into one line.\n'])
  const stopped = wake()!
  expect(body(stopped)).toBe(body(good))
  expect(stopped).toContain('has since said `Cannot wake: the memory context needs #0-1, which is not compressed yet.`')
  memo(['The summary of #0-1 is blank.\n'])
  expect(wake()).toContain('has since said `The summary of #0-1 is blank.`')
  expect(body(wake()!)).toBe(body(good))
  expect(wake({})).toBeUndefined()
})

test("the launcher and a memory pass write it the same way, with memory where the hex folder's settings put it", () => {
  memo(['#0 2026-10-06 First note.\nYou are awake.\n'])
  mkdirSync(join(home, '.claude'))
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ env: { MEMORY_DIR: join(home, 'memory') } }))
  expect(body(wake({})!)).toBe(LABEL + '#0 2026-10-06 First note.\nYou are awake.\n')
})

test("memory is fenced, so Claude Code reads no `@path` in it as an import", () => {
  memo(['#0 2026-10-06 He pasted @.env and ```code```.\nYou are awake.\n'])
  const text = wake()!
  expect(text).toContain('\n````\nYour memory, oldest first:\n\n#0 2026-10-06')
  expect(text).toEndWith('You are awake.\n````\n')
})

test('settings that turn memory off win over the environment, and settings that do not parse keep the last wake', () => {
  memo(['#0 2026-10-06 First note.\nYou are awake.\n'])
  const good = wake()!
  mkdirSync(join(home, '.claude'))
  writeFileSync(join(home, '.claude/settings.json'), '{ "env": ')
  expect(wake()).toBe(good)
  writeFileSync(join(home, '.claude/settings.json'), '{}')
  expect(wake()).toBeUndefined()
})
