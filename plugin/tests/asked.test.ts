import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { open, type Store } from '../../hub/store.ts'

const HOOK = join(import.meta.dir, '../../bin/asked')
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

function stop(session = 'session-1', again = false) {
  const run = Bun.spawnSync([HOOK], {
    stdin: Buffer.from(JSON.stringify({ hook_event_name: 'Stop', session_id: session, stop_hook_active: again })),
    env: { ...env, HEX_STORE: dir, TMPDIR: dir },
  })
  expect(run.exitCode).toBe(0)
  const out = run.stdout.toString()
  return out ? (JSON.parse(out) as { decision: string; reason: string }) : null
}

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

test('a session without a mark, as after a restart, counts only the message that woke it', () => {
  said('telegram:-100:1', 'an ask from last week')
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
