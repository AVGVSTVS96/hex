import { afterAll, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { until } from '../../hub/until.ts'
import { open, type Kept } from '../../hub/store.ts'

const home = mkdtempSync(join(tmpdir(), 'voice-activity-'))
process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
const { backOf, findThread, followAgent, followThread, followTranscript, generalOf, headline, itemStep, nameOf, past, stepOf } = await import('./activity.ts')
afterAll(() => rmSync(home, { recursive: true }))

const hex = '/home/someone/hex'
const project = join(home, 'claude', 'projects', '-home-someone-hex')
const state = join(home, 'state')

function tool(name: string, input: object) {
  return { type: 'assistant', message: { id: `msg_${name}`, content: [{ type: 'tool_use', id: `toolu_${name}_${Math.random()}`, name, input }] } }
}
const said = (text: string, extra = {}) => ({ type: 'assistant', message: { id: 'msg_text', content: [{ type: 'text', text }] }, ...extra })
const ended = { type: 'system', subtype: 'turn_duration' }
const asked = (tag: string) => ({ type: 'user', origin: { kind: 'channel' }, message: { role: 'user', content: `<channel source="buzz" voice_task="${tag}">look</channel>` } })

function write(path: string, ...entries: object[]) {
  appendFileSync(path, entries.map(entry => JSON.stringify(entry) + '\n').join(''))
}

function threads(app: string, all: Record<string, Kept>) {
  open(state).keepThreads(app, all)
}

test('a step reads as a few plain words: a command by its description or first line, a file by its name, an MCP tool by its app', () => {
  const path = join(home, 'steps.jsonl')
  write(
    path,
    tool('Bash', { command: 'git log --oneline', description: 'Show recent commits' }),
    tool('Bash', { command: 'uptime\nfree -g' }),
    tool('Read', { file_path: '/home/someone/hex/projects/notes/transcript.md' }),
    tool('mcp__plugin_telegram_telegram__reply', { text: 'done' }),
    tool('mcp__claude_ai_Gmail__search_threads', { query: 'invoice' }),
    tool('ToolSearch', { query: 'select:Monitor' }),
  )
  const lines: (string | undefined)[] = []
  followTranscript(path, 0, (_: unknown, updates: () => any[]) => lines.push(...updates().map(headline)))()
  expect(lines).toEqual(['Show recent commits', 'Running uptime', 'Reading transcript.md', 'Telegram: reply', 'Gmail: search threads', undefined])
  const thought = { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'The **lane** first.\n\nThen rows.' } } as const
  expect(stepOf(thought)).toEqual({ kind: 'think', text: 'The lane first. Then rows.' })
  expect(headline(thought)).toBe('Thinking')
})

test("a T3 Code hand-off reads by the agent or thread it's about, a Claude agent by its description, and any other MCP tool by its app with what it was given", () => {
  const call = (name: string, input: object) => stepOf({ sessionUpdate: 'tool_call', toolCallId: 't1', title: name, kind: name === 'Agent' ? 'think' : 'other', rawInput: input, _meta: { claudeCode: { toolName: name } } } as any, id => ({ 'task-1': 'sol: a second opinion', 'thread-2': 'voice app' })[id])
  expect(call('mcp__t3-code__delegate_task', { title: 'sol: a second opinion', task: 'Act as the reviewer.\nRead the brief.' })).toEqual({ kind: 'agent', text: 'Handed off sol: a second opinion', detail: 'Act as the reviewer.', id: 't1' })
  expect(call('mcp__t3-code__task_status', { taskId: 'task-1' })?.text).toBe('Checked on sol: a second opinion')
  expect(call('mcp__t3-code__task_cancel', { taskId: 'task-1', reason: 'Stalled' })).toMatchObject({ text: 'Stopped sol: a second opinion', detail: 'Stalled' })
  expect(call('mcp__t3-code__t3_thread_send', { threadId: 'thread-2', message: 'Look again.' })).toMatchObject({ text: 'Wrote to voice app', detail: 'Look again.' })
  expect(call('mcp__t3-code__t3_thread_read', { threadId: 'thread-9' })?.text).toBe('Read a thread')
  expect(call('mcp__t3-code__t3_thread_wait', {})?.text).toBe('Waiting on agents')
  expect(call('Agent', { description: 'Map the hub', subagent_type: 'Explore', prompt: 'Read hub.ts.\nReport back.' })).toMatchObject({ kind: 'agent', text: 'Started Map the hub', detail: 'Explore\nRead hub.ts.' })
  expect(call('mcp__t3-code__preview_open', { url: 'http://localhost:1422', open: false })).toMatchObject({ text: 'T3 Code: preview open', detail: 'url: http://localhost:1422\nopen: false' })
  expect(call('ToolSearch', { query: 'select:Monitor' })).toBeUndefined()
})

