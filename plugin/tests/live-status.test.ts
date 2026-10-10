import { beforeEach, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let home: string
let bin: string

const sh = (...cmd: string[]) => expect(Bun.spawnSync(cmd, { cwd: home }).exitCode).toBe(0)

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'live-status-'))
  bin = mkdtempSync(join(tmpdir(), 'live-status-bin-'))
  mkdirSync(join(home, '.hex/bin'), { recursive: true })
  copyFileSync(join(import.meta.dir, '../../bin/live-status'), join(home, '.hex/bin/live-status'))
  const commit = (msg: string) => sh('git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', msg)
  sh('git', 'init', '-q', '-b', 'trunk')
  commit('first')
  sh('git', 'branch', 'shipped')
  sh('git', 'switch', '-q', '-c', 'idea')
  commit('Try an idea')
  sh('git', 'switch', '-q', 'trunk')
})

function claude(agents: object[] | string) {
  const out = typeof agents === 'string' ? agents : JSON.stringify(agents)
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncat <<'END'\n${out}\nEND\n`)
  chmodSync(join(bin, 'claude'), 0o755)
}

function hook() {
  const run = Bun.spawnSync([join(home, '.hex/bin/live-status')], {
    stdin: Buffer.from(JSON.stringify({ source: 'startup' })),
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home },
  })
  expect(run.exitCode).toBe(0)
  expect(run.stderr.toString()).toBe('')
  return run.stdout.toString()
}

test('finds its hex folder from .hex/bin and lists unmerged branches, one-off jobs and background sessions', () => {
  writeFileSync(join(home, 'schedules.json'), JSON.stringify({
    heartbeat: { cron: '45 * * * *', prompt: 'x' },
    dentist: { cron: '30 9 14 3 *', prompt: 'x' },
  }))
  claude([
    { kind: 'background', state: 'working', name: 'General', cwd: home, startedAt: 2 },
    { kind: 'background', state: 'working', name: 'Topic', cwd: join(home, 'sub'), startedAt: 3 },
    { kind: 'background', state: 'blocked', name: 'Elsewhere', cwd: `${home}-other`, startedAt: 1 },
    { kind: 'interactive', state: 'working', name: 'Terminal', cwd: home, startedAt: 1 },
  ])
  const out = hook()
  expect(out).toContain('- idea (0m ago): Try an idea')
  expect(out).not.toContain('shipped')
  expect(out).toMatch(/- \w{3} Mar 14 9:30AM: dentist/)
  expect(out).not.toContain('heartbeat')
  expect(out).toContain('- working (2): Topic, General')
  expect(out).not.toContain('Elsewhere')
  expect(out).not.toContain('Terminal')
})

test('drops a section it cannot read, and says none for one that is empty', () => {
  writeFileSync(join(home, 'schedules.json'), JSON.stringify({ broken: { cron: '0 9 31 2 *' } }))
  claude('not json')
  const out = hook()
  expect(out).toContain('Unmerged hex branches')
  expect(out).not.toContain('Upcoming one-off jobs')
  expect(out).not.toContain('background sessions')
})

test('stays quiet and exits 0 when neither git nor claude can run', () => {
  const only = mkdtempSync(join(tmpdir(), 'live-status-path-'))
  symlinkSync(Bun.which('python3')!, join(only, 'python3'))
  const run = Bun.spawnSync([join(home, '.hex/bin/live-status')], {
    stdin: Buffer.from('{}'),
    env: { PATH: only, CLAUDE_PROJECT_DIR: join(home, 'missing') },
  })
  expect(run.exitCode).toBe(0)
  expect(run.stderr.toString()).toBe('')
  expect(run.stdout.toString()).not.toContain('Unmerged hex branches')
})
