import { afterEach, beforeEach, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { open } from '../../hub/store.ts'

const BIN = join(import.meta.dir, '../../bin')
const SESSION = 'addfa113-0000-4000-8000-000000000000'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rules-'))
  mkdirSync(join(home, '.hex/bin'), { recursive: true })
  mkdirSync(join(home, '.claude'))
  for (const script of ['rules', 'identity', 'instructions']) copyFileSync(join(BIN, script), join(home, '.hex/bin', script))
  symlinkSync(join(BIN, '../hub'), join(home, '.hex/hub'))
  writeFileSync(join(home, 'AGENTS.md'), '@.hex/HEX.md\n\n- Keep it short.\n')
  writeFileSync(join(home, '.hex/HEX.md'), '# How you work\n\nAnswer in plain words.\n')
  writeFileSync(join(home, '.claude/CLAUDE.md'), '# Global\n')
})

afterEach(() => rmSync(home, { recursive: true, force: true }))

function hook(event: 'SessionStart' | 'UserPromptSubmit' | 'SessionEnd') {
  const run = Bun.spawnSync([join(home, '.hex/bin/rules')], {
    stdin: Buffer.from(JSON.stringify({ session_id: SESSION, hook_event_name: event })),
    env: { ...process.env, HOME: home, TMPDIR: home, HEX_STORE: join(home, 'state') },
  })
  expect(run.exitCode).toBe(0)
  return run.stdout.toString()
}

test('says nothing while the rules are the ones the session loaded', () => {
  expect(hook('SessionStart')).toBe('')
  expect(hook('UserPromptSubmit')).toBe('')
})

test('an edit to an imported file reaches the session once, as a diff', () => {
  hook('SessionStart')
  writeFileSync(join(home, '.hex/HEX.md'), '# How you work\n\nAnswer in plain words, with a link.\n')
  const out = hook('UserPromptSubmit')
  expect(out).toContain('.hex/HEX.md')
  expect(out).toContain('-Answer in plain words.')
  expect(out).toContain('+Answer in plain words, with a link.')
  expect(hook('UserPromptSubmit')).toBe('')
})

test('the global CLAUDE.md is watched too', () => {
  hook('SessionStart')
  writeFileSync(join(home, '.claude/CLAUDE.md'), '# Global\n\n- Sign every commit.\n')
  expect(hook('UserPromptSubmit')).toContain('+- Sign every commit.')
})

test('a session that loads the rules again starts from them', () => {
  hook('SessionStart')
  writeFileSync(join(home, 'AGENTS.md'), '@.hex/HEX.md\n\n- Keep it shorter.\n')
  hook('SessionStart')
  expect(hook('UserPromptSubmit')).toBe('')
})

test('a change too long to show points to the files instead', () => {
  hook('SessionStart')
  writeFileSync(join(home, 'AGENTS.md'), '@.hex/HEX.md\n\n' + '- A long rule.\n'.repeat(1000))
  const out = hook('UserPromptSubmit')
  expect(out).toContain('read them again')
  expect(out.length).toBeLessThan(10_000)
})

test("a session's end forgets what it loaded, and leaves no file behind", () => {
  hook('SessionStart')
  expect(open(join(home, 'state')).seen(SESSION, 'rules')).toContain('Answer in plain words.')
  hook('SessionEnd')
  expect(open(join(home, 'state')).seen(SESSION, 'rules')).toBe('')
  expect(readdirSync(home).filter(name => name.startsWith('hex-'))).toEqual([])
})
