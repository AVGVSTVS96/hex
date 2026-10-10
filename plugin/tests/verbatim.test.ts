import { beforeEach, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SESSION = '8e990b61-0000-4000-8000-000000000000'
const BUZZ_THREAD = '3d5506629e8b'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'verbatim-'))
  mkdirSync(join(home, '.hex/bin'), { recursive: true })
  mkdirSync(join(home, '.hex/vendor'))
  mkdirSync(join(home, 'state/buzz'), { recursive: true })
  writeFileSync(join(home, 'state/buzz/threads.json'), JSON.stringify({ [BUZZ_THREAD]: { name: 'Context check' } }))
  copyFileSync(join(import.meta.dir, '../../bin/verbatim'), join(home, '.hex/bin/verbatim'))
  writeFileSync(join(home, '.hex/vendor/memo'), `#!/bin/sh
[ "$1" = config ] && echo 'ENTRY_CHARS  280     the longest one memory may be, in bytes' && exit
[ "$1" = note ] && printf '%s\\n' "$2" >> "${home}/notes" && echo 'Compress memories #0-1 into one line.'
`)
  chmodSync(join(home, '.hex/vendor/memo'), 0o755)
  writeFileSync(join(home, 'transcript.jsonl'), JSON.stringify({ type: 'user', timestamp: '2026-10-09T12:00:00.000Z' }) + '\n')
})

const channel = (attrs: Record<string, string>, text: string) =>
  `<channel ${Object.entries({ source: 'plugin:buzz:buzz', chat_id: 'c1', message_id: 'm1', ...attrs }).map(([k, v]) => `${k}="${v}"`).join(' ')}>\n${text}\n</channel>`

function hook(prompt: string, env: Record<string, string> = {}) {
  const run = Bun.spawnSync([join(home, '.hex/bin/verbatim')], {
    stdin: Buffer.from(JSON.stringify({ session_id: SESSION, transcript_path: join(home, 'transcript.jsonl'), prompt })),
    env: { ...process.env, CLAUDE_PROJECT_DIR: home, MEMORY_DIR: join(home, 'memory'), HEX_VERBATIM: '1', HEX_THREAD: BUZZ_THREAD, HEX_MAIN: '', ...env },
  })
  expect(run.exitCode).toBe(0)
  expect(run.stdout.toString()).toBe('')
  return notes()
}

const notes = () => (existsSync(join(home, 'notes')) ? readFileSync(join(home, 'notes'), 'utf8').trimEnd().split('\n') : [])
const date = (iso: string) => new Date(iso).toLocaleDateString('sv')

test('saves his message word for word, signed with app, thread, time and its log file', () => {
  const [line] = hook(channel({ user: 'bassim', user_id: 'u1', message_id: '05be3eb354e72f4424de', ts: '2026-10-10T02:02:56.000Z' }, 'save   this\nexactly,  please'), { TZ: 'America/Los_Angeles' })
  expect(line).toBe(`save this exactly, please — Bassim, buzz Context check, 2026-10-09 19:02, log/threads/${date('2026-10-09T12:00:00Z')}-8e990b61.md #05be3eb354e7`)
})

test('names General and its log folder in the main session', () => {
  const [line] = hook(channel({ source: 'plugin:telegram:telegram', user_id: 'u1' }, 'hi'), { HEX_MAIN: '1' })
  expect(line).toMatch(/^hi — Bassim, telegram General, .*, log\/\d{4}-\d\d-\d\d-8e990b61\.md #m1$/)
})

test('cuts a long message at a word to fit memo\'s byte limit', () => {
  const [line] = hook(channel({ user_id: 'u1' }, 'é '.repeat(300)))
  expect(Buffer.byteLength(line!)).toBeLessThanOrEqual(280)
  expect(line).toMatch(/^(é )+é… — Bassim/)
})

test('skips relays from other sessions, reactions and plain prompts', () => {
  expect(hook(channel({ user: 'hex General' }, 'relayed'))).toEqual([])
  expect(hook(channel({ user_id: 'u1', reaction: '👍' }, '(reaction: 👍)'))).toEqual([])
  expect(hook('[heartbeat] check mail')).toEqual([])
})

test('saves a message delivered twice once, and an edit again', () => {
  hook(channel({ user_id: 'u1' }, 'once'))
  hook(channel({ user_id: 'u1' }, 'once'))
  expect(hook(channel({ user_id: 'u1', edited: 'true' }, 'once, edited'))).toHaveLength(2)
})

test('does nothing unless HEX_VERBATIM=1', () => {
  expect(hook(channel({ user_id: 'u1' }, 'hi'), { HEX_VERBATIM: '' })).toEqual([])
})
