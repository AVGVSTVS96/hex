import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Ledger } from './ledger.ts'
import { open, Store } from './store.ts'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ledger-'))
  mkdirSync(join(dir, 'telegram'))
  file = join(dir, 'telegram', 'ledger.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test("an older hex's questions and pins move from ledger.json into hex.db once, answers and notes and all, and the file is renamed", () => {
  const pin = { message: 9, text: 'Status: shipping', at: '2026-10-18T09:00:00.000Z' }
  const post = { message: '12', text: 'Site: example.com\n\nmore', note: 'Site: example.com', at: '2026-10-18T09:30:00.000Z' }
  writeFileSync(
    file,
    JSON.stringify({
      asks: [
        { thread: '-100:7', message: 41, text: 'Deploy now?', options: ['Deploy', 'Wait'], at: '2026-10-18T08:00:00.000Z' },
        { thread: '-100:7', message: 42, text: 'Which take?', options: ['A', 'B'], at: '2026-10-18T08:05:00.000Z', poll: 'p-42', answer: { label: 'B', at: '2026-10-18T08:06:00.000Z', via: 'telegram' } },
        { thread: '-100:7', message: 43, text: 'Broken', options: 'not a list', at: '2026-10-18T08:07:00.000Z' },
        { thread: '-100:7', message: 44, text: 'Blank buttons', options: [null], at: '2026-10-18T08:08:00.000Z' },
      ],
      pins: { '-100:7': pin, '-100:8': post },
    }),
  )
  const ledger = new Ledger(dir, 'telegram')
  expect(ledger.find('-100:7', 41)).toMatchObject({ app: 'telegram', text: 'Deploy now?', options: ['Deploy', 'Wait'], at: '2026-10-18T08:00:00.000Z' })
  expect(ledger.byPoll('p-42')!.answer).toMatchObject({ label: 'B', via: 'telegram' })
  expect(ledger.find('-100:7', 43)).toBeUndefined()
  expect(ledger.find('-100:7', 44)).toBeUndefined()
  expect(ledger.pin('-100:7')).toEqual({ app: 'telegram', thread: '-100:7', ...pin })
  expect(ledger.pin('-100:8')).toEqual({ app: 'telegram', thread: '-100:8', ...post })
  expect(ledger.posts()).toEqual(['-100:8'])
  expect(existsSync(file)).toBe(false)
  expect(readFileSync(`${file}.moved-to-hex.db`, 'utf8')).toContain('Deploy now?')
  expect(open(dir).pins()).toHaveLength(2)
})

test('a hex.db that took a ledger in at each start brings in only what an older hex changed in it since, then renames it', () => {
  const store = new Store(dir)
  store.pinned({ app: 'telegram', thread: '-100:8', message: 30, text: 'pinned again here' })
  store.pinned({ app: 'telegram', thread: '-100:9', message: 20, text: 'pinned after the move' })
  store.db.run('create table files (name text primary key, body text not null); create table shown (session text primary key, digest text not null); alter table seen drop column at; pragma user_version = 19')
  const taken = { pins: { '-100:7': { message: 9, text: 'old', at: '2026-10-18T09:00:00.000Z' }, '-100:8': { message: 12, text: 'rolled back', at: '2026-10-19T09:00:00.000Z' } } }
  store.db.query('insert into files (name, body) values (?, ?)').run('telegram/ledger.json', JSON.stringify(taken))
  store.db.close()
  writeFileSync(file, JSON.stringify({ pins: { '-100:6': { message: 5, text: 'pinned there', at: '2026-10-20T09:00:00.000Z' }, '-100:8': { message: 12, text: 'edited there', at: '2026-10-20T09:00:00.000Z' } } }))
  const after = new Store(dir)
  expect(after.pins().map(({ thread, message, text }) => ({ thread, message, text }))).toEqual([
    { thread: '-100:6', message: 5, text: 'pinned there' },
    { thread: '-100:8', message: 30, text: 'pinned again here' },
    { thread: '-100:9', message: 20, text: 'pinned after the move' },
  ])
  expect(existsSync(file)).toBe(false)
  expect(after.db.query("select name from sqlite_master where name in ('files', 'shown')").all()).toEqual([])
})

test("a ledger.json that can't be read stays where it is", () => {
  writeFileSync(file, '{"broken')
  expect(new Ledger(dir, 'telegram').pin('-100:7')).toBeUndefined()
  expect(existsSync(file)).toBe(true)
})

test('a question stays open through an edit and leaves the waiting list only when answered or settled, and a pin keeps its latest text', () => {
  const ledger = new Ledger(dir, 'telegram')
  const store = open(dir)
  ledger.ask('-100:7', 41, 'Deploy now?', ['Deploy', 'Wait'])
  ledger.edited('-100:7', 41, 'Deploy now? CI is green.')
  expect(store.questions({ waiting: true })).toMatchObject([{ text: 'Deploy now? CI is green.' }])
  ledger.settled('-100:7', 41, '✓ Settled')
  expect(store.questions({ waiting: true })).toEqual([])
  ledger.reopened('-100:7', 41)
  ledger.answered('-100:7', 41, 'Deploy', 'app')
  expect(ledger.find('-100:7', 41)).toMatchObject({ answer: { label: 'Deploy', via: 'app' } })
  expect(ledger.find('-100:7', 41)!.settled).toBeUndefined()
  ledger.pinned('-100:7', 9, 'Status: starting')
  ledger.edited('-100:7', 9, 'Status: shipped')
  expect(ledger.pin('-100:7')).toMatchObject({ message: 9, text: 'Status: shipped' })
  ledger.forget('-100:7')
  expect(ledger.questions).toEqual([])
  expect(ledger.pin('-100:7')).toBeUndefined()
})

test("a pin with a note is the thread's status post: hex rewrites it from hex.db under its note, and a pin made meanwhile stands", async () => {
  const ledger = new Ledger(dir, 'telegram')
  const edits: [string, unknown, string][] = []
  const edit = async (thread: string, message: unknown, text: string) => void edits.push([thread, message, text])
  ledger.pinned('-100:7', 9, 'Status: by hand')
  await ledger.rewrite('-100:7', 4096, edit)
  expect(ledger.posts()).toEqual([])
  expect(edits).toEqual([])

  ledger.ask('-100:8', 10, 'Ship it?', ['Yes', 'No'])
  ledger.pinned('-100:8', 10, 'Site: example.com', 'Site: example.com')
  expect(ledger.posts()).toEqual(['-100:8'])
  await ledger.rewrite('-100:8', 4096, edit)
  const [[, message, text]] = edits as [[string, unknown, string]]
  expect(message).toBe(10)
  expect(text).toStartWith('Site: example.com\n\n🔴 **Blocked on you**\n1. Ship it? [Yes | No]')
  expect(ledger.pin('-100:8')).toMatchObject({ text, note: 'Site: example.com' })
  expect(ledger.find('-100:8', 10)!.text).toBe('Ship it?')
  await ledger.rewrite('-100:8', 4096, edit)
  expect(edits).toHaveLength(1)

  await ledger.rewrite('-100:8', 4096, edit, 'Site: example.org')
  expect(new Ledger(dir, 'telegram').pin('-100:8')).toMatchObject({ note: 'Site: example.org' })

  const slow = async (...args: [string, unknown, string]) => {
    ledger.pinned('-100:8', 11, 'Status: by hand again')
    await edit(...args)
  }
  await ledger.rewrite('-100:8', 4096, slow, 'Site: example.net')
  expect(ledger.pin('-100:8')).toEqual({ app: 'telegram', thread: '-100:8', message: 11, text: 'Status: by hand again', at: expect.any(String) })
})
