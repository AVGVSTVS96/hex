import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { Ledger } from './ledger.ts'
import { open } from './store.ts'

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

test("an older hex's questions move from ledger.json into hex.db once, answers and all, and the file keeps its pins", () => {
  const pin = { message: 9, text: 'Status: shipping', at: '2026-10-18T09:00:00.000Z' }
  writeFileSync(
    file,
    JSON.stringify({
      asks: [
        { thread: '-100:7', message: 41, text: 'Deploy now?', options: ['Deploy', 'Wait'], at: '2026-10-18T08:00:00.000Z' },
        { thread: '-100:7', message: 42, text: 'Which take?', options: ['A', 'B'], at: '2026-10-18T08:05:00.000Z', poll: 'p-42', answer: { label: 'B', at: '2026-10-18T08:06:00.000Z', via: 'telegram' } },
        { thread: '-100:7', message: 43, text: 'Broken', options: 'not a list', at: '2026-10-18T08:07:00.000Z' },
        { thread: '-100:7', message: 44, text: 'Blank buttons', options: [null], at: '2026-10-18T08:08:00.000Z' },
      ],
      pins: { '-100:7': pin },
    }),
  )
  const ledger = new Ledger(file, 'telegram')
  expect(ledger.find('-100:7', 41)).toMatchObject({ app: 'telegram', text: 'Deploy now?', options: ['Deploy', 'Wait'], at: '2026-10-18T08:00:00.000Z' })
  expect(ledger.byPoll('p-42')!.answer).toMatchObject({ label: 'B', via: 'telegram' })
  expect(ledger.find('-100:7', 43)).toBeUndefined()
  expect(ledger.find('-100:7', 44)).toBeUndefined()
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ pins: { '-100:7': pin } })
  expect(new Ledger(file, 'telegram').asks).toHaveLength(2)
})

test('a question stays open through an edit and leaves the waiting list only when answered or settled, and a pin keeps its latest text', () => {
  const ledger = new Ledger(file, 'telegram')
  const store = open(join(dir, 'telegram'))
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
  expect(ledger.asks).toEqual([])
  expect(ledger.pin('-100:7')).toBeUndefined()
})

test("a pin with a note is the thread's status post: hex rewrites it from hex.db under its note, and a pin made meanwhile stands", async () => {
  const ledger = new Ledger(file, 'telegram')
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
  expect(new Ledger(file, 'telegram').pin('-100:8')).toMatchObject({ note: 'Site: example.org' })

  const slow = async (...args: [string, unknown, string]) => {
    ledger.pinned('-100:8', 11, 'Status: by hand again')
    await edit(...args)
  }
  await ledger.rewrite('-100:8', 4096, slow, 'Site: example.net')
  expect(ledger.pin('-100:8')).toEqual({ message: 11, text: 'Status: by hand again', at: expect.any(String) })
})

test("a done task leaves the status post when its week is up, though hex.db stays quiet", async () => {
  const ledger = new Ledger(file, 'telegram')
  const store = open(dirname(file))
  const key = 'telegram:-100:51'
  store.deliver({ key, to: '-100:8', from: 'telegram', body: 'Blur the logo less', meta: { user: 'owner' } })
  const task = store.createTask({ message: key, owner: '-100:8' })
  store.editTask(task.id, { status: 'done', proof: 'shipped in abc123' })
  const db = new Database(join(dirname(file), 'hex.db'))
  db.query('update tasks set closed = ?').run(new Date(Date.now() - 7 * 24 * 60 * 60_000 + 150).toISOString())
  db.close()
  ledger.pinned('-100:8', 10, 'Site: example.com', 'Site: example.com')
  const texts: string[] = []
  const stop = ledger.keep(4096, async (_thread, _message, text) => void texts.push(text), () => {})
  await Bun.sleep(50)
  expect(texts.at(-1)).toContain('Blur the logo less')
  await Bun.sleep(250)
  stop()
  expect(texts.at(-1)).toContain('🟢 **Done**\n- nothing')
})

test('a status post pinned while hex runs drops its done task when the week is up, too', async () => {
  const ledger = new Ledger(file, 'telegram')
  const store = open(dirname(file))
  const key = 'telegram:-100:52'
  store.deliver({ key, to: '-100:9', from: 'telegram', body: 'Rename the repo', meta: { user: 'owner' } })
  const task = store.createTask({ message: key, owner: '-100:9' })
  store.editTask(task.id, { status: 'done', proof: 'gh repo rename' })
  const db = new Database(join(dirname(file), 'hex.db'))
  db.query('update tasks set closed = ?').run(new Date(Date.now() - 7 * 24 * 60 * 60_000 + 150).toISOString())
  db.close()
  const texts: string[] = []
  const edit = async (_thread: string, _message: unknown, text: string) => void texts.push(text)
  const stop = ledger.keep(4096, edit, () => {})
  ledger.pinned('-100:9', 10, 'Site: example.com', 'Site: example.com')
  await ledger.rewrite('-100:9', 4096, edit)
  expect(texts.at(-1)).toContain('Rename the repo')
  await Bun.sleep(300)
  stop()
  expect(texts.at(-1)).toContain('🟢 **Done**\n- nothing')
})
