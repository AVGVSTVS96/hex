import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { Database } from 'bun:sqlite'
import { tmpdir } from 'os'
import { join } from 'path'
import { open } from '../../hub/store.ts'

// bin/job against a fake systemd-run that records what it was asked to run.

const HEX = join(import.meta.dir, '../..')
const home = mkdtempSync(join(tmpdir(), 'job-'))
const job = join(home, '.hex/bin/job')
const ran = join(home, 'ran.json')
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HEX_') && !['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CONFIG_DIR'].includes(name)))
const session = { HEX_CHANNEL: 'plugin:t3@hex', HEX_THREAD: 'stray-key' }

beforeAll(() => {
  for (const file of ['bin/job', 'bin/hex', 'bin/session', 'hub/cli.ts', 'hub/fit.ts', 'hub/notes.ts', 'hub/tasks.ts', 'hub/schedule.ts', 'hub/clock.ts', 'hub/store.ts']) cpSync(join(HEX, file), join(home, '.hex', file))
  for (const [app, threads] of Object.entries({
    t3: { 'stray-key': { name: 'hex' } },
    telegram: { 'stray-key': { name: 'stray-key' }, '-100123:908': { name: 'autofork' } },
    discord: { '555': { name: 'fix hex NOW' } },
  })) {
    open(join(home, 'state')).keepThreads(app, threads)
  }
  mkdirSync(join(home, 'fake'))
  writeFileSync(join(home, 'fake/systemd-run'), `#!/bin/sh\njq -cn '$ARGS.positional' --args -- "$@" > "${ran}"\n`)
  chmodSync(join(home, 'fake/systemd-run'), 0o755)
})
afterAll(() => rmSync(home, { recursive: true }))

function run(args: string[], more: Record<string, string> = {}, cwd = home, stdin = '') {
  rmSync(ran, { force: true })
  const done = Bun.spawnSync(['bun', job, ...args], { cwd, stdin: Buffer.from(stdin), env: { ...env, PATH: `${join(home, 'fake')}:${env.PATH}`, ...more }, stderr: 'pipe' })
  return { code: done.exitCode, error: done.stderr.toString(), args: done.exitCode ? [] : (JSON.parse(readFileSync(ran, 'utf8')) as string[]) }
}

const value = (args: string[], name: string) => args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1)

test("a job a hex session starts is its thread's, in that session's own app, and its sessions are named for it", () => {
  const { args, error } = run(['round3', 'make', 'all'], session)
  expect(args.slice(args.indexOf('--'))).toEqual(['--', 'make', 'all'])
  expect(args).toContain('--same-dir')
  expect(error).toBe('')
  expect(value(args, 'HEX_OWNER')).toBe('t3:stray-key')
  expect(value(args, 'CLAUDE_CODE_SESSION_NAME')).toBe('hex/round3')
  expect(value(args, 'ExecStopPost')).toEndWith('job --ended round3 t3:stray-key')
  expect(run(['round3', 'stray-key', 'claude'], session).args).toContain('HEX_OWNER=t3:stray-key')
})

test('an agent job runs as a hex session in the folder it was started from', () => {
  const priced = run(['deck', 'claude', '-p', 'cost $5 in $HOME'], session).args
  expect(priced.at(-1)).toBe('cost $$5 in $$HOME')
  const project = mkdtempSync(join(home, 'deck-'))
  const away = run(['deck', 'claude', '-p', 'build it', '--model', 'opus'], session, project)
  expect(away.args).toContain('--same-dir')
  expect(away.args.slice(away.args.indexOf('--'))).toEqual(['--', join(home, '.hex/bin/session'), '-n', 'hex/deck', '-p', 'build it', '--model', 'opus'])
  expect(value(away.args, 'StandardInputData')).toBeUndefined()
  const piped = run(['deck', 'claude', '-p'], session, home, 'Build the Usage tab.\n')
  expect(Buffer.from(value(piped.args, 'StandardInputData')!, 'base64').toString()).toBe('Build the Usage tab.\n')
})

test('a shell that would run Claude is told how to start it as a hex session', () => {
  expect(run(['deck', 'sh', '-c', 'cd deck && claude -p go'], session).error).toContain('job deck claude -p "<prompt>"')
  expect(run(['build', 'rm', '-rf', '.claude/worktrees/old'], session).error).toBe('')
})

test("a job a job session starts is its owner's too", () => {
  expect(value(run(['inner', 'make'], { HEX_OWNER: 'discord:555' }).args, 'HEX_OWNER')).toBe('discord:555')
})

