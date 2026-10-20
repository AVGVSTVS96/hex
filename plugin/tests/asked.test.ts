import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { createServer } from 'net'
import { join } from 'path'
import { open, type Store } from '../../hub/store.ts'

const STATE = join(import.meta.dir, '../../hub/state.ts')
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HEX_')))
const OWNER = { user: 'avgvstvs9', user_id: '1' }

let dir: string
let store: Store

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'asked-'))
  store = open(dir)
})
afterEach(() => rmSync(dir, { recursive: true }))

function said(key: string, body: string, meta: Record<string, string> = OWNER, session = 'session-1') {
  store.deliver({ key, to: 'chat:1', from: 'telegram', body, meta })
  store.take(key, session)
}

function hook(mode: string, input: object) {
  const run = Bun.spawnSync(['bun', STATE, mode], {
    stdin: Buffer.from(JSON.stringify(input)),
    env: { ...env, HEX_STORE: dir, TMPDIR: dir },
  })
  expect(run.exitCode).toBe(0)
  const out = run.stdout.toString()
  return out ? (JSON.parse(out) as { decision: string; reason: string }) : null
}
const stop = (session = 'session-1', again = false) => hook('idle', { hook_event_name: 'Stop', session_id: session, stop_hook_active: again })

test('a turn that ends with an ask no task quotes goes on once with it, then stops', () => {
  said('telegram:-100:1', 'make the deck load faster')
  const block = stop()
  expect(block?.decision).toBe('block')
  expect(block?.reason).toContain('[telegram:-100:1] make the deck load faster')
  expect(block?.reason).toContain('hex task new <key>')
  expect(stop('session-1', true)).toBeNull()
  expect(stop()).toBeNull()
})

test('a message a task quotes needs nothing', () => {
  said('telegram:-100:1', 'make the deck load faster')
  store.createTask({ message: 'telegram:-100:1', owner: 'chat:1' })
  expect(stop()).toBeNull()
})

test('only messages taken since the last stop come back', () => {
  said('telegram:-100:1', 'make the deck load faster')
  stop()
  said('telegram:-100:2', 'and cache the usage view')
  const block = stop()
  expect(block?.reason).toContain('[telegram:-100:2]')
  expect(block?.reason).not.toContain('[telegram:-100:1]')
})

test('a session counts what it took from its start, so a resumed one leaves its history be', () => {
  said('telegram:-100:1', 'an ask from last week')
  hook('begin', { hook_event_name: 'SessionStart', session_id: 'session-1' })
  Bun.sleepSync(2)
  said('telegram:-100:2', 'the ask that woke it')
  const block = stop()
  expect(block?.reason).toContain('[telegram:-100:2]')
  expect(block?.reason).not.toContain('[telegram:-100:1]')
})

test('taps, reactions, votes, deletes, and messages from others or other sessions need nothing', () => {
  said('telegram:-100:1', 'Yes', { ...OWNER, button: 'true' })
  stop()
  said('telegram:-100:2', '(reaction: 👍)', { ...OWNER, reaction: '👍' })
  said('telegram:-100:9', 'a message from someone else', { user: 'kevin' })
  said('telegram:-100:3', 'make the deck load faster', OWNER, 'session-2')
  expect(stop()).toBeNull()
})

test('a failed turn and a call\'s handoffs need nothing', () => {
  said('telegram:-100:1', 'make the deck load faster')
  expect(hook('idle', { hook_event_name: 'StopFailure', session_id: 'session-1' })).toBeNull()
  store.deliver({ key: 'voice:1', to: 'voice', from: 'voice', body: '[1.4s] you: remind me to call mom', meta: { delegation_id: 'item_1' } })
  store.take('voice:1', 'session-2')
  expect(stop('session-2')).toBeNull()
})

test('the commands it gives run from any folder', () => {
  said('telegram:-100:1', 'make the deck load faster')
  expect(stop()?.reason).toContain(`\`${join(import.meta.dir, '../../bin/hex')} task new <key>\``)
})

test('the hub hears the session is idle only once the tasks are made', async () => {
  said('telegram:-100:1', 'make the deck load faster')
  const socket = join(dir, 'hub.sock')
  const received: object[] = []
  const server = createServer(client => client.on('data', chunk => received.push(JSON.parse(String(chunk))))).listen(socket)
  const idle = async (again: boolean) => {
    const run = Bun.spawn(['bun', STATE, 'idle'], {
      env: { ...env, HEX_STORE: dir, TMPDIR: dir, HEX_HUB: socket, HEX_THREAD: 'chat:1' },
      stdin: new Blob([JSON.stringify({ hook_event_name: 'Stop', session_id: 'session-1', stop_hook_active: again })]),
      stdout: 'pipe',
    })
    await run.exited
    return (await new Response(run.stdout).text()) !== ''
  }
  expect(await idle(false)).toBe(true)
  expect(await idle(true)).toBe(false)
  for (let i = 0; i < 100 && !received.length; i++) await Bun.sleep(10)
  await Bun.sleep(50)
  server.close()
  expect(received).toEqual([{ type: 'state', thread: 'chat:1', busy: false }])
})
