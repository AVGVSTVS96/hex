import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Run } from './board.ts'
import { jobs, jobsOf, lasted, overall } from './overall.ts'

const now = Date.parse('2026-11-05T20:00:00Z')
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString()

function run(name: string, more: Partial<Run> = {}): Run {
  return { id: `telegram:${name}`, app: 'telegram', thread: name, name, where: 'Telegram', place: name, state: 'working', running: true, line: '', since: ago(10), at: ago(1), agents: [], steps: [], plan: [], lately: [], track: [], ...more }
}

function agent(label: string, state: Run['agents'][number]['state'] = 'working', line?: string) {
  return { id: label, label, state, via: 'claude' as const, steps: [], ...(line && { line }) }
}

test('jobs are the units whose stop runs this hex’s bin/job --ended, with their thread and start', () => {
  const shown = [
    'Id=backup.service',
    'ActiveEnterTimestamp=Thu 2026-11-05 18:00:00 UTC',
    'ExecStopPost={ path=/bin/bun ; argv[]=/bin/bun /home/u/hex/.hex/bin/job --ended backup telegram:-100:42 ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }',
    '',
    'Id=ssh-agent.service',
    'ActiveEnterTimestamp=Thu 2026-11-05 09:00:00 UTC',
    'ExecStopPost=',
    '',
    'Id=other.service',
    'ActiveEnterTimestamp=Thu 2026-11-05 19:00:00 UTC',
    'ExecStopPost={ path=/bin/bun ; argv[]=/bin/bun /elsewhere/bin/job --ended other telegram:1 ; ignore_errors=no }',
  ].join('\n')
  expect(jobsOf(shown, '/home/u/hex/.hex/bin/job')).toEqual([{ unit: 'backup', owner: 'telegram:-100:42', since: Date.parse('2026-11-05T18:00:00Z'), working: false }])
})

test('nothing running says so', () => {
  expect(overall([run('idle', { state: 'idle' }), run('done', { state: 'done' })], [], [], {}, now)).toBe('Nothing is running anywhere in hex right now.')
})

test('everything hex runs, one line each: what waits on the caller first, then threads, jobs and sessions outside any thread', () => {
  const runs = [
    run('voiceapp', { line: 'building', agents: [agent('Build the Tasks view', 'working', 'Editing board.ts'), agent('Check the server', 'done'), agent('review-build')] }),
    run('autofork', { state: 'needs', needs: 'Pick a music style' }),
    run('lab', { where: 'Discord', since: ago(150) }),
    run('voice', { app: 'voice', where: 'Voice', agents: [agent('mail lookup')] }),
    run('hex/clips', { app: 'claude', where: 'Claude Code', line: 'cutting clips', since: ago(1) }),
  ]
  const strays = [{ id: '56565656-terminal', pid: 1, status: 'busy', name: 'bassim-1', started: now - 5 * 60_000 }]
  const jobs = [
    { unit: 'backup', owner: 'telegram:-100:42', since: now - 3 * 24 * 60 * 60_000, working: false },
    { unit: 'clips', owner: 'telegram:-100:65', since: now - 60_000, working: false },
    { unit: 'nightly', owner: 'discord:9', since: 0, working: false },
  ]
  expect(overall(runs, strays, jobs, { '-100:42': 'hex', '-100:65': 'hex' }, now)).toBe(
    [
      'Everything hex is running, 2 threads working, 1 waiting on you:',
      '- autofork (Telegram) waits on you: Pick a music style',
      '- voiceapp (Telegram), working for 10 minutes: Editing board.ts; 2 agents: Build the Tasks view, review-build',
      '- lab (Discord), working for 3 hours',
      "- This call's agents: mail lookup",
      '- hex/clips, working for 1 minute: cutting clips',
      '- The job backup for hex, running for 3 days',
      '- The job nightly, running for a while',
      '- bassim-1, a Claude Code session outside any thread, busy for 5 minutes',
    ].join('\n'),
  )
})

