import { afterEach, beforeEach, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { until } from '../../hub/until.ts'

// bin/hex run against a hex of its own, whose hub stands in for the real one: it logs when it
// starts and stops, and takes half a second to stop, the way the real one waits out a call.

const BIN = join(import.meta.dir, '../../bin')
const HUB = `import { appendFileSync } from 'fs'
const log = (line: string) => appendFileSync(process.env.HEX_DIR + '/state/hubs', line + ' ' + process.pid + '\\n')
log('start mark=' + process.env.MARK + ' loop=' + (process.env.LOOP ?? 1))
const stop = () => setTimeout(() => (log('stop'), process.exit(0)), 500)
for (const signal of ['SIGHUP', 'SIGTERM'] as const) process.on(signal, stop)
setInterval(() => {}, 1000)
`

let home: string
let hex: string
let loop: ReturnType<typeof Bun.spawn> | undefined

const git = (...args: string[]) => Bun.spawnSync(['git', '-C', hex, ...args]).stdout.toString().trim()
const hubs = () => (existsSync(join(home, 'state/hubs')) ? readFileSync(join(home, 'state/hubs'), 'utf8').trim().split('\n') : [])

function commit(hub: string, message: string) {
  writeFileSync(join(hex, 'hub/serve.ts'), hub)
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', message)
  return git('rev-parse', 'HEAD')
}

function run() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HEX_')))
  loop = Bun.spawn([join(hex, 'bin/hex'), 'run'], { env, stdout: 'ignore', stderr: 'pipe' })
  return loop
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'run-'))
  hex = join(home, '.hex')
  mkdirSync(join(hex, 'bin'), { recursive: true })
  mkdirSync(join(hex, 'hub'))
  mkdirSync(join(home, 'state'))
  for (const script of ['hex', 'settings', 'update']) copyFileSync(join(BIN, script), join(hex, 'bin', script))
  writeFileSync(join(home, '.env'), 'TELEGRAM_BOT_TOKEN=test\nMARK=1\n')
  git('init', '-q', '-b', 'main')
})

afterEach(async () => {
  loop?.kill('SIGTERM')
  await loop?.exited
  loop = undefined
  rmSync(home, { recursive: true, force: true })
})

test('a restart lets the hub finish before the next one starts, on the settings and bin/hex as they are now', async () => {
  commit(HUB, 'a hub')
  const running = run()
  await until(() => hubs().length === 1)
  writeFileSync(join(home, '.env'), 'TELEGRAM_BOT_TOKEN=test\nMARK=2\n')
  copyFileSync(join(hex, 'bin/hex'), join(hex, 'bin/hex.new'))
  writeFileSync(join(hex, 'bin/hex.new'), readFileSync(join(hex, 'bin/hex'), 'utf8').replace('echo $$ >', line => `export LOOP=2; ${line}`))
  renameSync(join(hex, 'bin/hex.new'), join(hex, 'bin/hex'))
  Bun.spawnSync([join(hex, 'bin/hex'), 'restart'])
  await until(() => hubs().length === 3)
  const [first, stopped, next] = hubs()
  const pid = first!.split(' ').at(-1)
  expect(first).toBe(`start mark=1 loop=1 ${pid}`)
  expect(stopped).toBe(`stop ${pid}`)
  expect(next).toMatch(/^start mark=2 loop=2 \d+$/)
  expect(readFileSync(join(home, 'state/hub.pid'), 'utf8').trim()).toBe(String(running.pid))
})

test('the hub gets the env of the settings files over .env, so a setting changes without touching .env', async () => {
  mkdirSync(join(home, '.claude'))
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ env: { MARK: 'settings' } }))
  commit(HUB, 'a hub')
  run()
  await until(() => hubs().length === 1)
  expect(hubs()[0]).toMatch(/^start mark=settings loop=1 \d+$/)
})

test('a stop waits for the hub to finish', async () => {
  commit(HUB, 'a hub')
  const running = run()
  await until(() => hubs().length === 1)
  running.kill('SIGTERM')
  expect(await running.exited).toBe(0)
  const pid = hubs()[0]!.split(' ').at(-1)
  expect(hubs()).toEqual([`start mark=1 loop=1 ${pid}`, `stop ${pid}`])
  expect(existsSync(join(home, 'state/hub.pid'))).toBe(false)
})

test('hex stop returns once the hub has finished, so whatever starts hex next never runs two', async () => {
  commit(HUB, 'a hub')
  run()
  await until(() => hubs().length === 1)
  expect(await Bun.spawn([join(hex, 'bin/hex'), 'stop']).exited).toBe(0)
  const pid = hubs()[0]!.split(' ').at(-1)
  expect(hubs()).toEqual([`start mark=1 loop=1 ${pid}`, `stop ${pid}`])
  expect(existsSync(join(home, 'state/hub.pid'))).toBe(false)
})

test("a commit whose hub can't start goes back to the last one General connected on, and bin/update won't take it again", async () => {
  const good = commit(HUB, 'a hub')
  writeFileSync(join(home, 'state/good'), good + '\n')
  const bad = commit('process.exit(1)\n', 'a hub that crashes')
  Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'main', join(home, 'origin')])
  git('remote', 'add', 'origin', join(home, 'origin'))
  git('push', '-q', 'origin', 'main')
  run()
  await until(() => hubs().length === 1, 20_000)
  expect(git('rev-parse', 'HEAD')).toBe(good)
  expect(readFileSync(join(home, 'state/bad'), 'utf8').trim()).toBe(bad)
  expect(readFileSync(join(home, 'state/rollback'), 'utf8')).toContain(`hex ${bad.slice(0, 7)} ("a hub that crashes") couldn't start`)
  const update = Bun.spawnSync([join(hex, 'bin/update')])
  expect(update.exitCode).toBe(1)
  expect(update.stdout.toString()).toContain(`not updated: hex ${bad.slice(0, 7)} couldn't start here`)
  expect(git('rev-parse', 'HEAD')).toBe(good)
}, 30_000)
