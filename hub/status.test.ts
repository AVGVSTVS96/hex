import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { above, statusPost } from './status.ts'
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
  store.deliver({ key, to: '-100:7', from: 'telegram', body, author: 'owner', meta: { user: 'owner' } })
  return key
}

test("a status post is the note over the thread's waiting questions, open tasks and the last five done", () => {
  const store = new Store(dir)
  const note = 'Site: https://example.com'
  expect(statusPost(store, '-100:7', note, 4096)).toBe(`${note}\n\n**🔴 Blocked on you:** no questions waiting\n\n**🟡 Pending:** no open tasks\n\n**🟢 Done:** no tasks done yet`)

  store.ask({ app: 'telegram', thread: '-100:7', message: 60, text: 'Ship today?\nCI is green.', options: ['Yes', 'No'] })
  store.ask({ app: 'telegram', thread: '-100:8', message: 61, text: 'Elsewhere?', options: ['Yes', 'No'] })
  const open = store.createTask({ title: 'Fix the login page', message: said(store, 50, 'Fix the login page'), owner: '-100:7' })
  const old = store.createTask({ title: 'Rename the repo', message: said(store, 52, 'Rename the repo'), owner: '-100:7' })
  const done = store.createTask({ title: 'Blur the logo less', message: said(store, 51, 'Blur the logo less'), owner: '-100:7' })
  store.createTask({ title: 'Not this thread', message: said(store, 53, 'Not this thread'), owner: '-100:8' })
  store.editTask(old.id, { status: 'done', proof: 'gh repo rename' })
  store.editTask(done.id, { status: 'done', proof: 'shipped in abc123, https://example.com/pull/3.' })

  expect(statusPost(store, '-100:7', note, 4096)).toBe(
    [note, '**🔴 Blocked on you**\n- Ship today?', '**🟡 Pending**\n- Fix the login page', '**🟢 Done**\n- [Blur the logo less](https://example.com/pull/3)\n- Rename the repo'].join('\n\n'),
  )
  expect(statusPost(store, '-100:7', note, 4096, (thread, message) => `https://t.me/c/${thread}/${message}`)).toContain('**🔴 Blocked on you**\n- [Ship today?](https://t.me/c/-100:7/60)\n\n')

  for (let n = 54; n < 58; n++) store.editTask(store.createTask({ title: `Later ${n}`, message: said(store, n, `Later ${n}`), owner: '-100:7' }).id, { status: 'done', proof: 'ok' })
  const latest = statusPost(store, '-100:7', note, 4096)
  expect(latest).toContain('- [Blur the logo less]')
  expect(latest).not.toContain('Rename the repo')
})

test('a status post fits the room the app gives one message, saying how many more there are', () => {
  const store = new Store(dir)
  for (let n = 0; n < 40; n++) store.createTask({ title: `Task number ${n} with enough words to take some room`, message: said(store, n, `Task number ${n} with enough words to take some room`), owner: '-100:7' })
  for (let room = 300; room <= 2100; room += 7) expect(statusPost(store, '-100:7', 'Note', room).length).toBeLessThanOrEqual(room)
  const long = statusPost(store, '-100:7', 'x'.repeat(3000), 2000)
  expect(long.length).toBeLessThanOrEqual(2000)
  expect(long).toMatch(/^x+…\n\n\*\*🔴 Blocked on you:\*\* no questions waiting\n\n\*\*🟡 Pending\*\*\n…and 40 more\n\n\*\*🟢 Done:\*\* no tasks done yet$/)
  const text = statusPost(store, '-100:7', 'Note', 2000)
  expect(text).toMatch(/\n…and \d+ more\n\n\*\*🟢 Done:\*\* no tasks done yet$/)
})

test("a done task links to the first link in its proof, without the markdown or punctuation around it", () => {
  const store = new Store(dir)
  const proofs = ['merged in `https://github.com/o/r/pull/3`.', '(see https://en.wikipedia.org/wiki/Foo_(bar))', '**https://example.com/a**', 'commit abc123']
  proofs.forEach((proof, n) => store.editTask(store.createTask({ title: `Task ${n}`, message: said(store, 70 + n, `Task ${n}`), owner: '-100:7' }).id, { status: 'done', proof }))
  expect(statusPost(store, '-100:7', 'Note', 4096).split('**🟢 Done**\n')[1]!.split('\n')).toEqual([
    '- Task 3',
    '- [Task 2](https://example.com/a)',
    '- [Task 1](https://en.wikipedia.org/wiki/Foo_(bar))',
    '- [Task 0](https://github.com/o/r/pull/3)',
  ])
})

test("a status post's note is its words above its first 🔴 🟡 🟢 line", () => {
  expect(above('📌 **desk**\nShipping today\n\n🔴 **Blocked on you**\n- old\n\n🟢 Done')).toBe('📌 **desk**\nShipping today')
  expect(above('Just a note')).toBe('Just a note')
})