test('a long board says the first eight and how many more', () => {
  const runs = Array.from({ length: 11 }, (_, i) => run(`t${i}`, { where: 'Buzz' }))
  const said = overall(runs, [], [], {}, now).split('\n')
  expect(said).toHaveLength(10)
  expect(said[0]).toBe('Everything hex is running, 11 threads working:')
  expect(said.at(-1)).toBe('and 3 more')
})

test('how long, as said aloud', () => {
  expect([0.2, 1, 59, 60, 90, 47 * 60, 49 * 60].map(minutes => lasted(now - minutes * 60_000, now))).toEqual(['1 minute', '1 minute', '59 minutes', '1 hour', '2 hours', '47 hours', '2 days'])
  expect(lasted(0, now)).toBe('a while')
})

test('the questions hex keeps for the caller wait on them too, past those of a thread already blocked on them', () => {
  const runs = [run('autofork', { state: 'needs', needs: 'Pick a music style' })]
  const asks = [
    { task: 'telegram:autofork', question: 'Pick a music style' },
    { task: 'discord:9', question: 'Ship the  release\nnow?' },
    { task: 'buzz:b1', question: 'Renew the domain?' },
  ]
  expect(overall(runs, [], [], {}, now, asks).split('\n')).toEqual([
    'Everything hex is running, 3 waiting on you:',
    '- autofork (Telegram) waits on you: Pick a music style',
    '- 2 questions wait on you, the first: Ship the release now?',
  ])
  expect(overall([], [], [], {}, now, asks.slice(2))).toBe('Everything hex is running, 1 waiting on you:\n- A question waits on you: Renew the domain?')
})

test("a job shows while the session it ran has stopped, even though its thread's last stretch still lists it", () => {
  const runs = [run('hex', { state: 'idle', agents: [agent('hex/build')] }), run('lab', { agents: [agent('lab/check', 'done')] })]
  const jobs = [
    { unit: 'build', owner: 'telegram:-100:42', since: now - 20 * 60_000, working: false },
    { unit: 'check', owner: 'telegram:-100:43', since: now - 5 * 60_000, working: false },
  ]
  expect(overall(runs, [], jobs, { '-100:42': 'hex', '-100:43': 'lab' }, now).split('\n').slice(2)).toEqual([
    '- The job build for hex, running for 20 minutes',
    '- The job check for lab, running for 5 minutes',
  ])
})

test('a busy session with no name is said by its folder, never its id', () => {
  const strays = [{ id: '58585858-terminal', pid: 1, status: 'busy', cwd: '/home/u/projects/site', started: now - 2 * 60_000 }]
  expect(overall([], strays, [], {}, now)).toBe('Everything hex is running:\n- A Claude Code session in site outside any thread, busy for 2 minutes')
})

