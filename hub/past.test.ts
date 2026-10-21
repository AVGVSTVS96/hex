import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { history } from './hub.ts'
import { importLogs } from './past.ts'
import { open } from './store.ts'

test("log/'s conversations come into hex.db once, under each session's thread, around what hex.db kept, and wake no memory pass", () => {
  const home = mkdtempSync(join(tmpdir(), 'past-'))
  mkdirSync(join(home, 'log', 'threads'), { recursive: true })
  const store = open(join(home, 'state'))
  store.deliver({ key: 'telegram:1', to: '-100:7', from: 'telegram', author: 'owner', body: 'how full is your context?' }, 'abc-session')
  store.db.query('update messages set at = ?1, taken_at = ?1 where key = ?2').run('2026-10-06T17:06:20.000Z', 'telegram:1')
  writeFileSync(
    join(home, 'log', 'threads', '2026-10-06-abc-sess.md'),
    '# 2026-10-06 · session abc-session\n\n## me · telegram · 2026-10-06 10:06\n\nhow full is your context?\n\n## assistant · telegram · 2026-10-06 10:06\n\nRoomy.\n',
  )
  expect(importLogs(store, join(home, 'log'), 'America/Los_Angeles')).toBe(1)
  expect(importLogs(store, join(home, 'log'), 'America/Los_Angeles')).toBe(0)
  expect(history(store, '-100:7')).toEqual([
    { from: 'me', text: 'how full is your context?' },
    { from: 'hex', text: 'Roomy.' },
  ])
  expect(store.observe('abc-session', new Date(Date.now() + 1000).toISOString()).map(row => row.key)).toEqual(['telegram:1'])
  rmSync(home, { recursive: true, force: true })
})

test("a session's turns go under the thread each was said in, and its terminal notes stay out", () => {
  const home = mkdtempSync(join(tmpdir(), 'past-'))
  mkdirSync(join(home, 'log'), { recursive: true })
  const store = open(join(home, 'state'))
  store.deliver({ key: 'telegram:1', to: '-100:7', from: 'telegram', author: 'owner', body: 'first ask' }, 'abc-session')
  store.deliver({ key: 'telegram:2', to: '-100:7', from: 'telegram', author: 'owner', body: 'second ask' }, 'abc-session')
  store.deliver({ key: 'discord:3', to: '900', from: 'discord', author: 'owner', body: 'moved ask' }, 'abc-session')
  for (const [key, at] of [['telegram:1', '2026-10-06T17:06:00.000Z'], ['telegram:2', '2026-10-06T17:07:00.000Z'], ['discord:3', '2026-10-06T17:10:00.000Z']])
    store.db.query('update messages set at = ?1, taken_at = ?1 where key = ?2').run(at, key)
  writeFileSync(
    join(home, 'log', '2026-10-06-abc-sess.md'),
    [
      '# 2026-10-06 · session abc-session\n',
      '## me · telegram · 2026-10-06 10:06\n\nfirst ask\n',
      '## assistant · terminal · 2026-10-06 10:06\n\nLet me check.\n',
      '## assistant · telegram · 2026-10-06 10:06\n\nOne.\n',
      '## me · discord · 2026-10-06 10:10\n\nmoved ask\n',
      '## assistant · discord · 2026-10-06 10:10\n\nTwo.\n',
    ].join('\n'),
  )
  expect(importLogs(store, join(home, 'log'), 'America/Los_Angeles')).toBe(2)
  expect(history(store, '-100:7')).toEqual([
    { from: 'me', text: 'first ask' },
    { from: 'hex', text: 'One.' },
    { from: 'me', text: 'second ask' },
  ])
  expect(history(store, '900')).toEqual([
    { from: 'me', text: 'moved ask' },
    { from: 'hex', text: 'Two.' },
  ])
  rmSync(home, { recursive: true, force: true })
})

test("a session that took nothing hex.db kept comes in under its thread in threads.json", () => {
  const home = mkdtempSync(join(tmpdir(), 'past-'))
  mkdirSync(join(home, 'log', 'threads'), { recursive: true })
  mkdirSync(join(home, 'state', 'telegram'), { recursive: true })
  writeFileSync(join(home, 'state', 'telegram', 'threads.json'), JSON.stringify({ '-100:9': { name: 'Errands', session: 'old-session' } }))
  const store = open(join(home, 'state'))
  writeFileSync(join(home, 'log', 'threads', '2026-10-01-old-sess.md'), '# 2026-10-01 · session old-session\n\n## me · telegram · 2026-10-01 10:06\n\nbuy stamps\n\n## assistant · telegram · 2026-10-01 10:06\n\nOn it.\n')
  expect(importLogs(store, join(home, 'log'), 'America/Los_Angeles')).toBe(2)
  expect(history(store, '-100:9', 'old-session')).toEqual([
    { from: 'me', text: 'buy stamps' },
    { from: 'hex', text: 'On it.' },
  ])
  rmSync(home, { recursive: true, force: true })
})
