import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { Database } from 'bun:sqlite'
import { tmpdir } from 'os'
import { join } from 'path'

// bin/job against a fake systemd-run that records what it was asked to run.

const HEX = join(import.meta.dir, '../..')
const home = mkdtempSync(join(tmpdir(), 'job-'))
const job = join(home, '.hex/bin/job')
const ran = join(home, 'ran.json')
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HEX_') && !['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CONFIG_DIR'].includes(name)))
const session = { HEX_CHANNEL: 'plugin:t3@hex', HEX_THREAD: 'stray-key' }

beforeAll(() => {
  for (const file of ['bin/job', 'bin/hex', 'bin/handoff', 'bin/log', 'bin/session', 'hub/cli.ts', 'hub/fit.ts', 'hub/notes.ts', 'hub/profile.ts', 'hub/store.ts']) cpSync(join(HEX, file), join(home, '.hex', file))
  for (const [app, threads] of Object.entries({
    t3: { 'stray-key': { name: 'hex' } },
    telegram: { 'stray-key': { name: 'stray-key' }, '-100123:908': { name: 'autofork' } },
    discord: { '555': { name: 'fix hex NOW' } },
  })) {
    mkdirSync(join(home, 'state', app), { recursive: true })
    writeFileSync(join(home, 'state', app, 'threads.json'), JSON.stringify(threads))
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

test('an agent job runs as a hex session in the hex folder, with the folder it was started from added', () => {
  const here = run(['deck', 'claude', '-p', 'build it', '--model', 'opus'], session)
  expect(here.args).toContain(`--working-directory=${home}`)
  expect(here.args).not.toContain('--same-dir')
  expect(here.args.slice(here.args.indexOf('--'))).toEqual(['--', join(home, '.hex/bin/session'), '-p', 'build it', '--model', 'opus'])
  const project = mkdtempSync(join(home, 'deck-'))
  const away = run(['deck', 'claude', '-p', 'build it'], session, project)
  expect(away.args).toContain(`--working-directory=${home}`)
  expect(away.args.slice(away.args.indexOf('--'))).toEqual(['--', join(home, '.hex/bin/session'), '-p', 'build it', '--add-dir', project])
  expect(Buffer.from(value(away.args, 'StandardInputData')!, 'base64').toString()).toBe(`\n\nThis work is in ${project}: run its commands there.`)
  const piped = run(['deck', 'claude', '-p'], session, home, 'Build the Usage tab.\n')
  expect(Buffer.from(value(piped.args, 'StandardInputData')!, 'base64').toString()).toBe('Build the Usage tab.\n')
})

test('Claude started any other way still runs, with how to start it as a hex session', () => {
  const { args, error } = run(['deck', 'sh', '-c', 'cd deck && claude -p go'], session)
  expect(args.slice(args.indexOf('--'))).toEqual(['--', 'sh', '-c', 'cd deck && claude -p go'])
  expect(error).toContain('job deck claude -p "<prompt>"')
  expect(run(['build', 'rm', '-rf', '.claude/worktrees/old'], session).error).toBe('')
})

test("a job a job session starts is its owner's too", () => {
  expect(value(run(['inner', 'make'], { HEX_OWNER: 'discord:555' }).args, 'HEX_OWNER')).toBe('discord:555')
})

test('an agent job gets the conversation behind it after its prompt, as any other agent a session hands work to', () => {
  const id = 'a4d76227-0000-4000-8000-000000000000'
  const config = join(home, 'config')
  mkdirSync(join(config, 'projects/-home-hex'), { recursive: true })
  const said = { type: 'user', message: { content: '<channel source="plugin:t3:t3" user="me" user_id="1">run it as a hex session</channel>' }, timestamp: new Date(Date.UTC(2026, 9, 20, 7, 17)).toISOString() }
  writeFileSync(join(config, `projects/-home-hex/${id}.jsonl`), JSON.stringify(said) + '\n')
  const caller = { ...session, CLAUDE_CODE_SESSION_ID: id, CLAUDE_CONFIG_DIR: config, HEX_STORE: join(home, 'state'), TZ: 'UTC' }
  const told = Buffer.from(value(run(['deck', 'claude', '-p', 'go'], caller).args, 'StandardInputData')!, 'base64').toString()
  const log = join(home, 'log/threads/2026-10-20-a4d76227.md')
  expect(told).toStartWith('\n\n---\nThis work comes from a conversation in hex.')
  expect(told).toContain(`is in ${log}, kept current`)
  expect(readFileSync(log, 'utf8')).toContain('run it as a hex session')
  expect(value(run(['build', 'make'], caller).args, 'StandardInputData')).toBeUndefined()
  expect(value(run(['deck', 'claude', '-p', 'go'], session).args, 'StandardInputData')).toBeUndefined()
})

test("a job session's log is hex's words, kept with the threads, not the owner's", () => {
  const transcript = join(home, 'job.jsonl')
  writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: 'Build the deck tab.' }, timestamp: new Date(Date.UTC(2026, 9, 20, 7, 30)).toISOString() }) + '\n')
  const input = JSON.stringify({ session_id: 'b5e87338-0000-4000-8000-000000000000', transcript_path: transcript })
  const logged = Bun.spawnSync([join(home, '.hex/bin/log'), 'path'], { stdin: Buffer.from(input), env: { ...env, TZ: 'UTC', HEX_OWNER: 't3:stray-key' } })
  expect(logged.stdout.toString().trim()).toBe(join(home, 'log/threads/2026-10-20-b5e87338.md'))
  expect(readFileSync(join(home, 'log/threads/2026-10-20-b5e87338.md'), 'utf8')).toContain('## hex · terminal')
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
