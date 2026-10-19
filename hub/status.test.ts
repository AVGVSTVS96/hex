import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { statusPost } from './status.ts'
import { Store } from './store.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'status-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const said = (store: Store, n: number, body: string) => {
  const key = `telegram:-100:${n}`
  store.deliver({ key, to: '-100:7', from: 'telegram', body, meta: { user: 'owner' } })
  return key
}

test("a status post is the note over the thread's waiting questions, open tasks and this week's done ones", () => {
  const store = new Store(dir)
  const note = 'Site: https://example.com'
  expect(statusPost(store, '-100:7', note, 4096)).toBe(`${note}\n\n🔴 **Blocked on you**\n- nothing\n\n🟡 **Pending**\n- nothing\n\n🟢 **Done**\n- nothing`)

  store.ask({ app: 'telegram', thread: '-100:7', message: 60, text: 'Ship today?\nCI is green.', options: ['Yes', 'No'] })
  store.ask({ app: 'telegram', thread: '-100:8', message: 61, text: 'Elsewhere?', options: ['Yes', 'No'] })
  const open = store.createTask({ message: said(store, 50, 'Fix the login page'), owner: '-100:7' })
  const done = store.createTask({ message: said(store, 51, 'Blur the logo less'), owner: '-100:7' })
  const old = store.createTask({ message: said(store, 52, 'Rename the repo'), owner: '-100:7' })
  store.createTask({ message: said(store, 53, 'Not this thread'), owner: '-100:8' })
  const closed = Date.parse(store.editTask(old.id, { status: 'done', proof: 'gh repo rename' }).closed!)
  store.editTask(done.id, { status: 'done', proof: 'shipped in abc123' })

  expect(statusPost(store, '-100:7', note, 4096, closed + 60_000)).toBe(
    [note, '🔴 **Blocked on you**\n1. Ship today? [Yes | No]', `🟡 **Pending**\n- Fix the login page (${open.id})`, `🟢 **Done**\n- Blur the logo less (${done.id}) · shipped in abc123\n- Rename the repo (${old.id}) · gh repo rename`].join('\n\n'),
  )
  expect(statusPost(store, '-100:7', note, 4096, closed + 8 * 24 * 60 * 60_000)).toEndWith('🟢 **Done**\n- nothing')
})

test('a status post fits the room the app gives one message, saying how many more there are', () => {
  const store = new Store(dir)
  for (let n = 0; n < 40; n++) store.createTask({ message: said(store, n, `Task number ${n} with enough words to take some room`), owner: '-100:7' })
  for (const room of [2000, 1990, 1980, 1970]) expect(statusPost(store, '-100:7', 'Note', room).length).toBeLessThanOrEqual(room)
  const text = statusPost(store, '-100:7', 'Note', 2000)
  expect(text).toMatch(/\n…and \d+ more\n\n🟢 \*\*Done\*\*\n- nothing$/)
})
