import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SESSION = 'addfa113-0000-4000-8000-000000000000'
const OTHER = 'b0b0b0b0-0000-4000-8000-000000000000'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ended-'))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

test("a session's end removes the files its hooks kept for it, and keeps what a resume still needs and other sessions' files", () => {
  const names = (id: string) => [`hex-rules-${id}.json`, `hex-wake-${id}.txt`, `hex-instructions-${id}.md`, `hex-log-${id}`]
  const noted = `hex-noted-${SESSION}`
  for (const name of [...names(SESSION), ...names(OTHER), noted]) writeFileSync(join(dir, name), '')
  const run = Bun.spawnSync([join(import.meta.dir, '../../bin/ended')], {
    stdin: Buffer.from(JSON.stringify({ session_id: SESSION, hook_event_name: 'SessionEnd' })),
    env: { ...process.env, TMPDIR: dir, XDG_RUNTIME_DIR: dir },
  })
  expect(run.exitCode).toBe(0)
  expect(readdirSync(dir).sort()).toEqual([...names(OTHER), noted].sort())
})
