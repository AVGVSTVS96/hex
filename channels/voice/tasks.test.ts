import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Tasks, track } from './tasks.ts'
import { until } from '../../hub/until.ts'

const home = mkdtempSync(join(tmpdir(), 'voice-tasks-'))
const claude = join(home, 'claude')
const state = join(home, 'hex', 'state')
const hex = join(home, 'hex')
const project = join(claude, 'projects', hex.replace(/[^a-zA-Z0-9]/g, '-'))
afterAll(() => rmSync(home, { recursive: true }))

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

function threads(app: string, all: object) {
  mkdirSync(join(state, app), { recursive: true })
  writeFileSync(join(state, app, 'threads.json'), JSON.stringify(all))
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
  '-1001234567890': { name: 'hex', session: 'aaaaaaaa-general' },
  '-1001234567890:908': { name: 'autofork', session: 'bbbbbbbb-autofork' },
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
job('cccccccc-voiceapp', { state: 'working', detail: 'building', updatedAt: ago(1), fan: [{ id: 'old', kind: 'agent', label: 'Earlier', doneAt: 1 }, { id: 'agent2', kind: 'agent', label: 'Check the server', startedAt: checking, doneAt: checked }, { id: 'agent1', kind: 'agent', label: 'Build the Tasks view', startedAt: building }, { id: 'sh', kind: 'shell', label: 'sleep' }] }, [
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
const tasks = new Tasks(state, hex, claude, t3)
afterAll(() => tasks.close())

test("each thread is a task from its session's own records, what needs you first, then what's working, then what finished", () => {
  expect(tasks.tasks.map(task => [task.name, task.state])).toEqual([
    ['autofork', 'needs'],
    ['voiceapp', 'working'],
    ['hex', 'done'],
    ['Leisure time', 'idle'],
    ['Theo clips', 'idle'],
  ])
  const autofork = tasks.get('telegram:-1001234567890:908')!
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
  expect(tasks.get('telegram:-1001234567890')).toMatchObject({ where: 'General', place: 'General', link: 'https://t.me/c/1234567890/1' })
  expect(tasks.get('telegram:-1001234567890:65')).toMatchObject({ line: 'clips posted', lately: [] })
  expect(tasks.get('buzz:b1')).toBeUndefined()
  expect(tasks.summary).toEqual({ needs: 1, working: 1 })
  expect(tasks.rows()[0]).not.toContainKeys(['needs', 'lately', 'steps'])
})

test("a working thread's line is its newest step, and each of its agents from this stretch of work shows its own, running ones first", async () => {
  const voiceapp = () => tasks.get('telegram:-1001234567890:2583')!
  expect(voiceapp().agents).toEqual([
    { id: 'agent1', label: 'Build the Tasks view', state: 'working', via: 'claude', since: new Date(building).toISOString(), steps: [] },
    { id: 'agent2', label: 'Check the server', state: 'done', via: 'claude', since: new Date(checking).toISOString(), end: new Date(checked).toISOString(), steps: [] },
  ])
  step(join(project, 'cccccccc-voiceapp.jsonl'), 'Read', { file_path: '/repo/src/tasks.ts' })
  step(join(project, 'cccccccc-voiceapp.jsonl'), 'Edit', { file_path: '/repo/src/tasks.ts', old_string: 'a', new_string: 'b' })
  await until(() => voiceapp().line === 'Editing tasks.ts')
  expect(voiceapp().steps.map(step => [step.kind, step.text])).toEqual([
    ['edit', 'Editing tasks.ts'],
    ['read', 'Reading tasks.ts'],
  ])
  step(join(project, 'cccccccc-voiceapp', 'subagents', 'agent-agent1.jsonl'), 'Read', { file_path: '/repo/README.md' })
  await until(() => voiceapp().agents[0].line === 'Reading README.md')
  const row = tasks.rows().find(row => row.name === 'voiceapp')!
  expect(row).not.toContainKey('steps')
  expect(row.agents[0]).toMatchObject({ id: 'agent1', label: 'Build the Tasks view', state: 'working', line: 'Reading README.md' })
})

test("a Claude Code agent shows its type and model, and once it stops, what it handed back", async () => {
  const voiceapp = () => tasks.get('telegram:-1001234567890:2583')!
  said(join(project, 'cccccccc-voiceapp', 'subagents', 'agent-agent1.jsonl'), { type: 'text', text: 'Looking.' }, { message: { id: 'm', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Looking.' }] } })
  await until(() => voiceapp().agents[0].who === 'Explore · Haiku 5.5')
  heard(
    join(project, 'cccccccc-voiceapp.jsonl'),
    '<task-notification>\n<task-id>agent2</task-id>\n<status>completed</status>\n<result>[harness: matched a pattern.]\n\n**The server** answers in 40ms.\nThe rest is fine.</result>\n</task-notification>',
    { origin: { kind: 'task-notification' } },
  )
  await until(() => !!voiceapp().agents[1].result)
  expect(voiceapp().agents[1]).toMatchObject({ state: 'done', line: 'The server answers in 40ms.', result: 'The server answers in 40ms.\nThe rest is fine.' })
  expect(tasks.rows().find(row => row.name === 'voiceapp')!.agents[1]).not.toContainKey('result')
})

test("a step's result comes back on it: when it ended, whether it worked, its first lines, and the agent it started", async () => {
  const voiceapp = () => tasks.get('telegram:-1001234567890:2583')!
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
  const voiceapp = () => tasks.get('telegram:-1001234567890:2583')!
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
  expect(tasks.rows().find(row => row.name === 'voiceapp')).not.toContainKey('plan')
})

test('a change to a session wakes the list, and the counts move only when a count does', async () => {
  const { version } = tasks
  const counted = tasks.counts.version
  const woke = tasks.changes(version, 2000)
  job('aaaaaaaa-general', { state: 'done', detail: 'heartbeat ran again', updatedAt: ago(0) })
  await woke
  await until(() => tasks.get('telegram:-1001234567890')?.line === 'heartbeat ran again')
  expect(tasks.counts.version).toBe(counted)
  job('aaaaaaaa-general', { state: 'blocked', detail: 'Your call: ship it?', updatedAt: ago(0) })
  await until(() => tasks.summary.needs === 2)
  expect(tasks.counts.version).toBeGreaterThan(counted)
  expect(tasks.tasks[0].name).toBe('hex')
})

test('a new thread shows up when its app writes threads.json, once its session has records, and links once Discord has said which server it is in', async () => {
  threads('discord', { d1: { name: 'Latest Claude', session: '99999999-latest' } })
  job('99999999-latest', { state: 'failed', detail: "You've hit your weekly limit", updatedAt: ago(0) })
  await until(() => tasks.get('discord:d1')?.state === 'failed')
  expect(tasks.get('discord:d1')).toMatchObject({ where: 'Discord', line: "You've hit your weekly limit" })
  expect(tasks.get('discord:d1')!.link).toBeUndefined()
  writeFileSync(join(state, 'discord', 'guild.json'), JSON.stringify({ id: '3000' }))
  await until(() => tasks.get('discord:d1')?.link === 'https://discord.com/channels/3000/d1')
})

test("a Buzz thread links to its message in the channel the bot recorded, a DM to its channel, and a thread with no channel to nothing", async () => {
  const [anchors, lost, dm, channel] = ['a'.repeat(64), 'b'.repeat(64), '5c0f9a6e-3b1d-4e7a-9c2f-7d8e1a4b6c30', '0d6f2c1e-5a4b-4c3d-8e9f-123456789abc']
  threads('buzz', {
    [anchors]: { name: 'Anchors', session: 'b0000001-anchors' },
    [lost]: { name: 'Lost', session: 'b0000002-lost' },
    [dm]: { name: 'bassim', session: 'b0000003-dm' },
  })
  for (const session of ['b0000001-anchors', 'b0000002-lost', 'b0000003-dm']) job(session, { state: 'done', detail: 'ok', updatedAt: ago(1) })
  await until(() => [anchors, lost, dm].every(thread => tasks.get(`buzz:${thread}`)))
  expect(tasks.get(`buzz:${anchors}`)!.link).toBeUndefined()
  writeFileSync(join(state, 'buzz', 'channels.json'), JSON.stringify({ [anchors]: channel }))
  await until(() => tasks.get(`buzz:${anchors}`)?.link === `buzz://message?channel=${channel}&id=${anchors}`)
  expect(tasks.get(`buzz:${dm}`)!.link).toBe(`buzz://channel/${dm}`)
  expect(tasks.get(`buzz:${lost}`)!.link).toBeUndefined()
})

test("a Telegram DM links to the bot once the bot has said its name", async () => {
  threads('telegram', { ...telegram, '2000100': { name: 'DM', session: '20001000-dm' } })
  job('20001000-dm', { state: 'done', detail: 'ok', updatedAt: ago(1) })
  await until(() => !!tasks.get('telegram:2000100'))
  expect(tasks.get('telegram:2000100')).toMatchObject({ where: 'DM' })
  expect(tasks.get('telegram:2000100')!.link).toBeUndefined()
  writeFileSync(join(state, 'telegram', 'bot.json'), JSON.stringify({ username: 'hex_bot' }))
  await until(() => tasks.get('telegram:2000100')?.link === 'https://t.me/hex_bot')
})

test("a T3 Code thread links to T3's own thread for it, once T3 has one, and the app's environment; deleted threads and other drivers give no link", async () => {
  threads('t3', {
    mapped: { name: 'Voice app', session: 'd3000001-mapped' },
    later: { name: 'Later', session: 'd3000002-later' },
    gone: { name: 'Gone', session: 'd3000003-gone' },
    other: { name: 'Other', session: 'd3000004-other' },
    unmapped: { name: 'Unmapped', session: 'd3000005-unmapped' },
  })
  for (const session of ['d3000001-mapped', 'd3000002-later', 'd3000003-gone', 'd3000004-other', 'd3000005-unmapped']) job(session, { state: 'done', detail: 'ok', updatedAt: ago(1) })
  mapped('mapped', '4a1e7c52-9b3d-4f60-8a2e-5d6c7b8e9f01', { title: 'Voice app restyle' })
  mapped('gone', 'thread-gone', { deleted: ago(5) })
  mapped('other', 'thread-other', { driver: 'claudeAgent' })
  await until(() => !!tasks.get('t3:mapped')?.link)
  expect(tasks.get('t3:mapped')).toMatchObject({ link: 't3code://threads/env-1/4a1e7c52-9b3d-4f60-8a2e-5d6c7b8e9f01', place: 'Voice app restyle', name: 'Voice app' })
  expect(tasks.get('t3:unmapped')!.place).toBe('Unmapped')
  for (const key of ['later', 'gone', 'other', 'unmapped']) expect(tasks.get(`t3:${key}`)!.link).toBeUndefined()
  mapped('later', 'thread:delegated task')
  await until(() => !!tasks.get('t3:later')?.link)
  expect(tasks.get('t3:later')!.link).toBe('t3code://threads/env-1/thread%3Adelegated%20task')
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
  const lead = () => tasks.get('t3:lead')
  await until(() => lead()?.agents.length === 4)
  expect(tasks.get('t3:kid')).toBeUndefined()
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
  expect(tasks.rows().find(row => row.id === 't3:lead')!.agents[2]).not.toContainKeys(['steps', 'result'])
  handed('task-kid', 'thread-lead', 'thread-kid', { status: 'completed', title: 'kid: map the hub', since: ago(5), end: ago(0) })
  handed('task-sol', 'thread-lead', 'thread-sol', { driver: 'codex', status: 'failed', title: 'sol: second opinion', since: ago(3), end: ago(0) })
  await until(() => lead()?.state === 'done')
  expect(tasks.get('t3:kid')).toBeUndefined()
})

test("a thread that stops working keeps its last stretch, with nothing left running and its agents as T3 Code has them now, until it works again", async () => {
  const lead = () => tasks.get('t3:lead')!
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
  expect(tasks.rows().find(row => row.id === 't3:lead')!.agents[0]).not.toContainKeys(['steps', 'result'])
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
  const antibody = () => tasks.get('telegram:-1001234567890:513')
  await until(() => antibody()?.state === 'working')
  expect(antibody()!.agents.map(agent => [agent.label, agent.state])).toEqual([['build:bills', 'working']])
  step(join(project, '51351351-antibody', 'subagents', 'workflows', 'wf_1', 'agent-wfbills.jsonl'), 'Read', { file_path: '/repo/bills.ts' })
  await until(() => antibody()?.agents[0].line === 'Reading bills.ts')
})

test('a running session no thread holds is a task of its own while it works', async () => {
  job('12121212-review', { state: 'working', detail: 'reviewing autofork', updatedAt: ago(0) })
  job('34343434-probe', { state: 'done', detail: 'probe ran', updatedAt: ago(0) })
  running('12121212-review', 'busy', process.pid, { kind: 'bg', name: 'autofork-review', cwd: '/repo' })
  running('34343434-probe', 'idle', process.pid, { kind: 'bg', name: 'probe' })
  running('56565656-terminal', 'busy', process.pid, { kind: 'interactive', name: 'bassim-1' })
  await until(() => tasks.get('claude:12121212')?.state === 'working')
  expect(tasks.get('claude:12121212')).toMatchObject({ name: 'autofork-review', where: 'Claude Code', line: 'reviewing autofork' })
  expect(tasks.tasks.filter(task => task.app === 'claude').map(task => task.name)).toEqual(['autofork-review', 'bassim-1'])
  job('12121212-review', { state: 'done', detail: 'reviewed', updatedAt: ago(0) })
  running('12121212-review', 'idle', process.pid, { kind: 'bg', name: 'autofork-review', cwd: '/repo' })
  rmSync(join(claude, 'sessions', '56565656.json'))
  await until(() => !tasks.get('claude:12121212') && !tasks.get('claude:56565656'))
})

test("a thread stays working while a session it started runs, that session one of its agents, and while its own shells run", async () => {
  const shell = Bun.spawn(['sh', '-c', 'sleep 30 >/dev/null & echo $!; wait'], { stdout: 'pipe' })
  const { value } = await shell.stdout.getReader().read()
  const build = Number(new TextDecoder().decode(value))
  afterAll(() => {
    process.kill(build)
    shell.kill()
  })
  threads('telegram', { ...telegram, '-1001234567890:3275': { name: 'lab', session: '32753275-lab' } })
  job('32753275-lab', { state: 'done', detail: 'started the build', updatedAt: ago(1) })
  running('32753275-lab', 'idle', shell.pid)
  const lab = () => tasks.get('telegram:-1001234567890:3275')
  await until(() => lab()?.state === 'done')
  running('78787878-build', 'busy', build, { kind: 'interactive', name: 'lab-build-c0', cwd: '/scratch/build', startedAt: Date.now() })
  await until(() => lab()?.state === 'working')
  expect(lab()!.agents.map(agent => [agent.id, agent.label, agent.state])).toEqual([['78787878-build', 'lab-build-c0', 'working']])
  expect(tasks.get('claude:78787878')).toBeUndefined()
  step(join(claude, 'projects', '-scratch-build', '78787878-build.jsonl'), 'Read', { file_path: '/scratch/build/plan.md' })
  await until(() => lab()?.agents[0]?.line === 'Reading plan.md')
  rmSync(join(claude, 'sessions', '78787878.json'))
  await until(() => lab()?.state === 'done')
  running('32753275-lab', 'shell', shell.pid)
  await until(() => lab()?.state === 'working')
})

test("a job's session works under the thread that owns it, wherever it runs, and one whose owner is gone is a task of its own", async () => {
  const owned = Bun.spawn(['sleep', '30'], { env: { ...process.env, HEX_OWNER: 'telegram:-1001234567890:65' } })
  const orphan = Bun.spawn(['sleep', '30'], { env: { ...process.env, HEX_OWNER: 'telegram:-1001234567890:404' } })
  afterAll(() => {
    owned.kill()
    orphan.kill()
  })
  const theo = () => tasks.get('telegram:-1001234567890:65')
  job('91919191-clips', { state: 'working', detail: 'cutting clips', updatedAt: ago(0) })
  job('92929292-lost', { state: 'working', detail: 'lost its thread', updatedAt: ago(0) })
  running('91919191-clips', 'busy', owned.pid, { kind: 'interactive', name: 'Theo clips/cut', startedAt: Date.now() })
  running('92929292-lost', 'busy', orphan.pid, { kind: 'interactive', name: 'gone/job', startedAt: Date.now() })
  await until(() => theo()?.state === 'working' && !!tasks.get('claude:92929292'))
  expect(theo()!.agents.map(agent => [agent.id, agent.label, agent.state])).toEqual([['91919191-clips', 'Theo clips/cut', 'working']])
  expect(tasks.get('claude:91919191')).toBeUndefined()
  rmSync(join(claude, 'sessions', '91919191.json'))
  rmSync(join(claude, 'sessions', '92929292.json'))
  await until(() => theo()?.state !== 'working' && !tasks.get('claude:92929292'))
})

test("a job's session works under the thread that owns it while that thread has no session of its own", async () => {
  const owned = Bun.spawn(['sleep', '30'], { env: { ...process.env, HEX_OWNER: 'telegram:-1001234567890:3675' } })
  afterAll(() => owned.kill())
  threads('telegram', { ...telegram, '-1001234567890:3675': { name: 'unemployment' } })
  const claim = () => tasks.get('telegram:-1001234567890:3675')
  job('93939393-claim', { state: 'working', detail: 'filling the claim', updatedAt: ago(0) })
  running('93939393-claim', 'busy', owned.pid, { kind: 'interactive', name: 'unemployment/claim', cwd: '/scratch/claim', startedAt: Date.now() })
  await until(() => claim()?.state === 'working')
  expect(claim()!.agents.map(agent => [agent.id, agent.label, agent.state])).toEqual([['93939393-claim', 'unemployment/claim', 'working']])
  expect(tasks.get('claude:93939393')).toBeUndefined()
  step(join(claude, 'projects', '-scratch-claim', '93939393-claim.jsonl'), 'Read', { file_path: '/scratch/claim/form.md' })
  await until(() => claim()?.agents[0]?.line === 'Reading form.md')
  rmSync(join(claude, 'sessions', '93939393.json'))
  await until(() => !claim())
})

test("a renewed session's new job folder still wakes the list", async () => {
  rmSync(join(claude, 'jobs', 'aaaaaaaa'), { recursive: true })
  job('aaaaaaaa-general', { state: 'done', detail: 'renewed', updatedAt: ago(0) })
  await until(() => tasks.get('telegram:-1001234567890')?.line === 'renewed')
  await Bun.sleep(100)
  job('aaaaaaaa-general', { state: 'done', detail: 'after the renew', updatedAt: ago(0) })
  await until(() => tasks.get('telegram:-1001234567890')?.line === 'after the renew')
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
  await until(() => tasks.get('telegram:-1001234567890')?.line === 'before the respawn')
  rmSync(join(claude, 'jobs', 'aaaaaaaa'), { recursive: true })
  job('aaaaaaaa-general', { state: 'done', detail: 'after the respawn', updatedAt: ago(0) }, [{ at: ago(1), state: 'done', detail: 'after the respawn', text: '' }])
  await until(() => tasks.get('telegram:-1001234567890')?.line === 'after the respawn')
  expect(tasks.get('telegram:-1001234567890')!.track[0]).toEqual({ at: earlier, state: 'working' })
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
  const woken = () => tasks.get('t3:woken')
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
  writeFileSync(
    join(state, 'discord', 'relays.jsonl'),
    [
      { at: ago(55), from: 'fix', thread: 'thread-prims', run: first },
      { at: ago(2), from: 'fix', thread: 'thread-prims', run: relayed },
      { at: ago(4), from: 'fix', thread: 'thread-codex', run: second },
      'not json',
    ].map(line => (typeof line === 'string' ? line : JSON.stringify(line)) + '\n').join(''),
  )
  const fix = () => tasks.get('discord:fix')
  await until(() => fix()?.agents.length === 2)
  expect(fix()!.state).toBe('working')
  expect(fix()!.agents.map(agent => [agent.label, agent.state, agent.via, agent.line])).toEqual([
    ['hex primitives + durability', 'working', 't3', undefined],
    ['sol: a second look', 'done', 't3', 'Looks sound.'],
  ])
  expect(tasks.get('t3:prims')).toBeUndefined()
  run('thread-prims', 2, { status: 'completed', since: ago(2), end: ago(0) })
  run('thread-prims', 3, { since: ago(0) })
  await until(() => !!tasks.get('t3:prims'))
  expect(fix()!.state).not.toBe('working')
})

test("two T3 threads that send each other work each show on their own, the other under it", async () => {
  threads('t3', { ping: { name: 'ping', session: 'a1a1a1a1-ping' }, pong: { name: 'pong', session: 'b2b2b2b2-pong' } })
  mapped('ping', 'thread-ping', { title: 'ping' })
  mapped('pong', 'thread-pong', { title: 'pong' })
  const toPong = run('thread-pong', 1, { since: ago(3) })
  const toPing = run('thread-ping', 1, { since: ago(1) })
  writeFileSync(
    join(state, 't3', 'relays.jsonl'),
    [
      { at: ago(3), from: 'ping', thread: 'thread-pong', run: toPong },
      { at: ago(1), from: 'pong', thread: 'thread-ping', run: toPing },
    ].map(line => JSON.stringify(line) + '\n').join(''),
  )
  await until(() => tasks.get('t3:ping')?.agents.length && tasks.get('t3:pong')?.agents.length)
  expect(tasks.get('t3:ping')!.agents.map(agent => [agent.label, agent.state])).toEqual([['pong', 'working']])
  expect(tasks.get('t3:pong')!.agents.map(agent => [agent.label, agent.state])).toEqual([['ping', 'working']])
})
