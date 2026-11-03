import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { hostname, tmpdir } from 'os'
import { join } from 'path'

// bin/place against fake machines: each one's room reading, and what ran where.

const HEX = join(import.meta.dir, '../..')
const home = mkdtempSync(join(tmpdir(), 'place-'))
const fake = join(home, 'fake')
const here = hostname()

const script = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

beforeAll(() => {
  mkdirSync(join(home, '.hex/bin'), { recursive: true })
  mkdirSync(fake)
  for (const file of ['bin/place', 'bin/settings']) cpSync(join(HEX, file), join(home, '.hex', file))
  script(join(home, '.hex/bin/room'), `cat "${fake}/${here}"; exit $(cat "${fake}/${here}.code")`)
  script(join(home, '.hex/bin/session'), `echo "session $*"`)
  script(join(home, '.hex/bin/away'), `echo "away $*"`)
  script(join(home, '.hex/bin/job'), `echo "$*" >> "${fake}/told"`)
  script(join(fake, 'bun'), 'exec "$@"')
  script(join(fake, 'ssh'), `cat "${fake}/$3"; exit $(cat "${fake}/$3.code")`)
  mkdirSync(join(home, '.claude'))
})
afterAll(() => rmSync(home, { recursive: true }))

function machine(name: string, reading: string, code: number) {
  writeFileSync(join(fake, name), `${reading}\n`)
  writeFileSync(join(fake, `${name}.code`), `${code}`)
}

function place(settings: Record<string, string> = {}, wait = 10_000) {
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ env: settings }))
  rmSync(join(fake, 'told'), { force: true })
  const ran = Bun.spawnSync(['timeout', `${wait / 1000}`, join(home, '.hex/bin/place'), 'hex/deck', '-p', 'build it'], {
    cwd: home,
    env: { ...process.env, PATH: `${fake}:${process.env.PATH}`, XDG_STATE_HOME: join(home, 'state'), HEX_OWNER: 'telegram:-100123:908' },
  })
  return ran.stdout.toString()
}

test('a job runs here as a hex session while this machine has room', () => {
  machine(here, 'cpu 3% waiting', 0)
  expect(place({ HEX_MACHINES: 'mac:3' })).toBe(`hex/deck runs on ${here}: cpu 3% waiting\nsession -n hex/deck -p build it\n`)
})

test("a job goes to the next machine with room, as a T3 Code thread on that machine's hex T3", () => {
  machine(here, 'cpu 80% waiting', 1)
  machine('mac', 'cpu 20% busy\nt3 env-mac', 0)
  expect(place({ HEX_MACHINES: 'mac:3' })).toBe('hex/deck runs on mac: cpu 20% busy\naway mac env-mac hex/deck -p build it\n')
})

test('a machine whose slots are all held has no room, and a machine without a hex T3 is passed over', () => {
  machine(here, 'cpu 3% waiting', 0)
  machine('mac', 'cpu 20% busy\nt3 env-mac', 0)
  machine('cloud', 'cpu 1% busy', 0)
  const held = Bun.spawn(['flock', join(home, 'state/hex/slots', `${here}.1`), 'sleep', '30'])
  Bun.sleepSync(200)
  expect(place({ HEX_SLOTS: '1', HEX_MACHINES: 'cloud:1 mac:3' })).toEndWith('away mac env-mac hex/deck -p build it\n')
  held.kill()
})

test('with no room anywhere a job waits, and its owner hears it once, with every reading', () => {
  machine(here, 'cpu 80% waiting', 1)
  machine('mac', '', 255)
  const out = place({ HEX_MACHINES: 'mac:3' }, 3_000)
  expect(out).toBe(`hex/deck waits for room:\n${here}: cpu 80% waiting\nmac: no answer\n`)
  expect(readFileSync(join(fake, 'told'), 'utf8')).toBe(`--waiting hex/deck telegram:-100123:908 \n${here}: cpu 80% waiting\nmac: no answer\n`)
})
