import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const BIN = join(import.meta.dir, '../../bin')
const SESSION = 'addfa113-0000-4000-8000-000000000000'
const LIMIT = 10_000
const SLOTS = 6
// A hex session running these would steer the hooks under test with its own HEX_* variables.
const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HEX_')))

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wake-'))
  mkdirSync(join(home, '.hex/bin'), { recursive: true })
  mkdirSync(join(home, '.hex/vendor'))
  copyFileSync(join(BIN, 'wake'), join(home, '.hex/bin/wake'))
  symlinkSync(join(BIN, '../hub'), join(home, '.hex/hub'))
})

afterEach(() => rmSync(home, { recursive: true, force: true }))

function memo(parts: string[]) {
  parts.forEach((part, i) => writeFileSync(join(home, `part${i + 1}.txt`), part))
  writeFileSync(join(home, '.hex/vendor/memo'), `#!/bin/sh\n[ "$1" = wake ] && cat "${home}/part\${2:-1}.txt"\n`)
  chmodSync(join(home, '.hex/vendor/memo'), 0o755)
}

function hook(chunk: number, source = 'startup') {
  const run = Bun.spawnSync([join(home, '.hex/bin/wake'), String(chunk), ...(chunk === SLOTS ? ['last'] : [])], {
    cwd: home,
    stdin: Buffer.from(JSON.stringify({ session_id: SESSION, source })),
    env: { ...clean, CLAUDE_PROJECT_DIR: home, MEMORY_DIR: join(home, 'memory'), TMPDIR: home },
  })
  expect(run.exitCode).toBe(0)
  const out = run.stdout.toString()
  expect(out.length).toBeLessThanOrEqual(LIMIT)
  return out
}

const body = (out: string) => out.split('\n\n').slice(1).join('\n\n')
const notes = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => `#${from + i} 2026-10-06 ${'x'.repeat(180)}`).join('\n') + '\n'

test('a short wake arrives whole in the first part, and the other slots say nothing', () => {
  const wake = '#0 2026-10-06 First note.\nYou are awake.\n'
  memo([wake])
  expect(hook(1)).not.toContain('part 1')
  expect(body(hook(1))).toBe(wake)
  for (let n = 2; n <= SLOTS; n++) expect(hook(n)).toBe('')
})

test("follows memo's parts to the end and splits them into chunks that each fit a hook, losing no line", () => {
  const wake = [
    notes(0, 60) + 'Not awake yet. Run: /x/memo wake 2 150\n',
    'Your memory, part 2 of 2\n' + notes(60, 60) + 'You are awake.\n',
  ]
  memo(wake)
  const chunks = Array.from({ length: SLOTS }, (_, i) => hook(i + 1)).filter(Boolean)
  expect(chunks.length).toBeGreaterThan(1)
  const joined = chunks.map(body).join('')
  expect(joined).toBe(wake.join('').replace('Not awake yet. Run: /x/memo wake 2 150\n', ''))
  expect(joined.endsWith('You are awake.\n')).toBe(true)
})

test('a wake longer than every slot sends the last one to memo for the rest', () => {
  memo([notes(0, 400) + 'You are awake.\n'])
  expect(hook(SLOTS)).toEndWith(`\nThat's all the hooks can show. ${join(home, '.hex/vendor/memo')} wake prints the whole memory; follow its "Not awake yet" lines to the end.\n`)
  const copies = Array.from({ length: SLOTS }, (_, i) => hook(i + 1).match(/parts of copy (\w+)/)?.[1])
  expect(new Set(copies).size).toBe(1)
})

