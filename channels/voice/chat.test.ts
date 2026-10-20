import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { Chats } from './chat.ts'
import { until } from '../../hub/until.ts'
import { open } from '../../hub/store.ts'

const DESK = '-1001234:5'
const SESSION = 'abcdef12-0000-0000-0000-000000000000'
let hexDir: string
let state: string
let chats: Chats
let hub: Server
let lines: any[]

beforeEach(async () => {
  hexDir = mkdtempSync(join(tmpdir(), 'chat-'))
  state = join(hexDir, 'state')
  mkdirSync(join(state, 'telegram'), { recursive: true })
  mkdirSync(join(hexDir, 'log', 'threads'), { recursive: true })
  lines = []
  hub = createServer(socket => {
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => lines.push(...chunk.trim().split('\n').map(line => JSON.parse(line))))
  })
  await new Promise<void>(resolve => hub.listen(join(state, 'telegram', 'hub.sock'), resolve))
  chats = new Chats(state, hexDir)
})

afterEach(() => {
  chats.close()
  hub.close()
  rmSync(hexDir, { recursive: true, force: true })
})

test("a thread's chat is its session's log, and what the owner sent that it hasn't taken yet", () => {
  writeFileSync(
    join(hexDir, 'log', 'threads', `2026-10-20-${SESSION.slice(0, 8)}.md`),
    `# 2026-10-20 · session ${SESSION}\n\n## me · telegram · 2026-10-20 01:10\n\nship it\n\n## assistant · terminal · 2026-10-20 01:11\n\nthinking out loud\n\n## assistant · telegram · 2026-10-20 01:12\n\nShipped.\n`,
  )
  const store = open(state)
  store.deliver({ key: 'telegram:app-1', to: DESK, from: 'telegram', body: 'and the docs' })
  store.deliver({ key: 'telegram:app-2', to: DESK, from: 'telegram', body: 'taken already' })
  store.take('telegram:app-2', SESSION)
  expect(chats.of(DESK, SESSION)).toMatchObject({
    turns: [
      { from: 'me', text: 'ship it' },
      { from: 'hex', text: 'Shipped.' },
    ],
    waiting: [{ key: 'telegram:app-1', text: 'and the docs' }],
  })
})

test('words typed in the app reach the thread as the owner, and a stop reaches its hub', async () => {
  const key = await chats.send('telegram', DESK, 'and the docs')
  await chats.stop('telegram', DESK)
  await until(() => lines.length === 2)
  expect(lines[0]).toEqual({ type: 'inbound', thread: DESK, key: key.replace('telegram:', ''), content: 'and the docs', meta: { user_id: 'owner', via: 'hex app' } })
  expect(lines[1]).toEqual({ type: 'stop', thread: DESK })
})

test('a session taking a message changes the chat', async () => {
  const before = chats.version
  open(state).deliver({ key: 'telegram:app-3', to: DESK, from: 'telegram', body: 'hi' })
  await until(() => chats.version !== before)
})