test('a tool call that comes back says whether it worked and its first lines, never a file body or a hand-off receipt, and names the agent it started', () => {
  const update = (toolName: string, rawOutput: unknown, status = 'completed') => backOf({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status, rawOutput, _meta: { claudeCode: { toolName } } } as any)
  expect(update('Bash', 'one\ntwo\nthree\nfour\nfive\nsix\nseven')).toEqual({ state: 'done', result: 'one\ntwo\nthree\nfour\nfive\nsix' })
  expect(update('Bash', 'Exit code 1\nboom', 'failed')).toEqual({ state: 'failed', result: 'Exit code 1\nboom' })
  expect(update('Read', [{ type: 'text', text: 'the body' }])).toEqual({ state: 'done' })
  expect(update('Agent', [{ type: 'text', text: 'Async agent launched successfully.\nagentId: a1b2 (internal ID)' }])).toEqual({ state: 'done', agent: 'a1b2' })
  expect(update('mcp__t3-code__delegate_task', JSON.stringify({ taskId: 'task-1', childThreadId: 'thread-1' }))).toEqual({ state: 'done', agent: 'thread-1' })
  expect(update('mcp__t3-code__t3_thread_send', 'Thread not found', 'failed')).toEqual({ state: 'failed', result: 'Thread not found' })
  expect(['Reading x.ts', 'Writing a.md', 'Running ls', 'Searching for x', 'Waiting on agents', 'Run the tests', 'Started Map the hub'].map(past)).toEqual([
    'Read x.ts',
    'Wrote a.md',
    'Ran ls',
    'Searched for x',
    'Waited on agents',
    'Run the tests',
    'Started Map the hub',
  ])
})

