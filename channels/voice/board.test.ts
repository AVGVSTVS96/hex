import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Board, track } from './board.ts'
import { until } from '../../hub/until.ts'
import { open, type Kept } from '../../hub/store.ts'

const home = mkdtempSync(join(tmpdir(), 'voice-board-'))
const claude = join(home, 'claude')
const state = join(home, 'hex', 'state')
const hex = join(home, 'hex')
const project = join(claude, 'projects', hex.replace(/[^a-zA-Z0-9]/g, '-'))
afterAll(() => rmSync(home, { recursive: true }))

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

function threads(app: string, all: Record<string, Kept>) {
  mkdirSync(join(state, app), { recursive: true })
  open(state).keepThreads(app, all)
}

function job(session: string, record: object, timeline: object[] = []) {
  const dir = join(claude, 'jobs', session.slice(0, 8))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'timeline.jsonl'), timeline.map(entry => JSON.stringify(entry) + '\n').join(''))
  writeFileSync(join(dir, 'state.json'), JSON.stringify(record))
}

function running(session: string, status: 'busy' | 'idle' | 'shell', pid = process.pid, more: object = {}) {
  mkdirSync(join(claude, 'sessions'), { recursive: true })
  writeFileSync(join(claude, 'sessions', `${session.slice(0, 8)}.json`), JSON.stringify({ pid, sessionId: session, status, ...more }))
}

function step(path: string, name: string, input: object, id = `toolu_${Math.random()}`) {
  said(path, { type: 'tool_use', id, name, input })
}

function said(path: string, content: object, more: object = {}) {
  mkdirSync(join(path, '..'), { recursive: true })
  appendFileSync(path, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: `msg_${Math.random()}`, content: [content] }, ...more }) + '\n')
}

function heard(path: string, content: unknown, more: object = {}) {
  appendFileSync(path, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content }, ...more }) + '\n')
}

function back(path: string, id: string, content: string, more: object = {}) {
  heard(path, [{ type: 'tool_result', tool_use_id: id, content, ...more }])
}

mkdirSync(join(claude, 'jobs'), { recursive: true })
mkdirSync(join(claude, 'sessions'), { recursive: true })
const telegram = {
  '-1001234567890': { name: 'hex', session: 'aaaaaaaa-general', link: 'https://t.me/c/1234567890/1' },
  '-1001234567890:908': { name: 'autofork', session: 'bbbbbbbb-autofork', link: 'https://t.me/c/1234567890/908' },
  '-1001234567890:2583': { name: 'voiceapp', session: 'cccccccc-voiceapp' },
  '-1001234567890:65': { name: 'Theo clips', session: 'dddddddd-theo' },
  '-1001234567890:72': { name: 'Leisure time', session: 'eeeeeeee-leisure' },
}
threads('telegram', telegram)
threads('buzz', { b1: { name: 'Old news', session: 'ffffffff-old' } })
job('aaaaaaaa-general', { state: 'done', detail: 'heartbeat ran', updatedAt: ago(5) })
const [overnight, askedOvernight, published, finished, asked, still] = [ago(13 * 60), ago(12.5 * 60), ago(90), ago(60), ago(40), ago(20)]
job('bbbbbbbb-autofork', { state: 'blocked', detail: 'needs music', needs: 'Pick a music style, and run `claude setup-token`', updatedAt: ago(20) }, [
  { at: overnight, state: 'done', detail: 'Overnight', text: '' },
  { at: askedOvernight, state: 'blocked', detail: 'Asked overnight', text: '' },
  { at: published, state: 'working', detail: 'Publishing', text: '' },
  { at: finished, state: 'done', detail: '**Published** autofork 0.1.2', text: 'npm is live' },
  { at: asked, state: 'blocked', detail: 'needs music', text: 'Your call' },
  { at: still, state: 'blocked', detail: 'still needs music', text: 'Still yours' },
])
const [checking, checked, building] = [Date.now() - 9 * 60_000, Date.now() - 60_000, Date.now() - 5 * 60_000]
const voiceFan = [{ id: 'old', kind: 'agent', label: 'Earlier', doneAt: 1 }, { id: 'agent2', kind: 'agent', label: 'Check the server', startedAt: checking, doneAt: checked }, { id: 'agent1', kind: 'agent', label: 'Build the Tasks view', startedAt: building }, { id: 'sh', kind: 'shell', label: 'sleep' }]
job('cccccccc-voiceapp', { state: 'working', detail: 'building', updatedAt: ago(1), fan: voiceFan }, [
  { at: ago(14), state: 'working', detail: '', text: '' },
])
job('dddddddd-theo', { state: 'stopped', detail: 'stopped', updatedAt: ago(30) }, [{ at: ago(100), state: 'done', detail: 'clips posted', text: 'done' }])
job('eeeeeeee-leisure', { state: 'working', detail: 'was working', updatedAt: ago(29) })
job('ffffffff-old', { state: 'done', detail: 'long ago', updatedAt: ago(8 * 24 * 60) })
running('aaaaaaaa-general', 'idle')
running('cccccccc-voiceapp', 'busy')
running('eeeeeeee-leisure', 'busy', 2 ** 22 + 12345)

const t3 = join(home, 't3')
mkdirSync(t3)
writeFileSync(join(t3, 'environment-id'), 'env-1\n')
const t3db = new Database(join(t3, 'statev2.sqlite'))
t3db.run('create table orchestration_v2_projection_threads (thread_id text primary key, title text, deleted_at text)')
t3db.run('create table orchestration_v2_projection_provider_threads (provider_thread_id text primary key, driver text, updated_at text, payload_json text)')
t3db.run(
  'create table orchestration_v2_projection_subagents (subagent_id text primary key, thread_id text, child_thread_id text, origin text, driver text, status text, started_at text, completed_at text, payload_json text)',
)
t3db.run('create table orchestration_v2_projection_turn_items (turn_item_id text primary key, thread_id text, ordinal integer, type text, status text, payload_json text)')
t3db.run('create table orchestration_v2_projection_messages (thread_id text, role text, created_at text, payload_json text, run_id text)')
t3db.run('create table orchestration_v2_projection_runs (run_id text primary key, thread_id text, ordinal integer, status text, requested_at text, completed_at text)')
afterAll(() => t3db.close())

function mapped(key: string, thread: string, { driver = 'acpRegistry', deleted = null as string | null, title = 'T3 thread' } = {}) {
  t3db.run('insert or replace into orchestration_v2_projection_threads values (?, ?, ?)', [thread, title, deleted])
  t3db.run('insert or replace into orchestration_v2_projection_provider_threads values (?, ?, ?, ?)', [
    `${driver}:${key}`,
    driver,
    new Date().toISOString(),
    JSON.stringify({ appThreadId: thread, nativeThreadRef: { driver, nativeId: key } }),
  ])
}

function handed(task: string, parent: string, child: string, { driver = 'acpRegistry', status = 'running', since = ago(5), end = null as string | null, title = 'a task', model = 'claude-opus-5-5', result = null as string | null, origin = 'app_owned' } = {}) {
  t3db.run('insert or replace into orchestration_v2_projection_subagents values (?, ?, ?, ?, ?, ?, ?, ?, ?)', [task, parent, child, origin, driver, status, since, end, JSON.stringify({ title, model, result })])
}

function ask(thread: string, at: string, payload: object = {}) {
  t3db.run('insert into orchestration_v2_projection_messages (thread_id, role, created_at, payload_json) values (?, ?, ?, ?)', [thread, 'user', at, JSON.stringify(payload)])
}

function item(thread: string, ordinal: number, type: string, status: string, payload: object) {
  t3db.run('insert or replace into orchestration_v2_projection_turn_items values (?, ?, ?, ?, ?, ?)', [`${thread}:${ordinal}`, thread, ordinal, type, status, JSON.stringify({ type, startedAt: ago(1), completedAt: ago(0.5), ...payload })])
}

mkdirSync(join(project, 'cccccccc-voiceapp', 'subagents'), { recursive: true })
writeFileSync(join(project, 'cccccccc-voiceapp', 'subagents', 'agent-agent1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Build the Tasks view' }))
const board = new Board(state, hex, claude, t3)
afterAll(() => board.close())

