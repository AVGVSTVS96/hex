import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { hostname, tmpdir, userInfo } from 'os'
import { join } from 'path'

// bin/away against a fake ssh that records the command it was asked to run on the other machine.

const HEX = join(import.meta.dir, '../..')
const home = mkdtempSync(join(tmpdir(), 'away-'))
const ran = join(home, 'ran.json')
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HEX_')))

beforeAll(() => {
  for (const file of ['bin/away', 'hub/loaded.ts', 'plugin/hooks/hooks.json']) cpSync(join(HEX, file), join(home, '.hex', file))
  writeFileSync(join(home, 'AGENTS.md'), 'Rules for hex.\n@SOUL.md\n')
  writeFileSync(join(home, 'SOUL.md'), 'Who hex is.\n')
  mkdirSync(join(home, 'state/wake'), { recursive: true })
  writeFileSync(join(home, 'state/wake/CLAUDE.md'), 'What hex remembers.\n')
  mkdirSync(join(home, '.claude'))
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ env: { MEMORY_DIR: `${home}/memory` }, permissions: { defaultMode: 'bypassPermissions' } }))
  mkdirSync(join(home, 'fake'))
  writeFileSync(join(home, 'fake/ssh'), `#!/bin/sh\njq -cn '$ARGS.positional' --args -- "$@" > "${ran}"\n`)
  chmodSync(join(home, 'fake/ssh'), 0o755)
})
afterAll(() => rmSync(home, { recursive: true }))

const decoded = (text: string) => [...text.matchAll(/echo ([A-Za-z0-9+/=]+) \| base64 -d/g)].map(([, encoded]) => Buffer.from(encoded!, 'base64').toString())
const script = (command: string) => decoded(command)[0]!

test("a session away has hex's instructions and the wake, its hooks run back here, and it gets what was piped to it", () => {
  const done = Bun.spawnSync(['bun', join(home, '.hex/bin/away'), 'mac', '-n', 'hex/deck', '-p', "it's $5"], { stdin: Buffer.from('Build the Usage tab.\n'), env: { ...env, PATH: `${join(home, 'fake')}:${env.PATH}`, HEX_OWNER: 't3:stray-key' } })
  expect(done.exitCode).toBe(0)
  const args = JSON.parse(readFileSync(ran, 'utf8')) as string[]
  expect(args.slice(0, -1)).toEqual(['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4', 'mac'])
  const run = script(args.at(-1)!)
  expect(run).toContain(`claude --permission-mode 'bypassPermissions' --strict-mcp-config --settings "$f.json" --append-system-prompt-file "$f.md" '-n' 'hex/deck' '-p' 'it'\\''s $5' < "$f.in"`)
  const [prompt, settings, input] = decoded(run)
  expect(prompt).toStartWith(`You are hex, working on mac, one of the owner's other machines, because ${hostname()}`)
  for (const part of ['── AGENTS.md ──\nRules for hex.', '── SOUL.md ──\nWho hex is.', '── state/wake/CLAUDE.md ──\nWhat hex remembers.']) expect(prompt).toContain(part)
  expect(input).toBe('Build the Usage tab.\n')
  const hooks = Object.values(JSON.parse(settings!).hooks as Record<string, { hooks: { command: string }[] }[]>).flat().flatMap(group => group.hooks)
  expect(hooks.length).toBeGreaterThan(5)
  for (const { command } of hooks) {
    expect(command).toStartWith(`ssh -o BatchMode=yes ${userInfo().username}@${hostname()} 'sh -c "eval`)
    expect(script(command)).toStartWith(`cd '${home}'\nexport MEMORY_DIR='${home}/memory'\n`)
    expect(script(command)).toContain(`export HEX_OWNER='t3:stray-key'\nexport CLAUDE_PLUGIN_ROOT='${home}/.hex/plugin'\n`)
  }
})

test('a session away stops when its connection closes', async () => {
  Bun.spawnSync(['bun', join(home, '.hex/bin/away'), 'mac', '-p', 'go'], { env: { ...env, PATH: `${join(home, 'fake')}:${env.PATH}` } })
  const run = script((JSON.parse(readFileSync(ran, 'utf8')) as string[]).at(-1)!)
  writeFileSync(join(home, 'fake/claude'), `#!/bin/sh\necho $$ > "${home}/claude.pid"\nexec sleep 30\n`)
  chmodSync(join(home, 'fake/claude'), 0o755)
  const there = Bun.spawn(['sh', '-c', run], { stdin: 'pipe', env: { ...env, HOME: home, PATH: `${join(home, 'fake')}:${env.PATH}` } })
  while (!(await Bun.file(join(home, 'claude.pid')).exists())) await Bun.sleep(50)
  there.stdin.end()
  expect(await Promise.race([there.exited, Bun.sleep(5000).then(() => 'still running')])).not.toBe('still running')
  expect(() => process.kill(Number(readFileSync(join(home, 'claude.pid'), 'utf8')), 0)).toThrow()
  expect(Bun.spawnSync(['sh', '-c', `ls ${home}/.cache/hex`]).stdout.toString()).toBe('')
})
