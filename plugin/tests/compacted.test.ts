import { beforeEach, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const BIN = join(import.meta.dir, '../../bin')
const SESSION = 'addfa113-0000-4000-8000-000000000000'
const LIMIT = 10_000

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'compacted-'))
  mkdirSync(join(home, '.hex/bin'), { recursive: true })
  mkdirSync(join(home, '.hex/vendor'))
  for (const script of ['compacted', 'log']) copyFileSync(join(BIN, script), join(home, '.hex/bin', script))
})

function memo(output: string) {
  writeFileSync(join(home, 'wake.txt'), output)
  writeFileSync(join(home, '.hex/vendor/memo'), `#!/bin/sh\n[ "$1" = wake ] && cat "${home}/wake.txt"\n`)
  chmodSync(join(home, '.hex/vendor/memo'), 0o755)
}

function transcript(turns: [string, string][]) {
  const at = (i: number) => new Date(Date.UTC(2026, 9, 6, 16, i)).toISOString()
  const lines = turns.map(([who, text], i) =>
    who === 'me'
      ? { type: 'user', message: { content: text }, timestamp: at(i) }
      : { type: 'assistant', message: { content: [{ type: 'text', text }] }, timestamp: at(i) })
  lines.push({ type: 'user', isCompactSummary: true, message: { content: 'This session is being continued…' }, timestamp: at(turns.length) } as any)
  const path = join(home, 'transcript.jsonl')
  writeFileSync(path, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  return path
}

function hook(part: 'memory' | 'turns', transcriptPath = join(home, 'none.jsonl'), env: Record<string, string> = {}) {
  const run = Bun.spawnSync([join(home, '.hex/bin/compacted'), part], {
    cwd: home,
    stdin: Buffer.from(JSON.stringify({ session_id: SESSION, transcript_path: transcriptPath, source: 'compact' })),
    env: { ...process.env, CLAUDE_PROJECT_DIR: home, MEMORY_DIR: join(home, 'memory'), TMPDIR: home, TZ: 'UTC', HEX_THREAD: '', HEX_MAIN: '', ...env },
  })
  expect(run.exitCode).toBe(0)
  const out = run.stdout.toString()
  expect(out.trim().length).toBeLessThanOrEqual(LIMIT)
  return out
}

test('puts all of wake back when it fits', () => {
  const wake = '#0 2026-10-06 First note.\n#1 2026-10-06 Second note.\nYou are awake.\n'
  memo(wake)
  const out = hook('memory')
  expect(out).toContain('compacted')
  expect(out.endsWith(wake)).toBe(true)
})

test('a wake too long for the hook is cut at a line, and the session is told exactly where the rest is', () => {
  const lines = Array.from({ length: 120 }, (_, i) => `#${i} 2026-10-06 ${'x'.repeat(180)}`)
  const wake = [...lines, 'Not awake yet. Run: memo wake 2 240'].join('\n') + '\n'
  memo(wake)
  const out = hook('memory')
  const pointer = out.match(/from line (\d+) of (\S+), and/)!
  const rest = readFileSync(pointer[2], 'utf8').split('\n').slice(Number(pointer[1]) - 1).join('\n')
  const shown = out.split('\n\n').slice(1, -1).join('\n\n')
  expect(shown + '\n' + rest).toBe(wake)
  expect(rest).toContain('Not awake yet')
})

test('says nothing when OptMem is not installed', () => {
  expect(hook('memory')).toBe('')
})

test('brings back the whole conversation when it fits, without the compact summary', () => {
  const out = hook('turns', transcript([['me', 'hi'], ['assistant', 'hey'], ['me', 'what is up']]))
  expect(out).toContain('the whole conversation so far')
  expect(out).toContain('## me · terminal · 2026-10-06 16:00\n\nhi')
  expect(out).toContain('## me · terminal · 2026-10-06 16:02\n\nwhat is up')
  expect(out).not.toContain('being continued')
})

test('brings back the last whole turns of a long conversation, and points to the earlier ones', () => {
  const turns = Array.from({ length: 40 }, (_, i): [string, string] => [i % 2 ? 'assistant' : 'me', `turn ${i} ${'y'.repeat(600)}`])
  const out = hook('turns', transcript(turns))
  const pointer = out.match(/from line (\d+) of (log\/\S+\.md)\. Earlier turns are above it there\./)!
  const log = readFileSync(join(home, pointer[2]), 'utf8').split('\n')
  expect(log[Number(pointer[1]) - 1]).toMatch(/^## (me|assistant) · /)
  expect(out.endsWith(log.slice(Number(pointer[1]) - 1).join('\n'))).toBe(true)
  expect(out).toContain('turn 39')
  expect(out).not.toContain('turn 20 ')
})

test('logs relays under their sender and only channel messages with a user_id as me', () => {
  const out = hook('turns', transcript([
    ['me', '<channel source="plugin:telegram:telegram" chat_id="1" user="ada" user_id="1001">ping me every minute</channel>'],
    ['me', '<channel source="plugin:telegram:telegram" user="watcher">Verified problems, fix them</channel>'],
    ['me', '<channel source="plugin:telegram:telegram" user="hex General">Bassim said, word for word</channel>'],
  ]))
  expect(out).toContain('## me · telegram · 2026-10-06 16:00\n\nping me every minute')
  expect(out).toContain('## watcher · telegram · 2026-10-06 16:01\n\nVerified problems')
  expect(out).toContain('## hex General · telegram · 2026-10-06 16:02\n\nBassim said')
})

test('a thread logs the prompt that opened it as hex, not me', () => {
  const out = hook('turns', transcript([['me', 'You own the input device topic'], ['assistant', 'on it']]), { HEX_THREAD: '42' })
  expect(out).toContain('## hex · terminal · 2026-10-06 16:00\n\nYou own the input device topic')
})

test('a T3 thread logs what I type there as me', () => {
  const out = hook('turns', transcript([['me', 'try the sidebar again'], ['assistant', 'on it']]), { HEX_THREAD: '42', HEX_CHANNEL: 'plugin:t3@hex' })
  expect(out).toContain('## me · terminal · 2026-10-06 16:00\n\ntry the sidebar again')
})
