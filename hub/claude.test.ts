import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { start } from './claude.ts'
import { noClaude } from './testing.ts'

const scopes = !!Bun.which('systemd-run') && Bun.spawnSync(['systemd-run', '--user', '--scope', '--quiet', 'true']).success

test.skipIf(!scopes)('a session started in the sessions slice gets its name and prompt as written, ${VARIABLE}s and all', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-'))
  const launcher = join(dir, 'session')
  writeFileSync(launcher, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\necho "backgrounded · job12345 · test"\n`)
  chmodSync(launcher, 0o755)
  const path = process.env.PATH
  process.env.HEX_SESSIONS_SLICE = 'hex-sessions.slice'
  process.env.PATH = noClaude()
  try {
    expect(await start(launcher, ['--name', 'cost of ${HOME}', 'echo $PATH ${PATH}'], { cwd: dir, env: process.env })).toBe('job12345')
    expect(readFileSync(join(dir, 'args'), 'utf8')).toBe('--bg\n--name\ncost of ${HOME}\necho $PATH ${PATH}\n')
  } finally {
    delete process.env.HEX_SESSIONS_SLICE
    process.env.PATH = path
    rmSync(dir, { recursive: true, force: true })
  }
})
