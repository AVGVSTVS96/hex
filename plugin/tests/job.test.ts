import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'

// bin/job against a fake systemd-run that records what it was asked to run.

const HEX = join(import.meta.dir, '../..')
const home = mkdtempSync(join(tmpdir(), 'job-'))
const job = join(home, '.hex/bin/job')
const ran = join(home, 'ran.json')
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HEX_')))
const session = { HEX_CHANNEL: 'plugin:t3@hex', HEX_THREAD: 'stray-key' }

beforeAll(() => {
  cpSync(join(HEX, 'bin/job'), job)
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

function run(args: string[], more: Record<string, string> = {}) {
  rmSync(ran, { force: true })
  const done = Bun.spawnSync(['bun', job, ...args], { env: { ...env, PATH: `${join(home, 'fake')}:${env.PATH}`, ...more }, stderr: 'pipe' })
  return { code: done.exitCode, error: done.stderr.toString(), args: done.exitCode ? [] : (JSON.parse(readFileSync(ran, 'utf8')) as string[]) }
}

const value = (args: string[], name: string) => args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1)

test("a job a hex session starts is its thread's, in that session's own app, and its sessions are named for it", () => {
  const { args } = run(['round3', 'claude', '-p', 'go'], session)
  expect(args.slice(args.indexOf('--'))).toEqual(['--', 'claude', '-p', 'go'])
  expect(value(args, 'HEX_OWNER')).toBe('t3:stray-key')
  expect(value(args, 'CLAUDE_CODE_SESSION_NAME')).toBe('hex/round3')
  expect(value(args, 'ExecStopPost')).toEndWith('job --ended round3 t3:stray-key')
  expect(run(['round3', 'stray-key', 'claude'], session).args).toContain('HEX_OWNER=t3:stray-key')
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

test("a job's end wakes its owner through its own app's hub, and an older unit's bare key the one app that has it", async () => {
  const lines: Record<string, any[]> = { t3: [], discord: [] }
  const hubs = Object.keys(lines).map(app =>
    createServer(socket => socket.on('data', chunk => lines[app]!.push(...chunk.toString().trim().split('\n').map(line => JSON.parse(line))))).listen(join(home, 'state', app, 'hub.sock')),
  )
  afterAll(() => hubs.forEach(hub => hub.close()))
  await Promise.all(hubs.map(hub => new Promise(resolve => hub.once('listening', resolve))))
  const end = (...args: string[]) => Bun.spawn(['bun', job, '--ended', ...args], { env: { ...env, SERVICE_RESULT: 'success', EXIT_STATUS: '0' }, stderr: 'pipe' }).exited
  expect(await end('round3', 't3:stray-key')).toBe(0)
  expect(await end('older', '555')).toBe(0)
  expect(await end('older', 'stray-key')).toBe(2)
  while (!lines.t3!.length || !lines.discord!.length) await Bun.sleep(10)
  expect(lines.t3).toEqual([{ type: 'inbound', thread: 'stray-key', content: expect.stringContaining('[job] round3 ended: success (exit 0).'), meta: { user: 'job' } }])
  expect(lines.discord).toEqual([{ type: 'inbound', thread: '555', content: expect.stringContaining('[job] older ended'), meta: { user: 'job' } }])
})
