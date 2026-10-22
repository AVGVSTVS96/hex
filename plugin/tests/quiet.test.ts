import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { open } from '../../hub/store.ts'

const HEX = join(import.meta.dir, '../..')
const home = mkdtempSync(join(tmpdir(), 'quiet-'))
const sessions = join(home, 'config/sessions')
const state = join(home, 'state')
const store = open(state)
const env = { ...process.env, CLAUDE_CONFIG_DIR: join(home, 'config'), HEX_STORE: state, HEX_QUIET_MS: '100' }
afterAll(() => rmSync(home, { recursive: true }))

test("bin/quiet waits while a session hex started is mid-turn, and not on other sessions or one whose turn ended since Claude Code called it busy", async () => {
  mkdirSync(sessions, { recursive: true })
  const status = (file: string, name: string, kind: string, status: string, at = Date.now() - 1000) => writeFileSync(join(sessions, file), JSON.stringify({ pid: process.pid, sessionId: name, name, kind, status, statusUpdatedAt: at }))
  status('1.json', 'ours', 'bg', 'busy')
  status('2.json', 'theirs', 'interactive', 'busy')
  writeFileSync(join(sessions, '3.json'), JSON.stringify({ pid: 2 ** 22 + 1, sessionId: 'gone', kind: 'bg', status: 'busy' }))
  status('4.json', 'agents', 'bg', 'busy')
  store.turned('agents', true)
  store.turned('agents', false)
  store.turned('ours', true)
  store.turned('unheard', true)
  store.turned('unheard', false)
  status('5.json', 'unheard', 'bg', 'busy', Date.now() + 1000)
  const quiet = Bun.spawn([join(HEX, 'bin/quiet')], { env, stdout: 'pipe' })
  await Bun.sleep(500)
  expect(quiet.exitCode).toBeNull()
  store.turned('ours', false)
  await Bun.sleep(500)
  expect(quiet.exitCode).toBeNull()
  status('5.json', 'unheard', 'bg', 'idle', Date.now())
  expect(await quiet.exited).toBe(0)
  expect(await new Response(quiet.stdout).text()).toBe('waiting on: ours, unheard\nwaiting on: unheard\n')
})

test('bin/quiet leaves out the turn that asked for the wait, not the turns after it', async () => {
  rmSync(sessions, { recursive: true, force: true })
  mkdirSync(sessions, { recursive: true })
  writeFileSync(join(sessions, '1.json'), JSON.stringify({ pid: process.pid, sessionId: 'asker', name: 'asker', kind: 'bg', status: 'busy' }))
  store.turned('asker', true)
  await Bun.sleep(5)
  const asked = Date.now()
  const quiet = () => Bun.spawn([join(HEX, 'bin/quiet'), `asker@${asked}`], { env, stdout: 'pipe' })
  const first = quiet()
  expect(await first.exited).toBe(0)
  expect(await new Response(first.stdout).text()).toBe('')
  await Bun.sleep(5)
  store.turned('asker', true)
  const next = quiet()
  await Bun.sleep(500)
  expect(next.exitCode).toBeNull()
  next.kill()
})
