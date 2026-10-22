import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { open, Store } from './store.ts'
import { until } from './until.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'store-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const message = { key: 'telegram:-100:42', to: '-100:7', from: 'telegram', body: 'remind me to buy Cheryl a salty treat', author: 'owner', meta: { user: 'bassim' } }

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

test('a message reads as its newest edit, made in any topic of its chat, even when only the edit was kept', () => {
  const store = new Store(dir)
  const sent = { key: 'telegram:-100:42', to: '-100:7', from: 'telegram', author: 'hex', body: 'Deploy at 5' }
  store.deliver(sent)
  expect(store.latest(sent.key)?.body).toBe('Deploy at 5')
  store.deliver({ ...sent, key: 'telegram:edit-1', body: 'Deploy at 6', meta: { edited: 'true', message_id: '42' } })
  store.deliver({ ...sent, key: 'telegram:edit-2', body: 'Deploy at 7', meta: { edited: 'true', message_id: '42' } })
  store.deliver({ ...sent, key: 'telegram:edit-3', to: '-200:3', body: 'another chat', meta: { edited: 'true', message_id: '42' } })
  store.deliver({ ...sent, key: 'discord:edit-4', from: 'discord', body: 'another app', meta: { edited: 'true', message_id: '42' } })
  expect(store.latest(sent.key)?.body).toBe('Deploy at 7')
  store.deliver({ ...sent, key: 'telegram:edit-5', to: '-100:9', body: 'Deploy at 8, edited from another topic', meta: { edited: 'true', message_id: '42' } })
  expect(store.latest(sent.key)).toMatchObject({ key: sent.key, to: '-100:7', body: 'Deploy at 8, edited from another topic' })
  expect(store.latest('telegram:-100:43')).toBeNull()
  store.deliver({ key: 'buzz:e2', to: 'thread', from: 'buzz', author: 'owner', body: 'tagged on edit', meta: { edited: 'true', message_id: 'e1' } })
  expect(store.latest('buzz:e1')?.body).toBe('tagged on edit')
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

test("a schedule's slot fires once, and its next slot fires whether or not the last was taken", () => {
  const store = new Store(dir)
  const minute = Date.UTC(2026, 9, 18, 21, 45) / 60_000
  expect(store.fire('heartbeat', minute, 'general', '[heartbeat] Hourly check')).toBe(true)
  expect(store.fire('heartbeat', minute, 'general', '[heartbeat] Hourly check')).toBe(false)
  expect(store.fire('heartbeat', minute + 60, 'general', '[heartbeat] Hourly check')).toBe(true)
  expect(store.fire('call', minute, 'general', '[call] Ring if needed', true)).toBe(true)
  expect(store.message('schedule:heartbeat@2026-10-18T21:45Z')).toMatchObject({ to: 'general', from: 'schedule', meta: { user: 'schedule', schedule: 'heartbeat' } })
  expect(store.message('schedule:call@2026-10-18T21:45Z')!.meta!.late).toBe('true')
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

test('a change right after the one the bell just rang for is still heard', async () => {
  const store = open(dir)
  const seen: (string | undefined)[] = []
  const stop = store.watch(() => {
    seen.push(store.message('job:quick:2')?.body)
    if (seen.length === 1) store.deliver({ key: 'job:quick:2', to: 'general', from: 'job', author: 'prompt', body: 'two' })
  })
  store.deliver({ key: 'job:quick:1', to: 'general', from: 'job', author: 'prompt', body: 'one' })
  await until(() => seen.at(-1) === 'two')
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

test('a task from before titles gets its first words as its title', () => {
  const store = new Store(dir)
  store.deliver({ ...ask, body: 'Fix the login page.\nIt 500s on submit.' })
  store.createTask({ title: 'x', message: ask.key, owner: '-100:7' })
  store.db.run('update tasks set title = null')
  store.db.run('drop index said; drop table profiles')
  store.db.run('alter table messages drop column author')
  store.db.run('drop table seen')
  store.db.run('drop table pins; create table shown (session text primary key, digest text not null); drop table threads; create table threads (app text not null, thread text not null, name text not null, primary key (app, thread))')
  store.db.run('drop table turns; drop table relays')
  store.db.run('pragma user_version = 10')
  store.db.close()
  expect(new Store(dir).task('t-1')!.title).toBe('Fix the login page. It 500s on submit.')
})

test('a task has a clean title of its own, and its words still come from the message', () => {
  const store = new Store(dir)
  store.deliver(ask)
  const task = store.createTask({ title: '  Sharpen the logo on retina ', message: ask.key, owner: '-100:7' })
  expect(task).toMatchObject({ title: 'Sharpen the logo on retina', words: [{ text: ask.body }] })
  expect(() => store.createTask({ title: ' ', message: ask.key, owner: '-100:7' })).toThrow('needs a title')
  expect(store.editTask(task.id, { title: 'Make the logo crisp' }).title).toBe('Make the logo crisp')
  expect(() => store.editTask(task.id, { title: ' \n' })).toThrow("can't be empty")
  expect(store.editTask(task.id, { title: 'Make the logo\n  crisp ' }).title).toBe('Make the logo crisp')
  expect(store.editTask(task.id, { status: 'done', proof: 'abc123' }).title).toBe('Make the logo crisp')
  expect(store.editTask(task.id, { status: 'open' }).proof).toBeUndefined()
})

test("a task holds the owner's words as they sent them, quoted whole or in part, and never retyped", () => {
  const store = new Store(dir)
  store.deliver(ask)
  const whole = store.createTask({ title: 'Fix it', message: ask.key, owner: '-100:7' })
  expect(whole).toMatchObject({ id: 't-1', owner: '-100:7', status: 'open', words: [{ message: ask.key, text: ask.body, who: 'owner' }] })
  expect(store.createTask({ title: 'Fix it', message: ask.key, quote: 'the logo looks blurry on retina', owner: '-100:7' }).words[0]!.text).toBe('the logo looks blurry on retina')
  expect(() => store.createTask({ title: 'Fix it', message: ask.key, quote: 'the logo is blurry', owner: '-100:7' })).toThrow("isn't in telegram:-100:50 as written")
  expect(() => store.createTask({ title: 'Fix it', message: 'telegram:-100:404', owner: '-100:7' })).toThrow('no message')
  expect(() => store.db.run("insert into words (task, message, text) values (1, 'telegram:-100:50', 'fix it all')")).toThrow('character for character')
  expect(() => store.db.run("update words set text = 'Fix it' where task = 1")).toThrow('only ever cut down')
  expect(() => store.db.run("update messages set body = 'Fix it'")).toThrow('keeps its words')
  expect(() => store.createTask({ title: 'Fix it', message: ask.key, quote: '', owner: '-100:7' })).toThrow('needs words')
  store.db.run("insert or replace into messages (key, \"to\", \"from\", author, body, at) values ('telegram:-100:50', '-100:7', 'telegram', 'owner', 'Fix it', '2026-10-19T00:00:00.000Z')")
  expect(store.message(ask.key)!.body).toBe(ask.body)
  expect(() => store.db.run("insert or replace into words (rowid, task, message, text) values (1, 1, 'telegram:-100:50', 'Fix the login page.')")).toThrow('never rewritten')
  expect(store.tasks().map(task => task.id)).toEqual(['t-2', 't-1'])
  expect(store.task('t-1')!.words[0]!.text).toBe(ask.body)
})

test('a task can be cut down to the words that ask, still quoted as written', () => {
  const store = new Store(dir)
  store.deliver(ask)
  store.createTask({ title: 'Fix it', message: ask.key, owner: '-100:7' })
  expect(store.requote('t-1', ask.key, 'Fix the login page.').words.map(words => words.text)).toEqual(['Fix the login page.'])
  expect(() => store.requote('t-1', ask.key, 'fix it all')).toThrow('holds no whole message')
  expect(store.requote('t-1', ask.key, 'Fix the login page.').words.map(words => words.text)).toEqual(['Fix the login page.'])
  expect(store.task('t-1')!.words.map(words => words.text)).toEqual(['Fix the login page.'])
  expect(() => store.db.run("update words set text = 'Fix it all' where task = 1")).toThrow('only ever cut down')
  expect(() => store.db.run('delete from words')).toThrow('never taken away')
})

test('cutting a whole message down keeps the other asks quoted from it', () => {
  const store = new Store(dir)
  store.deliver(ask)
  store.createTask({ title: 'Fix it', message: ask.key, owner: '-100:7' })
  store.addWords('t-1', ask.key, 'the logo looks blurry on retina')
  store.requote('t-1', ask.key, 'Fix the login page.')
  expect(store.task('t-1')!.words.map(words => words.text)).toEqual(['Fix the login page.', 'the logo looks blurry on retina'])
})

test('a task already holding the ask folds its whole copy of the message into it', () => {
  const store = new Store(dir)
  store.deliver(ask)
  store.createTask({ title: 'Fix it', message: ask.key, owner: '-100:7' })
  store.addWords('t-1', ask.key, 'Fix the login page.')
  expect(store.requote('t-1', ask.key, 'Fix the login page.').words.map(words => words.text)).toEqual(['Fix the login page.'])
  expect(store.requote('t-1', ask.key, 'Fix the login page.').words.map(words => words.text)).toEqual(['Fix the login page.'])
  expect(() => store.db.run('update words set rowid = 99 where task = 1')).toThrow('only ever cut down')
})

test('cutting takes the whole message and leaves quotes picked on purpose alone', () => {
  const store = new Store(dir)
  store.deliver(ask)
  store.createTask({ title: 'Fix it', message: ask.key, owner: '-100:7' })
  store.deliver({ ...ask, key: 'telegram:-100:51', body: 'Also the docs.' })
  store.addWords('t-1', 'telegram:-100:51')
  store.addWords('t-1', ask.key, 'Fix the login page.')
  store.requote('t-1', ask.key, 'Fix the login page.')
  expect(store.task('t-1')!.words.map(words => words.text)).toEqual(['Fix the login page.', 'Also the docs.'])
  store.addWords('t-1', ask.key, 'the logo looks blurry on retina')
  expect(() => store.requote('t-1', ask.key, 'blurry')).toThrow('holds no whole message')
  expect(store.task('t-1')!.words.map(words => words.text)).toEqual(['Fix the login page.', 'Also the docs.', 'the logo looks blurry on retina'])
  expect(() => store.db.run("delete from words where text = 'Also the docs.'")).toThrow('never taken away')
})

test("a task from a T3 Code prompt holds what was asked, not T3's instructions around it", () => {
  const store = new Store(dir)
  const body = '<t3_code_instructions>\n## T3 Code interaction mode: Default\n</t3_code_instructions>\n\n<user_request>\nship it\n</user_request>\n\n<runtime_info>opus</runtime_info>'
  store.deliver({ key: 't3:1', to: 'thread-1', from: 't3', author: 'owner', body, meta: { ts: '2026-10-20T00:00:00.000Z' } })
  expect(store.createTask({ title: 'Fix it', message: 't3:1', owner: 'thread-1' }).words[0]!.text).toBe('ship it')
  expect(() => store.addWords('t-1', 't3:1', body)).toThrow("isn't in")
  expect(store.addWords('t-1', 't3:1').words.map(words => words.text)).toEqual(['ship it'])
  expect(store.requote('t-1', 't3:1', 'ship').words.map(words => words.text)).toEqual(['ship'])
  expect(store.requote('t-1', 't3:1', 'ship').words.map(words => words.text)).toEqual(['ship'])
  const shot = `${body}\n\n[image: /inbox/1.png]`
  store.deliver({ key: 't3:2', to: 'thread-1', from: 't3', author: 'owner', body: shot, meta: { ts: '2026-10-20T00:00:00.000Z' } })
  expect(store.createTask({ title: 'Fix it', message: 't3:2', owner: 'thread-1' }).words.map(words => words.text)).toEqual(['ship it', '[image: /inbox/1.png]'])
  expect(store.requote('t-2', 't3:2', 'ship').words.map(words => words.text)).toEqual(['ship', '[image: /inbox/1.png]'])
  store.addWords('t-2', 't3:2')
  expect(store.task('t-2')!.words.map(words => words.text)).toEqual(['ship', '[image: /inbox/1.png]'])
  const attached = '<t3_code_instructions>\nx\n</t3_code_instructions>\n\n<user_request>\nship it\n</user_request>\n\n[image: /inbox/2.png]'
  store.deliver({ key: 't3:5', to: 'thread-1', from: 't3', author: 'owner', body: attached, meta: { ts: '2026-10-20T00:00:00.000Z' } })
  expect(store.createTask({ title: 'Fix it', message: 't3:5', owner: 'thread-1' }).words.map(words => words.text)).toEqual(['ship it', '[image: /inbox/2.png]'])
  const tagged = '<user_request>\nmake the header say\n<title>Hello</title>\n</user_request>\n\n<runtime_info>opus</runtime_info>'
  store.deliver({ key: 't3:4', to: 'thread-1', from: 't3', author: 'owner', body: tagged, meta: { ts: '2026-10-20T00:00:00.000Z' } })
  expect(store.createTask({ title: 'Fix it', message: 't3:4', owner: 'thread-1' }).words[0]!.text).toBe('make the header say\n<title>Hello</title>')
  store.deliver({ key: 't3:3', to: 'thread-1', from: 't3', author: 'owner', body: 'and the docs\n\n<runtime_info>opus</runtime_info>', meta: { ts: '2026-10-20T00:00:00.000Z' } })
  expect(store.createTask({ title: 'Fix it', message: 't3:3', owner: 'thread-1' }).words[0]!.text).toBe('and the docs')
  store.deliver({ ...ask, key: 'telegram:-100:51', body: 'paste: <user_request>x</user_request>' })
  expect(store.createTask({ title: 'Fix it', message: 'telegram:-100:51', owner: '-100:7' }).words[0]!.text).toBe('paste: <user_request>x</user_request>')
})

test('follow-ups are added after what was said first, and a repeat changes nothing', () => {
  const store = new Store(dir)
  store.deliver(ask)
  store.deliver({ ...message, key: 'telegram:-100:51', body: 'and make it work on mobile' })
  const task = store.createTask({ title: 'Fix it', message: ask.key, quote: 'Fix the login page.', owner: '-100:7' })
  store.addWords(task.id, 'telegram:-100:51')
  store.addWords(task.id, 'telegram:-100:51')
  expect(store.task(task.id)!.words.map(words => words.text)).toEqual(['Fix the login page.', 'and make it work on mobile'])
})

test('done needs a proof, and the states are the four a task has', () => {
  const store = new Store(dir)
  store.deliver(ask)
  const { id } = store.createTask({ title: 'Fix it', message: ask.key, owner: '-100:7', status: 'idea' })
  expect(() => store.editTask(id, { status: 'done' })).toThrow()
  expect(() => store.editTask(id, { status: 'finished' as any })).toThrow()
  store.editTask(id, { project: 'site', doneWhen: 'it signs in' })
  expect(store.editTask(id, { owner: '-100:9', project: undefined })).toMatchObject({ owner: '-100:9', project: 'site', doneWhen: 'it signs in' })
  expect(store.editTask(id, { status: 'done', proof: 'https://example.com/pr/1' })).toMatchObject({ status: 'done', proof: 'https://example.com/pr/1' })
  expect(store.tasks({ status: ['open', 'idea'] })).toEqual([])
  expect(store.tasks({ status: ['done'] }).map(task => task.id)).toEqual([id])
})

test('a task keeps when it was closed: set when it ends, kept through later edits, cleared if it opens again', () => {
  const store = new Store(dir)
  store.deliver(ask)
  const { id } = store.createTask({ title: 'Fix it', message: ask.key, owner: '-100:7' })
  expect(store.task(id)!.closed).toBeUndefined()
  const { closed } = store.editTask(id, { status: 'done', proof: 'https://example.com/pr/1' })
  expect(closed).toBeString()
  expect(store.editTask(id, { proof: 'https://example.com/pr/2' }).closed).toBe(closed)
  expect(store.editTask(id, { status: 'open' }).closed).toBeUndefined()
  const duplicate = store.createTask({ title: 'Fix it', message: ask.key, quote: 'Fix the login page.', owner: '-100:7' })
  expect(store.mergeTasks(id, duplicate.id)).toMatchObject({ status: 'open' })
  expect(store.task(duplicate.id)!.closed).toBeString()
})

test("a merge puts the duplicate's words after the task's own, drops it, and its follow-ups go where it went", () => {
  const store = new Store(dir)
  store.deliver(ask)
  store.deliver({ ...message, key: 'telegram:-100:60', to: '-100:9', body: 'the login page is broken' })
  store.deliver({ ...message, key: 'telegram:-100:61', to: '-100:9', body: 'still broken btw' })
  const kept = store.createTask({ title: 'Fix it', message: ask.key, quote: 'Fix the login page.', owner: '-100:7' })
  const duplicate = store.createTask({ title: 'Fix it', message: 'telegram:-100:60', owner: '-100:9' })
  const merged = store.mergeTasks(kept.id, duplicate.id)
  expect(merged.words.map(words => words.text)).toEqual(['Fix the login page.', 'the login page is broken'])
  expect(store.task(duplicate.id)).toMatchObject({ status: 'dropped', mergedInto: kept.id })
  expect(store.addWords(duplicate.id, 'telegram:-100:61').id).toBe(kept.id)
  expect(store.task(kept.id)!.words).toHaveLength(3)
  expect(() => store.editTask(duplicate.id, { status: 'open' })).toThrow()
  expect(() => store.mergeTasks(kept.id, duplicate.id)).toThrow('dropped')
  expect(() => store.mergeTasks(kept.id, kept.id)).toThrow('itself')
})

test("each app's threads.json comes into hex.db once, as that app's open threads", () => {
  new Store(dir).db.close()
  const old = new Database(join(dir, 'hex.db'))
  old.run('drop table pins; create table shown (session text primary key, digest text not null); alter table seen drop column at; drop table threads; create table threads (app text not null, thread text not null, name text not null, primary key (app, thread))')
  old.run("insert into threads values ('telegram', '-100:9', 'Errands')")
  old.run('drop table turns; drop table relays')
  old.run('pragma user_version = 16')
  old.close()
  mkdirSync(join(dir, 'telegram'))
  writeFileSync(join(dir, 'telegram', 'threads.json'), JSON.stringify({ '-100:7': { name: 'Desk', session: 's-1', cwd: '/w', from: 's-0', launched: 'abc' } }))
  mkdirSync(join(dir, 'discord'))
  writeFileSync(join(dir, 'discord', 'threads.json'), '{"broken')
  writeFileSync(join(dir, 'threads.json'), JSON.stringify({ '7': { name: 'Outside a hex' } }))
  expect(new Store(dir).threads()).toEqual([
    { app: 'telegram', thread: '-100:7', name: 'Desk', session: 's-1', cwd: '/w', launched: 'abc', fork: 's-0', open: true },
    { app: 'telegram', thread: '-100:9', name: 'Errands', open: false },
    { app: basename(dir), thread: '7', name: 'Outside a hex', open: true },
  ].sort((a, b) => a.app.localeCompare(b.app) || a.thread.localeCompare(b.thread)))
  expect(['telegram/threads.json', 'threads.json'].map(file => existsSync(join(dir, file)))).toEqual([false, false])
  expect(readFileSync(join(dir, 'telegram', 'threads.json.moved-to-hex.db'), 'utf8')).toContain('Desk')
})

test("a session that ended loses what it was shown, and log/'s turns headed t become T3's", () => {
  const store = new Store(dir)
  store.db.run('create table files (name text primary key, body text not null); create table shown (session text primary key, digest text not null); alter table seen drop column at')
  const shown = store.db.query('insert into seen (session, kind, record) values (?, ?, ?)')
  shown.run('ended', 'tasks', 'old')
  shown.run('live', 'tasks', 'now')
  shown.run('live', 'rules', '{}')
  store.db.query('insert into messages (key, "to", "from", author, body, at) values (?, ?, ?, ?, ?, ?)').run('t:past:abc:0', 'abc', 't', 'owner', 'Quick test from T3', '2026-10-08T10:16:00.000Z')
  store.db.run('drop table turns; drop table relays')
  store.db.run('pragma user_version = 20')
  store.db.close()
  const after = new Store(dir)
  expect([after.seen('ended', 'tasks'), after.seen('live', 'tasks'), after.seen('live', 'rules')]).toEqual(['', 'now', '{}'])
  expect(after.message('t3:past:abc:0')).toMatchObject({ from: 't3', author: 'owner' })
  expect(after.message('t:past:abc:0')).toBeNull()
})

test("each app's relays.jsonl comes into hex.db once, the newest run per pair of threads", () => {
  mkdirSync(join(dir, 'discord'))
  const lines = [
    { at: '2026-10-21T10:00:00.000Z', from: 'fix', thread: 'thread-prims', run: 'run-1' },
    { at: '2026-10-21T10:05:00.000Z', from: 'fix', thread: 'thread-codex', run: 'run-2' },
    { at: '2026-10-21T10:10:00.000Z', from: 'fix', thread: 'thread-prims', run: 'run-3' },
  ]
  writeFileSync(join(dir, 'discord', 'relays.jsonl'), [...lines.map(line => JSON.stringify(line)), 'not json', ''].join('\n'))
  expect(new Store(dir).relays()).toEqual([
    { from: 'discord:fix', thread: 'thread-codex', run: 'run-2' },
    { from: 'discord:fix', thread: 'thread-prims', run: 'run-3' },
  ])
  expect(existsSync(join(dir, 'discord', 'relays.jsonl'))).toBe(false)
  expect(existsSync(join(dir, 'discord', 'relays.jsonl.moved-to-hex.db'))).toBe(true)
})

test("a session's turns: one begins, ends, and the next begins again, an end from before its begin is old news, and one not heard from in 30 days goes", () => {
  const store = new Store(dir)
  store.turned('s-1', true)
  expect(store.turn('s-1')).toEqual({ began: expect.any(String) })
  store.turned('s-1', false)
  const { began, ended } = store.turn('s-1')
  expect(ended! >= began!).toBe(true)
  store.turned('s-1', true, '2026-10-21T10:00:00.000Z')
  store.turned('s-1', false, '2026-10-21T09:59:59.000Z')
  expect(store.turn('s-1')).toEqual({ began: '2026-10-21T10:00:00.000Z' })
  store.db.run("update turns set began = '2026-01-01T00:00:00.000Z', ended = '2026-01-01T00:00:01.000Z'")
  store.turned('s-2', true)
  expect(store.turn('s-1')).toEqual({})
  expect(store.turn('s-2')).toEqual({ began: expect.any(String) })
})

test("a thread keeps its row after it closes, and takes a new name when renamed", () => {
  const store = new Store(dir)
  store.keepThreads('telegram', { '-100:7': { name: 'tokenhub', session: 's-1', cwd: '/w' }, '-100:8': { name: 'portfolio' } })
  store.keepThreads('telegram', { '-100:7': { name: 'tokenhub and deck', session: 's-2', model: 'opus', link: 'https://t.me/c/100/7' } })
  store.keepThreads('discord', { '1561': { name: 'Fixhex' } })
  expect(store.threads()).toEqual([
    { app: 'discord', thread: '1561', name: 'Fixhex', open: true },
    { app: 'telegram', thread: '-100:7', name: 'tokenhub and deck', session: 's-2', model: 'opus', link: 'https://t.me/c/100/7', open: true },
    { app: 'telegram', thread: '-100:8', name: 'portfolio', open: false },
  ])
  expect(store.threads({ app: 'telegram', open: true }).map(thread => thread.thread)).toEqual(['-100:7'])
})

test("a thread is named by <app>:<key>, and by its bare key only where one app has that key", async () => {
  const store = new Store(dir)
  store.keepThreads('discord', { '1561': { name: 'Fixhex' }, '1562': { name: 'Deck' } })
  store.keepThreads('buzz', { '1561': { name: 'Lab' } })
  expect(store.names()).toEqual({ 'discord:1561': 'Fixhex', 'discord:1562': 'Deck', '1562': 'Deck', 'buzz:1561': 'Lab' })
  expect(store.ids()).toEqual({ '1562': 'discord:1562' })
  const cli = Bun.spawn(['bun', join(import.meta.dir, 'cli.ts'), dir, 'threads', '--json'], { stdout: 'pipe' })
  expect(JSON.parse(await new Response(cli.stdout).text()).map(({ id }: { id: string }) => id)).toEqual(['buzz:1561', 'discord:1561', 'discord:1562'])
})

test("what a session was shown is kept per kind, until its context loses it", () => {
  const store = new Store(dir)
  expect(store.seen('session-a', 'tasks')).toBe('')
  store.show('session-a', 'tasks', 'one')
  store.show('session-a', 'rules', '{}')
  store.show('session-b', 'tasks', 'two')
  expect(store.seen('session-a', 'tasks')).toBe('one')
  store.unshow('session-a', 'tasks')
  expect([store.seen('session-a', 'tasks'), store.seen('session-a', 'rules'), store.seen('session-b', 'tasks')]).toEqual(['', '{}', 'two'])
  store.show('session-c', 'tasks', 'three', new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString())
  expect([store.seen('session-a', 'rules'), store.seen('session-b', 'tasks'), store.seen('session-c', 'tasks')]).toEqual(['{}', '', 'three'])
})

test('hex task makes a task from a message by its key, and the owner is the thread asking', async () => {
  open(dir).deliver(ask)
  const hex = async (...args: string[]) => {
    const cli = Bun.spawn(['bun', join(import.meta.dir, 'cli.ts'), dir, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, HEX_THREAD: 'chat:3' } })
    return { code: await cli.exited, out: await new Response(cli.stdout).text(), err: await new Response(cli.stderr).text() }
  }
  expect(await hex('task', 'new', ask.key, '--done-when', 'it signs in')).toMatchObject({ code: 1, err: expect.stringContaining('needs a title') })
  expect(await hex('task', 'new', ask.key, '--title', 'Fix the login page', '--quote', 'Fix the login page.', '--done-when', 'it signs in')).toMatchObject({ code: 0 })
  expect(open(dir).task('t-1')).toMatchObject({ title: 'Fix the login page', owner: 'chat:3', doneWhen: 'it signs in', words: [{ text: 'Fix the login page.' }] })
  expect((await hex('tasks')).out).toContain('t-1 (open, chat:3): Fix the login page\n')
  expect(await hex('task', 'edit', 't-1', '--title', 'Make sign-in work')).toMatchObject({ code: 0, out: expect.stringContaining(': Make sign-in work\n') })
  expect(await hex('task', 'done', 't-1')).toMatchObject({ code: 1, err: expect.stringContaining('--proof') })
  expect(await hex('task', 'done', 't-1', '--proof', 'shipped', 'in', 'abc123')).toMatchObject({ code: 1, err: expect.stringContaining('"in" isn\'t a flag\'s value') })
  expect((await hex('tasks', '--status', 'open')).out).toBe((await hex('tasks')).out)
  expect(await hex('task', 'new', ask.key, '--title', 'Fix', 'the', 'login')).toMatchObject({ code: 1, err: expect.stringContaining('"the" isn\'t a flag\'s value') })
  expect(await hex('task', 'edit', 't-1', '--title', 'Make', 'it', 'work')).toMatchObject({ code: 1, err: expect.stringContaining('"it" isn\'t') })
  expect(await hex('task', 'new', ask.key, '--title', 'Fix login', '--quote', 'fix login')).toMatchObject({ code: 1, err: expect.stringContaining('as written') })
  expect((await hex('message', ask.key)).out).toBe(`${ask.body}\n`)
})

test("hex pins lists the asking thread's pinned post, or every thread's with --all, as text or JSON", async () => {
  const store = open(dir)
  store.pinned({ app: 'telegram', thread: 'chat:3', message: 9, text: 'Site: example.com\n\n🔴 **Blocked on you**', note: 'Site: example.com' })
  store.pinned({ app: 'discord', thread: '1561', message: '1562', text: 'Status: by hand' })
  const hex = async (...args: string[]) => {
    const cli = Bun.spawn(['bun', join(import.meta.dir, 'cli.ts'), dir, 'pins', ...args], { stdout: 'pipe', env: { ...process.env, HEX_THREAD: 'chat:3', HEX_MAIN: '' } })
    return (await new Response(cli.stdout).text()).trim()
  }
  expect(await hex()).toBe('telegram · chat:3 · message 9 · Site: example.com')
  expect((await hex('--all')).split('\n')).toEqual(['discord · 1561 · message 1562 · Status: by hand', 'telegram · chat:3 · message 9 · Site: example.com'])
  expect(JSON.parse(await hex('--thread', '1561', '--json'))).toEqual([{ app: 'discord', thread: '1561', message: '1562', text: 'Status: by hand', at: expect.any(String), threadId: 'discord:1561' }])
  open(dir).keepThreads('discord', { '1561': { name: 'Fixhex' } })
  expect(await hex('--thread', 'discord:1561', '--json')).toBe(await hex('--thread', '1561', '--json'))
})

test("a question keeps its first answer, a poll's vote replaces the one before, and taking one back says whether there was one", () => {
  const store = new Store(dir)
  const question = { app: 'telegram', thread: '-100:7', message: 41, text: 'Deploy now?', options: ['Deploy', 'Wait'] }
  store.ask(question)
  expect(store.answered('telegram', '-100:7', 41, 'Wait', 'telegram')).toBe(true)
  expect(store.answered('telegram', '-100:7', 41, 'Deploy', 'app')).toBe(false)
  expect(store.question('telegram', '-100:7', 41)!.answer).toMatchObject({ label: 'Wait', via: 'telegram' })
  expect(store.answered('telegram', '-100:7', 41, 'Deploy', 'telegram', true)).toBe(true)
  expect(store.question('telegram', '-100:7', 41)!.answer).toMatchObject({ label: 'Deploy' })
  expect(store.reopened('telegram', '-100:7', 41)).toBe(true)
  expect(store.reopened('telegram', '-100:7', 41)).toBe(false)
  expect(store.answered('telegram', '-100:7', 99, 'Wait', 'telegram')).toBe(false)
})

test('an answer and the message that wakes its thread with it land together or not at all', () => {
  const store = new Store(dir)
  store.ask({ app: 'telegram', thread: '-100:7', message: 41, text: 'Deploy now?', options: ['Deploy', 'Wait'] })
  const wake = { key: 'telegram:tap:1', to: '-100:7', from: 'telegram', author: 'owner', body: 'Wait' }
  expect(() =>
    store.write(() => {
      store.answered('telegram', '-100:7', 41, 'Wait', 'telegram')
      throw new Error('killed before the wake was kept')
    }),
  ).toThrow('killed')
  expect(store.question('telegram', '-100:7', 41)!.answer).toBeUndefined()
  expect(store.write(() => store.answered('telegram', '-100:7', 41, 'Wait', 'telegram') && store.deliver(wake))).toBe(true)
  expect(store.write(() => store.answered('telegram', '-100:7', 41, 'Deploy', 'telegram') && store.deliver({ ...wake, key: 'telegram:tap:2', body: 'Deploy' }))).toBe(false)
  expect(store.message('telegram:tap:2')).toBeNull()
})

test("messages kept under a sender's name get one of hex's five authors, and keep the name in meta.user", () => {
  const store = new Store(dir)
  store.db.run('drop table pins; create table shown (session text primary key, digest text not null); alter table seen drop column at; drop table threads; create table threads (app text not null, thread text not null, name text not null, primary key (app, thread))')
  store.db.run('drop table turns; drop table relays')
  store.db.run('create index unauthored on messages (n) where author = \'\'; pragma user_version = 15')
  const kept = (key: string, from: string, author: string, meta?: object) => store.db.query('insert into messages (key, "to", "from", author, body, meta, at) values (?, ?, ?, ?, ?, ?, ?)').run(key, '-100:7', from, author, 'hi', meta ? JSON.stringify(meta) : null, '2026-10-21T10:00:00.000Z')
  kept('telegram:1', 'telegram', 'hex General', { user: 'hex General' })
  kept('job:a:1', 'job', 'job')
  kept('schedule:b@1', 'schedule', 'schedule', { user: 'schedule' })
  kept('buzz:2', 'buzz', 'buzz:abc', { user: 'Ana', user_id: 'abc' })
  kept('t3:3', 't3', 't3')
  kept('discord:4', 'discord', 'discord')
  kept('telegram:5', 'telegram', 'owner', { user_id: '1' })
  kept('telegram:6', 'telegram', '', { user_id: '1' })
  store.db.close()
  const reopened = new Store(dir)
  expect(reopened.since().map(({ key, author, meta }) => [key, author, meta?.user])).toEqual([
    ['telegram:1', 'prompt', 'hex General'],
    ['job:a:1', 'prompt', 'job'],
    ['schedule:b@1', 'prompt', 'schedule'],
    ['buzz:2', 'other', 'Ana'],
    ['t3:3', 'other', 't3'],
    ['discord:4', 'other', 'discord'],
    ['telegram:5', 'owner', undefined],
    ['telegram:6', 'owner', undefined],
  ])
})

test("a message's author is the owner, hex, a prompt, a call or someone other", () => {
  const store = new Store(dir)
  expect(() => store.deliver({ key: 'telegram:-100:90', to: '-100:7', from: 'telegram', author: '' as never, body: 'hi' })).toThrow('owner, hex, prompt, call or other')
  expect(() => store.deliver({ key: 'job:x:1', to: '-100:7', from: 'job', author: 'job' as never, body: 'hi' })).toThrow('owner, hex, prompt, call or other')
  expect(store.deliver({ key: 'telegram:-100:91', to: '-100:7', from: 'telegram', author: 'other', body: 'hi' })).toBe(true)
})

test('the profile is its newest version, put in place only over the one a writer read, and every version stays', async () => {
  const store = open(dir)
  expect(store.profile()).toBe('')
  expect(store.profiled('', '# Who he is\n- Ships on fridays\n')).toBe(true)
  expect(store.profiled('', '# Who he is\n- Ships any day')).toBe(false)
  expect(store.profiled('# Who he is\n- Ships on fridays', '# Who he is\n- Ships on fridays')).toBe(true)
  expect(store.profiled('# Who he is\n- Ships on fridays', '# Who he is\n- Ships any day')).toBe(true)
  expect(store.profile()).toBe('# Who he is\n- Ships any day')
  expect(store.profiles().map(({ body }) => body)).toEqual(['# Who he is\n- Ships any day', '# Who he is\n- Ships on fridays'])
  const cli = Bun.spawn(['bun', join(import.meta.dir, 'cli.ts'), dir, 'profile'], { stdout: 'pipe' })
  expect(await new Response(cli.stdout).text()).toBe('# Who he is\n- Ships any day\n')
})

test('a profile kept in state/profile.md comes into hex.db with its history, in order and once each, and the files move aside', () => {
  writeFileSync(join(dir, 'profile.md'), '# Who he is\n- Third\n')
  const history = [{ at: '2026-10-21T13:00:00.000Z', profile: '# Always\n- First' }, { at: '2026-10-21T13:32:54.590Z', profile: '# Always\n- First' }, { at: '2026-10-21T15:09:00.000Z', profile: '# Who he is\n- Second' }]
  writeFileSync(join(dir, 'profile.md.history'), history.map(each => JSON.stringify(each)).join('\n') + '\n{"at": "broken\n')
  const store = new Store(dir)
  expect(store.profiles().map(({ body }) => body)).toEqual(['# Who he is\n- Third', '# Who he is\n- Second', '# Always\n- First'])
  expect(store.profiles()[1]!.at).toBe('2026-10-21T13:32:54.590Z')
  expect(store.profiles()[2]!.at).toBe('2026-10-21T13:00:00.000Z')
  expect(readFileSync(join(dir, 'profile.md.moved-to-hex.db'), 'utf8')).toBe('# Who he is\n- Third\n')
  expect(() => store.db.run('delete from profiles')).toThrow('never taken away')
})

test('a carry that renamed the profile files and then failed to commit carries them from their new names', () => {
  writeFileSync(join(dir, 'profile.md.moved-to-hex.db'), '# Who he is\n- Third\n')
  expect(new Store(dir).profile()).toBe('# Who he is\n- Third')
})