test("each thread is a run from its session's own records, what needs you first, then what's working, then what finished", () => {
  expect(board.runs.map(run => [run.name, run.state])).toEqual([
    ['autofork', 'needs'],
    ['voiceapp', 'working'],
    ['General', 'done'],
    ['Leisure time', 'idle'],
    ['Theo clips', 'idle'],
  ])
  const autofork = board.get('telegram:-1001234567890:908')!
  expect(autofork).toMatchObject({
    where: 'Telegram',
    place: 'autofork',
    line: 'Pick a music style, and run claude setup-token',
    needs: 'Pick a music style, and run claude setup-token',
    since: asked,
    link: 'https://t.me/c/1234567890/908',
  })
  expect(autofork.lately.map(moment => [moment.state, moment.text])).toEqual([
    ['needs', 'still needs music'],
    ['needs', 'needs music'],
    ['done', 'Published autofork 0.1.2'],
  ])
  expect(autofork.track).toEqual([
    { at: overnight, state: 'done' },
    { at: askedOvernight, state: 'needs' },
    { at: published, state: 'working' },
    { at: finished, state: 'done' },
    { at: asked, state: 'needs' },
    { at: still, state: 'needs' },
  ])
  expect(board.get('telegram:-1001234567890')).toMatchObject({ where: 'General', place: 'General', link: 'https://t.me/c/1234567890/1', running: false })
  expect(board.get('telegram:-1001234567890:2583')!.running).toBe(true)
  expect(board.get('telegram:-1001234567890:65')).toMatchObject({ line: 'clips posted', lately: [] })
  expect(board.get('buzz:b1')).toBeUndefined()
  expect(board.summary).toEqual({ needs: 1, working: 1 })
  expect(board.rows()[0]).not.toContainKeys(['needs', 'lately', 'steps'])
})

test("a working thread's line is its newest step in words, never a tool call, and each of its agents from this stretch of work shows its own, running ones first", async () => {
  const voiceapp = () => board.get('telegram:-1001234567890:2583')!
  expect(voiceapp().agents).toEqual([
    { id: 'agent1', label: 'Build the Tasks view', state: 'working', via: 'claude', since: new Date(building).toISOString(), steps: [] },
    { id: 'agent2', label: 'Check the server', state: 'done', via: 'claude', since: new Date(checking).toISOString(), end: new Date(checked).toISOString(), steps: [] },
  ])
  step(join(project, 'cccccccc-voiceapp.jsonl'), 'Read', { file_path: '/repo/src/tasks.ts' })
  step(join(project, 'cccccccc-voiceapp.jsonl'), 'Edit', { file_path: '/repo/src/tasks.ts', old_string: 'a', new_string: 'b' })
  await until(() => voiceapp().steps.length === 2)
  expect(voiceapp().steps.map(step => [step.kind, step.text])).toEqual([
    ['edit', 'Editing tasks.ts'],
    ['read', 'Reading tasks.ts'],
  ])
  expect(voiceapp().line).toBe('building')
  step(join(project, 'cccccccc-voiceapp.jsonl'), 'Bash', { command: 'cd ~/repo && git status --short && git log --oneline -3' })
  const record = (detail: string) => job('cccccccc-voiceapp', { state: 'working', detail, updatedAt: ago(1), fan: voiceFan }, [{ at: ago(14), state: 'working', detail: '', text: '' }])
  record('Running cd ~/repo && git status --short && git l…')
  await until(() => voiceapp().steps[0]?.kind === 'run')
  await Bun.sleep(50)
  expect(voiceapp().line).not.toContain('Running')
  step(join(project, 'cccccccc-voiceapp.jsonl'), 'Bash', { command: "cd ~/repo && python3 -c '\nimport json\nprint(1)'" })
  step(join(project, 'cccccccc-voiceapp.jsonl'), 'Write', { file_path: '/repo/src/rows.ts', content: 'x' })
  await until(() => voiceapp().steps[0]?.kind === 'edit')
  step(join(project, 'cccccccc-voiceapp.jsonl'), 'Bash', { command: 'for r in a b; do echo $r; done' })
  step(join(project, 'cccccccc-voiceapp.jsonl'), 'Bash', { command: 'pwd' })
  step(join(project, 'cccccccc-voiceapp.jsonl'), 'Grep', { pattern: 'board', path: '/repo' })
  await until(() => voiceapp().steps[0]?.kind === 'search')
  record('Wired the Tasks rows to the board')
  await until(() => voiceapp().line === 'Wired the Tasks rows to the board')
  for (const tool of ['Running pwd', "Running cd ~/repo && python3 -c ' import json print(1)'", 'Writing /repo/src/rows.ts', 'Reading src/tasks.ts', 'Running for r in a b; do ec…', 'Writing /repo/…/rows.ts']) {
    record(tool)
    await Bun.sleep(50)
    expect(voiceapp().line).toBe('')
  }
  record('Tasks rows wired to the board')
  await until(() => voiceapp().line === 'Tasks rows wired to the board')
  record('building')
  await until(() => voiceapp().line === 'building')
  said(join(project, 'cccccccc-voiceapp.jsonl'), { type: 'text', text: 'The **Tasks** view reads its rows now.' })
  step(join(project, 'cccccccc-voiceapp.jsonl'), 'Bash', { command: 'cd ~/repo && git commit -qm "fix: rows"' })
  await until(() => voiceapp().steps[0]?.text.includes('git commit'))
  expect(voiceapp().line).toBe('The Tasks view reads its rows now.')
  const wiring = { state: 'working', detail: 'Wiring rows', text: '' }
  const spoken = Date.now()
  job('cccccccc-voiceapp', { state: 'working', detail: 'Wiring rows', updatedAt: ago(0), fan: voiceFan }, [{ ...wiring, at: new Date(spoken - 30_000).toISOString() }, { ...wiring, at: ago(0) }])
  await Bun.sleep(50)
  expect(voiceapp().line).toBe('The Tasks view reads its rows now.')
  job('cccccccc-voiceapp', { state: 'working', detail: 'Rows render from the board', updatedAt: ago(0), fan: voiceFan }, [{ ...wiring, at: new Date(spoken - 30_000).toISOString() }, { ...wiring, detail: 'Rows render from the board', at: ago(0) }])
  await until(() => voiceapp().line === 'Rows render from the board')
  job('cccccccc-voiceapp', { state: 'working', detail: 'building', updatedAt: ago(1), fan: voiceFan }, [{ at: ago(14), state: 'working', detail: '', text: '' }])
  step(join(project, 'cccccccc-voiceapp', 'subagents', 'agent-agent1.jsonl'), 'Read', { file_path: '/repo/README.md' })
  await until(() => voiceapp().agents[0].line === 'Reading README.md')
  const row = board.rows().find(row => row.name === 'voiceapp')!
  expect(row).not.toContainKey('steps')
  expect(row.agents[0]).toMatchObject({ id: 'agent1', label: 'Build the Tasks view', state: 'working', line: 'Reading README.md' })
})