test('a compaction hands the session its wake again, as the start did', () => {
  const hooks = JSON.parse(readFileSync(join(BIN, '../plugin/hooks/hooks.json'), 'utf8')).hooks.SessionStart
  const wakes = hooks.find((group: { hooks: { command: string }[] }) => group.hooks.some(each => each.command.endsWith('/bin/wake 1')))
  expect(wakes.matcher.split('|')).toEqual(['startup', 'resume', 'clear', 'compact'])
  expect(wakes.hooks.map((each: { command: string }) => each.command.replace(/.*\/bin\//, ''))).toEqual(['wake 1', 'wake 2', 'wake 3', 'wake 4', 'wake 5', `wake ${SLOTS} last`])
  memo(['#0 2026-10-06 First note.\nYou are awake.\n'])
  expect(hook(1, 'compact')).toBe(hook(1))
})

test('says nothing when OptMem is not installed', () => {
  expect(hook(1)).toBe('')
})

test('`wake all` prints every part in order, as long as it runs, for the launcher to hand over as a file', () => {
  const wake = [
    notes(0, 200) + 'Not awake yet. Run: /x/memo wake 2 400\n',
    'Your memory, part 2 of 2\n' + notes(200, 200) + 'You are awake.\n',
  ]
  memo(wake)
  const run = Bun.spawnSync([join(home, '.hex/bin/wake'), 'all'], { cwd: home, env: { ...clean, MEMORY_DIR: join(home, 'memory') } })
  const out = run.stdout.toString()
  expect(out.length).toBeGreaterThan(LIMIT * 6)
  expect(out).toStartWith('This is your memory: `.hex/vendor/memo wake`, run in full for you')
  expect(body(out)).toBe(wake.join('').replace('Not awake yet. Run: /x/memo wake 2 400\n', ''))
})

test('the profile comes first, ahead of memory, in the launcher\'s file and in the hooks', () => {
  memo(['#0 2026-10-06 First note.\nYou are awake.\n'])
  mkdirSync(join(home, 'state'))
  writeFileSync(join(home, 'state/profile.md'), '# Always\n- Ships on fridays\n')
  const all = Bun.spawnSync([join(home, '.hex/bin/wake'), 'all'], { cwd: home, env: { ...clean, MEMORY_DIR: join(home, 'memory') } }).stdout.toString()
  const both = "My profile, the current truth about me, kept by hex's memory agent from my own words:\n\n# Always\n- Ships on fridays\n\nYour memory:\n\n#0 2026-10-06 First note.\nYou are awake.\n"
  expect(body(all)).toBe(both)
  expect(body(hook(1)) + '\n' + body(hook(2))).toBe(both)
})

test('the hooks say nothing in a session the launcher already handed its wake', () => {
  memo(['#0 2026-10-06 First note.\nYou are awake.\n'])
  const run = Bun.spawnSync([join(home, '.hex/bin/wake'), '1'], {
    cwd: home,
    stdin: Buffer.from(JSON.stringify({ session_id: SESSION, source: 'startup' })),
    env: { ...clean, MEMORY_DIR: join(home, 'memory'), TMPDIR: home, HEX_WAKE: join(home, 'state/wake/CLAUDE.md') },
  })
  expect(run.stdout.toString()).toBe('')
})

test('the launcher writes the whole wake where Claude Code loads it at startup, tells the hooks so, in the foreground too, and keeps the last wake when memo stops to ask for a compression', () => {
  copyFileSync(join(BIN, 'session'), join(home, '.hex/bin/session'))
  mkdirSync(join(home, '.claude'))
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ env: { MEMORY_DIR: join(home, 'memory') } }))
  mkdirSync(join(home, 'fake'))
  writeFileSync(join(home, 'fake/claude'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${home}/args"\nenv > "${home}/env"\n`)
  chmodSync(join(home, 'fake/claude'), 0o755)
  const launch = (...args: string[]) => {
    Bun.spawnSync([join(home, '.hex/bin/session'), ...(args.length ? args : ['--bg', '--settings', JSON.stringify({ env: { HEX_THREAD: '-100:5' } })])], {
      cwd: home,
      env: { ...clean, PATH: `${join(home, 'fake')}:${process.env.PATH}`, HEX_WAKE: 'stale' },
    })
    return { args: readFileSync(join(home, 'args'), 'utf8').trim().split('\n'), env: readFileSync(join(home, 'env'), 'utf8') }
  }
  const wake = notes(0, 400) + 'You are awake.\n'
  memo([wake])
  const settings = (args: string[]) => JSON.parse(args[args.indexOf('--settings') + 1]!)
  const { args, env } = launch()
  const dir = args[args.indexOf('--add-dir') + 1]!
  expect(dir).toBe(join(home, 'state/wake'))
  expect(body(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'))).toBe(wake)
  expect(settings(args).env).toEqual({ HEX_THREAD: '-100:5', HEX_WAKE: join(dir, 'CLAUDE.md') })
  expect(env).toContain('CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1')
  expect(env).toContain('HEX_WAKE=stale')
  expect(launch('-p', 'go').env).toContain(`HEX_WAKE=${join(dir, 'CLAUDE.md')}\n`)
  writeFileSync(join(home, '.hex/vendor/memo'), '#!/bin/sh\necho "Cannot wake: the memory context needs #0-1."\necho "Compress memories #0-1 into one line."\nexit 1\n')
  expect(launch().args).toContain(dir)
  expect(body(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'))).toBe(wake)
  renameSync(join(home, '.hex/hub'), join(home, '.hex/hub.away'))
  expect(launch().args).toContain(dir)
  renameSync(join(home, '.hex/hub.away'), join(home, '.hex/hub'))
  writeFileSync(join(home, '.hex/vendor/memo'), '#!/bin/sh\necho "The summary of #0-1 is blank."\nexit 1\n')
  expect(launch().args).not.toContain(dir)
  rmSync(join(home, '.hex/vendor/memo'))
  const without = launch()
  expect(without.args).not.toContain(join(home, 'state/wake'))
  expect(settings(without.args).env).toEqual({ HEX_THREAD: '-100:5' })
  expect(without.env).not.toContain('HEX_WAKE=')
})
