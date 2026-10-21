import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { running, serving } from './running.ts'

const claude = mkdtempSync(join(tmpdir(), 'running-'))
const spawned: ReturnType<typeof Bun.spawn>[] = []
afterEach(() => {
  for (const child of spawned.splice(0)) child.kill()
  rmSync(join(claude, 'sessions'), { recursive: true, force: true })
})

function record(name: string, session: object) {
  mkdirSync(join(claude, 'sessions'), { recursive: true })
  writeFileSync(join(claude, 'sessions', `${name}.json`), JSON.stringify(session))
}

test("a session runs while its process lives, works for the thread it serves, the one above it, or its job's owner", () => {
  const job = Bun.spawn(['sleep', '30'], { env: { ...process.env, HEX_OWNER: 'telegram:-100:65' } })
  spawned.push(job)
  record('thread', { pid: process.pid, sessionId: 'aaaaaaaa-1', status: 'idle', kind: 'bg', name: 'General', cwd: '/hex', startedAt: 1 })
  record('job', { pid: job.pid, sessionId: 'bbbbbbbb-1', status: 'busy', kind: 'bg', startedAt: 2, statusUpdatedAt: 3 })
  record('gone', { pid: 2 ** 22 + 1, sessionId: 'cccccccc-1', status: 'busy' })
  record('old', { pid: process.pid, sessionId: 'dddddddd-1', status: 'idle' })
  record('new', { pid: process.pid, sessionId: 'dddddddd-1', status: 'busy' })
  const sessions = running(claude)
  expect([...sessions.keys()].sort()).toEqual(['aaaaaaaa-1', 'bbbbbbbb-1', 'dddddddd-1'])
  expect(sessions.get('aaaaaaaa-1')).toMatchObject({ status: 'idle', kind: 'bg', name: 'General', cwd: '/hex', started: 1, at: 1 })
  expect(sessions.get('bbbbbbbb-1')).toMatchObject({ owner: 'telegram:-100:65', at: 3 })
  expect(sessions.get('dddddddd-1')!.status).toBe('busy')
  const held = new Map([['aaaaaaaa-1', 'discord:7']])
  expect(serving(sessions.get('aaaaaaaa-1')!, sessions, held)).toBe('discord:7')
  expect(serving(sessions.get('bbbbbbbb-1')!, sessions, held)).toBe('telegram:-100:65')
  const child = { id: 'eeeeeeee-1', pid: 0, status: 'busy', started: 0, at: 0, parent: 'aaaaaaaa-1' }
  expect(serving(child, new Map([...sessions, [child.id, child]]), held)).toBe('discord:7')
  expect(serving(child, new Map([...sessions, [child.id, child]]), new Map())).toBeUndefined()
})
