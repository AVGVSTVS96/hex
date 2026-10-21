import { afterEach, beforeEach, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { open } from '../../hub/store.ts'
import { tmpdir } from 'os'
import { join } from 'path'

const BIN = join(import.meta.dir, '../../bin')
const SESSION = 'addfa113-0000-4000-8000-000000000000'
const LIMIT = 10_000

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'compacted-'))
  mkdirSync(join(home, '.hex/bin'), { recursive: true })
  mkdirSync(join(home, '.hex/vendor'))
  for (const script of ['compacted', 'hex']) copyFileSync(join(BIN, script), join(home, '.hex/bin', script))
  symlinkSync(join(import.meta.dir, '../../hub'), join(home, '.hex/hub'))
})

afterEach(() => rmSync(home, { recursive: true, force: true }))

// A thread's messages in hex.db, a minute apart, as its session took or wrote them.
function kept(thread: string, turns: [string, string][]) {
  const store = open(join(home, 'state'))
  for (const [i, [author, body]] of turns.entries()) {
    store.deliver({ key: `telegram:${i}`, to: thread, from: 'telegram', author, body }, SESSION)
    store.db.query('update messages set at = ? where key = ?').run(new Date(Date.UTC(2026, 9, 6, 16, i)).toISOString(), `telegram:${i}`)
  }
}

function hook(env: Record<string, string> = {}) {
  const run = Bun.spawnSync([join(home, '.hex/bin/compacted')], {
    cwd: home,
    stdin: Buffer.from(JSON.stringify({ session_id: SESSION, source: 'compact' })),
    env: { ...process.env, CLAUDE_PROJECT_DIR: home, MEMORY_DIR: join(home, 'memory'), TMPDIR: home, TZ: 'UTC', HEX_THREAD: '', HEX_MAIN: '', ...env },
  })
  expect(run.exitCode).toBe(0)
  const out = run.stdout.toString()
  expect(out.trim().length).toBeLessThanOrEqual(LIMIT)
  return out
}

test("brings back the thread's whole conversation when it fits", () => {
  kept('42', [['owner', 'hi'], ['hex', 'hey'], ['owner', 'what is up']])
  kept('43', [['owner', 'another thread']])
  const out = hook({ HEX_THREAD: '42' })
  expect(out).toContain('the whole conversation so far')
  expect(out).toContain('## owner · telegram · 42 · 2026-10-06 16:00 · [telegram:0]\n\nhi')
  expect(out).toContain('## hex · telegram · 42 · 2026-10-06 16:01 · [telegram:1]\n\nhey')
  expect(out).not.toContain('another thread')
})

test('brings back the last whole turns of a long conversation, and points to the earlier ones', () => {
  kept(SESSION, Array.from({ length: 40 }, (_, i): [string, string] => [i % 2 ? 'hex' : 'owner', `turn ${i} ${'y'.repeat(600)}`]))
  const out = hook()
  expect(out).toContain(`\`.hex/bin/hex log -- '${SESSION}'\` has the earlier messages`)
  expect(out.split('\n\n').slice(1).join('\n\n')).toMatch(/^## (owner|hex) · /)
  expect(out).toContain('turn 39')
  expect(out).not.toContain('turn 20 ')
})