test("jobs come from systemctl's own output, its start read in any zone the machine keeps", async () => {
  const bin = mkdtempSync(join(tmpdir(), 'voice-systemctl-'))
  const job = realpathSync(join(import.meta.dir, '..', '..', 'bin', 'job'))
  // Like systemctl, it writes times in the zone TZ names, as that zone's abbreviation.
  writeFileSync(
    join(bin, 'systemctl'),
    `#!/bin/sh
zone=CET; hour=19; [ "$TZ" = UTC ] && zone=UTC && hour=18
case "$2" in
  list-units) printf 'backup.service loaded active running backup\\nssh-agent.service loaded active running agent\\n' ;;
  show) printf 'Id=backup.service\\nActiveEnterTimestamp=Thu 2026-11-05 %s:00:00 %s\\nExecStopPost={ path=/bin/bun ; argv[]=/bin/bun ${job} --ended backup telegram:-100:42 ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }\\n\\nId=ssh-agent.service\\nActiveEnterTimestamp=Thu 2026-11-05 09:00:00 %s\\nExecStopPost=\\n' $hour $zone $zone ;;
esac
`,
  )
  chmodSync(join(bin, 'systemctl'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    expect(await jobs()).toEqual([{ unit: 'backup', owner: 'telegram:-100:42', since: Date.parse('2026-11-05T18:00:00Z'), working: false }])
  } finally {
    process.env.PATH = path
    rmSync(bin, { recursive: true })
  }
})

test('a job is on the board only under the name bin/job gave it, never under another thread’s session of the same unit', () => {
  const runs = [run('lab', { agents: [agent('lab/build')] }), run('hex', { agents: [agent('hex/deploy')] })]
  const jobs = [
    { unit: 'build', owner: 'telegram:-100:42', since: now - 20 * 60_000, working: false },
    { unit: 'deploy', owner: 'telegram:-100:42', since: now - 5 * 60_000, working: false },
    { unit: 'sync', owner: 'discord:9', since: now - 5 * 60_000, working: false },
  ]
  const strays = [{ id: '59595959-terminal', pid: 1, status: 'busy', name: 'x/sync', started: now - 60_000 }]
  expect(overall(runs, strays, jobs, { '-100:42': 'hex' }, now).split('\n').filter(line => line.includes('The job'))).toEqual([
    '- The job build for hex, running for 20 minutes',
    '- The job sync, running for 5 minutes',
  ])
  expect(overall([run('9/sync')], [], jobs.slice(2), {}, now)).not.toContain('The job')
})

test('a job whose session at work renamed itself shows once, as that session', () => {
  const runs = [run('hex', { agents: [agent('fix the deploy')] })]
  const jobs = [{ unit: 'deploy', owner: 'telegram:-100:42', since: now - 5 * 60_000, working: true }]
  expect(overall(runs, [], jobs, { '-100:42': 'hex' }, now)).toBe('Everything hex is running, 1 thread working:\n- hex (Telegram), working for 10 minutes; an agent: fix the deploy')
})

test("a job is at work when a busy Claude Code session runs in its unit's cgroup", async () => {
  const root = mkdtempSync(join(tmpdir(), 'voice-cgroup-'))
  const job = realpathSync(join(import.meta.dir, '..', '..', 'bin', 'job'))
  const unit = (name: string, pids: number[]) => {
    mkdirSync(join(root, 'cg', name), { recursive: true })
    writeFileSync(join(root, 'cg', name, 'cgroup.procs'), pids.map(pid => `${pid}\n`).join(''))
    return [`Id=${name}.service`, 'ActiveEnterTimestamp=', `ExecStopPost={ path=/bin/bun ; argv[]=/bin/bun ${job} --ended ${name} telegram:1 ; ignore_errors=no }`, `ControlGroup=/${name}`].join('\n')
  }
  const shown = [unit('deploy', [101, 102]), unit('idle', [201]), unit('script', [301]), ['Id=bare.service', `ExecStopPost={ argv[]=/bin/bun ${job} --ended bare telegram:1 }`].join('\n')].join('\n\n')
  mkdirSync(join(root, 'claude', 'sessions'), { recursive: true })
  writeFileSync(join(root, 'claude', 'sessions', '102.json'), JSON.stringify({ sessionId: 'aaaa', pid: 102, status: 'busy', name: 'fix the deploy' }))
  writeFileSync(join(root, 'claude', 'sessions', '201.json'), JSON.stringify({ sessionId: 'bbbb', pid: 201, status: 'idle' }))
  const bin = mkdtempSync(join(tmpdir(), 'voice-systemctl-'))
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\ncase "$2" in list-units) echo 'deploy.service loaded active running deploy' ;; show) cat '${join(root, 'shown')}' ;; esac\n`)
  writeFileSync(join(root, 'shown'), shown)
  chmodSync(join(bin, 'systemctl'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    expect((await jobs(join(root, 'cg'), join(root, 'claude'))).map(({ unit, working }) => [unit, working])).toEqual([
      ['deploy', true],
      ['idle', false],
      ['script', false],
      ['bare', false],
    ])
  } finally {
    process.env.PATH = path
    rmSync(bin, { recursive: true })
    rmSync(root, { recursive: true })
  }
})

test('a session outside any thread counts as no thread in what the call hears first', () => {
  const runs = [run('lab'), run('hex/clips', { app: 'claude', where: 'Claude Code' })]
  expect(overall(runs, [], [], {}, now).split('\n')[0]).toBe('Everything hex is running, 1 thread working:')
  expect(overall(runs.slice(1), [], [], {}, now).split('\n')[0]).toBe('Everything hex is running:')
})