test("Codex's turn items read like Claude's steps: a command by what it does, with the command as typed, a search, an edit's size, a tool, its thoughts and words, a hand-off and an error", () => {
  const item = (type: string, payload: object, status = 'completed') => itemStep({ id: `${type}-1`, type, status, payload: { startedAt: 'b', completedAt: 'e', ...payload } })
  expect(item('command_execution', { input: `/usr/bin/bash -lc "pwd; rg -n 'durable|queue' ~/notes"`, output: 'notes.md:3: durable\n', exitCode: 0 })).toEqual({
    id: 'command_execution-1',
    at: 'b',
    end: 'e',
    kind: 'run',
    text: 'Searched for durable|queue',
    state: 'done',
    detail: "pwd; rg -n 'durable|queue' ~/notes",
    result: 'notes.md:3: durable',
  })
  const words = (input: string) => item('command_execution', { input, exitCode: 0 })!.text
  expect([`bash -lc 'nl -ba hub.ts | sed -n 1,80p'`, `bash -lc "cat > ~/x/sol.md <<'EOF'\nhi\nEOF"`, 'git log --oneline | head', 'rg --files src', 'cat a.txt 2>/dev/null', `bash -lc 'cat AGENTS.md >/dev/null\nnl -ba links.ts'`].map(words)).toEqual([
    'Read hub.ts',
    'Wrote sol.md',
    'Ran git log',
    'Listed src',
    'Read a.txt',
    'Read links.ts',
  ])
  expect(item('command_execution', { input: 'bun test', output: '1 fail', exitCode: 1 })).toMatchObject({ state: 'failed', result: '1 fail' })
  expect(item('command_execution', { input: 'bun test', completedAt: null }, 'running')).toMatchObject({ text: 'Running bun test', state: 'running' })
  expect(item('command_execution', { input: 'bun test', completedAt: null }, 'running')).not.toContainKey('end')
  expect(item('web_search', { patterns: ['FULL (2)', 'https://sqlite.org/pragma.html', "'FULL (2)' in https://sqlite.org/pragma.html"] })).toMatchObject({ kind: 'web', text: 'Looked for FULL (2) on sqlite.org' })
  expect(item('web_search', { patterns: ['https://docs.dbos.dev/x', 'https://docs.dbos.dev/x'] })).toMatchObject({ text: 'Read docs.dbos.dev', detail: 'https://docs.dbos.dev/x' })
  expect(item('file_change', { fileName: '/repo/sol.md', diffStr: '@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d' })).toMatchObject({ kind: 'edit', text: 'Edited sol.md', detail: '/repo/sol.md', result: '+2 −1' })
  expect(item('dynamic_tool', { toolName: 't3-code.html_render', input: { title: 'Plan', height: 560 }, output: { error: 'Missing key height' } })).toMatchObject({
    kind: 'tool',
    text: 'T3 Code: html render',
    detail: 'title: Plan\nheight: 560',
    state: 'failed',
    result: 'Missing key height',
  })
  expect(item('dynamic_tool', { toolName: 'Read', input: { file_path: '/repo/a.ts' }, output: { file: { content: 'body' } } })).toEqual({ id: 'dynamic_tool-1', at: 'b', end: 'e', kind: 'read', text: 'Read a.ts', state: 'done', detail: '/repo/a.ts' })
  expect(item('reasoning', { text: '**Weighing the options**\n\nI need a durable core.' })).toEqual({ id: 'reasoning-1', at: 'b', kind: 'think', text: 'Weighing the options. I need a durable core.' })
  expect(item('assistant_message', { text: '**Done.** The page is up.\nMore.' })).toMatchObject({ kind: 'say', text: 'Done. The page is up.' })
  expect(item('subagent', { title: 'scout: look around', childThreadId: 'thread-3', prompt: 'Look around.\nThen report.' })).toMatchObject({ kind: 'agent', text: 'Handed off scout: look around', agent: 'thread-3', detail: 'Look around.' })
  expect(item('error', { title: 'Provider turn failed to start', failure: { message: 'no session id' } }, 'failed')).toMatchObject({ kind: 'tool', text: 'Provider turn failed to start', state: 'failed', result: 'no session id' })
  expect(item('user_message', { text: 'hi' })).toBeUndefined()
})

test("an agent's own words read as their first line, without markdown, and its plan as the step in progress", () => {
  expect(headline({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '**Found it.** The hub drops\nthe rest' } })).toBe('Found it. The hub drops')
  expect(headline({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '  \n' } })).toBeUndefined()
  expect(
    headline({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read the hub', status: 'completed', priority: 'medium' },
        { content: 'Wire the line', status: 'in_progress', priority: 'medium' },
      ],
    }),
  ).toBe('Wire the line')
})

test("a background subagent's steps come from its transcript as it writes them", async () => {
  const dir = join(project, 'brain-session', 'subagents')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'agent-a1b2.jsonl')
  write(path, { type: 'user', isSidechain: true, message: { role: 'user', content: 'You are a subagent.' } }, tool('Read', { file_path: '/x/plan.md' }))
  const lines: string[] = []
  const stop = followAgent('a1b2', 'brain-session', step => step.line && lines.push(step.line))!
  expect(lines).toEqual(['Reading plan.md'])
  write(path, said('Read it; checking the hub next.'))
  await until(() => lines.length === 2)
  expect(lines[1]).toBe('Read it; checking the hub next.')
  stop()
  expect(followAgent('nobody', 'brain-session', () => {})).toBeUndefined()
  expect(followAgent('../x', 'brain-session', () => {})).toBeUndefined()
})

