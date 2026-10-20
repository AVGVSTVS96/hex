import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { clock, observe } from './observe.ts'
import { open } from './store.ts'

let dir: string
let memo: string
const noted = () => (existsSync(join(dir, 'noted')) ? readFileSync(join(dir, 'noted'), 'utf8').trim().split('\n') : [])

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'observe-'))
  memo = join(dir, 'memo')
  writeFileSync(join(dir, 'memories'), '#1 2026-10-19 Oct 19 9pm: the owner wants "the login page fixed first" [telegram:-100:40]\n')
  writeFileSync(memo, `#!/bin/sh\ncase "$1" in\n  note) printf '%s\\n' "$2" >> "${dir}/noted" ;;\n  recall) grep -E -- "$2" "${dir}/memories" ;;\nesac\n`)
  chmodSync(memo, 0o755)
  const store = open(dir)
  store.deliver({ key: 'telegram:-100:40', to: '-100:7', from: 'telegram', body: 'get the login page fixed first', meta: { user_id: '1' } })
  store.deliver({ key: 'telegram:-100:50', to: '-100:7', from: 'telegram', body: 'ship it on fridays only, my team reviews thursdays', meta: { user_id: '1', ts: '2026-10-20T06:31:00.000Z' } })
  store.deliver({ key: 'schedule:nightly:1', to: '-100:7', from: 'schedule', body: '[nightly] run the backup', meta: {} })
  for (const key of ['telegram:-100:40', 'telegram:-100:50', 'schedule:nightly:1']) store.take(key, 's')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test("the owner's messages no note names reach the pass, which writes the notes that keep their words", async () => {
  const seen: string[] = []
  const ask = async (input: string) => {
    seen.push(input)
    return ['Oct 19 11:31pm: ships "on fridays only, my team reviews thursdays" [telegram:-100:50]']
  }
  expect(await observe(dir, 's', 'Done, Friday deploys only.', { ask, memo })).toHaveLength(1)
  expect(seen[0]).toContain('[telegram:-100:50]')
  expect(seen[0]).toContain("The session's reply:\nDone, Friday deploys only.")
  expect(seen[0]).not.toContain('get the login page fixed first')
  expect(seen[0]).not.toContain('run the backup')
  expect(noted()).toEqual(['Oct 19 11:31pm: ships "on fridays only, my team reviews thursdays" [telegram:-100:50]'])
  expect(await observe(dir, 's', '', { ask, memo })).toEqual([])
  expect(seen).toHaveLength(1)
})

test("a note that misquotes the owner, names no message, or doesn't fit isn't written, and one is written without the date memo adds", async () => {
  const ask = async () => [
    'Oct 19: ships "only on fridays" [telegram:-100:50]',
    'Oct 19: ships on fridays only',
    `Oct 19: "ship it on fridays only" ${'x'.repeat(280)} [telegram:-100:50]`,
    '2026-10-19 Oct 19: "ship it on fridays only" [telegram:-100:50]',
  ]
  expect(await observe(dir, 's', '', { ask, memo })).toEqual(['Oct 19: "ship it on fridays only" [telegram:-100:50]'])
  expect(noted()).toHaveLength(1)
})

test('a pass that fails hands its messages to the next one, and one that died does once its lease runs out', async () => {
  const fail = async (): Promise<string[]> => {
    throw new Error('limit')
  }
  expect(await observe(dir, 's', '', { ask: fail, memo })).toEqual([])
  let asked = 0
  const count = async () => (asked++, [])
  await observe(dir, 's', '', { ask: count, memo })
  expect(asked).toBe(1)

  const store = open(dir)
  store.deliver({ key: 'telegram:-100:60', to: '-100:7', from: 'telegram', body: 'move standup to 10', meta: { user_id: '1' } })
  store.take('telegram:-100:60', 's')
  expect(store.observe('s', new Date().toISOString()).map(row => row.key)).toEqual(['telegram:-100:60'])
  expect(store.observe('s', new Date().toISOString())).toEqual([])
  await Bun.sleep(2)
  expect(store.observe('s', new Date().toISOString(), 0).map(row => row.key)).toEqual(['telegram:-100:60'])
})

test("a pass takes what the session had taken when its turn ended, not the next turn's message", async () => {
  const by = new Date().toISOString()
  await Bun.sleep(2)
  const store = open(dir)
  store.deliver({ key: 'telegram:-100:70', to: '-100:7', from: 'telegram', body: 'and add a dark mode', meta: { user_id: '1' } })
  store.take('telegram:-100:70', 's')
  const seen: string[] = []
  await observe(dir, 's', '', { ask: async input => (seen.push(input), []), memo, by })
  expect(seen[0]).toContain('[telegram:-100:50]')
  expect(seen[0]).not.toContain('dark mode')
  await observe(dir, 's', '', { ask: async input => (seen.push(input), []), memo })
  expect(seen[1]).toContain('and add a dark mode')
})

test("a note may only name this pass's messages", async () => {
  const ask = async () => ['Oct 19: "get the login page fixed first" [telegram:-100:40]', 'Oct 19: "run the backup" [schedule:nightly:1]']
  expect(await observe(dir, 's', '', { ask, memo })).toEqual([])
})

test('a time reads the way notes write it, on the owner’s clock', () => {
  expect(clock('2026-10-20T06:31:00.000Z', 'America/Los_Angeles')).toBe('Oct 19 11:31pm')
  expect(clock('2026-10-20T19:05:00.000Z', 'America/Los_Angeles')).toBe('Oct 20 12:05pm')
})