test("a job session's prompt is hex's words in hex.db, its answer too, what the owner types in a terminal or into the job is theirs, and an app session's terminal words are kept as unsent", () => {
  const state = join(home, 'state')
  const hook = (step: string, input: object, extra: Record<string, string> = {}) =>
    Bun.spawnSync(['bun', join(HEX, step === 'busy' ? 'hub/state.ts' : 'hub/observe.ts'), step], { stdin: Buffer.from(JSON.stringify(input)), env: { ...env, HEX_STORE: state, MEMORY_DIR: '', ...extra } })
  hook('busy', { session_id: 'job-1', prompt: 'Build the deck tab.' }, { HEX_OWNER: 't3:stray-key' })
  hook('idle', { hook_event_name: 'Stop', session_id: 'job-1', last_assistant_message: 'Built.' }, { HEX_OWNER: 't3:stray-key' })
  hook('busy', { session_id: 'job-1', prompt: 'make the tab blue' }, { HEX_OWNER: 't3:stray-key' })
  hook('busy', { session_id: 'mine-1', prompt: 'what is up' })
  hook('busy', { session_id: 'mine-1', prompt: '<task-notification>done</task-notification>' })
  hook('busy', { session_id: 'mine-1', prompt: '<agent-message from="a1">merged</agent-message>' })
  hook('busy', { session_id: 'mine-1', prompt: '<cross-session-message from="s2">done</cross-session-message>' })
  hook('busy', { session_id: 'mine-1', prompt: '<teammate-message teammate_id="t1">hi</teammate-message>' })
  hook('busy', { session_id: 'mine-1', prompt: '/compact' })
  hook('idle', { hook_event_name: 'Stop', session_id: 'chat-1', last_assistant_message: 'narration' }, { HEX_CHANNEL: 'plugin:telegram@hex', HEX_THREAD: '-100:1' })
  const rows = open(state).since().map(({ to, from, author, body, taken }) => ({ to, from, author, body, by: taken?.by }))
  expect(rows).toEqual([
    { to: 'job-1', from: 'terminal', author: 'prompt', body: 'Build the deck tab.', by: 'job-1' },
    { to: 'job-1', from: 'terminal', author: 'hex', body: 'Built.', by: 'job-1' },
    { to: 'job-1', from: 'terminal', author: 'owner', body: 'make the tab blue', by: 'job-1' },
    { to: 'mine-1', from: 'terminal', author: 'owner', body: 'what is up', by: 'mine-1' },
    { to: '-100:1', from: 'terminal', author: 'hex', body: 'narration', by: 'chat-1' },
  ])
  expect(open(state).said('-100:1')[0]?.meta).toEqual({ session: 'chat-1', unsent: 'true' })
})

test("a named owner is a key in one app's list, or <app>:<key>; a key in two lists is refused instead of guessed", () => {
  expect(value(run(['build', '-100123:908', 'make'], session).args, 'HEX_OWNER')).toBe('telegram:-100123:908')
  expect(value(run(['build', 'discord:555', 'make']).args, 'HEX_OWNER')).toBe('discord:555')
  expect(value(run(['build', '555', 'make']).args, 'CLAUDE_CODE_SESSION_NAME')).toBe('fix hex NOW/build')
  const twice = run(['build', 'stray-key', 'make'])
  expect(twice.code).toBe(2)
  expect(twice.error).toContain('stray-key is a thread in t3 and telegram')
  expect(value(run(['build', 'telegram:stray-key', 'make']).args, 'HEX_OWNER')).toBe('telegram:stray-key')
})

test('a job with no owner, or no command, is refused', () => {
  expect(run(['build', 'make']).code).toBe(2)
  expect(run(['build'], session).code).toBe(2)
})

test("a job's end is kept for its owner's app while no hub runs, and an older unit's bare key goes to the one app that has it", async () => {
  const end = (...args: string[]) => Bun.spawn(['bun', job, '--ended', ...args], { env: { ...env, SERVICE_RESULT: 'success', EXIT_STATUS: '0' }, stderr: 'pipe' }).exited
  expect(await end('round3', 't3:stray-key')).toBe(0)
  expect(await end('older', '555')).toBe(0)
  expect(await end('older', 'stray-key')).toBe(2)
  expect(await end('topic', '-100123:908')).toBe(0)
  const rows = new Database(join(home, 'state/hex.db')).query('select "to", "from", body, meta from messages where taken_at is null order by rowid').all()
  expect(rows).toEqual([
    { to: 'stray-key', from: 't3', body: expect.stringContaining('[job] round3 ended: success (exit 0).'), meta: JSON.stringify({ user: 'job' }) },
    { to: '555', from: 'discord', body: expect.stringContaining('[job] older ended'), meta: JSON.stringify({ user: 'job' }) },
    { to: '-100123:908', from: 'telegram', body: expect.stringContaining('[job] topic ended'), meta: JSON.stringify({ user: 'job' }) },
  ])
})