test('a thread is found by its id or its name, in any app but voice', () => {
  threads('telegram', { '-100:452': { name: 'voiceapp', session: 's1' } })
  threads('voice', { voice: { name: 'voice', session: 'v' } })
  threads('t3', { 't3-id': { name: 'commonplace', cwd: '/home/someone/Developer/commonplace' } })
  expect(findThread(state, 'VoiceApp')).toMatchObject({ app: 'telegram', id: '-100:452', name: 'voiceapp' })
  expect(findThread(state, 't3-id')).toMatchObject({ app: 't3', cwd: '/home/someone/Developer/commonplace' })
  expect(findThread(state, 'voice')).toBeUndefined()
})

test("General goes by General, found by that name too, and a second Telegram group keeps its own", () => {
  threads('telegram', { '-100:452': { name: 'voiceapp', session: 's1' }, '-100': { name: 'main', session: 's0' }, '-200': { name: 'Family', session: 's3' } })
  expect(findThread(state, 'general')).toMatchObject({ app: 'telegram', id: '-100', name: 'General' })
  expect(findThread(state, 'Family')).toMatchObject({ id: '-200', name: 'Family' })
  const rows = [{ app: 'telegram', thread: '-100', name: 'old', open: false }, { app: 'telegram', thread: '-200', name: 'main' }, { app: 'telegram', thread: '-300', name: 'Family' }]
  expect(rows.map(row => nameOf(row, generalOf(rows)))).toEqual(['old', 'General', 'Family'])
  expect(generalOf([rows[0]!])).toBeUndefined()
  expect(rows.map(row => nameOf(row, generalOf(rows, '-300')))).toEqual(['old', 'main', 'General'])
  threads('discord', { 'discord-general': { name: 'general', session: 's9' } })
  expect(() => findThread(state, 'General')).toThrow('more than one hex thread goes by General, in discord and telegram')
  threads('discord', {})
  threads('telegram', { '-100:452': { name: 'voiceapp', session: 's1' } })
})

test('a name more than one thread has finds none of them, and says where they are', () => {
  threads('buzz', { 'buzz-id': { name: 'hex', session: 's1' } })
  threads('discord', { 'discord-id': { name: 'hex', session: 's2' } })
  expect(() => findThread(state, 'hex')).toThrow('more than one hex thread goes by hex, in buzz and discord: pass its app:key id, from hex threads --json')
  expect(findThread(state, 'discord-id')).toMatchObject({ app: 'discord', name: 'hex' })
  expect(findThread(state, 'buzz:buzz-id')).toMatchObject({ app: 'buzz', id: 'buzz-id', name: 'hex' })
})

