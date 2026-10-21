import { afterAll, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const HEX = join(import.meta.dir, '../..')
const home = mkdtempSync(join(tmpdir(), 'quiet-'))
const sessions = join(home, 'config/sessions')
afterAll(() => rmSync(home, { recursive: true }))

test("bin/quiet waits while a session hex started is busy, and not on other sessions", async () => {
  cpSync(join(HEX, 'bin/quiet'), join(home, '.hex/bin/quiet'))
  mkdirSync(sessions, { recursive: true })
  const status = (file: string, name: string, kind: string, status: string) => writeFileSync(join(sessions, file), JSON.stringify({ pid: process.pid, sessionId: name, name, kind, status }))
  status('1.json', 'ours', 'bg', 'busy')
  status('2.json', 'theirs', 'interactive', 'busy')
  status('3.json', 'gone', 'bg', 'busy')
  writeFileSync(join(sessions, '3.json'), JSON.stringify({ pid: 2 ** 22 + 1, sessionId: 'gone', kind: 'bg', status: 'busy' }))
  const quiet = Bun.spawn([join(home, '.hex/bin/quiet')], { env: { ...process.env, CLAUDE_CONFIG_DIR: join(home, 'config'), HEX_QUIET_MS: '100' }, stdout: 'pipe' })
  await Bun.sleep(500)
  expect(quiet.exitCode).toBeNull()
  status('1.json', 'ours', 'bg', 'idle')
  expect(await quiet.exited).toBe(0)
  expect(await new Response(quiet.stdout).text()).toBe('waiting on: ours\n')
})

test('bin/quiet leaves out the session that asked for the wait', async () => {
  const status = (file: string, name: string) => writeFileSync(join(sessions, file), JSON.stringify({ pid: process.pid, sessionId: name, name, kind: 'bg', status: 'busy' }))
  rmSync(sessions, { recursive: true, force: true })
  mkdirSync(sessions, { recursive: true })
  status('1.json', 'asker')
  const quiet = Bun.spawn([join(home, '.hex/bin/quiet'), 'asker'], { env: { ...process.env, CLAUDE_CONFIG_DIR: join(home, 'config'), HEX_QUIET_MS: '100' }, stdout: 'pipe' })
  expect(await quiet.exited).toBe(0)
  expect(await new Response(quiet.stdout).text()).toBe('')
})
