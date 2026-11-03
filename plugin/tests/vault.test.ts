import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'vault-'))
  mkdirSync(join(home, '.hex/bin'), { recursive: true })
  mkdirSync(join(home, '.claude'))
  mkdirSync(join(home, 'fake'))
  for (const script of ['vault', 'settings']) copyFileSync(join(import.meta.dir, '../../bin', script), join(home, '.hex/bin', script))
  writeFileSync(join(home, '.env'), 'TELEGRAM_BOT_TOKEN=bot-secret\nexport TRANSCRIBE_URL=http://transcribe\nTRANSCRIBE_MODEL=a SPEECH_KEY=speech-secret\nreadonly TELEGRAM_BOT_TOKEN\nENCLAVE_HOME=/vault-home\n')
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ env: { HEX_NAME: 'herald', HEX_COMPUTER: 'box' } }))
  fake('enclave', '[ "$1" = --version ] && echo 0.2.12 && exit\n[ "$1" = get ] && printf hunter2 && exit\nenv')
  fake('sprite', `cat > ${join(home, 'typed')}`)
})

afterEach(() => rmSync(home, { recursive: true, force: true }))

function fake(name: string, body: string) {
  writeFileSync(join(home, 'fake', name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(home, 'fake', name), 0o755)
}

function vault(args: string[], caller: Record<string, string> = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HEX_') && !name.startsWith('ENCLAVE_')))
  const run = Bun.spawnSync([join(home, '.hex/bin/vault'), ...args], { env: { ...env, ...caller, PATH: `${join(home, 'fake')}:${env.PATH}` } })
  expect(run.exitCode).toBe(0)
  return run.stdout.toString()
}

test('vault run hands the command enclave\'s settings and none of .env, even when its caller has them', () => {
  const env = vault(['run', 'GitHub', '--', 'env'], { TRANSCRIBE_URL: 'http://transcribe', TELEGRAM_BOT_TOKEN: 'bot-secret', SPEECH_KEY: 'speech-secret', LANG: 'C.UTF-8' })
  expect(env).toContain('ENCLAVE_FROM=herald\n')
  expect(env).toContain('ENCLAVE_HOME=/vault-home\n')
  expect(env).not.toContain('bot-secret')
  expect(env).not.toContain('speech-secret')
  expect(env).not.toContain('TRANSCRIBE_URL')
  expect(env).toContain('LANG=C.UTF-8\n')
})

test('vault run works without a .env', () => {
  rmSync(join(home, '.env'))
  expect(vault(['run', 'GitHub', '--', 'env'])).toContain('ENCLAVE_FROM=herald\n')
})

test('vault fill still finds the computer in the settings', () => {
  expect(vault(['fill', 'GitHub', 'password'])).toBe('typed GitHub\'s password on box\n')
  expect(readFileSync(join(home, 'typed'), 'utf8')).toBe('hunter2')
})
