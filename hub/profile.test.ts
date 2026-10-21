import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { open } from './store.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'profile-'))
  mkdirSync(join(dir, 'telegram'))
  const store = open(dir)
  store.named('telegram', { '-100:7': 'Website', '-100:9': 'Errands' })
  store.deliver({ key: 'telegram:-100:50', to: '-100:7', from: 'telegram', body: 'Fix the login page.\nIt 500s on submit.', meta: { user: 'bassim' } })
  store.deliver({ key: 'telegram:-100:60', to: '-100:9', from: 'telegram', body: 'buy a power adapter', meta: { user: 'bassim' } })
  store.createTask({ title: 'Fix the login page', message: 'telegram:-100:50', owner: '-100:7', doneWhen: 'it signs in' })
  store.createTask({ title: 'Buy a power adapter', message: 'telegram:-100:60', owner: '-100:9' })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function hook(input: object, env: Record<string, string> = {}) {
  const run = Bun.spawn(['bun', join(import.meta.dir, 'profile.ts')], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', env: { PATH: process.env.PATH!, HEX_STORE: dir, ...env } })
  expect(await run.exited).toBe(0)
  return new Response(run.stdout).text()
}

test("a thread's session gets its own open tasks as clean entries, once, and again when they change", async () => {
  const first = await hook({ session_id: 'a', hook_event_name: 'UserPromptSubmit' }, { HEX_THREAD: '-100:7' })
  expect(first).toContain("This thread's open tasks")
  expect(first).toContain('t-1 (open, Website): Fix the login page\n  done when: it signs in')
  expect(first).not.toContain('It 500s on submit')
  expect(first).not.toContain('telegram:-100:50')
  expect(first).not.toContain('power adapter')
  expect(await hook({ session_id: 'a' }, { HEX_THREAD: '-100:7' })).toBe('')
  open(dir).editTask('t-1', { status: 'done', proof: 'https://example.com/pr/1' })
  expect(await hook({ session_id: 'a' }, { HEX_THREAD: '-100:7' })).toBe('No open tasks or questions waiting on me now.\n')
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

test("a list too long for one hook's output gives each entry with its done-when while it fits, then one line, and never the owner's words", async () => {
  const store = open(dir)
  for (let n = 0; n < 120; n++) {
    store.deliver({ key: `telegram:-100:${100 + n}`, to: '-100:7', from: 'telegram', body: `chore ${n}, damn it`, meta: { user: 'bassim' } })
    store.createTask({ title: `Chore ${n}: ${'tidy up the build '.repeat(7)}`, message: `telegram:-100:${100 + n}`, owner: '-100:7', doneWhen: 'the build is tidy '.repeat(8) })
  }
  const shown = await hook({ session_id: 'big' }, { HEX_THREAD: '-100:7' })
  expect(shown.length).toBeLessThan(10_000)
  expect(shown).toContain('t-1 (open, Website): Fix the login page\n  done when: it signs in')
  expect(shown).toMatch(/\n  done when: the build is tidy[^\n]*\nt-\d+ \(open, Website\): Chore \d+: [^\n]*\n…and \d+ more: `\.hex\/bin\/hex tasks` lists them all\n$/)
  expect(shown).not.toContain('damn it')
  store.deliver({ key: 'telegram:-100:300', to: '-100:7', from: 'telegram', body: 'and the API reference', meta: { user: 'bassim' } })
  store.addWords('t-3', 'telegram:-100:300')
  expect(await hook({ session_id: 'big' }, { HEX_THREAD: '-100:7' })).toBe('')
})

test('the questions still waiting on the owner come with the tasks, and leave once answered', async () => {
  open(dir).ask({ app: 'telegram', thread: '-100:7', message: 3935, text: 'Remove the 4 old pages?\nThey are below the cutoff.', options: ['Remove', 'Keep'] })
  const shown = await hook({ session_id: 'q' }, { HEX_THREAD: '-100:7' })
  expect(shown).toContain("This thread's questions still waiting on my answer")
  expect(shown).toContain('- telegram · Website · message 3935 · ')
  expect(shown).toContain('Remove the 4 old pages? [Remove | Keep]')
  expect(shown).not.toContain('below the cutoff')
  open(dir).answered('telegram', '-100:7', 3935, 'Remove', 'telegram')
  expect(await hook({ session_id: 'q' }, { HEX_THREAD: '-100:7' })).not.toContain('waiting on my answer')
})
