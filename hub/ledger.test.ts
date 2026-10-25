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

test("an older hex's questions and pins move from ledger.json into hex.db once, answers and notes and all (a pin written by hand stays only in its chat), and the file is renamed", () => {
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
  expect(ledger.pin('-100:7')).toBeUndefined()
  expect(ledger.pin('-100:8')).toEqual({ app: 'telegram', thread: '-100:8', ...post })
  expect(existsSync(file)).toBe(false)
  expect(readFileSync(`${file}.moved-to-hex.db`, 'utf8')).toContain('Deploy now?')
  expect(open(dir).pins()).toHaveLength(1)
})

test('a hex.db that took a ledger in at each start brings in only what an older hex changed in it since, then renames it', () => {
  const store = new Store(dir)
  store.pinned({ app: 'telegram', thread: '-100:8', message: 30, text: 'pinned again here', note: 'pinned again here' })
  store.pinned({ app: 'telegram', thread: '-100:9', message: 20, text: 'pinned after the move', note: 'pinned after the move' })
  store.db.run('drop table turns; drop table relays; create table files (name text primary key, body text not null); create table shown (session text primary key, digest text not null); alter table seen drop column at; pragma user_version = 19')
  const taken = { pins: { '-100:7': { message: 9, text: 'old', at: '2026-10-18T09:00:00.000Z' }, '-100:8': { message: 12, text: 'rolled back', at: '2026-10-19T09:00:00.000Z' } } }
  store.db.query('insert into files (name, body) values (?, ?)').run('telegram/ledger.json', JSON.stringify(taken))
  store.db.close()
  writeFileSync(file, JSON.stringify({ pins: { '-100:6': { message: 5, text: 'pinned there', at: '2026-10-20T09:00:00.000Z' }, '-100:8': { message: 12, text: 'edited there', at: '2026-10-20T09:00:00.000Z' } } }))
  const after = new Store(dir)
  expect(after.pins().map(({ thread, message, text }) => ({ thread, message, text }))).toEqual([
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

test('a question stays open through an edit and leaves the waiting list only when answered or settled', () => {
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
  open(dir).pinned({ app: 'telegram', thread: '-100:7', message: 9, text: 'Status: starting', note: 'Status: starting' })
  ledger.forget('-100:7')
  expect(ledger.questions).toEqual([])
  expect(ledger.pin('-100:7')).toBeUndefined()
})

test("a pinned message becomes the thread's status post, rewritten from hex.db under its note, and a pin made meanwhile stands", async () => {
  const ledger = new Ledger(dir, 'telegram')
  const done: unknown[] = []
  const post = { room: 4096, edit: async (thread: string, message: unknown, text: string) => void done.push(['edit', message, text]), link: () => undefined }
  const pin = (message: number) => async () => void done.push(['pin', message])
  const unpin = async (message: unknown) => void done.push(['unpin', message])
  ledger.ask('-100:8', 10, 'Ship it?', ['Yes', 'No'])
  await ledger.post('-100:8', 12, 'Site: example.com', post, pin(12), unpin)
  const [pinned, [, message, text]] = done as [unknown, [string, unknown, string]]
  expect(pinned).toEqual(['pin', 12])
  expect(message).toBe(12)
  expect(text).toStartWith('Site: example.com\n\n**🔴 Blocked on you**\n- Ship it?')
  expect(ledger.pin('-100:8')).toMatchObject({ message: 12, text, note: 'Site: example.com' })
  await ledger.rewrite('-100:8', post)
  expect(done).toHaveLength(2)

  await ledger.rewrite('-100:8', post, 'Site: example.org', 12)
  expect(new Ledger(dir, 'telegram').pin('-100:8')).toMatchObject({ note: 'Site: example.org' })
  await expect(ledger.rewrite('-100:8', post, 'Site: elsewhere', 99)).rejects.toThrow('no longer the status post')
  await ledger.post('-100:8', 12, 'Site: example.org\n\nwhat the post said', post, pin(12), unpin)
  expect(ledger.pin('-100:8')).toMatchObject({ note: 'Site: example.org' })
  expect(done.slice(-1)).toEqual([['pin', 12]])

  const refused = { ...post, edit: async () => Promise.reject(new Error('there is no text in the message to edit')) }
  await expect(ledger.post('-100:8', 13, 'A photo', refused, pin(13), unpin)).rejects.toThrow('no text')
  expect(done.slice(-2)).toEqual([['pin', 13], ['unpin', 13]])
  expect(ledger.pin('-100:8')).toMatchObject({ message: 12 })

  await ledger.post('-100:8', 14, 'Site: moved', post, pin(14), unpin)
  expect(done.slice(-3).map(step => (step as unknown[]).slice(0, 2))).toEqual([['pin', 14], ['edit', 14], ['unpin', 12]])
  expect(ledger.pin('-100:8')).toMatchObject({ message: 14, note: 'Site: moved' })

  const closed = { ...post, edit: async () => false }
  const before = ledger.pin('-100:8')!
  ledger.ask('-100:8', 15, 'Rename it?', ['Yes', 'No'])
  await ledger.rewrite('-100:8', closed)
  expect(ledger.pin('-100:8')).toEqual(before)
  await expect(ledger.rewrite('-100:8', closed, 'Site: closed', 14)).rejects.toThrow('closed')

  const slow = {
    ...post,
    edit: async (...args: [string, unknown, string]) => {
      open(dir).pinned({ app: 'telegram', thread: '-100:8', message: 11, text: 'Status: another post', note: 'Status: another post' })
      await post.edit(...args)
    },
  }
  await ledger.rewrite('-100:8', slow, 'Site: example.net')
  expect(ledger.pin('-100:8')).toEqual({ app: 'telegram', thread: '-100:8', message: 11, text: 'Status: another post', note: 'Status: another post', at: expect.any(String) })
})

test("Telegram's bot.json, which nothing reads now, is renamed", () => {
  writeFileSync(join(dir, 'telegram', 'bot.json'), '{"username":"hex_bot"}')
  open(dir)
  expect([existsSync(join(dir, 'telegram', 'bot.json')), existsSync(join(dir, 'telegram', 'bot.json.moved-to-hex.db'))]).toEqual([false, true])
})
