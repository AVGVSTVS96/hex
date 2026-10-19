import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { open, Store } from './store.ts'
import { until } from './until.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'store-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const message = { key: 'telegram:-100:42', to: '-100:7', from: 'telegram', body: 'remind me to buy Cheryl a salty treat', meta: { user: 'bassim' } }

test('a message is kept once, word for word, and a resend under its key changes nothing', () => {
  const store = new Store(dir)
  expect(store.deliver(message)).toBe(true)
  expect(store.deliver({ ...message, body: 'something else' })).toBe(false)
  const kept = store.message(message.key)!
  expect(kept).toMatchObject({ ...message })
  expect(kept.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  expect(kept.taken).toBeUndefined()
})

test('a key has to start with its sender, so the keys hex makes stay its own', () => {
  const store = new Store(dir)
  expect(() => store.deliver({ ...message, key: 'schedule:heartbeat@2026-10-18T21:45Z' })).toThrow()
  expect(() => store.deliver({ ...message, key: '42' })).toThrow()
  expect(store.untaken()).toEqual([])
})

test('the first session to take a message has it, and it leaves what waits', () => {
  const store = new Store(dir)
  store.deliver(message)
  store.deliver({ ...message, key: 'telegram:-100:43', body: 'and some chips' })
  store.deliver({ ...message, key: 'telegram:-100:44', to: '-100:9' })
  expect(store.take(message.key, 'session-a')).toBe(true)
  expect(store.take(message.key, 'session-b')).toBe(false)
  expect(store.take('telegram:-100:99', 'session-a')).toBe(false)
  expect(store.message(message.key)!.taken!.by).toBe('session-a')
  expect(store.untaken('-100:7').map(row => row.body)).toEqual(['and some chips'])
  expect(store.untaken().map(row => row.key)).toEqual(['telegram:-100:43', 'telegram:-100:44'])
})

test("a schedule's slot fires once, and not again while its last message still waits", () => {
  const store = new Store(dir)
  const minute = Date.UTC(2026, 9, 18, 21, 45) / 60_000
  expect(store.fire('heartbeat', minute, 'general', '[heartbeat] Hourly check')).toBe(true)
  expect(store.fire('heartbeat', minute, 'general', '[heartbeat] Hourly check')).toBe(false)
  expect(store.fire('heartbeat', minute + 60, 'general', '[heartbeat] Hourly check')).toBe(false)
  expect(store.fire('call', minute, 'general', '[call] Ring if needed', true)).toBe(true)
  expect(store.message('schedule:heartbeat@2026-10-18T21:45Z')).toMatchObject({ to: 'general', from: 'schedule', meta: { user: 'schedule', schedule: 'heartbeat' } })
  expect(store.message('schedule:call@2026-10-18T21:45Z')!.meta!.late).toBe('true')
  store.take('schedule:heartbeat@2026-10-18T21:45Z', 'session-a')
  expect(store.fire('heartbeat', minute + 60, 'general', '[heartbeat] Hourly check')).toBe(true)
})

test('the scheduler keeps the last minute it checked', () => {
  const store = new Store(dir)
  expect(store.checked()).toBeUndefined()
  store.check(100)
  store.check(101)
  expect(new Store(dir).checked()).toBe(101)
})

test('a change committed in another process rings the bell, and a write that changed nothing stays quiet', async () => {
  const store = open(dir)
  expect(open(dir)).toBe(store)
  let rang = 0
  const stop = store.watch(() => rang++)
  const cli = Bun.spawn(['bun', join(import.meta.dir, 'cli.ts'), dir, 'deliver', 'job:build:abc', '--to', 'general', '[job]', 'build', 'ended'])
  expect(await cli.exited).toBe(0)
  await until(() => rang > 0)
  expect(store.message('job:build:abc')).toMatchObject({ to: 'general', from: 'job', body: '[job] build ended', meta: { user: 'job' } })
  const bell = readFileSync(join(dir, 'hex.bell'), 'utf8')
  expect(store.take('job:nothing:here', 'session-a')).toBe(false)
  expect(readFileSync(join(dir, 'hex.bell'), 'utf8')).toBe(bell)
  stop()
})

test('hex deliver says how to call it when something is missing', async () => {
  for (const args of [['job:build:abc', 'no thread'], ['build', '--to', 'general', 'no sender']]) {
    const cli = Bun.spawn(['bun', join(import.meta.dir, 'cli.ts'), dir, 'deliver', ...args], { stderr: 'pipe' })
    expect(await cli.exited).toBe(2)
    expect(await new Response(cli.stderr).text()).toContain('hex deliver <from>:<id> --to <thread>')
  }
})

const ask = { ...message, key: 'telegram:-100:50', body: 'Fix the login page. Also the logo looks blurry on retina.' }

test("a task holds the owner's words as they sent them, quoted whole or in part, and never retyped", () => {
  const store = new Store(dir)
  store.deliver(ask)
  const whole = store.createTask({ message: ask.key, owner: '-100:7' })
  expect(whole).toMatchObject({ id: 't-1', owner: '-100:7', status: 'open', words: [{ message: ask.key, text: ask.body, who: 'bassim' }] })
  expect(store.createTask({ message: ask.key, quote: 'the logo looks blurry on retina', owner: '-100:7' }).words[0]!.text).toBe('the logo looks blurry on retina')
  expect(() => store.createTask({ message: ask.key, quote: 'the logo is blurry', owner: '-100:7' })).toThrow("isn't in telegram:-100:50 as written")
  expect(() => store.createTask({ message: 'telegram:-100:404', owner: '-100:7' })).toThrow('no message')
  expect(() => store.db.run("insert into words (task, message, text) values (1, 'telegram:-100:50', 'fix it all')")).toThrow('character for character')
  expect(() => store.db.run("update words set text = 'Fix it' where task = 1")).toThrow('never rewritten')
  expect(() => store.db.run('delete from words')).toThrow('never taken away')
  expect(() => store.db.run("update messages set body = 'Fix it'")).toThrow('keeps its words')
  expect(() => store.createTask({ message: ask.key, quote: '', owner: '-100:7' })).toThrow('needs words')
  store.db.run("insert or replace into messages (key, \"to\", \"from\", body, at) values ('telegram:-100:50', '-100:7', 'telegram', 'Fix it', '2026-10-19T00:00:00.000Z')")
  expect(store.message(ask.key)!.body).toBe(ask.body)
  expect(() => store.db.run("insert or replace into words (rowid, task, message, text) values (1, 1, 'telegram:-100:50', 'Fix the login page.')")).toThrow('never rewritten')
  expect(store.tasks().map(task => task.id)).toEqual(['t-1', 't-2'])
  expect(store.task('t-1')!.words[0]!.text).toBe(ask.body)
})

test('follow-ups are added after what was said first, and a repeat changes nothing', () => {
  const store = new Store(dir)
  store.deliver(ask)
  store.deliver({ ...message, key: 'telegram:-100:51', body: 'and make it work on mobile' })
  const task = store.createTask({ message: ask.key, quote: 'Fix the login page.', owner: '-100:7' })
  store.addWords(task.id, 'telegram:-100:51')
  store.addWords(task.id, 'telegram:-100:51')
  expect(store.task(task.id)!.words.map(words => words.text)).toEqual(['Fix the login page.', 'and make it work on mobile'])
})

test('done needs a proof, and the states are the four a task has', () => {
  const store = new Store(dir)
  store.deliver(ask)
  const { id } = store.createTask({ message: ask.key, owner: '-100:7', status: 'idea' })
  expect(() => store.editTask(id, { status: 'done' })).toThrow()
  expect(() => store.editTask(id, { status: 'finished' as any })).toThrow()
  store.editTask(id, { project: 'site', doneWhen: 'it signs in' })
  expect(store.editTask(id, { owner: '-100:9', project: undefined })).toMatchObject({ owner: '-100:9', project: 'site', doneWhen: 'it signs in' })
  expect(store.editTask(id, { status: 'done', proof: 'https://example.com/pr/1' })).toMatchObject({ status: 'done', proof: 'https://example.com/pr/1' })
  expect(store.tasks({ status: ['open', 'idea'] })).toEqual([])
  expect(store.tasks({ status: ['done'] }).map(task => task.id)).toEqual([id])
})

test("a merge puts the duplicate's words after the task's own, drops it, and its follow-ups go where it went", () => {
  const store = new Store(dir)
  store.deliver(ask)
  store.deliver({ ...message, key: 'telegram:-100:60', to: '-100:9', body: 'the login page is broken' })
  store.deliver({ ...message, key: 'telegram:-100:61', to: '-100:9', body: 'still broken btw' })
  const kept = store.createTask({ message: ask.key, quote: 'Fix the login page.', owner: '-100:7' })
  const duplicate = store.createTask({ message: 'telegram:-100:60', owner: '-100:9' })
  const merged = store.mergeTasks(kept.id, duplicate.id)
  expect(merged.words.map(words => words.text)).toEqual(['Fix the login page.', 'the login page is broken'])
  expect(store.task(duplicate.id)).toMatchObject({ status: 'dropped', mergedInto: kept.id })
  expect(store.addWords(duplicate.id, 'telegram:-100:61').id).toBe(kept.id)
  expect(store.task(kept.id)!.words).toHaveLength(3)
  expect(() => store.editTask(duplicate.id, { status: 'open' })).toThrow()
  expect(() => store.mergeTasks(kept.id, duplicate.id)).toThrow('dropped')
  expect(() => store.mergeTasks(kept.id, kept.id)).toThrow('itself')
})

test("a session is shown its list again only once it changed, or after its context lost it", () => {
  const store = new Store(dir)
  expect(store.show('session-a', '')).toBe(false)
  expect(store.show('session-a', 'one')).toBe(true)
  expect(store.show('session-a', 'one')).toBe(false)
  expect(store.show('session-b', 'one')).toBe(true)
  store.unshow('session-a')
  expect(store.show('session-a', 'one')).toBe(true)
})

test('hex task makes a task from a message by its key, and the owner is the thread asking', async () => {
  open(dir).deliver(ask)
  const hex = async (...args: string[]) => {
    const cli = Bun.spawn(['bun', join(import.meta.dir, 'cli.ts'), dir, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, HEX_THREAD: 'chat:3' } })
    return { code: await cli.exited, out: await new Response(cli.stdout).text(), err: await new Response(cli.stderr).text() }
  }
  expect(await hex('task', 'new', ask.key, '--quote', 'Fix the login page.', '--done-when', 'it signs in')).toMatchObject({ code: 0 })
  expect(open(dir).task('t-1')).toMatchObject({ owner: 'chat:3', doneWhen: 'it signs in', words: [{ text: 'Fix the login page.' }] })
  expect((await hex('tasks')).out).toContain('Fix the login page.')
  expect(await hex('task', 'done', 't-1')).toMatchObject({ code: 1, err: expect.stringContaining('--proof') })
  expect(await hex('task', 'new', ask.key, '--quote', 'fix login')).toMatchObject({ code: 1, err: expect.stringContaining('as written') })
  expect((await hex('message', ask.key)).out).toBe(`${ask.body}\n`)
})
