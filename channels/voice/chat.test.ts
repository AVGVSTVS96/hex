import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Chats } from './chat.ts'
import { clients, type Client } from '../../hub/hub.ts'
import { open } from '../../hub/store.ts'

const DESK = '-1001234:5'
const OLD = 'abcdef12-0000-0000-0000-000000000000'
const NOW = '12345678-0000-0000-0000-000000000000'
const where = { app: 'telegram', thread: DESK, session: NOW }
let hexDir: string
let state: string
let chats: Chats
let calls: unknown[][]

beforeEach(() => {
  hexDir = mkdtempSync(join(tmpdir(), 'chat-'))
  state = join(hexDir, 'state')
  mkdirSync(state, { recursive: true })
  calls = []
  clients.set('telegram', {
    hub: { name: () => 'Desk', deliver: (...args: unknown[]) => calls.push(['deliver', ...args]), stop: (thread: string) => calls.push(['hub stop', thread]) },
    place: async () => ({ thread: '', link: '' }),
  } as unknown as Client)
  chats = new Chats(state, hexDir)
})

afterEach(() => {
  chats.close()
  clients.clear()
  rmSync(hexDir, { recursive: true, force: true })
})

const log = (session: string, body: string) => {
  const file = join(hexDir, 'log', 'threads', `2026-10-20-${session.slice(0, 8)}.md`)
  writeFileSync(file, `# 2026-10-20 · session ${session}\n\n${body}`)
  return file
}

test("a thread's chat runs through every session it had, then what it took but hasn't logged, then what's waiting", () => {
  const store = open(state)
  store.deliver({ key: 'telegram:1', to: DESK, from: 'telegram', body: 'ship it', meta: { user_id: '1' } })
  store.take('telegram:1', OLD)
  log(OLD, `## me · telegram · 2026-10-20 01:10\n\nship it\n\n## assistant · terminal · 01:11\n\nthinking out loud\n\n## assistant · telegram · 01:12\n\nShipped.\n`)
  const now = log(NOW, `## hex app · telegram · 02:00\n\nand the docs\n\n## assistant · telegram · 02:01\n\nOn it.\n`)
  utimesSync(now, new Date(0), new Date(0))
  store.deliver({ key: 'telegram:2', to: DESK, from: 'telegram', body: 'and the tests', meta: { user: 'hex app' } })
  store.take('telegram:2', NOW)
  store.deliver({ key: 'telegram:3', to: DESK, from: 'telegram', body: 'then ship', meta: { user_id: '1' } })
  store.deliver({ key: 'schedule:4', to: DESK, from: 'schedule', body: 'heartbeat', meta: { user: 'schedule' } })
  expect(chats.of(where)).toMatchObject({
    sends: true,
    turns: [
      { from: 'me', text: 'ship it' },
      { from: 'hex', text: 'Shipped.' },
      { from: 'me', text: 'and the docs' },
      { from: 'hex', text: 'On it.' },
      { from: 'me', text: 'and the tests' },
    ],
    waiting: [{ key: 'telegram:3', text: 'then ship' }],
  })
})

test('words typed in the app reach the thread as the owner, under the key the app named them', () => {
  chats.send(where, 'and the docs', 'app-0001')
  expect(calls).toMatchObject([['deliver', DESK, 'Desk', { content: 'and the docs', key: 'app-0001', meta: { user: 'hex app' } }]])
})

test("a stop goes through the app's own stop when it has one", () => {
  chats.stop(where)
  clients.get('telegram')!.stop = thread => calls.push(['own stop', thread])
  chats.stop(where)
  expect(calls).toEqual([
    ['hub stop', DESK],
    ['own stop', DESK],
  ])
})

test("an app that shows only turns it starts, or none at all, can't take words from here", () => {
  clients.get('telegram')!.waits = true
  expect(chats.of(where).sends).toBe(false)
  expect(() => chats.send(where, 'hi', 'app-0002')).toThrow()
  expect(() => chats.send({ ...where, app: 'claude' }, 'hi', 'app-0003')).toThrow()
})

test('a wait for the chat ends when it changes, and not on a change elsewhere', async () => {
  const { version } = chats.of(where)
  const waited = chats.next(where, version, 5_000)
  open(state).deliver({ key: 'telegram:5', to: '-1009:1', from: 'telegram', body: 'elsewhere', meta: { user_id: '1' } })
  await Bun.sleep(50)
  open(state).deliver({ key: 'telegram:6', to: DESK, from: 'telegram', body: 'hi', meta: { user_id: '1' } })
  const chat = await waited
  expect(chat.version).not.toBe(version)
  expect(chat.waiting.map(sent => sent.text)).toEqual(['hi'])
  expect((await chats.next(where, chat.version, 100)).version).toBe(chat.version)
})