test("a Claude Code agent shows its type and model, and once it stops, what it handed back", async () => {
  const voiceapp = () => board.get('telegram:-1001234567890:2583')!
  said(join(project, 'cccccccc-voiceapp', 'subagents', 'agent-agent1.jsonl'), { type: 'text', text: 'Looking.' }, { message: { id: 'm', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Looking.' }] } })
  await until(() => voiceapp().agents[0].who === 'Explore · Haiku 5.5')
  heard(
    join(project, 'cccccccc-voiceapp.jsonl'),
    '<task-notification>\n<task-id>agent2</task-id>\n<status>completed</status>\n<result>[harness: matched a pattern.]\n\n**The server** answers in 40ms.\nThe rest is fine.</result>\n</task-notification>',
    { origin: { kind: 'task-notification' } },
  )
  await until(() => !!voiceapp().agents[1].result)
  expect(voiceapp().agents[1]).toMatchObject({ state: 'done', line: 'The server answers in 40ms.', result: 'The server answers in 40ms.\nThe rest is fine.' })
  expect(board.rows().find(row => row.name === 'voiceapp')!.agents[1]).not.toContainKey('result')
})

test("a step's result comes back on it: when it ended, whether it worked, its first lines, and the agent it started", async () => {
  const voiceapp = () => board.get('telegram:-1001234567890:2583')!
  const transcript = join(project, 'cccccccc-voiceapp.jsonl')
  step(transcript, 'Bash', { command: 'bun test', description: 'Run the tests' }, 'toolu_test')
  await until(() => voiceapp().steps[0]?.id === 'toolu_test')
  expect(voiceapp().steps[0]).toMatchObject({ kind: 'run', text: 'Run the tests', state: 'running', detail: 'bun test' })
  back(transcript, 'toolu_test', 'Exit code 1\n2 fail\n9 pass', { is_error: true })
  await until(() => voiceapp().steps[0].state === 'failed')
  expect(voiceapp().steps[0]).toMatchObject({ result: 'Exit code 1\n2 fail\n9 pass', end: expect.any(String) })
  step(transcript, 'Read', { file_path: '/repo/src/big.ts' }, 'toolu_read')
  back(transcript, 'toolu_read', 'a file body')
  step(transcript, 'Agent', { description: 'Check the phone', subagent_type: 'Explore', prompt: 'Look at the phone.\nThen report.' }, 'toolu_agent')
  back(transcript, 'toolu_agent', 'Async agent launched successfully.\nagentId: agent9 (internal ID)')
  await until(() => voiceapp().steps[0].agent === 'agent9')
  const [agent, read] = voiceapp().steps
  expect(agent).toMatchObject({ kind: 'agent', text: 'Started Check the phone', detail: 'Explore\nLook at the phone.', state: 'done' })
  expect(agent).not.toContainKey('result')
  expect(read).toMatchObject({ kind: 'read', text: 'Read big.ts', state: 'done', detail: '/repo/src/big.ts' })
  expect(read).not.toContainKey('result')
})

test("a working thread's page has its thoughts in their own words and its plan as Claude Code's todo list stands", async () => {
  const voiceapp = () => board.get('telegram:-1001234567890:2583')!
  const transcript = join(project, 'cccccccc-voiceapp.jsonl')
  said(transcript, { type: 'thinking', thinking: 'The **list** needs a lane.\n\nThen the rows.', signature: 'x' })
  step(transcript, 'TodoWrite', {
    todos: [
      { content: 'Read the inbox', status: 'completed', activeForm: 'Reading the inbox' },
      { content: 'Draw the lanes', status: 'in_progress', activeForm: 'Drawing the lanes' },
      { content: 'Ship it', status: 'pending', activeForm: 'Shipping it' },
    ],
  })
  await until(() => voiceapp().plan.length === 3)
  expect(voiceapp().plan).toEqual([
    { text: 'Read the inbox', state: 'done' },
    { text: 'Drawing the lanes', state: 'running' },
    { text: 'Ship it', state: 'pending' },
  ])
  expect(voiceapp().steps.slice(0, 2).map(step => [step.kind, step.text])).toEqual([
    ['plan', 'Drawing the lanes'],
    ['think', 'The list needs a lane. Then the rows.'],
  ])
  expect(board.rows().find(row => row.name === 'voiceapp')).not.toContainKey('plan')
})

test('a change to a session wakes the list, and the counts move only when a count does', async () => {
  const { version } = board
  const counted = board.counts.version
  const woke = board.changes(version, 2000)
  job('aaaaaaaa-general', { state: 'done', detail: 'heartbeat ran again', updatedAt: ago(0) })
  await woke
  await until(() => board.get('telegram:-1001234567890')?.line === 'heartbeat ran again')
  expect(board.counts.version).toBe(counted)
  job('aaaaaaaa-general', { state: 'blocked', detail: 'Your call: ship it?', updatedAt: ago(0) })
  await until(() => board.summary.needs === 2)
  expect(board.counts.version).toBeGreaterThan(counted)
  expect(board.runs[0].name).toBe('General')
})

test('a new thread shows up when its app keeps it in hex.db, once its session has records, and links where its app keeps it opening there', async () => {
  threads('discord', { d1: { name: 'Latest Claude', session: '99999999-latest' } })
  job('99999999-latest', { state: 'failed', detail: "You've hit your weekly limit", updatedAt: ago(0) })
  await until(() => board.get('discord:d1')?.state === 'failed')
  expect(board.get('discord:d1')).toMatchObject({ where: 'Discord', line: "You've hit your weekly limit" })
  expect(board.get('discord:d1')!.link).toBeUndefined()
  threads('discord', { d1: { name: 'Latest Claude', session: '99999999-latest', link: 'https://discord.com/channels/3000/d1' } })
  await until(() => board.get('discord:d1')?.link === 'https://discord.com/channels/3000/d1')
})

test("a T3 Code thread is placed by T3's own title for it, where T3 has one", async () => {
  threads('t3', {
    mapped: { name: 'Voice app', session: 'd3000001-mapped', link: 't3code://threads/env-1/4a1e7c52' },
    unmapped: { name: 'Unmapped', session: 'd3000005-unmapped' },
  })
  for (const session of ['d3000001-mapped', 'd3000005-unmapped']) job(session, { state: 'done', detail: 'ok', updatedAt: ago(1) })
  mapped('mapped', '4a1e7c52', { title: 'Voice app restyle' })
  await until(() => board.get('t3:mapped')?.place === 'Voice app restyle')
  expect(board.get('t3:mapped')).toMatchObject({ link: 't3code://threads/env-1/4a1e7c52', name: 'Voice app' })
  expect(board.get('t3:unmapped')!.place).toBe('Unmapped')
})

test("a hex T3 thread's delegations are its agents, one on hex only under it with its own transcript's steps, and the thread works while any of them does", async () => {
  threads('t3', { lead: { name: 'hex', session: 'e5000001-lead' }, kid: { name: 'hex', session: 'e5000002-kid' } })
  job('e5000001-lead', { state: 'done', detail: 'handed it off', updatedAt: ago(6) })
  job('e5000002-kid', { state: 'working', detail: 'reading', updatedAt: ago(1) })
  running('e5000001-lead', 'idle')
  const [kidSince, oldEnd] = [ago(5), ago(2)]
  mapped('lead', 'thread-lead', { title: 'hex primitives' })
  mapped('kid', 'thread-kid', { title: 'kid: map the hub' })
  ask('thread-lead', ago(25))
  handed('task-kid', 'thread-lead', 'thread-kid', { title: 'kid: map the hub', since: kidSince })
  handed('task-sol', 'thread-lead', 'thread-sol', { driver: 'codex', title: 'sol: second opinion', model: 'gpt-6.1-sol', since: ago(3) })
  handed('task-old', 'thread-lead', 'thread-old', { driver: 'codex', status: 'completed', title: 'old: an earlier pass', model: 'default', since: ago(30), end: oldEnd, result: '- Found **three** gaps in [hub.ts:12](/repo/hub.ts#L12).\nDetails follow.' })
  handed('task-cut', 'thread-lead', 'thread-cut', { status: 'interrupted', title: 'cut: stopped early', since: ago(20), end: ago(4) })
  handed('task-gone', 'thread-lead', 'thread-gone', { status: 'completed', title: 'gone: before this stretch', since: ago(40), end: ago(10) })
  handed('native', 'thread-lead', 'thread-native', { origin: 'provider_native', title: 'a native subagent' })
  item('thread-sol', 1, 'command_execution', 'completed', { input: `/usr/bin/bash -lc "rg -n 'durable' ~/notes"`, output: 'notes.md:3: durable\n', exitCode: 0 })
  item('thread-sol', 2, 'web_search', 'running', { patterns: ['pi-durable github', 'temporal schedules'], completedAt: null })
  const lead = () => board.get('t3:lead')
  await until(() => lead()?.agents.length === 4)
  expect(board.get('t3:kid')).toBeUndefined()
  const kidBuild = Bun.spawn(['sleep', '30'], { env: { ...process.env, HEX_CHANNEL: 'plugin:t3@hex', HEX_THREAD: 'kid', HEX_OWNER: '' } })
  running('e5000004-kidbuild', 'busy', kidBuild.pid, { kind: 'interactive', name: 'kid build', startedAt: Date.now() })
  await until(() => lead()!.agents.some(agent => agent.id === 'e5000004-kidbuild'))
  expect(board.runs.filter(run => run.app === 'claude')).toEqual([])
  rmSync(join(claude, 'sessions', 'e5000004.json'))
  kidBuild.kill()
  await until(() => lead()?.agents.length === 4)
  mapped('e5000005-grand', 'thread-grand', { driver: 'claudeAgent', title: 'grand: a T3 task of kid' })
  handed('task-grand', 'thread-kid', 'thread-grand', { driver: 'claudeAgent', title: 'grand: a T3 task of kid', since: ago(1) })
  running('e5000005-grand', 'busy', process.pid, { kind: 'interactive', name: 'grand: a T3 task of kid', startedAt: Date.now() })
  await until(() => lead()!.agents.some(agent => agent.id === 'e5000005-grand'))
  expect(board.runs.filter(run => run.app === 'claude')).toEqual([])
  rmSync(join(claude, 'sessions', 'e5000005.json'))
  await until(() => lead()?.agents.length === 4)
  expect(lead()).toMatchObject({ state: 'working', since: kidSince, place: 'hex primitives' })
  expect(lead()!.agents.map(agent => [agent.label, agent.state, agent.via, agent.who])).toEqual([
    ['sol: second opinion', 'working', 't3', 'Sol'],
    ['kid: map the hub', 'working', 't3', 'Opus 5.5'],
    ['old: an earlier pass', 'done', 't3', undefined],
    ['cut: stopped early', 'stopped', 't3', 'Opus 5.5'],
  ])
  const [sol, kid, old] = lead()!.agents
  expect(sol).toMatchObject({ id: 'thread-sol', link: 't3code://threads/env-1/thread-sol', line: 'Searching the web for pi-durable github' })
  expect(sol.steps.map(step => [step.kind, step.text, step.state, step.detail])).toEqual([
    ['web', 'Searching the web for pi-durable github', 'running', 'pi-durable github\ntemporal schedules'],
    ['run', 'Searched for durable', 'done', "rg -n 'durable' ~/notes"],
  ])
  expect(sol).not.toContainKeys(['end', 'result'])
  expect(old).toMatchObject({ end: oldEnd, line: 'Found three gaps in hub.ts:12.', result: '- Found three gaps in hub.ts:12.\nDetails follow.' })
  step(join(project, 'e5000002-kid.jsonl'), 'Read', { file_path: '/repo/hub.ts' })
  await until(() => lead()!.agents[1].line === 'Reading hub.ts')
  expect(kid).toMatchObject({ since: kidSince, link: 't3code://threads/env-1/thread-kid' })
  const transcript = join(project, 'e5000001-lead.jsonl')
  step(transcript, 'mcp__t3-code__delegate_task', { title: 'sol: second opinion', task: 'Act as the reviewer.\nRead the brief.', target: { providerInstanceId: 'codex' } }, 'toolu_hand')
  back(transcript, 'toolu_hand', JSON.stringify({ taskId: 'task-sol', childThreadId: 'thread-sol', status: 'running' }))
  step(transcript, 'mcp__t3-code__task_status', { taskId: 'task-kid' })
  step(transcript, 'mcp__t3-code__t3_thread_send', { threadId: 'thread-old', message: 'Check the siblings.' })
  step(transcript, 'mcp__t3-code__t3_thread_read', { threadId: 'thread-lead' })
  step(transcript, 'mcp__t3-code__t3_thread_wait', { threadIds: ['thread-sol'] })
  await until(() => lead()!.steps.length === 5)
  expect(lead()!.steps.map(step => [step.kind, step.text, step.detail, step.agent])).toEqual([
    ['tool', 'Waiting on agents', undefined, undefined],
    ['tool', 'Read hex primitives', undefined, undefined],
    ['tool', 'Wrote to old: an earlier pass', 'Check the siblings.', undefined],
    ['tool', 'Checked on kid: map the hub', undefined, undefined],
    ['agent', 'Handed off sol: second opinion', 'Act as the reviewer.', 'thread-sol'],
  ])
  expect(board.rows().find(row => row.id === 't3:lead')!.agents[2]).not.toContainKeys(['steps', 'result'])
  handed('task-kid', 'thread-lead', 'thread-kid', { status: 'completed', title: 'kid: map the hub', since: ago(5), end: ago(0) })
  handed('task-sol', 'thread-lead', 'thread-sol', { driver: 'codex', status: 'failed', title: 'sol: second opinion', since: ago(3), end: ago(0) })
  await until(() => lead()?.state === 'done')
  expect(board.get('t3:kid')).toBeUndefined()
})

test("a thread that stops working keeps its last stretch, with nothing left running and its agents as T3 Code has them now, until it works again", async () => {
  const lead = () => board.get('t3:lead')!
  expect(lead().state).toBe('done')
  expect(lead().steps.map(step => [step.text, step.state])).toEqual([
    ['Waiting on agents', undefined],
    ['Read hex primitives', undefined],
    ['Wrote to old: an earlier pass', undefined],
    ['Checked on kid: map the hub', undefined],
    ['Handed off sol: second opinion', 'done'],
  ])
  expect(lead().agents.map(agent => [agent.label, agent.state, agent.line])).toEqual([
    ['sol: second opinion', 'failed', 'Searching the web for pi-durable github'],
    ['kid: map the hub', 'done', 'Reading hub.ts'],
    ['old: an earlier pass', 'done', 'Found three gaps in hub.ts:12.'],
    ['cut: stopped early', 'stopped', undefined],
  ])
  expect(lead().agents[0]).toMatchObject({ end: expect.any(String), link: 't3code://threads/env-1/thread-sol' })
  expect(lead().agents[0].steps[0]).not.toContainKey('state')
  expect(board.rows().find(row => row.id === 't3:lead')!.agents[0]).not.toContainKeys(['steps', 'result'])
  ask('thread-lead', new Date().toISOString())
  handed('task-new', 'thread-lead', 'thread-new', { driver: 'codex', title: 'new: round two', since: new Date(Date.now() + 1000).toISOString() })
  await until(() => lead().state === 'working')
  expect(lead().agents.map(agent => agent.label)).toEqual(['new: round two'])
})

test("a thread whose turn ended stays working while its workflow runs, each workflow agent with its own steps", async () => {
  threads('telegram', { ...telegram, '-1001234567890:513': { name: 'antibody', session: '51351351-antibody' } })
  job('51351351-antibody', { state: 'working', detail: 'Phase 1 resumed', updatedAt: ago(0), fan: [{ id: 'wfbills', kind: 'workflow', label: 'build:bills' }, { id: 'sh', kind: 'shell', label: 'sleep' }], inFlight: { tasks: 1, kinds: ['local_workflow'] } }, [
    { at: ago(3), state: 'working', detail: 'Phase 1 resumed', text: 'Resumed Phase 1' },
  ])
  running('51351351-antibody', 'idle')
  const antibody = () => board.get('telegram:-1001234567890:513')
  await until(() => antibody()?.state === 'working')
  expect(antibody()!.agents.map(agent => [agent.label, agent.state])).toEqual([['build:bills', 'working']])
  step(join(project, '51351351-antibody', 'subagents', 'workflows', 'wf_1', 'agent-wfbills.jsonl'), 'Read', { file_path: '/repo/bills.ts' })
  await until(() => antibody()?.agents[0].line === 'Reading bills.ts')
})

test("a running session that works for no thread isn't on the board", async () => {
  job('12121212-review', { state: 'working', detail: 'reviewing autofork', updatedAt: ago(0) })
  running('12121212-review', 'busy', process.pid, { kind: 'bg', name: 'autofork-review', cwd: '/repo' })
  running('56565656-terminal', 'busy', process.pid, { kind: 'interactive', name: 'bassim-1' })
  const version = board.version
  job('aaaaaaaa-general', { state: 'done', detail: 'heartbeat ran again', updatedAt: ago(0) })
  await until(() => board.version !== version)
  expect(board.runs.filter(run => run.app === 'claude')).toEqual([])
  rmSync(join(claude, 'sessions', '12121212.json'))
  rmSync(join(claude, 'sessions', '56565656.json'))
})

// What hex's hook writes as a session takes a prompt: the message taken and the turn begun.
function prompted(session: string, thread: string, body: string, heartbeat = false) {
  const store = open(state)
  const key = heartbeat ? `schedule:heartbeat@${crypto.randomUUID()}` : `telegram:${crypto.randomUUID()}`
  store.deliver({ key, to: thread, from: heartbeat ? 'schedule' : 'telegram', author: heartbeat ? 'prompt' : 'owner', body, ...(heartbeat && { meta: { user: 'schedule', schedule: 'heartbeat' } }) })
  return () => store.write(() => store.take(key, session) && store.turned(session, true, new Date().toISOString(), heartbeat))
}

// The session's turn ends: Claude Code's Stop hook, then the session idle.
function stopped(session: string, status: 'idle' | 'busy' | 'shell' = 'idle', flipped = Date.now()) {
  open(state).turned(session, false)
  running(session, status, process.pid, { statusUpdatedAt: flipped })
}

const settle = () => Bun.sleep(80)

test("the hourly heartbeat is no turn of work: from the moment its session is busy, the thread stands as it did before it", async () => {
  threads('telegram', { ...telegram, '-1001234567890:4100': { name: 'pulse', session: '41004100-pulse' } })
  const session = '41004100-pulse'
  const thread = '-1001234567890:4100'
  const transcript = join(project, `${session}.jsonl`)
  const pulse = () => board.get(`telegram:${thread}`)!
  const shipped = { at: ago(10), state: 'done', detail: 'shipped the fix', text: 'Shipped.' }
  const timeline = [shipped]
  prompted(session, thread, 'Ship the fix')()
  said(transcript, { type: 'text', text: 'Shipped.' })
  job(session, { state: 'done', detail: 'shipped the fix', updatedAt: shipped.at }, timeline)
  stopped(session)
  await until(() => board.get(`telegram:${thread}`)?.state === 'done')
  const counted = board.counts.version
  for (const _ of [1, 2]) {
    await Bun.sleep(5)
    const take = prompted(session, thread, '[heartbeat] Hourly check', true)
    const flipped = Date.now()
    running(session, 'busy', process.pid, { statusUpdatedAt: flipped })
    await settle()
    expect(pulse()).toMatchObject({ state: 'done', line: 'shipped the fix', running: false })
    await Bun.sleep(5)
    take()
    said(transcript, { type: 'text', text: 'HEARTBEAT_OK' })
    step(transcript, 'Bash', { command: 'gh pr list' })
    timeline.push({ at: new Date().toISOString(), state: 'working', detail: 'Checking the inbox', text: '' })
    job(session, { state: 'working', detail: 'Checking the inbox', updatedAt: ago(0) }, timeline)
    await settle()
    expect(pulse()).toMatchObject({ state: 'done', line: 'shipped the fix', running: false, steps: [] })
    timeline.push({ at: new Date().toISOString(), state: 'done', detail: 'Nothing new', text: 'HEARTBEAT_OK' })
    job(session, { state: 'done', detail: 'Nothing new', updatedAt: ago(0) }, timeline)
    stopped(session)
    await settle()
    expect(pulse()).toMatchObject({ state: 'done', line: 'shipped the fix', lately: [{ text: 'shipped the fix' }] })
    expect(pulse()!.at > shipped.at).toBe(true)
    rmSync(join(claude, 'sessions', `${session.slice(0, 8)}.json`))
    await settle()
    expect(pulse()).toMatchObject({ state: 'done', line: 'shipped the fix' })
    running(session, 'idle')
    expect(board.counts.version).toBe(counted)
  }
  running(session, 'busy', process.pid, { statusUpdatedAt: Date.now() })
  await settle()
  expect(pulse()).toMatchObject({ state: 'done', line: 'shipped the fix', running: false })
  stopped(session)
  job(session, { state: 'done', detail: 'heartbeat checked', updatedAt: ago(0) }, [{ at: ago(0), state: 'done', detail: 'heartbeat checked', text: 'HEARTBEAT_OK' }])
  await until(() => pulse().state === 'idle')
  expect(pulse().line).toBe('')
  job(session, { state: 'done', detail: 'Nothing new', updatedAt: ago(0) }, timeline)
  await settle()
  expect(board.counts.version).toBe(counted)
  await Bun.sleep(5)
  const take = prompted(session, thread, 'Build the page')
  running(session, 'busy', process.pid, { statusUpdatedAt: Date.now() })
  await until(() => pulse().state === 'working')
  take()
  timeline.push({ at: new Date().toISOString(), state: 'working', detail: 'Building the page', text: '' })
  job(session, { state: 'working', detail: 'Building the page', updatedAt: ago(0) }, timeline)
  await until(() => pulse().state === 'working' && pulse().line === 'Building the page')
  expect(pulse().running).toBe(true)
  await Bun.sleep(5)
  said(transcript, { type: 'text', text: 'Laying out the page.' })
  await until(() => pulse().line === 'Laying out the page.')
  stopped(session)
  job(session, { state: 'done', detail: 'page built', updatedAt: ago(0) }, timeline)
})

test("a heartbeat after a turn that ended handing work off shows that turn's end, not the task before it", async () => {
  threads('telegram', { ...telegram, '-1001234567890:4300': { name: 'handoff', session: '43004300-handoff' } })
  const session = '43004300-handoff'
  const thread = '-1001234567890:4300'
  const off = () => board.get(`telegram:${thread}`)!
  const older = { at: ago(30), state: 'done', detail: 'shipped the old fix', text: 'Shipped.' }
  const handed = { at: ago(5), state: 'working', detail: 'page job started; it runs on', text: 'The page job is running.' }
  prompted(session, thread, 'Build the page')()
  job(session, { state: 'working', detail: handed.detail, updatedAt: handed.at }, [older, handed])
  stopped(session)
  await until(() => board.get(`telegram:${thread}`)?.line === 'page job started; it runs on')
  await Bun.sleep(5)
  const take = prompted(session, thread, '[heartbeat] Hourly check', true)
  const flipped = Date.now()
  running(session, 'busy', process.pid, { statusUpdatedAt: flipped })
  await Bun.sleep(5)
  take()
  job(session, { state: 'done', detail: 'Nothing new', updatedAt: ago(0) }, [older, handed, { at: ago(0), state: 'done', detail: 'Nothing new', text: 'HEARTBEAT_OK' }])
  stopped(session)
  await settle()
  expect(off()).toMatchObject({ line: 'page job started; it runs on' })
  job(session, { state: 'done', detail: 'page built', updatedAt: ago(0) })
})

test("a heartbeat while agents or shells from before it run leaves the thread working on its own words, and a shell of its own is no work", async () => {
  threads('telegram', { ...telegram, '-1001234567890:4200': { name: 'beatwork', session: '42004200-beatwork' } })
  const session = '42004200-beatwork'
  const thread = '-1001234567890:4200'
  const transcript = join(project, `${session}.jsonl`)
  const work = () => board.get(`telegram:${thread}`)!
  const flipped = Date.now() - 60_000
  const building = { at: ago(1), state: 'working', detail: 'Building the page', text: '' }
  const agent = { id: 'page', kind: 'agent', label: 'Build the page', startedAt: Date.now() - 60_000 }
  prompted(session, thread, 'Build the page')()
  said(transcript, { type: 'text', text: 'Starting on the page.' })
  job(session, { state: 'working', detail: 'Building the page', updatedAt: ago(2), fan: [agent] }, [building])
  running(session, 'busy', process.pid, { statusUpdatedAt: flipped })
  await until(() => board.get(`telegram:${thread}`)?.line === 'Starting on the page.')
  stopped(session, 'busy', flipped)
  await Bun.sleep(5)

  prompted(session, thread, '[heartbeat] Hourly check', true)()
  said(transcript, { type: 'text', text: 'HEARTBEAT_OK' })
  step(transcript, 'Bash', { command: 'gh pr list' })
  job(session, { state: 'working', detail: 'Checking the inbox', updatedAt: ago(0), fan: [agent] }, [building, { at: new Date().toISOString(), state: 'working', detail: 'Checking the inbox', text: '' }])
  await settle()
  expect(work()).toMatchObject({ state: 'working', line: 'Starting on the page.', running: true })
  expect(work().steps.map(step => step.text)).toEqual(['Starting on the page.'])
  stopped(session, 'busy', flipped)
  job(session, { state: 'done', detail: 'Nothing new', updatedAt: ago(0), fan: [agent] }, [building, { at: new Date().toISOString(), state: 'done', detail: 'Nothing new', text: 'HEARTBEAT_OK' }])
  await settle()
  expect(work()).toMatchObject({ state: 'working', line: 'Starting on the page.' })

  await Bun.sleep(5)
  const back = prompted(session, thread, '<task-notification>page built</task-notification>')
  back()
  const built = { at: new Date().toISOString(), state: 'done', detail: 'page built', text: 'Built.' }
  job(session, { state: 'done', detail: 'page built', updatedAt: built.at, fan: [{ ...agent, doneAt: Date.now() }] }, [building, built])
  stopped(session)
  await until(() => work().state === 'done' && work().line === 'page built')

  await Bun.sleep(5)
  const check = prompted(session, thread, '[heartbeat] Hourly check', true)
  const again = Date.now()
  running(session, 'busy', process.pid, { statusUpdatedAt: again })
  await Bun.sleep(5)
  check()
  await Bun.sleep(5)
  const own = { id: 'sh', kind: 'shell', label: 'gh pr checks --watch', startedAt: Date.now() }
  const beaten = [building, built, { at: new Date().toISOString(), state: 'done', detail: 'Nothing new', text: 'HEARTBEAT_OK' }]
  job(session, { state: 'done', detail: 'Nothing new', updatedAt: ago(0), fan: [own] }, beaten)
  stopped(session, 'shell')
  await settle()
  expect(work()).toMatchObject({ state: 'done', line: 'page built' })
  job(session, { state: 'done', detail: 'Nothing new', updatedAt: ago(0), fan: [{ ...own, kind: 'monitor', startedAt: Date.now() - 120_000 }] }, beaten)
  await until(() => work().state === 'working')
  stopped(session)
  job(session, { state: 'done', detail: 'page built', updatedAt: ago(0) })
})

test("a session whose process runs under a thread's session is one of its agents, and neither hex's own check there nor a session T3 Code runs there is", async () => {
  const env = { ...process.env, HEX_CHANNEL: '', HEX_THREAD: '', HEX_OWNER: '' }
  const topic = Bun.spawn(['sh', '-c', 'sleep 30 & HEX_HELPER=check sleep 30 & sleep 30 & wait'], { env })
  const kids = await until(() => children(topic.pid).length === 3 && children(topic.pid))
  afterAll(() => [topic.pid, ...kids].forEach(stop))
  const helper = kids.find(pid => readFileSync(`/proc/${pid}/environ`, 'utf8').includes('HEX_HELPER=check'))!
  const [build, t3run] = kids.filter(pid => pid !== helper)
  threads('telegram', { ...telegram, '-1001234567890:4110': { name: 'review', session: '41104110-review' } })
  job('41104110-review', { state: 'done', detail: 'started a build', updatedAt: ago(1) })
  running('41104110-review', 'idle', topic.pid, { kind: 'bg' })
  const review = () => board.get('telegram:-1001234567890:4110')
  await until(() => review()?.state === 'done')
  mapped('41034103-t3', 'thread-loner', { driver: 'claudeAgent', title: 'started in T3 Code' })
  running('41014101-build', 'busy', build, { kind: 'interactive', name: 'review-build', startedAt: Date.now() })
  running('41024102-check', 'busy', helper, { kind: 'interactive', name: 'hex-check-x', startedAt: Date.now() })
  running('41034103-t3', 'busy', t3run, { kind: 'interactive', name: 'started in T3 Code', startedAt: Date.now() })
  await until(() => review()?.state === 'working' && review()!.agents.length === 1)
  expect(review()!.agents.map(agent => [agent.id, agent.label, agent.state])).toEqual([['41014101-build', 'review-build', 'working']])
  expect(board.runs.filter(run => run.app === 'claude')).toEqual([])
  rmSync(join(claude, 'sessions', '41014101.json'))
  await until(() => review()?.state === 'done')
  expect(board.runs.filter(run => run.app === 'claude')).toEqual([])
  rmSync(join(claude, 'sessions', '41024102.json'))
  rmSync(join(claude, 'sessions', '41034103.json'))
})

function stop(pid: number) {
  try {
    process.kill(pid)
  } catch {}
}

function children(pid: number) {
  return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(' ').filter(Boolean).map(Number)
}

test("a thread stays working while a session it started runs, that session one of its agents, and while its own shells run", async () => {
  const build = Bun.spawn(['sleep', '30'], { env: { ...process.env, HEX_CHANNEL: 'plugin:telegram@hex', HEX_THREAD: '-1001234567890:3275' } })
  afterAll(() => build.kill())
  threads('telegram', { ...telegram, '-1001234567890:3275': { name: 'lab', session: '32753275-lab' } })
  job('32753275-lab', { state: 'done', detail: 'started the build', updatedAt: ago(1) })
  running('32753275-lab', 'idle')
  const lab = () => board.get('telegram:-1001234567890:3275')
  await until(() => lab()?.state === 'done')
  running('78787878-build', 'busy', build.pid, { kind: 'interactive', name: 'lab-build-c0', cwd: '/scratch/build', startedAt: Date.now() })
  await until(() => lab()?.state === 'working')
  expect(lab()!.agents.map(agent => [agent.id, agent.label, agent.state])).toEqual([['78787878-build', 'lab-build-c0', 'working']])
  expect(board.get('claude:78787878')).toBeUndefined()
  step(join(claude, 'projects', '-scratch-build', '78787878-build.jsonl'), 'Read', { file_path: '/scratch/build/plan.md' })
  await until(() => lab()?.agents[0]?.line === 'Reading plan.md')
  rmSync(join(claude, 'sessions', '78787878.json'))
  await until(() => lab()?.state === 'done')
  running('32753275-lab', 'shell')
  await until(() => lab()?.state === 'working')
  expect(lab()!.running).toBe(false)
})

test("a job's session works under the thread that owns it, wherever it runs, and one whose owner is gone is a run of its own, with what it launched", async () => {
  const owned = Bun.spawn(['sleep', '30'], { env: { ...process.env, HEX_OWNER: 'telegram:-1001234567890:65' } })
  const orphan = Bun.spawn(['sh', '-c', 'sleep 30 & wait'], { env: { ...process.env, HEX_OWNER: 'telegram:-1001234567890:404' } })
  const [sub] = await until(() => children(orphan.pid).length === 1 && children(orphan.pid))
  afterAll(() => [owned.pid, orphan.pid, sub!].forEach(stop))
  const theo = () => board.get('telegram:-1001234567890:65')
  const lastActive = Date.now() - 60_000
  job('91919191-clips', { state: 'working', detail: 'cutting clips', updatedAt: ago(0) })
  running('91919191-clips', 'busy', owned.pid, { kind: 'interactive', name: 'Theo clips/cut', startedAt: Date.now() })
  running('92929292-lost', 'busy', orphan.pid, { kind: 'interactive', name: 'gone/job', startedAt: lastActive - 60_000, statusUpdatedAt: lastActive })
  running('92939293-sub', 'busy', sub, { kind: 'interactive', name: 'gone/job-build', startedAt: Date.now() })
  await until(() => theo()?.state === 'working' && !!board.get('claude:92929292'))
  expect(theo()!.agents.map(agent => [agent.id, agent.label, agent.state])).toEqual([['91919191-clips', 'Theo clips/cut', 'working']])
  expect(board.get('claude:92929292')).toMatchObject({ name: 'gone/job', at: new Date(lastActive).toISOString() })
  expect(board.runs.filter(run => run.app === 'claude').map(run => run.id)).toEqual(['claude:92929292'])
  await until(() => board.get('claude:92929292')!.agents.length === 1)
  expect(board.get('claude:92929292')!.agents.map(agent => [agent.id, agent.label, agent.state])).toEqual([['92939293-sub', 'gone/job-build', 'working']])
  running('92929292-lost', 'idle', orphan.pid, { kind: 'interactive', name: 'gone/job', startedAt: lastActive - 60_000, statusUpdatedAt: Date.now() })
  await until(() => board.get('claude:92929292')?.running === false)
  expect(board.get('claude:92929292')!.state).toBe('working')
  rmSync(join(claude, 'sessions', '92939293.json'))
  expect(board.get('claude:91919191')).toBeUndefined()
  rmSync(join(claude, 'sessions', '91919191.json'))
  rmSync(join(claude, 'sessions', '92929292.json'))
  await until(() => theo()?.state !== 'working' && !board.get('claude:92929292'))
})

test("a job's session works under the thread that owns it while that thread has no session of its own", async () => {
  const owned = Bun.spawn(['sleep', '30'], { env: { ...process.env, HEX_OWNER: 'telegram:-1001234567890:3675' } })
  afterAll(() => owned.kill())
  threads('telegram', { ...telegram, '-1001234567890:3675': { name: 'unemployment' } })
  const claim = () => board.get('telegram:-1001234567890:3675')
  job('93939393-claim', { state: 'working', detail: 'filling the claim', updatedAt: ago(0) })
  running('93939393-claim', 'busy', owned.pid, { kind: 'interactive', name: 'unemployment/claim', cwd: '/scratch/claim', startedAt: Date.now() })
  await until(() => claim()?.state === 'working')
  expect(claim()!.agents.map(agent => [agent.id, agent.label, agent.state])).toEqual([['93939393-claim', 'unemployment/claim', 'working']])
  expect(board.get('claude:93939393')).toBeUndefined()
  step(join(claude, 'projects', '-scratch-claim', '93939393-claim.jsonl'), 'Read', { file_path: '/scratch/claim/form.md' })
  await until(() => claim()?.agents[0]?.line === 'Reading form.md')
  rmSync(join(claude, 'sessions', '93939393.json'))
  await until(() => !claim())
})

test("a renewed session's new job folder still wakes the list", async () => {
  rmSync(join(claude, 'jobs', 'aaaaaaaa'), { recursive: true })
  job('aaaaaaaa-general', { state: 'done', detail: 'renewed', updatedAt: ago(0) })
  await until(() => board.get('telegram:-1001234567890')?.line === 'renewed')
  await Bun.sleep(100)
  job('aaaaaaaa-general', { state: 'done', detail: 'after the renew', updatedAt: ago(0) })
  await until(() => board.get('telegram:-1001234567890')?.line === 'after the renew')
})

test("a lane holds a week: the change before it, steps only in the last hour, and quiet gaps too small to see joined", () => {
  const now = Date.parse('2026-10-17T12:00:00.000Z')
  const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString()
  const day = 24 * 60
  const turns = [
    { at: at(9 * day), state: 'done' as const },
    { at: at(8 * day), state: 'needs' as const },
    { at: at(3 * day), state: 'working' as const },
    { at: at(3 * day - 1), state: 'working' as const },
    { at: at(3 * day - 2), state: 'done' as const },
    { at: at(3 * day - 30), state: 'working' as const },
    { at: at(3 * day - 31), state: 'needs' as const },
    { at: at(3 * day - 40), state: 'working' as const },
    { at: at(3 * day - 50), state: 'done' as const },
    { at: at(30), state: 'working' as const },
    { at: at(20), state: 'working' as const },
    { at: at(10), state: 'done' as const },
  ]
  expect(track(turns, now)).toEqual([
    { at: at(8 * day), state: 'needs' },
    { at: at(3 * day), state: 'working' },
    { at: at(3 * day - 31), state: 'needs' },
    { at: at(3 * day - 40), state: 'working' },
    { at: at(3 * day - 50), state: 'done' },
    { at: at(30), state: 'working' },
    { at: at(20), state: 'working' },
    { at: at(10), state: 'done' },
  ])
  expect(track(turns, now)).toEqual(track(track(turns, now), now))
})

test("a thread's lane outlives its session starting over, kept in the voice folder", async () => {
  const earlier = ago(3 * 60)
  job('aaaaaaaa-general', { state: 'done', detail: 'before the respawn', updatedAt: ago(0) }, [
    { at: earlier, state: 'working', detail: 'before', text: '' },
    { at: ago(2 * 60), state: 'done', detail: 'before the respawn', text: '' },
  ])
  await until(() => board.get('telegram:-1001234567890')?.line === 'before the respawn')
  rmSync(join(claude, 'jobs', 'aaaaaaaa'), { recursive: true })
  job('aaaaaaaa-general', { state: 'done', detail: 'after the respawn', updatedAt: ago(0) }, [{ at: ago(1), state: 'done', detail: 'after the respawn', text: '' }])
  await until(() => board.get('telegram:-1001234567890')?.line === 'after the respawn')
  expect(board.get('telegram:-1001234567890')!.track[0]).toEqual({ at: earlier, state: 'working' })
  await until(() => {
    try {
      return JSON.parse(readFileSync(join(state, 'voice', 'tracks.json'), 'utf8'))['telegram:-1001234567890']?.[0]?.at === earlier
    } catch {
      return false
    }
  })
})

test("a T3 thread woken by its delegations finishing still shows what it handed off since it was last asked", async () => {
  threads('t3', { woken: { name: 'hex', session: 'e5000003-woken' } })
  job('e5000003-woken', { state: 'working', detail: 'summing up', updatedAt: ago(0.5) }, [{ at: ago(1), state: 'working', detail: '', text: '' }])
  running('e5000003-woken', 'busy')
  mapped('woken', 'thread-woken', { title: 'two at once' })
  ask('thread-woken', ago(30))
  handed('task-before', 'thread-woken', 'thread-before', { driver: 'codex', status: 'completed', title: 'before: an earlier ask', since: ago(29), end: ago(20) })
  ask('thread-woken', ago(10))
  handed('task-files', 'thread-woken', 'thread-files', { driver: 'codex', status: 'completed', title: 'files: one line each', since: ago(9), end: ago(2) })
  ask('thread-woken', ago(2), { delegatedCompletion: { taskIds: ['task-files'] } })
  const woken = () => board.get('t3:woken')
  await until(() => woken()?.state === 'working' && woken()!.agents.length > 0)
  expect(woken()!.agents.map(agent => [agent.label, agent.state])).toEqual([['files: one line each', 'done']])
})

function run(thread: string, ordinal: number, { status = 'running', since = ago(2), end = null as string | null, said = null as string | null } = {}) {
  const id = `run:${thread}:${ordinal}`
  t3db.run('insert or replace into orchestration_v2_projection_runs values (?, ?, ?, ?, ?, ?)', [id, thread, ordinal, status, since, end])
  if (said) t3db.run('insert into orchestration_v2_projection_messages values (?, ?, ?, ?, ?)', [thread, 'assistant', end ?? since, JSON.stringify({ text: said }), id])
  return id
}

test("a T3 thread another hex thread sent work to shows under the sender while that run is its newest, then on its own again", async () => {
  threads('discord', { fix: { name: 'fix hex NOW', session: 'f1f1f1f1-fix' } })
  threads('t3', { prims: { name: 'hex', session: 'f2f2f2f2-prims' } })
  job('f1f1f1f1-fix', { state: 'done', detail: 'sent it on', updatedAt: ago(3) })
  job('f2f2f2f2-prims', { state: 'working', detail: 'building', updatedAt: ago(1) })
  running('f1f1f1f1-fix', 'idle')
  mapped('prims', 'thread-prims', { title: 'hex primitives + durability' })
  mapped('codex', 'thread-codex', { driver: 'codex', title: 'sol: a second look' })
  const first = run('thread-prims', 1, { status: 'completed', since: ago(60), end: ago(50) })
  const relayed = run('thread-prims', 2, { since: ago(2) })
  const second = run('thread-codex', 1, { status: 'completed', since: ago(4), end: ago(1), said: 'Looks **sound**.' })
  open(state).relayed('discord:fix', 'thread-prims', first, ago(55))
  open(state).relayed('discord:fix', 'thread-prims', relayed, ago(2))
  open(state).relayed('discord:fix', 'thread-codex', second, ago(4))
  const fix = () => board.get('discord:fix')
  await until(() => fix()?.agents.length === 2)
  expect(fix()!.state).toBe('working')
  expect(fix()!.agents.map(agent => [agent.label, agent.state, agent.via, agent.line])).toEqual([
    ['hex primitives + durability', 'working', 't3', undefined],
    ['sol: a second look', 'done', 't3', 'Looks sound.'],
  ])
  expect(board.get('t3:prims')).toBeUndefined()
  running('f2f2f2f2-prims', 'busy')
  const version = board.version
  job('f1f1f1f1-fix', { state: 'done', detail: 'sent it on, still', updatedAt: ago(0) })
  await until(() => board.version !== version)
  expect(board.get('claude:f2f2f2f2')).toBeUndefined()
  running('f2f2f2f2-prims', 'idle')
  run('thread-prims', 2, { status: 'completed', since: ago(2), end: ago(0) })
  run('thread-prims', 3, { since: ago(0) })
  await until(() => !!board.get('t3:prims'))
  expect(fix()!.state).not.toBe('working')
})

test("two T3 threads that send each other work each show on their own, the other under it", async () => {
  threads('t3', { ping: { name: 'ping', session: 'a1a1a1a1-ping' }, pong: { name: 'pong', session: 'b2b2b2b2-pong' } })
  mapped('ping', 'thread-ping', { title: 'ping' })
  mapped('pong', 'thread-pong', { title: 'pong' })
  const toPong = run('thread-pong', 1, { since: ago(3) })
  const toPing = run('thread-ping', 1, { since: ago(1) })
  open(state).relayed('t3:ping', 'thread-pong', toPong, ago(3))
  open(state).relayed('t3:pong', 'thread-ping', toPing, ago(1))
  await until(() => board.get('t3:ping')?.agents.length && board.get('t3:pong')?.agents.length)
  expect(board.get('t3:ping')!.agents.map(agent => [agent.label, agent.state])).toEqual([['pong', 'working']])
  expect(board.get('t3:pong')!.agents.map(agent => [agent.label, agent.state])).toEqual([['ping', 'working']])
})

test("a thread off the board, quiet for a week or closed, is a page of what was last kept for it, read without touching the board", async () => {
  expect(board.find('telegram:-1001234567890')).toBe(board.get('telegram:-1001234567890')!)
  const lanes = readFileSync(join(state, 'voice', 'tracks.json'), 'utf8')
  expect(board.find('buzz:b1')).toEqual({ id: 'buzz:b1', app: 'buzz', thread: 'b1', name: 'Old news', where: 'Buzz', place: 'Old news', at: JSON.parse(readFileSync(join(claude, 'jobs', 'ffffffff', 'state.json'), 'utf8')).updatedAt, line: 'long ago' })
  threads('discord', { gone: { name: 'Data kit', session: 'abababab-gone', link: 'https://discord.com/channels/1/gone' } })
  job('abababab-gone', { state: 'blocked', detail: 'kit waits', needs: 'Pick a kit', updatedAt: ago(10 * 24 * 60) })
  threads('discord', {})
  await until(() => !open(state).threads({ app: 'discord', open: true }).length)
  expect(board.find('discord:gone')).toEqual({ id: 'discord:gone', app: 'discord', thread: 'gone', name: 'Data kit', where: 'Discord', place: 'Data kit', at: JSON.parse(readFileSync(join(claude, 'jobs', 'abababab', 'state.json'), 'utf8')).updatedAt, link: 'https://discord.com/channels/1/gone' })
  expect(board.find('discord:never')).toBeUndefined()
  expect(board.runs.map(run => run.id)).not.toContainAnyValues(['buzz:b1', 'discord:gone'])
  expect(readFileSync(join(state, 'voice', 'tracks.json'), 'utf8')).toBe(lanes)
})

test("a closed thread whose session another open thread holds now shows nothing of that session", async () => {
  job('acacacac-moved', { state: 'blocked', detail: 'needs a pick', updatedAt: ago(1) })
  threads('discord', { topic: { name: 'Snailmail', session: 'acacacac-moved' } })
  threads('discord', {})
  threads('buzz', { b1: { name: 'Old news', session: 'ffffffff-old' }, there: { name: 'Snailmail', session: 'acacacac-moved' } })
  await until(() => !!board.get('buzz:there'))
  expect(board.find('discord:topic')).toEqual({ id: 'discord:topic', app: 'discord', thread: 'topic', name: 'Snailmail', where: 'Discord', place: 'Snailmail' })
  threads('buzz', { b1: { name: 'Old news', session: 'ffffffff-old' } })
})

test("another Telegram group keeps its own name and place, and only hex's General goes by General", async () => {
  job('99999999-family', { state: 'done', detail: 'photos sent', updatedAt: ago(2) })
  threads('telegram', { ...telegram, '-2002': { name: 'Family', session: '99999999-family' } })
  await until(() => !!board.get('telegram:-2002'))
  expect(board.get('telegram:-2002')).toMatchObject({ name: 'Family', where: 'Telegram', place: 'Family' })
  expect(board.get('telegram:-1001234567890')).toMatchObject({ name: 'General', where: 'General', place: 'General' })
  threads('telegram', telegram)
})

test("a T3 Code thread's session below one a hex thread handed work to works under that thread while it's busy, and one nothing handed off isn't on the board", async () => {
  threads('telegram', { ...telegram, '-1001234567890:4210': { name: 'audit', session: '42104210-audit' } })
  job('42104210-audit', { state: 'done', detail: 'sent the audit on', updatedAt: ago(3) })
  running('42104210-audit', 'idle')
  mapped('43104310-lead', 'thread-audit', { driver: 'claudeAgent', title: 'audit lead' })
  mapped('44004400-fix', 'thread-fix', { driver: 'claudeAgent', title: 'audit: fixes' })
  mapped('45004500-watch', 'thread-watch', { driver: 'claudeAgent', title: 'Server Watcher' })
  open(state).relayed('telegram:-1001234567890:4210', 'thread-audit', run('thread-audit', 1, { since: ago(3) }), ago(3))
  run('thread-audit', 2, { status: 'queued', since: ago(1) })
  handed('task-fix', 'thread-audit', 'thread-fix', { driver: 'claudeAgent', title: 'audit: fixes', since: ago(2) })
  running('43104310-lead', 'busy', process.pid, { kind: 'interactive', name: 'audit lead', startedAt: Date.now() })
  running('44004400-fix', 'busy', process.pid, { kind: 'interactive', name: 'audit: fixes', startedAt: Date.now() })
  running('45004500-watch', 'busy', process.pid, { kind: 'interactive', name: 'Server Watcher', startedAt: Date.now() })
  const audit = () => board.get('telegram:-1001234567890:4210')
  await until(() => audit()?.agents.length === 2)
  expect(audit()!.state).toBe('working')
  expect(audit()!.agents.map(agent => [agent.label, agent.via])).toEqual([
    ['audit: fixes', 'claude'],
    ['audit lead', 't3'],
  ])
  expect(board.runs.filter(run => run.app === 'claude')).toEqual([])
  handed('task-fix', 'thread-audit', 'thread-fix', { driver: 'claudeAgent', status: 'completed', title: 'audit: fixes', since: ago(2), end: ago(0) })
  run('thread-audit', 1, { status: 'completed', since: ago(3), end: ago(0) })
  running('43104310-lead', 'idle', process.pid, { kind: 'interactive', name: 'audit lead', startedAt: Date.now() })
  await until(() => audit()!.agents.every(agent => agent.via === 'claude' || agent.state !== 'working'))
  expect(audit()!.state).toBe('working')
  expect(audit()!.agents.filter(agent => agent.via === 'claude').map(agent => [agent.label, agent.state])).toEqual([['audit: fixes', 'working']])
  running('44004400-fix', 'idle', process.pid, { kind: 'interactive', name: 'audit: fixes', startedAt: Date.now() })
  await until(() => audit()!.state !== 'working')
  expect(board.runs.filter(run => run.app === 'claude')).toEqual([])
})

test("a T3 Code thread a hex thread delegated before and now sends more work to counts toward it while that run goes on", async () => {
  threads('t3', { boss: { name: 'hex', session: '46004600-boss' } })
  job('46004600-boss', { state: 'done', detail: 'sent it more', updatedAt: ago(1) })
  running('46004600-boss', 'idle')
  mapped('boss', 'thread-boss', { title: 'boss' })
  mapped('47004700-again', 'thread-again', { driver: 'claudeAgent', title: 'again: round two' })
  handed('task-again', 'thread-boss', 'thread-again', { driver: 'claudeAgent', status: 'completed', title: 'again: round two', since: ago(30), end: ago(20) })
  open(state).relayed('t3:boss', 'thread-again', run('thread-again', 1, { since: ago(1) }), ago(1))
  running('47004700-again', 'busy', process.pid, { kind: 'interactive', name: 'again: round two', startedAt: Date.now() })
  const boss = () => board.get('t3:boss')
  await until(() => boss()?.state === 'working')
  expect(boss()!.agents.filter(agent => agent.via === 'claude').map(agent => agent.id)).toEqual(['47004700-again'])
  expect(board.runs.filter(run => run.app === 'claude')).toEqual([])
})

test("a T3 Code thread goes to the hex thread that sent it work last, by when hex sent it, not when its run began", async () => {
  threads('discord', { early: { name: 'early', session: 'c1c1c1c1-early' }, late: { name: 'late', session: 'c2c2c2c2-late' } })
  running('c1c1c1c1-early', 'idle')
  running('c2c2c2c2-late', 'idle')
  mapped('c3c3c3c3-steer', 'thread-steer', { driver: 'claudeAgent', title: 'steered' })
  mapped('c4c4c4c4-kid', 'thread-steerkid', { driver: 'claudeAgent', title: 'steered: kid' })
  const active = run('thread-steer', 1, { since: ago(10) })
  open(state).relayed('discord:early', 'thread-steer', run('thread-steer', 2, { status: 'queued', since: ago(5) }), ago(5))
  open(state).relayed('discord:late', 'thread-steer', active, ago(2))
  handed('task-steerkid', 'thread-steer', 'thread-steerkid', { driver: 'claudeAgent', title: 'steered: kid', since: ago(1) })
  running('c4c4c4c4-kid', 'busy', process.pid, { kind: 'interactive', name: 'steered: kid', startedAt: Date.now() })
  await until(() => board.get('discord:late')?.agents.some(agent => agent.id === 'c4c4c4c4-kid'))
  expect(board.get('discord:early')!.agents.map(agent => agent.id)).not.toContain('c4c4c4c4-kid')
  running('c4c4c4c4-kid', 'idle', process.pid, { kind: 'interactive', name: 'steered: kid', startedAt: Date.now() })
})

test("what a session T3 Code runs launches goes by T3's handoffs, not the thread its inherited environment names", async () => {
  const t3server = Bun.spawn(['sh', '-c', 'HEX_OWNER=telegram:-1001234567890:65 sleep 30 & wait'], { env: { ...process.env, HEX_CHANNEL: '', HEX_THREAD: '', HEX_OWNER: '' } })
  const [kid] = await until(() => children(t3server.pid).length === 1 && children(t3server.pid))
  afterAll(() => [t3server.pid, kid!].forEach(stop))
  mapped('c5c5c5c5-loner', 'thread-loner2', { driver: 'claudeAgent', title: 'nobody handed this off' })
  await Bun.sleep(800)
  running('c5c5c5c5-loner', 'busy', t3server.pid, { kind: 'interactive', name: 'nobody handed this off', startedAt: Date.now() })
  running('c6c6c6c6-build', 'busy', kid, { kind: 'interactive', name: 'loner build', startedAt: Date.now() })
  const version = board.version
  job('aaaaaaaa-general', { state: 'done', detail: 'heartbeat ran once more', updatedAt: ago(0) })
  await until(() => board.version !== version)
  expect(board.get('telegram:-1001234567890:65')?.agents.map(agent => agent.id) ?? []).not.toContain('c6c6c6c6-build')
  expect(board.runs.filter(run => run.app === 'claude')).toEqual([])
  rmSync(join(claude, 'sessions', 'c5c5c5c5.json'))
  rmSync(join(claude, 'sessions', 'c6c6c6c6.json'))
})

test("a hex thread that sends its busy T3 Code thread more work, which T3 queues, keeps what that thread launched", async () => {
  threads('discord', { again: { name: 'again', session: 'c7c7c7c7-again' } })
  running('c7c7c7c7-again', 'idle')
  mapped('c8c8c8c8-busy', 'thread-busy', { driver: 'claudeAgent', title: 'busy' })
  mapped('c9c9c9c9-busykid', 'thread-busykid', { driver: 'claudeAgent', title: 'busy: kid' })
  run('thread-busy', 1, { since: ago(10) })
  open(state).relayed('discord:again', 'thread-busy', run('thread-busy', 2, { status: 'queued', since: ago(1) }), ago(1))
  handed('task-busykid', 'thread-busy', 'thread-busykid', { driver: 'claudeAgent', title: 'busy: kid', since: ago(5) })
  running('c9c9c9c9-busykid', 'busy', process.pid, { kind: 'interactive', name: 'busy: kid', startedAt: Date.now() })
  await until(() => board.get('discord:again')?.agents.some(agent => agent.id === 'c9c9c9c9-busykid'))
  running('c9c9c9c9-busykid', 'idle', process.pid, { kind: 'interactive', name: 'busy: kid', startedAt: Date.now() })
})

test("a thread's fresh background session works under it from its first turn, before hex.db holds it", async () => {
  writeFileSync(join(home, 'leisure-settings.json'), JSON.stringify({ env: { HEX_CHANNEL: 'plugin:telegram@hex', HEX_THREAD: '-1001234567890:72' } }))
  job('d1d1d1d1-fresh', { state: 'working', detail: 'first turn', updatedAt: ago(0), respawnFlags: ['--settings', join(home, 'leisure-settings.json')] })
  running('d1d1d1d1-fresh', 'busy', process.pid, { kind: 'bg', name: 'Leisure time', startedAt: Date.now() })
  const leisure = () => board.get('telegram:-1001234567890:72')
  await until(() => leisure()?.state === 'working' && leisure()!.agents.some(agent => agent.id === 'd1d1d1d1-fresh'))
  expect(board.runs.filter(run => run.app === 'claude')).toEqual([])
  rmSync(join(claude, 'sessions', 'd1d1d1d1.json'))
})
