import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { open, Store } from './store.ts'
import { until } from './until.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'store-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const message = { key: 'telegram:-100:42', to: '-100:7', from: 'telegram', body: 'remind me to buy Cheryl a salty treat', meta: { user: 'bassim' } }

test('a message is kept once, word for word, and a resend under its key changes nothing', () => {
  const store = new Store(dir)
  expect(store.deliver(message)).toBe(true)
  expect(store.deliver({ ...message, body: 'something else' })).toBe(false)
  const kept = store.message(message.key)!
  expect(kept).toMatchObject({ ...message })
  expect(kept.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  expect(kept.taken).toBeUndefined()
})

test('a key has to start with its sender, so the keys hex makes stay its own', () => {
  const store = new Store(dir)
  expect(() => store.deliver({ ...message, key: 'schedule:heartbeat@2026-10-18T21:45Z' })).toThrow()
  expect(() => store.deliver({ ...message, key: '42' })).toThrow()
  expect(store.untaken()).toEqual([])
})

test('the first session to take a message has it, and it leaves what waits', () => {
  const store = new Store(dir)
  store.deliver(message)
  store.deliver({ ...message, key: 'telegram:-100:43', body: 'and some chips' })
  store.deliver({ ...message, key: 'telegram:-100:44', to: '-100:9' })
  expect(store.take(message.key, 'session-a')).toBe(true)
  expect(store.take(message.key, 'session-b')).toBe(false)
  expect(store.take('telegram:-100:99', 'session-a')).toBe(false)
  expect(store.message(message.key)!.taken!.by).toBe('session-a')
  expect(store.untaken('-100:7').map(row => row.body)).toEqual(['and some chips'])
  expect(store.untaken().map(row => row.key)).toEqual(['telegram:-100:43', 'telegram:-100:44'])
})

test("a schedule's slot fires once, and not again while its last message still waits", () => {
  const store = new Store(dir)
  const minute = Date.UTC(2026, 9, 18, 21, 45) / 60_000
  expect(store.fire('heartbeat', minute, 'general', '[heartbeat] Hourly check')).toBe(true)
  expect(store.fire('heartbeat', minute, 'general', '[heartbeat] Hourly check')).toBe(false)
  expect(store.fire('heartbeat', minute + 60, 'general', '[heartbeat] Hourly check')).toBe(false)
  expect(store.fire('call', minute, 'general', '[call] Ring if needed', true)).toBe(true)
  expect(store.message('schedule:heartbeat@2026-10-18T21:45Z')).toMatchObject({ to: 'general', from: 'schedule', meta: { user: 'schedule', schedule: 'heartbeat' } })
  expect(store.message('schedule:call@2026-10-18T21:45Z')!.meta!.late).toBe('true')
  store.take('schedule:heartbeat@2026-10-18T21:45Z', 'session-a')
  expect(store.fire('heartbeat', minute + 60, 'general', '[heartbeat] Hourly check')).toBe(true)
})

test('the scheduler keeps the last minute it checked', () => {
  const store = new Store(dir)
  expect(store.checked()).toBeUndefined()
  store.check(100)
  store.check(101)
  expect(new Store(dir).checked()).toBe(101)
})

test('a change committed in another process rings the bell, and a write that changed nothing stays quiet', async () => {
  const store = open(dir)
  expect(open(dir)).toBe(store)
  let rang = 0
  const stop = store.watch(() => rang++)
  const cli = Bun.spawn(['bun', join(import.meta.dir, 'store.ts'), dir, 'job:build:abc', '--to', 'general', '[job]', 'build', 'ended'])
  expect(await cli.exited).toBe(0)
  await until(() => rang > 0)
  expect(store.message('job:build:abc')).toMatchObject({ to: 'general', from: 'job', body: '[job] build ended', meta: { user: 'job' } })
  const bell = readFileSync(join(dir, 'hex.bell'), 'utf8')
  expect(store.take('job:nothing:here', 'session-a')).toBe(false)
  expect(readFileSync(join(dir, 'hex.bell'), 'utf8')).toBe(bell)
  stop()
})

test('hex deliver says how to call it when something is missing', async () => {
  for (const args of [['job:build:abc', 'no thread'], ['build', '--to', 'general', 'no sender']]) {
    const cli = Bun.spawn(['bun', join(import.meta.dir, 'store.ts'), dir, ...args], { stderr: 'pipe' })
    expect(await cli.exited).toBe(2)
    expect(await new Response(cli.stderr).text()).toContain('usage: hex deliver')
  }
})
