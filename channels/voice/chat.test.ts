import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
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
  chats = new Chats(state)
})

afterEach(() => {
  chats.close()
  clients.clear()
  rmSync(hexDir, { recursive: true, force: true })
})

test("a thread's chat is what the owner said and hex replied across its sessions, then what's waiting", () => {
  const store = open(state)
  store.deliver({ key: 'telegram:1', to: DESK, from: 'telegram', author: 'owner', body: 'ship it', meta: { user_id: '1' } })
  store.take('telegram:1', OLD)
  store.deliver({ key: 'terminal:1', to: DESK, from: 'terminal', author: 'hex', body: 'thinking out loud' }, OLD)
  store.deliver({ key: 'telegram:10', to: DESK, from: 'telegram', author: 'hex', body: 'Shipped.' }, OLD)
  store.deliver({ key: 'telegram:2', to: DESK, from: 'telegram', author: 'owner', body: 'and the tests', meta: { user: 'hex app' } })
  store.take('telegram:2', NOW)
  store.deliver({ key: 'telegram:11', to: DESK, from: 'telegram', author: 'hex', body: 'On it.' }, NOW)
  store.deliver({ key: 'telegram:3', to: DESK, from: 'telegram', author: 'owner', body: 'then ship', meta: { user_id: '1' } })
  store.deliver({ key: 'schedule:4', to: DESK, from: 'schedule', author: 'prompt', body: 'heartbeat', meta: { user: 'schedule' } })
  expect(chats.of(where)).toMatchObject({
    sends: true,
    total: 4,
    turns: [
      { from: 'me', text: 'ship it' },
      { from: 'hex', text: 'Shipped.' },
      { from: 'me', text: 'and the tests' },
      { from: 'hex', text: 'On it.' },
    ],
    waiting: [{ key: 'telegram:3', text: 'then ship' }],
  })
})

test('words typed in the app reach the thread as the owner, under the key the app named them', () => {
  chats.send(where, 'and the docs', 'app-00000001')
  expect(calls).toMatchObject([['deliver', DESK, 'Desk', { content: 'and the docs', key: 'app-00000001', author: 'owner', meta: { user: 'hex app' } }]])
})

test("a stop goes through the app's own stop when it has one, and only where an app holds the thread", () => {
  chats.stop(where)
  clients.get('telegram')!.stop = thread => calls.push(['own stop', thread])
  chats.stop(where)
  clients.get('telegram')!.hub.name = () => undefined
  expect(() => chats.stop(where)).toThrow()
  expect(calls).toEqual([
    ['hub stop', DESK],
    ['own stop', DESK],
  ])
})

test("an app that shows only turns it starts, doesn't hold the thread, or isn't here can't take words from here", () => {
  clients.get('telegram')!.hub.name = () => undefined
  expect(chats.of(where).sends).toBe(false)
  clients.get('telegram')!.hub.name = () => 'Desk'
  clients.get('telegram')!.waits = true
  expect(chats.of(where).sends).toBe(false)
  expect(() => chats.send(where, 'hi', 'app-0002')).toThrow()
  expect(() => chats.send({ ...where, app: 'claude' }, 'hi', 'app-0003')).toThrow()
})

test('a wait for the chat ends when it changes, and not on a change elsewhere', async () => {
  const { version } = chats.of(where)
  const waited = chats.next(() => where, version, 5_000)
  open(state).deliver({ key: 'telegram:5', to: '-1009:1', from: 'telegram', author: 'owner', body: 'elsewhere', meta: { user_id: '1' } })
  await Bun.sleep(50)
  open(state).deliver({ key: 'telegram:6', to: DESK, from: 'telegram', author: 'owner', body: 'hi', meta: { user_id: '1' } })
  const chat = await waited
  expect(chat.version).not.toBe(version)
  expect(chat.waiting.map(sent => sent.text)).toEqual(['hi'])
  expect((await chats.next(() => where, chat.version, 100)).version).toBe(chat.version)
})
