import { afterEach, beforeEach, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { open } from '../../hub/store.ts'

let home: string
let bin: string

const sh = (...cmd: string[]) => expect(Bun.spawnSync(cmd, { cwd: home }).exitCode).toBe(0)

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'live-status-'))
  bin = mkdtempSync(join(tmpdir(), 'live-status-bin-'))
  mkdirSync(join(home, '.hex/bin'), { recursive: true })
  copyFileSync(join(import.meta.dir, '../../bin/live-status'), join(home, '.hex/bin/live-status'))
  copyFileSync(join(import.meta.dir, '../../bin/hex'), join(home, '.hex/bin/hex'))
  symlinkSync(join(import.meta.dir, '../../hub'), join(home, '.hex/hub'))
  const commit = (msg: string) => sh('git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', msg)
  sh('git', 'init', '-q', '-b', 'trunk')
  commit('first')
  sh('git', 'branch', 'shipped')
  sh('git', 'switch', '-q', '-c', 'idea')
  commit('Try an idea')
  sh('git', 'switch', '-q', 'trunk')
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(bin, { recursive: true, force: true })
})

// Running Claude Code sessions, as Claude Code records them while their process lives.
function running(sessions: object[]) {
  mkdirSync(join(home, '.claude/sessions'), { recursive: true })
  sessions.forEach((session, n) => writeFileSync(join(home, `.claude/sessions/${n}.json`), JSON.stringify({ pid: process.pid, sessionId: `${n}0000000-s`, ...session })))
}

function hook() {
  const run = Bun.spawnSync([join(home, '.hex/bin/live-status')], {
    stdin: Buffer.from(JSON.stringify({ source: 'startup' })),
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, TZ: 'UTC' },
  })
  expect(run.exitCode).toBe(0)
  expect(run.stderr.toString()).toBe('')
  return run.stdout.toString()
}

test('finds its hex folder from .hex/bin and lists unmerged branches, one-off jobs and background sessions', () => {
  writeFileSync(join(home, 'schedules.json'), JSON.stringify({
    heartbeat: { cron: '45 * * * *', prompt: 'x' },
    dentist: { cron: '30 9 14 3 *', prompt: 'x' },
    treat: { at: ['2020-10-20 16:00', '2999-10-20 16:00'], prompt: 'x' },
  }))
  running([
    { kind: 'bg', status: 'busy', name: 'General', cwd: home, startedAt: 2 },
    { kind: 'bg', status: 'busy', name: 'Topic', cwd: join(home, 'sub'), startedAt: 3 },
    { kind: 'bg', status: 'idle', name: 'Elsewhere', cwd: `${home}-other`, startedAt: 1 },
    { kind: 'interactive', status: 'busy', name: 'Terminal', cwd: home, startedAt: 1 },
    { kind: 'bg', status: 'busy', name: 'Gone', cwd: home, startedAt: 4, pid: 2 ** 22 + 1 },
  ])
  const out = hook()
  expect(out).toContain('- idea (0m ago): Try an idea')
  expect(out).not.toContain('shipped')
  expect(out).toMatch(/- \w{3} Mar 14 9:30AM: dentist/)
  expect(out).toMatch(/- \w{3} Oct 20 4:00PM: treat\n/)
  expect(out.match(/: treat/g)).toHaveLength(1)
  expect(out).not.toContain('heartbeat')
  expect(out).toContain('- busy (2): Topic, General')
  expect(out).not.toContain('Elsewhere')
  expect(out).not.toContain('Gone')
  expect(out).not.toContain('Terminal')
})

test("lists each thread active in the last day with its last message, skipping what only the terminal saw", () => {
  const store = open(join(home, 'state'))
  store.keepThreads('telegram', { '1': { name: 'Garden', session: 'aaaaaaaa-1' }, '2': { name: 'Stale', session: 'bbbbbbbb-1' } })
  store.keepThreads('discord', { '3': { name: 'Kiln', session: 'cccccccc-1' } })
  const said = (key: string, to: string, author: string, body: string, minutesAgo: number) => {
    store.deliver({ key, to, from: key.split(':')[0]!, author, body }, 'x')
    store.db.query('update messages set at = ? where key = ?').run(new Date(Date.now() - minutesAgo * 60_000).toISOString(), key)
  }
  said('telegram:1', '1', 'owner', 'water the beds?', 90)
  said('telegram:2', '1', 'hex', '**Done.** Beds watered.\n## not a header', 89)
  said('terminal:1', '1', 'hex', 'watered', 88)
  said('telegram:3', '2', 'owner', 'old', 3000)
  said('discord:4', '3', 'owner', 'fire it\nat noon', 5)
  running([{ kind: 'bg', status: 'busy', sessionId: 'cccccccc-1', cwd: home }])
  const out = hook()
  expect(out).toContain('- Kiln (discord, busy, 5m ago) owner: fire it at noon\n- Garden (telegram, 1h ago) hex: Done. Beds watered. ## not a header\n')
  expect(out).not.toContain('Stale')
})

test('drops a section it cannot read, and says none for one that is empty', () => {
  writeFileSync(join(home, 'schedules.json'), JSON.stringify({ broken: { cron: '0 9 31 2 *' } }))
  const out = hook()
  expect(out).toContain('Unmerged hex branches')
  expect(out).not.toContain('Upcoming one-off jobs')
  expect(out).toContain('background sessions running, by status (`hex running`):\n- none')
})

test('stays quiet and exits 0 when neither git nor claude can run', () => {
  const only = join(bin, 'only')
  mkdirSync(only)
  symlinkSync(Bun.which('python3')!, join(only, 'python3'))
  const run = Bun.spawnSync([join(home, '.hex/bin/live-status')], {
    stdin: Buffer.from('{}'),
    env: { PATH: only, CLAUDE_PROJECT_DIR: join(home, 'missing') },
  })
  expect(run.exitCode).toBe(0)
  expect(run.stderr.toString()).toBe('')
  expect(run.stdout.toString()).not.toContain('Unmerged hex branches')
})
