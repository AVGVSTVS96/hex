import { afterAll, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const HEX = join(import.meta.dir, '../..')
const home = mkdtempSync(join(tmpdir(), 'quiet-'))
const sessions = join(home, 'config/sessions')
afterAll(() => rmSync(home, { recursive: true }))

test("bin/quiet waits while a hex thread's session is busy, and not on other sessions", async () => {
  cpSync(join(HEX, 'bin/quiet'), join(home, '.hex/bin/quiet'))
  mkdirSync(join(home, 'state/discord'), { recursive: true })
  mkdirSync(sessions, { recursive: true })
  writeFileSync(join(home, 'state/discord/threads.json'), JSON.stringify({ '555': { name: 'Asks', session: 'ours' } }))
  const status = (file: string, sessionId: string, status: string) => writeFileSync(join(sessions, file), JSON.stringify({ pid: process.pid, sessionId, name: sessionId, status }))
  status('1.json', 'ours', 'busy')
  status('2.json', 'theirs', 'busy')
  const quiet = Bun.spawn([join(home, '.hex/bin/quiet')], { env: { ...process.env, CLAUDE_CONFIG_DIR: join(home, 'config'), HEX_QUIET_MS: '100' }, stdout: 'pipe' })
  await Bun.sleep(500)
  expect(quiet.exitCode).toBeNull()
  status('1.json', 'ours', 'idle')
  expect(await quiet.exited).toBe(0)
  expect(await new Response(quiet.stdout).text()).toBe('waiting on: ours\n')
})
