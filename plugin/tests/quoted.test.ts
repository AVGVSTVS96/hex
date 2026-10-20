import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { open, type Store } from '../../hub/store.ts'

const HOOK = join(import.meta.dir, '../../bin/quoted')
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HEX_')))
const KEY = 'telegram:-100:3955'
const SAID = 'openmuse isnt about their server just the app layout and agent design dont waste On things we already know'

let dir: string
let store: Store

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quoted-'))
  store = open(dir)
  store.deliver({ key: KEY, to: 'chat:1', from: 'telegram', body: SAID, meta: { user: 'avgvstvs9' } })
  store.take(KEY, 'session-1')
})
afterEach(() => rmSync(dir, { recursive: true }))

function hook(command: string, session = 'session-1') {
  const run = Bun.spawnSync([HOOK], {
    stdin: Buffer.from(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, session_id: session })),
    env: { ...env, HEX_STORE: dir, TMPDIR: dir },
  })
  expect(run.exitCode).toBe(0)
  const out = run.stdout.toString()
  return out ? (JSON.parse(out).hookSpecificOutput.permissionDecisionReason as string) : null
}
const note = (text: string) => hook(`cd ~/hex && .hex/vendor/memo note ${JSON.stringify(text)}`)

test('a note that quotes the message it names goes through', () => {
  expect(note(`Correction: the borrow is "just the app layout and agent design" [${KEY}]`)).toBeNull()
})

test('quotes match across curly quotes, case, line wraps and an ellipsis that skips words', () => {
  store.deliver({ key: 'discord:7', to: 'chat:1', from: 'discord', body: 'I don’t wanna close threads to save memory.\nI want to close and consolidate to save mental load', meta: { user: 'avgvstvs96' } })
  expect(note(`Bassim: "I don't wanna close threads … to save mental load" [discord:7]`)).toBeNull()
})

test('words the message doesn\'t say are sent back with the message, so the session can fix the note', () => {
  const why = note(`Correction: "only the server and assistant" [${KEY}]`)
  expect(why).toContain(`"only the server and assistant" isn't in [${KEY}] as written`)
  expect(why).toContain(SAID)
})

test('a note that names a message without quoting it is sent back with the message', () => {
  const why = note(`Correction: OpenMuse borrow is only its layout [${KEY}]`)
  expect(why).toContain('without quoting it')
  expect(why).toContain(SAID)
})

test('a key hex.db doesn\'t keep is sent back', () => {
  expect(note('Bassim: "app layout" [telegram:-100:1]')).toContain("[telegram:-100:1] isn't a message hex keeps")
})

test('a note without a key, after messages of the owner\'s, comes back once with them, then goes through', () => {
  const why = note('OpenMuse borrow is only its layout')
  expect(why).toContain(`[${KEY}] ${SAID}`)
  expect(why).toContain('run it again as it is')
  expect(note('OpenMuse borrow is only its layout')).toBeNull()
  expect(note('hex PR #20 live')).toBeNull()
})

test('a note quoting the message counts as answering it, so the next one without a key goes through', () => {
  expect(note(`Bassim: "just the app layout" [${KEY}]`)).toBeNull()
  expect(note('hex PR #20 live')).toBeNull()
})

test('a note without a key goes through when the session took nothing of the owner\'s', () => {
  store.deliver({ key: 'job:build:1', to: 'chat:1', from: 'job', body: '[job] build ended', meta: { user: 'job' } })
  store.deliver({ key: 'telegram:relay', to: 'chat:1', from: 'telegram', body: 'from General', meta: { user: 'hex General' } })
  store.take('job:build:1', 'session-2')
  store.take('telegram:relay', 'session-2')
  expect(hook('.hex/vendor/memo note "build ended"', 'session-2')).toBeNull()
})

test('a tap in hex\'s app is the owner\'s', () => {
  store.deliver({ key: 'telegram:tap', to: 'chat:1', from: 'telegram', body: 'Pick it up', meta: { user: 'hex app' } })
  store.take('telegram:tap', 'session-3')
  expect(hook('.hex/vendor/memo note "OpenMuse picked up"', 'session-3')).toContain('[telegram:tap] Pick it up')
})

test('the note is read the way the shell passes it', () => {
  expect(hook(`.hex/vendor/memo note 'Correction: "just the app layout" [${KEY}]' && git commit`)).toBeNull()
  expect(hook(`.hex/vendor/memo note "Correction: \\"just the app layout\\" [${KEY}]"`)).toBeNull()
  expect(hook(`.hex/vendor/memo note "Correction: \\"just the server\\" [${KEY}]"`)).toContain('isn\'t in')
})

test('commands that aren\'t a note, and notes built at run time, are left alone', () => {
  expect(hook('git status')).toBeNull()
  expect(hook('.hex/vendor/memo note "$(cat note.txt)"')).toBeNull()
  expect(hook('.hex/vendor/memo recall OpenMuse')).toBeNull()
})