test("a message sent to a thread shows that thread's steps once it takes the message in, its agents' too, and is done when a turn ends with no agent out", async () => {
  mkdirSync(project, { recursive: true })
  const path = join(project, 's1.jsonl')
  write(path, tool('Bash', { command: 'ls', description: 'Earlier work' }), ended)
  const steps: object[] = []
  const stop = followThread(findThread(state, 'voiceapp')!, hex, 'tag42', false, step => steps.push(step))
  write(path, tool('Bash', { command: 'ls', description: 'Work on something else' }))
  write(path, { type: 'user', origin: { kind: 'channel' }, message: { role: 'user', content: '<channel source="telegram" user="hex voice" voice_task="tag42">the orb bounces</channel>' } })
  write(path, tool('Agent', { description: 'Tune the glide', prompt: 'go' }))
  write(path, { type: 'user', message: { role: 'user', content: [] }, toolUseResult: { isAsync: true, agentId: 'agent7' } }, ended)
  await until(() => steps.length === 1)
  expect(steps).toEqual([{ line: 'Started Tune the glide' }])

  const agent = join(project, 's1', 'subagents', 'agent-agent7.jsonl')
  mkdirSync(join(project, 's1', 'subagents'), { recursive: true })
  write(agent, tool('Edit', { file_path: '/repo/src/motion.ts', old_string: 'a', new_string: 'b' }))
  await until(() => steps.length === 2)
  expect(steps[1]).toEqual({ line: 'Editing motion.ts' })

  write(path, { type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>\n<task-id>agent7</task-id>\n<status>completed</status>' } })
  write(path, said('The glide no longer overshoots.'), ended)
  await until(() => steps.length === 4)
  expect(steps.slice(2)).toEqual([{ line: 'The glide no longer overshoots.' }, { end: 'done' }])
  stop()
})

test("a message is picked by its own tag only, not by a tag it begins, in a string or in blocks", async () => {
  threads('buzz', { b2: { name: 'Tags', session: 'tags' } })
  const path = join(project, 'tags.jsonl')
  const sent = (tag: string, blocks = false) => {
    const text = `<channel source="telegram" user="hex voice" voice_task="${tag}">look</channel>`
    return { type: 'user', origin: { kind: 'channel' }, message: { role: 'user', content: blocks ? [{ type: 'text', text }] : text } }
  }
  write(path, sent('call:x-2'), said('The other one.'), ended)
  const steps: object[] = []
  const stop = followThread(findThread(state, 'tags')!, hex, 'call:x', true, step => steps.push(step))
  expect(steps).toEqual([])
  write(path, { type: 'user', origin: { kind: 'channel' }, message: { role: 'user', content: '<channel source="telegram">quoting voice_task="call:x"</channel>' } }, said('A quote.'), ended)
  write(path, sent('call:x', true), said('This one.'), ended)
  await until(() => steps.length === 2)
  expect(steps).toEqual([{ line: 'This one.' }, { end: 'done' }])
  stop()
})

test('a message the thread took while a turn ran, queued as an attachment, is picked too', async () => {
  threads('buzz', { b5: { name: 'Busy', session: 'busy' } })
  const path = join(project, 'busy.jsonl')
  write(path, said('Working on something else.'))
  const steps: object[] = []
  const stop = followThread(findThread(state, 'busy')!, hex, 'call:queued', true, step => steps.push(step))
  write(path, { type: 'attachment', attachment: { type: 'queued_command', origin: { kind: 'channel' }, prompt: '<channel source="telegram" voice_task="call:queued">look</channel>' } }, said('Looking now.'), ended)
  await until(() => steps.length === 2)
  expect(steps).toEqual([{ line: 'Looking now.' }, { end: 'done' }])
  stop()
})

test("following a message sent before a restart starts in the session that took it, though the thread has renewed since, and goes on in the new one", () => {
  threads('buzz', { b3: { name: 'Renewed', session: 'renewed-now' } })
  const sent = (tag: string, by: string) =>
    open(state).deliver({ key: `buzz:${tag}`, to: 'b3', from: 'buzz', author: 'other', body: 'look', meta: { user: 'hex voice', voice_task: tag } }, by)
  sent('call:finished', 'took-it')
  write(join(project, 'took-it.jsonl'), asked('call:finished'), said('Done before the renewal.'), ended)
  sent('call:cut-off', 'cut-off')
  write(join(project, 'cut-off.jsonl'), asked('call:cut-off'), said('Starting on it.'))
  write(join(project, 'renewed-now.jsonl'), said('Picked it up again.'), ended)

  const finished: object[] = []
  followThread(findThread(state, 'renewed')!, hex, 'call:finished', true, step => finished.push(step))
  expect(finished).toEqual([{ line: 'Done before the renewal.' }, { end: 'done' }])
  const cut: object[] = []
  const stop = followThread(findThread(state, 'renewed')!, hex, 'call:cut-off', true, step => cut.push(step))
  expect(cut).toEqual([{ line: 'Starting on it.' }, { line: 'Picked it up again.' }, { end: 'done' }])
  stop()
})

// A session resumed from another copies its finished turns, uuids and all, then takes the message
// of the turn that was cut off again and does it over.
function resumedFrom(tag: string) {
  const old = [said('An earlier turn.'), ended, asked(tag), said('Starting on it.')].map((entry, n) => ({ ...entry, uuid: `${tag}-${n}` }))
  return { old, copy: [old[0], old[1], { ...asked(tag), uuid: `${tag}-again` }, { ...said('Finished it.'), uuid: `${tag}-4` }, { ...ended, uuid: `${tag}-5` }] }
}

test("a session resumed from the one that took the message is followed past what it copied, after a restart or live", async () => {
  threads('buzz', { b4: { name: 'Copied', session: 'copy-now' } })
  open(state).deliver({ key: 'buzz:copied', to: 'b4', from: 'buzz', author: 'other', body: 'look', meta: { user: 'hex voice', voice_task: 'call:copied' } }, 'copy-old')
  const restart = resumedFrom('call:copied')
  write(join(project, 'copy-old.jsonl'), ...restart.old)
  write(join(project, 'copy-now.jsonl'), ...restart.copy)
  const resumed: object[] = []
  followThread(findThread(state, 'copied')!, hex, 'call:copied', true, step => resumed.push(step))
  expect(resumed).toEqual([{ line: 'Starting on it.' }, { line: 'Finished it.' }, { end: 'done' }])

  threads('buzz', { b6: { name: 'Live copy', session: 'live-old' } })
  const live = resumedFrom('call:live')
  write(join(project, 'live-old.jsonl'), live.old[0], live.old[1])
  const steps: object[] = []
  const stop = followThread(findThread(state, 'live copy')!, hex, 'call:live', false, step => steps.push(step))
  write(join(project, 'live-old.jsonl'), live.old[2], live.old[3])
  await until(() => steps.length === 1)
  write(join(project, 'live-new.jsonl'), ...live.copy)
  threads('buzz', { b6: { name: 'Live copy', session: 'live-new' } })
  await until(() => steps.length === 3)
  expect(steps).toEqual([{ line: 'Starting on it.' }, { line: 'Finished it.' }, { end: 'done' }])
  stop()
})

test("a thread's new session is followed from its start, and a turn that ends on an API error fails", async () => {
  threads('discord', { d1: { name: 'Latest Claude', session: 'old' } })
  const steps: object[] = []
  followThread(findThread(state, 'latest claude')!, hex, 'tag7', false, step => steps.push(step))
  write(join(project, 'new.jsonl'), { type: 'user', origin: { kind: 'channel' }, message: { role: 'user', content: '<channel source="discord" voice_task="tag7">look</channel>' } })
  threads('discord', { d1: { name: 'Latest Claude', session: 'new' } })
  await Bun.sleep(50)
  write(join(project, 'new.jsonl'), said("You've hit your weekly limit", { isApiErrorMessage: true }), ended)
  await until(() => steps.length === 2)
  expect(steps).toEqual([{ line: "You've hit your weekly limit" }, { end: 'failed' }])
})

test('following a message sent before a restart reads its thread from the start, ends at once when the thread already finished, and reads no further', async () => {
  threads('buzz', { b1: { name: 'Context check', session: 'done-already' } })
  write(join(project, 'done-already.jsonl'), { type: 'user', origin: { kind: 'channel' }, message: { role: 'user', content: '<channel source="buzz" voice_task="call:id">look</channel>' } }, said('All set.'), ended, said('Next turn.'), ended)
  const steps: object[] = []
  followThread(findThread(state, 'context check')!, hex, 'call:id', true, step => steps.push(step))
  expect(steps).toEqual([{ line: 'All set.' }, { end: 'done' }])
  write(join(project, 'done-already.jsonl'), said('A later turn.'), ended)
  await Bun.sleep(200)
  expect(steps).toHaveLength(2)
})
