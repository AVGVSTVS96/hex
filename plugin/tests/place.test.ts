import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// bin/place against fake machines: each one's room reading, and what ran where.

const HEX = join(import.meta.dir, '../..')
const home = mkdtempSync(join(tmpdir(), 'place-'))
const fake = join(home, 'fake')
const here = Bun.spawnSync(['uname', '-n']).stdout.toString().trim()
const slots = join(home, 'state/hex/slots')

const script = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

beforeAll(() => {
  mkdirSync(join(home, '.hex/bin'), { recursive: true })
  mkdirSync(fake)
  for (const file of ['bin/place', 'bin/settings']) cpSync(join(HEX, file), join(home, '.hex', file))
  script(join(home, '.hex/bin/room'), `cat "${fake}/${here}"; exit $(cat "${fake}/${here}.code")`)
  script(join(home, '.hex/bin/session'), `echo "session $* $(cat)"`)
  // A machine's away exits as that machine's file says: 76 when the job can't run there.
  script(join(home, '.hex/bin/away'), `echo "away $*"; exit $(cat "${fake}/$1.away" 2>/dev/null || echo 0)`)
  script(join(home, '.hex/bin/job'), `echo "$*" >> "${fake}/told"`)
  script(join(fake, 'bun'), 'exec "$@"')
  script(join(fake, 'ssh'), `cat "${fake}/$3"; exit $(cat "${fake}/$3.code")`)
  mkdirSync(join(home, '.claude'))
})
afterAll(() => rmSync(home, { recursive: true }))

function machine(name: string, reading: string, code: number, away?: number) {
  writeFileSync(join(fake, name), reading ? `${reading}\n` : '')
  writeFileSync(join(fake, `${name}.code`), `${code}`)
  away === undefined ? rmSync(join(fake, `${name}.away`), { force: true }) : writeFileSync(join(fake, `${name}.away`), `${away}`)
}

function place(settings: Record<string, string> = {}, wait = 10_000) {
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ env: settings }))
  rmSync(join(fake, 'told'), { force: true })
  const ran = Bun.spawnSync(['timeout', `${wait / 1000}`, join(home, '.hex/bin/place'), 'hex/deck', '-p', 'build it'], {
    cwd: home,
    stdin: Buffer.from('the log'),
    env: { ...process.env, PATH: `${fake}:${process.env.PATH}`, XDG_STATE_HOME: join(home, 'state'), HEX_OWNER: 'telegram:-100123:908' },
  })
  return { out: ran.stdout.toString(), code: ran.exitCode, told: existsSync(join(fake, 'told')) ? readFileSync(join(fake, 'told'), 'utf8') : '' }
}

test('a job runs here as a hex session while this machine has room, with what came on its stdin', () => {
  machine(here, 'cpu 3% busy', 0)
  expect(place({ HEX_MACHINES: 'mac:3' }).out).toBe(`hex/deck runs on ${here}\nsession -n hex/deck -p build it the log\n`)
})

test("a job goes to the next machine with room, as a T3 Code thread on that machine's hex T3", () => {
  machine(here, 'cpu 80% busy', 1)
  machine('mac', 'cpu 20% busy\nt3 env-mac', 0)
  expect(place({ HEX_MACHINES: 'mac:3' }).out).toBe('hex/deck runs on mac\naway mac env-mac hex/deck -p build it\n')
})

test('held slots, a machine without a hex T3 Code, and one where the job could not run are passed over', () => {
  machine(here, 'cpu 3% busy', 0)
  machine('cloud', 'cpu 1% busy', 0)
  machine('mini', 'cpu 1% busy\nt3 env-mini', 0, 76)
  machine('mac', 'cpu 20% busy\nt3 env-mac', 0)
  mkdirSync(slots, { recursive: true })
  const held = Bun.spawn(['flock', join(slots, `${here}.1`), 'sleep', '30'])
  Bun.sleepSync(200)
  const { out, code } = place({ HEX_SLOTS: '1', HEX_MACHINES: 'cloud:1 mini mac:3' })
  held.kill()
  expect(out).toBe('hex/deck runs on mini\naway mini env-mini hex/deck -p build it\nhex/deck runs on mac\naway mac env-mac hex/deck -p build it\n')
  expect(code).toBe(0)
})

test('with no room anywhere a job waits, and its owner hears it once, with every reading', () => {
  machine(here, 'cpu 80% busy', 1)
  machine('mac', '', 255)
  const { out, told } = place({ HEX_MACHINES: 'mac:3' }, 3_000)
  expect(out).toBe(`hex/deck waits for room:\n${here}: cpu 80% busy\nmac: no answer\n`)
  expect(told).toBe(`--waiting deck telegram:-100123:908 \n${here}: cpu 80% busy\nmac: no answer\n`)
})

test("a job behind another in line tells its owner it's waiting too", () => {
  machine(here, 'cpu 3% busy', 0)
  mkdirSync(slots, { recursive: true })
  const ahead = Bun.spawn(['flock', join(slots, 'line'), 'sleep', '30'])
  Bun.sleepSync(200)
  const { told } = place({}, 2_000)
  ahead.kill()
  expect(told).toBe('--waiting deck telegram:-100123:908 \nother jobs are ahead of it in line\n')
})
