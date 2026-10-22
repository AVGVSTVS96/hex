import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { running, served, serving } from './running.ts'
import { open } from './store.ts'

const claude = mkdtempSync(join(tmpdir(), 'running-'))
const store = open(join(claude, 'state'))
afterEach(() => rmSync(join(claude, 'sessions'), { recursive: true, force: true }))

function record(name: string, session: object) {
  mkdirSync(join(claude, 'sessions'), { recursive: true })
  writeFileSync(join(claude, 'sessions', `${name}.json`), JSON.stringify(session))
}

test("a session runs while its process lives, works for the thread it serves or the one its hooks heard, and its turns are hex's record", () => {
  record('thread', { pid: process.pid, sessionId: 'aaaaaaaa-1', status: 'idle', kind: 'bg', name: 'General', cwd: '/hex', startedAt: 1 })
  record('job', { pid: process.pid, sessionId: 'bbbbbbbb-1', status: 'busy', kind: 'bg', startedAt: 2 })
  record('gone', { pid: 2 ** 22 + 1, sessionId: 'cccccccc-1', status: 'busy' })
  record('old', { pid: process.pid, sessionId: 'dddddddd-1', status: 'idle' })
  record('new', { pid: process.pid, sessionId: 'dddddddd-1', status: 'busy' })
  store.turned('bbbbbbbb-1', true, 'telegram:-100:65')
  const sessions = running(store, claude)
  expect([...sessions.keys()].sort()).toEqual(['aaaaaaaa-1', 'bbbbbbbb-1', 'dddddddd-1'])
  expect(sessions.get('aaaaaaaa-1')).toMatchObject({ status: 'idle', kind: 'bg', name: 'General', cwd: '/hex', started: 1 })
  expect(sessions.get('bbbbbbbb-1')).toMatchObject({ thread: 'telegram:-100:65', began: expect.any(String) })
  expect(sessions.get('bbbbbbbb-1')!.ended).toBeUndefined()
  expect(sessions.get('dddddddd-1')!.status).toBe('busy')
  const held = new Map([['aaaaaaaa-1', 'discord:7']])
  expect(serving(sessions.get('aaaaaaaa-1')!, held)).toBe('discord:7')
  expect(serving(sessions.get('bbbbbbbb-1')!, held)).toBe('telegram:-100:65')
  store.turned('bbbbbbbb-1', false, 'telegram:-100:65')
  const ended = running(store, claude).get('bbbbbbbb-1')!
  expect(ended.status).toBe('busy')
  expect(Date.parse(ended.ended!)).toBeGreaterThanOrEqual(Date.parse(ended.began!))
})

test('a session works for the thread its hub started it for, else its job owner', () => {
  expect(served({ HEX_CHANNEL: 'plugin:t3@hex', HEX_THREAD: 'x', HEX_OWNER: 'discord:1' })).toBe('t3:x')
  expect(served({ HEX_OWNER: 'discord:1' })).toBe('discord:1')
  expect(served({ HEX_THREAD: 'x', HEX_OWNER: 'stray' })).toBeUndefined()
})
