import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import { follow } from './transcript.ts'
import { until } from '../../hub/until.ts'

let dir: string
let path: string
let updates: SessionNotification['update'][]
let ended: number
let reader: ReturnType<typeof follow> | undefined

const prompt = { type: 'user', origin: { kind: 'channel' }, isMeta: true, message: { content: '<channel source="t3">hi</channel>' } }
const text = (id: string, words: string) => ({ type: 'assistant', message: { id, content: [{ type: 'text', text: words }] } })
const bash = { type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'pwd' } }] } }
const result = { type: 'user', uuid: 'u1', message: { content: [{ type: 'tool_result', tool_use_id: 'tool1', content: '/work' }] } }
const done = { type: 'system', subtype: 'turn_duration' }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 't3-transcript-'))
  path = join(dir, 'session.jsonl')
  updates = []
  ended = 0
})

afterEach(() => {
  reader?.close()
  rmSync(dir, { recursive: true, force: true })
})

function write(...entries: object[]) {
  appendFileSync(path, entries.map(entry => JSON.stringify(entry) + '\n').join(''))
}

function start(since?: number) {
  reader = follow({ path, sessionId: 'thread', cwd: '/work', since, done: () => true, emit: n => void updates.push(n.update), end: () => void ended++ })
}

test('a turn streams from where the transcript ends, without the channel prompt, and ends at its turn_duration', async () => {
  write(prompt, text('m0', 'an earlier turn'), done)
  start()
  write(prompt, bash, result, text('m3', 'you are in /work'), done, text('m4', 'a later turn'))
  await until(() => ended)
  expect(updates.map(update => update.sessionUpdate)).toEqual(['tool_call', 'tool_call_update', 'agent_message_chunk'])
  expect(updates.at(-1)).toMatchObject({ content: { type: 'text', text: 'you are in /work' } })
  expect(ended).toBe(1)
})

test('a new session streams from its start, once its transcript appears', async () => {
  start(0)
  write(prompt, text('m1', 'hello'))
  await until(() => updates.length)
  expect(ended).toBe(0)
  write(done)
  await until(() => ended)
  expect(updates).toEqual([expect.objectContaining({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } })])
})

test('a forked session streams from its start without the conversation it copied, written before the turn began', async () => {
  const before = '2026-10-18T23:08:37.604Z'
  start(Date.parse('2026-10-18T23:11:19.000Z'))
  write({ ...prompt, timestamp: before }, { ...text('m0', 'anchors are in'), timestamp: before }, { ...done, timestamp: before })
  write({ ...prompt, timestamp: '2026-10-18T23:11:21.000Z' }, { ...text('m1', 'I said anchors are in'), timestamp: '2026-10-18T23:11:27.000Z' }, done)
  await until(() => ended)
  expect(updates).toEqual([expect.objectContaining({ content: { type: 'text', text: 'I said anchors are in' } })])
})

test('a turn_duration before the prompt is an earlier turn ending, not this one', async () => {
  start(0)
  write(done, prompt, text('m1', 'still going'))
  await until(() => updates.length)
  expect(ended).toBe(0)
})

test('a line written in two pieces is read once it is whole', async () => {
  start(0)
  const line = JSON.stringify(text('m1', 'whole')) + '\n'
  writeFileSync(path, JSON.stringify(prompt) + '\n' + line.slice(0, 20))
  await Bun.sleep(100)
  expect(updates).toEqual([])
  appendFileSync(path, line.slice(20))
  await until(() => updates.length)
  expect(updates[0]).toMatchObject({ content: { text: 'whole' } })
})

