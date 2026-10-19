import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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
