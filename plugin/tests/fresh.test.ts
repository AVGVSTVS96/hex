import { beforeEach, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const BIN = join(import.meta.dir, '../../bin')

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'fresh-'))
  mkdirSync(join(home, 'bin'))
  mkdirSync(join(home, 'channels/hub'), { recursive: true })
  for (const script of ['fresh', 'context-size']) copyFileSync(join(BIN, script), join(home, 'bin', script))
  writeFileSync(join(home, 'channels/hub/fresh.ts'), `require('fs').writeFileSync('${home}/asked', process.env.HEX_THREAD ?? '')\n`)
})

function hook(tokens: number, input: object = {}, env: Record<string, string> = { HEX_FRESH_AT: '500000', HEX_MAIN: '1', HEX_THREAD: 'chat' }) {
  const transcript = join(home, 'transcript.jsonl')
  writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { model: 'claude', usage: { input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + '\n')
  const run = Bun.spawnSync([join(home, 'bin/fresh')], {
    stdin: Buffer.from(JSON.stringify({ transcript_path: transcript, stop_hook_active: false, background_tasks: [], ...input })),
    env: { PATH: process.env.PATH!, ...env },
  })
  expect(run.exitCode).toBe(0)
  return run.stdout.toString()
}

const asked = () => existsSync(join(home, 'asked'))

test('is off unless HEX_FRESH_AT is set, and only ever acts in General', () => {
  expect(hook(900_000, {}, { HEX_MAIN: '1', HEX_THREAD: 'chat' })).toBe('')
  expect(hook(900_000, {}, { HEX_FRESH_AT: '500000', HEX_THREAD: 'chat:7' })).toBe('')
  expect(asked()).toBe(false)
})

test('does nothing while the context is under the line', () => {
  expect(hook(499_999)).toBe('')
  expect(asked()).toBe(false)
})

test('a full General first saves what is in flight to memory', () => {
  const { decision, reason } = JSON.parse(hook(512_000))
  expect(decision).toBe('block')
  expect(reason).toContain('512k tokens')
  expect(reason).toContain('.hex/vendor/memo note')
  expect(asked()).toBe(false)
})

test('then asks the hub for a fresh session', () => {
  expect(hook(530_000, { stop_hook_active: true })).toBe('')
  expect(readFileSync(join(home, 'asked'), 'utf8')).toBe('chat')
})

test('waits while background work could still wake the session', () => {
  expect(hook(530_000, { stop_hook_active: true, background_tasks: [{ id: 'a1', type: 'subagent', status: 'running', description: 'research' }] })).toBe('')
  expect(hook(530_000, { background_tasks: [{ id: 'a1', type: 'subagent', status: 'running', description: 'research' }] })).toBe('')
  expect(asked()).toBe(false)
})
