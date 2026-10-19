import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { open } from './store.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'profile-'))
  mkdirSync(join(dir, 'telegram'))
  writeFileSync(join(dir, 'telegram', 'threads.json'), JSON.stringify({ '-100:7': { name: 'Website' }, '-100:9': { name: 'Errands' } }))
  const store = open(dir)
  store.deliver({ key: 'telegram:-100:50', to: '-100:7', from: 'telegram', body: 'Fix the login page.\nIt 500s on submit.', meta: { user: 'bassim' } })
  store.deliver({ key: 'telegram:-100:60', to: '-100:9', from: 'telegram', body: 'buy a power adapter', meta: { user: 'bassim' } })
  store.createTask({ message: 'telegram:-100:50', owner: '-100:7', doneWhen: 'it signs in' })
  store.createTask({ message: 'telegram:-100:60', owner: '-100:9' })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function hook(input: object, env: Record<string, string> = {}) {
  const run = Bun.spawn(['bun', join(import.meta.dir, 'profile.ts')], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', env: { PATH: process.env.PATH!, HEX_STORE: dir, ...env } })
  expect(await run.exited).toBe(0)
  return new Response(run.stdout).text()
}

test("a thread's session gets its own open tasks in the owner's words, once, and again when they change", async () => {
  const first = await hook({ session_id: 'a', hook_event_name: 'UserPromptSubmit' }, { HEX_THREAD: '-100:7' })
  expect(first).toContain("This thread's open tasks")
  expect(first).toContain('t-1 (open, Website)')
  expect(first).toContain('  done when: it signs in')
  expect(first).toContain('[telegram:-100:50 · bassim · ')
  expect(first).toContain('    Fix the login page.\n    It 500s on submit.')
  expect(first).not.toContain('power adapter')
  expect(await hook({ session_id: 'a' }, { HEX_THREAD: '-100:7' })).toBe('')
  open(dir).editTask('t-1', { status: 'done', proof: 'https://example.com/pr/1' })
  expect(await hook({ session_id: 'a' }, { HEX_THREAD: '-100:7' })).toBe('No open tasks now.\n')
  expect(await hook({ session_id: 'a' }, { HEX_THREAD: '-100:7' })).toBe('')
})

test("main sees every thread's open tasks, and gets them again after a compaction", async () => {
  const all = await hook({ session_id: 'm' }, { HEX_THREAD: '-100', HEX_MAIN: '1' })
  expect(all).toContain("Every thread's open tasks")
  expect(all).toContain('t-1 (open, Website)')
  expect(all).toContain('t-2 (open, Errands)')
  expect(await hook({ session_id: 'm', hook_event_name: 'SessionStart', source: 'resume' }, { HEX_THREAD: '-100', HEX_MAIN: '1' })).toBe('')
  expect(await hook({ session_id: 'm', hook_event_name: 'SessionStart', source: 'compact' }, { HEX_THREAD: '-100', HEX_MAIN: '1' })).toBe(all)
})

test('a session outside hex, or one with no tasks, hears nothing', async () => {
  const outside = Bun.spawn(['bun', join(import.meta.dir, 'profile.ts')], { stdin: new Blob(['{"session_id":"x"}']), stdout: 'pipe', env: { PATH: process.env.PATH! } })
  expect(await outside.exited).toBe(0)
  expect(await new Response(outside.stdout).text()).toBe('')
  expect(await hook({ session_id: 'b' }, { HEX_THREAD: '-100:404' })).toBe('')
})
