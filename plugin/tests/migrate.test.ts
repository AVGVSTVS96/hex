import { afterEach, beforeEach, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const BIN = join(import.meta.dir, '../../bin')
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'migrate-'))
  for (const dir of ['.hex/bin', '.hex/hub', '.claude', 'state']) mkdirSync(join(home, dir), { recursive: true })
  copyFileSync(join(BIN, 'migrate'), join(home, '.hex/bin/migrate'))
  writeFileSync(join(home, '.hex/hub/past.ts'), '')
  writeFileSync(join(home, 'schedules.json'), '{}')
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ model: 'opus', enabledPlugins: { 'other@x': true } }))
})

afterEach(() => rmSync(home, { recursive: true, force: true }))

const migrate = () => expect(Bun.spawnSync(['sh', join(home, '.hex/bin/migrate')]).exitCode).toBe(0)

test("each step runs once, and the hex folder's settings come to load hex's hooks from where hex is", () => {
  migrate()
  expect(readFileSync(join(home, 'state/migrated'), 'utf8').trim()).toBe('4')
  const settings = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8'))
  expect(settings).toMatchObject({
    model: 'opus',
    enabledPlugins: { 'other@x': true, 'hex@hex-hooks': true },
    extraKnownMarketplaces: { 'hex-hooks': { source: { source: 'directory', path: join(home, '.hex/plugin') } } },
  })
  writeFileSync(join(home, '.claude/settings.json'), '{}')
  migrate()
  expect(readFileSync(join(home, '.claude/settings.json'), 'utf8')).toBe('{}')
})
