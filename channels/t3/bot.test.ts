import { afterEach, beforeEach, expect, test } from 'bun:test'
import { connect, type Socket } from 'net'
import { Readable, Writable } from 'stream'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Subprocess } from 'bun'
import { Database } from 'bun:sqlite'
import { client, ndJsonStream, type SessionNotification } from '@agentclientprotocol/sdk'
import { ATTACH, connect as channel, service } from '../../hub/testing.ts'
import { until } from '../../hub/until.ts'
import { open as hexdb } from '../../hub/store.ts'

const SESSION = '0a1b2c3d-0000-4000-8000-000000000000'
let PORT = 0

let dir: string
let project: string
let bot: Subprocess
let env: Record<string, string | undefined>
const sockets: Socket[] = []
const proxies: Subprocess[] = []

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 't3-bot-'))
  project = join(dir, 'project')
  for (const path of [project, join(dir, 'hex', '.claude'), join(dir, 'state'), join(dir, 'config', 'jobs', 'job12345'), join(dir, '.t3', 'scratch', 'chat')]) mkdirSync(path, { recursive: true })
  writeFileSync(join(dir, '.claude.json'), '{"projects":{}}')
  script('claude', `jq -cn '$ARGS.positional' --args -- "$@" >> "${dir}/calls"
[ "$1 $2" = "agents --json" ] && { cat "${dir}/agents" 2>/dev/null || echo '[]'; }
${ATTACH}
[ "$1" = stop ] && [ -f "${dir}/agents" ] && pid=$(jq '.[0].pid' "${dir}/agents") && rm "${dir}/agents" && kill "$pid"
exit 0`)
  script('launch', `pwd >> "${dir}/cwd"
jq -cn '$ARGS.positional' --args -- "$@" >> "${dir}/launched"
[ -f "${dir}/broken" ] && { echo "Workspace not trusted." >&2; exit 1; }
echo "backgrounded · job12345 · test"`)
  env = {
    ...process.env,
    HOME: dir,
    PATH: `${dir}:${process.env.PATH}`,
    T3_STATE_DIR: join(dir, 'state'),
    HEX_DIR: join(dir, 'hex'),
    HEX_LAUNCHER: join(dir, 'launch'),
    CLAUDE_CONFIG_DIR: join(dir, 'config'),
    MEMORY_DIR: '',
  }
  await start()
})

// Each open thread as the hub keeps it in hex.db, by its id.
const registered = (): Record<string, any> => Object.fromEntries(hexdb(join(dir, 'hex', 'state')).threads({ open: true }).map(thread => [thread.thread, thread]))

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const proxy of proxies.splice(0)) proxy.kill()
  bot.kill()
  rmSync(dir, { recursive: true, force: true })
})

async function start() {
  ;({ process: bot, port: PORT } = await service(join(import.meta.dir, 'bot.ts'), env))
  await until(() => existsSync(join(dir, 'state', 'acp.sock')))
}

// The hub service stops and starts again on the same state, as a hex restart does.
async function restart(down = () => {}) {
  bot.kill()
  await bot.exited
  down()
  rmSync(join(dir, 'state', 'acp.sock'), { force: true })
  await start()
}

function script(name: string, body: string) {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(dir, name), 0o755)
}

function lines(file: string) {
  return existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8').split('\n').slice(0, -1) : []
}

async function open(path: string) {
  const socket = connect(path)
  sockets.push(socket)
  await new Promise(resolve => socket.on('connect', resolve))
  return socket
}

// T3 Code's side: an ACP client on the agent's socket.
async function t3() {
  const socket = await open(join(dir, 'state', 'acp.sock'))
  return { ...(await acp(Writable.toWeb(socket) as WritableStream<Uint8Array>, Readable.toWeb(socket) as ReadableStream<Uint8Array>)), socket }
}

// T3 Code's side as T3 runs it: `hex acp` on its stdio, relaying to the agent's socket.
async function t3OverAcp() {
  const proxy = Bun.spawn(['bun', join(import.meta.dir, 'acp.ts'), join(dir, 'state', 'acp.sock')], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
  proxies.push(proxy)
  const stdin = new WritableStream<Uint8Array>({
    write: chunk => {
      proxy.stdin.write(chunk)
      proxy.stdin.flush()
    },
  })
  return { ...(await acp(stdin, proxy.stdout)), proxy }
}

async function acp(output: WritableStream<Uint8Array>, input: ReadableStream<Uint8Array>) {
  const updates: SessionNotification['update'][] = []
  const connection = client({ name: 't3' })
    .onNotification('session/update', ({ params }) => void updates.push(params.update))
    .connect(ndJsonStream(output, input))
  const agent = connection.agent
  await agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  return { agent, updates }
}

function texts(updates: SessionNotification['update'][]) {
  return updates.flatMap(update => (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : []))
}

// The hex session's side: its channel over HTTP, its Claude job record, and its hooks.
async function session(thread: string) {
  const settings = join(dir, 'state', 'settings-test.json')
  writeFileSync(settings, JSON.stringify({ env: { HEX_CHANNEL: 'plugin:t3@hex', HEX_THREAD: thread } }))
  writeFileSync(join(dir, 'config', 'jobs', 'job12345', 'state.json'), JSON.stringify({ state: 'working', sessionId: SESSION, respawnFlags: ['--settings', settings] }))
  // A session the hub didn't start is found by its job record once it connects.
  if (!existsSync(join(dir, 'agents'))) writeFileSync(join(dir, 'agents'), JSON.stringify([{ id: 'job12345', sessionId: SESSION, pid: Bun.spawn(['sleep', '60']).pid, status: 'idle' }]))
  const line = await channel({ stateDir: join(dir, 'state'), path: '/t3', channel: 'plugin:t3@hex', thread, at: PORT })
  const inbound = line.received
  const transcript = join(dir, 'config', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'), `${SESSION}.jsonl`)
  mkdirSync(join(transcript, '..'), { recursive: true })
  return {
    inbound,
    // As the prompt hook does for a session started before hex kept messages: it takes what reached it.
    busy: async () => {
      await until(() => inbound.length)
      await hook({ type: 'state', thread, busy: true, taken: inbound.map(message => message.meta.key), session: SESSION })
    },
    idle: (background = false) => hook({ type: 'state', thread, busy: false, ...(background && { background }) }),
    write: (...entries: object[]) => appendFileSync(transcript, entries.map(entry => JSON.stringify(entry) + '\n').join('')),
    read: () => readFileSync(transcript, 'utf8'),
  }
}

// A line on hub.sock, the way a session's hooks send one. Resolves once the hub has read it.
async function hook(payload: object) {
  const socket = await open(join(dir, 'state', 'hub.sock'))
  socket.end(JSON.stringify(payload) + '\n')
  await new Promise(resolve => socket.on('close', resolve))
}

const prompt = { type: 'user', origin: { kind: 'channel' }, isMeta: true, message: { content: '<channel source="t3">hi</channel>' } }
const reply = { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'hi from hex' }] } }
const done = { type: 'system', subtype: 'turn_duration' }
const now = () => new Date().toISOString()

// A thread hex keeps: T3 opened it in the project, and its session answered the first prompt.
async function kept(agent: Awaited<ReturnType<typeof t3>>['agent']) {
  const { sessionId } = await agent.request('session/new', { cwd: project, mcpServers: [] })
  const first = agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] })
  await until(() => lines('launched').length)
  const hex = await session(sessionId)
  await hex.busy()
  hex.write(prompt, reply, done)
  await hex.idle()
  await first
  return { sessionId, hex }
}

test('a new thread starts its hex session in its project on the first prompt, which streams the turn until the transcript ends it', async () => {
  const { agent, updates } = await t3()
  const { sessionId } = await agent.request('session/new', { cwd: project, mcpServers: [] })
  expect(lines('launched')).toEqual([])
  const answer = agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] })
  await until(() => lines('cwd').length)
  expect(lines('cwd')).toEqual([project])
  const hex = await session(sessionId)
  await until(() => hex.inbound.length)
  expect(hex.inbound[0]).toMatchObject({ type: 'inbound', content: 'hi' })
  await hex.busy()
  hex.write(prompt, reply, done)
  await hex.idle()
  expect(await answer).toEqual({ stopReason: 'end_turn' })
  expect(updates.filter(update => update.sessionUpdate !== 'available_commands_update')).toEqual([expect.objectContaining({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi from hex' } })])
})

test('a turn whose session stops with a background agent still working stays open through the turn its result starts', async () => {
  const { agent, updates } = await t3()
  const { sessionId } = await agent.request('session/new', { cwd: project, mcpServers: [] })
  let answered = false
  const answer = agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] }).finally(() => (answered = true))
  await until(() => lines('cwd').length)
  const hex = await session(sessionId)
  await hex.busy()
  hex.write(prompt, { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'started an agent' }] } }, done)
  await hex.idle(true)
  await agent.request('session/list', { cwd: project })
  expect(answered).toBe(false)
  hex.write({ type: 'user', origin: { kind: 'task-notification' }, message: { content: '<task-notification>ok</task-notification>' } })
  await hex.idle()
  await agent.request('session/list', { cwd: project })
  expect(answered).toBe(false)
  hex.write({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'the agent says ok' }] } }, done)
  await hex.idle()
  expect(await answer).toEqual({ stopReason: 'end_turn' })
  expect(updates.filter(update => update.sessionUpdate === 'agent_message_chunk').map(update => (update as any).content.text)).toEqual(['started an agent', 'the agent says ok'])
})

test('a session advertises /compact once T3 knows it', async () => {
  const { agent, updates } = await t3()
  await agent.request('session/new', { cwd: project, mcpServers: [] })
  await until(() => updates.length)
  expect(updates).toEqual([{ sessionUpdate: 'available_commands_update', availableCommands: [expect.objectContaining({ name: 'compact' })] }])
})

test('/compact stops a running session, resumes it with the command once it has exited, and ends at the compaction', async () => {
  const { agent, updates } = await t3()
  const { sessionId, hex } = await kept(agent)
  updates.length = 0
  const answer = agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/compact' }, { type: 'text', text: 'T3 context' }] })
  await until(() => lines('launched').some(line => line.includes('"/compact"')))
  expect(lines('calls')).toContain(JSON.stringify(['stop', SESSION.slice(0, 8)]))
  expect(JSON.parse(lines('launched').at(-1)!)).toEqual(expect.arrayContaining(['--resume', SESSION, '/compact']))
  hex.write(
    { type: 'user', message: { content: '/compact' } },
    { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual' } },
  )
  expect(await answer).toEqual({ stopReason: 'end_turn' })
  expect(hex.inbound.map(message => message.content)).toEqual(['hi'])
  expect(updates.map(update => update.sessionUpdate === 'compaction_update' && update.status)).toEqual(['in_progress', 'completed'])
})

test('a /compact that fails fails the prompt with the command\'s error', async () => {
  const { agent, updates } = await t3()
  const { sessionId, hex } = await kept(agent)
  const answer = agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/compact' }] })
  await until(() => lines('launched').some(line => line.includes('"/compact"')))
  hex.write({ type: 'system', subtype: 'local_command', content: '<local-command-stderr>Error: No messages to compact</local-command-stderr>' })
  await expect(answer).rejects.toThrow('Error: No messages to compact')
  await until(() => updates.some(update => update.sessionUpdate === 'compaction_update' && update.status === 'failed'))
})

const t3Tools = (token: string) => ({ name: 't3-code', command: '/opt/t3code', args: ['acp-mcp-bridge'], env: [{ name: 'T3_ACP_MCP_AUTHORIZATION', value: token }] })

test('a session gets T3\'s MCP servers, and starts again with them when they change', async () => {
  const { agent } = await t3()
  const { sessionId } = await agent.request('session/new', { cwd: project, mcpServers: [t3Tools('one'), { type: 'http', name: 'docs', url: 'http://localhost:9/mcp', headers: [{ name: 'Authorization', value: 'Bearer x' }] }] })
  const first = agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] })
  await until(() => lines('launched').length)
  const launched = JSON.parse(lines('launched')[0]!)
  expect(JSON.parse(launched[launched.indexOf('--mcp-config') + 1])).toEqual({
    mcpServers: {
      't3-code': { command: '/opt/t3code', args: ['acp-mcp-bridge'], env: { T3_ACP_MCP_AUTHORIZATION: 'one' } },
      docs: { type: 'http', url: 'http://localhost:9/mcp', headers: { Authorization: 'Bearer x' } },
    },
  })
  const saved = join(dir, 'config', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(saved, { recursive: true })
  writeFileSync(join(saved, `${SESSION}.jsonl`), '')
  const hex = await session(sessionId)
  await until(() => JSON.stringify(registered()).includes(SESSION))
  await hex.busy()
  hex.write(prompt, reply, done)
  await hex.idle()
  expect(await first).toEqual({ stopReason: 'end_turn' })
  // Not this test's child, so it's reaped once killed and the hub sees it go, as with a real session.
  const pid = Number(Bun.spawnSync(['sh', '-c', 'sleep 60 >/dev/null 2>&1 & echo $!']).stdout.toString())
  writeFileSync(join(dir, 'agents'), JSON.stringify([{ sessionId: SESSION, pid, status: 'idle' }]))
  await agent.request('session/resume', { sessionId, cwd: project, mcpServers: [t3Tools('two')] })
  agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'again' }] }).catch(() => {})
  await until(() => lines('launched').some(line => line.includes('two')))
  expect(lines('calls')).toContain(JSON.stringify(['stop', SESSION.slice(0, 8)]))
  expect(hex.inbound.map(message => message.content)).toEqual(['hi'])
  const fresh = await session(sessionId)
  await until(() => fresh.inbound.length)
  expect(fresh.inbound[0]).toMatchObject({ type: 'inbound', content: 'again' })
})

test('a turn whose T3 connection closes stops its session, and a reconnected T3 starts it again with its new tools', async () => {
  const first = await t3()
  const { sessionId } = await first.agent.request('session/new', { cwd: project, mcpServers: [t3Tools('one')] })
  first.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] }).catch(() => {})
  await until(() => lines('launched').length)
  const saved = join(dir, 'config', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(saved, { recursive: true })
  writeFileSync(join(saved, `${SESSION}.jsonl`), '')
  const hex = await session(sessionId)
  await until(() => JSON.stringify(registered()).includes(SESSION))
  await hex.busy()
  const pid = Number(Bun.spawnSync(['sh', '-c', 'sleep 60 >/dev/null 2>&1 & echo $!']).stdout.toString())
  writeFileSync(join(dir, 'agents'), JSON.stringify([{ sessionId: SESSION, pid, status: 'busy' }]))
  first.socket.destroy()
  await until(() => lines('calls').includes(JSON.stringify(['stop', SESSION.slice(0, 8)])) && !existsSync(join(dir, 'agents')))
  const second = await t3()
  await second.agent.request('session/resume', { sessionId, cwd: project, mcpServers: [t3Tools('two')] })
  second.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] }).catch(() => {})
  await until(() => lines('launched').some(line => line.includes('two')))
  const fresh = await session(sessionId)
  await until(() => fresh.inbound.length)
  expect(fresh.inbound[0]).toMatchObject({ type: 'inbound', content: 'hi' })
})

test('a thread offers T3 model and effort pickers, and its session starts again with what was picked', async () => {
  writeFileSync(join(dir, 'hex', '.claude', 'settings.json'), JSON.stringify({ model: 'opus', effortLevel: 'medium' }))
  const { agent } = await t3()
  const { sessionId, configOptions } = await agent.request('session/new', { cwd: project, mcpServers: [] })
  expect(configOptions!.map(option => [option.id, option.category, option.type === 'select' && option.currentValue])).toEqual([['model', 'model', 'opus'], ['effort', 'thought_level', 'medium']])
  await expect(agent.request('session/set_config_option', { sessionId, configId: 'effort', value: 'ludicrous' })).rejects.toThrow()
  const { configOptions: picked } = await agent.request('session/set_config_option', { sessionId, configId: 'effort', value: 'xhigh' })
  expect(picked.find(option => option.id === 'effort')).toMatchObject({ currentValue: 'xhigh' })
  const first = agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] })
  await until(() => lines('launched').length)
  const launched = JSON.parse(lines('launched')[0]!)
  expect(launched[launched.indexOf('--effort') + 1]).toBe('xhigh')
  expect(launched).not.toContain('--model')
  const saved = join(dir, 'config', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(saved, { recursive: true })
  writeFileSync(join(saved, `${SESSION}.jsonl`), '')
  const hex = await session(sessionId)
  await until(() => JSON.stringify(registered()).includes(SESSION))
  await hex.busy()
  hex.write(prompt, reply, done)
  await hex.idle()
  expect(await first).toEqual({ stopReason: 'end_turn' })
  const pid = Number(Bun.spawnSync(['sh', '-c', 'sleep 60 >/dev/null 2>&1 & echo $!']).stdout.toString())
  writeFileSync(join(dir, 'agents'), JSON.stringify([{ sessionId: SESSION, pid, status: 'idle' }]))
  await agent.request('session/set_config_option', { sessionId, configId: 'model', value: 'claude-fable-5-1' })
  agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'again' }] }).catch(() => {})
  await until(() => lines('launched').length === 2)
  const again = JSON.parse(lines('launched')[1]!)
  expect([again[again.indexOf('--model') + 1], again[again.indexOf('--effort') + 1], again[again.indexOf('--resume') + 1]]).toEqual(['fable', 'xhigh', SESSION])
  expect(lines('calls')).toContain(JSON.stringify(['stop', SESSION.slice(0, 8)]))
  const fresh = await session(sessionId)
  await until(() => fresh.inbound.length)
  expect(fresh.inbound[0]).toMatchObject({ type: 'inbound', content: 'again' })
  expect(registered()[sessionId]).toMatchObject({ model: 'fable', effort: 'xhigh' })
})

test('a thread T3 opens is kept only once it sends a prompt, so T3\'s provider check leaves nothing behind', async () => {
  const check = await t3()
  await check.agent.request('session/new', { cwd: project, mcpServers: [] })
  await until(() => check.updates.length)
  check.socket.destroy()
  expect(registered()).toEqual({})
  expect(JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')).projects).toEqual({})
  expect(lines('launched')).toEqual([])
})

test('a known thread resumes, an unprompted one T3 opened before resumes as new, and a prompt to an unknown one is not found', async () => {
  const first = await t3()
  const { sessionId } = await kept(first.agent)
  const { sessionId: unprompted } = await first.agent.request('session/new', { cwd: project, mcpServers: [] })
  first.socket.destroy()
  const { agent } = await t3()
  expect(await agent.request('session/resume', { sessionId, cwd: project, mcpServers: [] })).toMatchObject({ configOptions: [{ id: 'model' }, { id: 'effort' }] })
  await agent.request('session/resume', { sessionId: unprompted, cwd: project, mcpServers: [] })
  agent.request('session/prompt', { sessionId: unprompted, prompt: [{ type: 'text', text: 'hi' }] }).catch(() => {})
  await until(() => lines('launched').length === 2)
  expect(lines('cwd')).toEqual([project, project])
  expect(registered()[unprompted]).toMatchObject({ name: 'project', cwd: project })
  expect(agent.request('session/prompt', { sessionId: 'nope', prompt: [{ type: 'text', text: 'hi' }] })).rejects.toThrow('Resource not found')
})

test('hex acp keeps T3 connected through a hub restart, and the turn T3 waits on carries on without repeating what T3 has', async () => {
  const { agent, updates, proxy } = await t3OverAcp()
  const { sessionId } = await agent.request('session/new', { cwd: project, mcpServers: [] })
  const answer = agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] })
  await until(() => lines('launched').length)
  const hex = await session(sessionId)
  await hex.busy()
  hex.write({ ...prompt, timestamp: now() }, { type: 'assistant', timestamp: now(), message: { id: 'm1', content: [{ type: 'text', text: 'one' }] } })
  await until(() => texts(updates).length)
  const pid = Number(Bun.spawnSync(['sh', '-c', 'sleep 60 >/dev/null 2>&1 & echo $!']).stdout.toString())
  writeFileSync(join(dir, 'agents'), JSON.stringify([{ id: 'job12345', sessionId: SESSION, pid, status: 'busy' }]))
  await restart()
  const back = await session(sessionId)
  back.write({ type: 'assistant', timestamp: now(), message: { id: 'm2', content: [{ type: 'text', text: 'two' }] } }, done)
  writeFileSync(join(dir, 'agents'), JSON.stringify([{ id: 'job12345', sessionId: SESSION, pid, status: 'idle' }]))
  await back.idle()
  expect(await answer).toEqual({ stopReason: 'end_turn' })
  expect(texts(updates)).toEqual(['one', 'two'])
  expect(back.inbound).toEqual([])
  expect(lines('launched')).toHaveLength(1)
  expect(proxy.exitCode).toBeNull()
})

test('a turn rejoined after a hub restart follows the session running for its thread, not the one it saved before', async () => {
  const { agent, updates } = await t3OverAcp()
  const { sessionId } = await agent.request('session/new', { cwd: project, mcpServers: [] })
  const answer = agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] })
  await until(() => lines('launched').length)
  const hex = await session(sessionId)
  await hex.busy()
  hex.write({ ...prompt, timestamp: now() }, { type: 'assistant', timestamp: now(), message: { id: 'm1', content: [{ type: 'text', text: 'one' }] } })
  await until(() => texts(updates).length)
  const pid = Number(Bun.spawnSync(['sh', '-c', 'sleep 60 >/dev/null 2>&1 & echo $!']).stdout.toString())
  writeFileSync(join(dir, 'agents'), JSON.stringify([{ id: 'job12345', sessionId: SESSION, pid, status: 'busy' }]))
  await restart(() => hexdb(join(dir, 'hex', 'state')).keepThreads('t3', { [sessionId]: { ...registered()[sessionId], session: 'f0e1d2c3-0000-4000-8000-000000000000' } }))
  const back = await session(sessionId)
  back.write({ type: 'assistant', timestamp: now(), message: { id: 'm2', content: [{ type: 'text', text: 'two' }] } }, done)
  writeFileSync(join(dir, 'agents'), JSON.stringify([{ id: 'job12345', sessionId: SESSION, pid, status: 'idle' }]))
  await back.idle()
  expect(await answer).toEqual({ stopReason: 'end_turn' })
  expect(texts(updates)).toEqual(['one', 'two'])
  expect(back.inbound).toEqual([])
})

test('what T3 picked for a thread it hasn\'t prompted yet still holds after a hub restart', async () => {
  const { agent } = await t3OverAcp()
  const { sessionId } = await agent.request('session/new', { cwd: project, mcpServers: [] })
  await agent.request('session/set_config_option', { sessionId, configId: 'effort', value: 'xhigh' })
  await restart()
  agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] }).catch(() => {})
  await until(() => lines('launched').length)
  const launched = JSON.parse(lines('launched')[0]!)
  expect(launched[launched.indexOf('--effort') + 1]).toBe('xhigh')
})

test('a prompt a hub restart lost before its session took it reaches the session once hex is back', async () => {
  const { agent } = await t3OverAcp()
  const { sessionId } = await agent.request('session/new', { cwd: project, mcpServers: [] })
  const answer = agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] })
  await until(() => lines('launched').length)
  await restart()
  await until(() => lines('launched').length === 2)
  const hex = await session(sessionId)
  await until(() => hex.inbound.length)
  await hex.busy()
  hex.write({ ...prompt, timestamp: now() }, { ...reply, timestamp: now() }, done)
  await hex.idle()
  expect(await answer).toEqual({ stopReason: 'end_turn' })
  expect(hex.inbound.map(message => message.content)).toEqual(['hi'])
  expect(new Database(join(dir, 'hex', 'state', 'hex.db')).query('select author, count(*) as n from messages group by author order by author').all()).toEqual([{ author: 'hex', n: 1 }, { author: 'owner', n: 1 }])
})

test('a prompt the old hub never read before a restart reaches the session once hex is back', async () => {
  const { agent } = await t3OverAcp()
  const { sessionId } = await agent.request('session/new', { cwd: project, mcpServers: [] })
  bot.kill('SIGSTOP')
  const answer = agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] })
  bot.kill('SIGKILL')
  await restart()
  await until(() => lines('launched').length)
  const hex = await session(sessionId)
  await until(() => hex.inbound.length)
  await hex.busy()
  hex.write({ ...prompt, timestamp: now() }, { ...reply, timestamp: now() }, done)
  await hex.idle()
  expect(await answer).toEqual({ stopReason: 'end_turn' })
  expect(hex.inbound.map(message => message.content)).toEqual(['hi'])
})

test('a thread\'s history loads the same each time, so hex acp can tell what T3 already has when a hub restart cuts a load short', async () => {
  const { agent, updates } = await t3()
  const { sessionId } = await kept(agent)
  const load = async () => {
    updates.splice(0)
    await agent.request('session/load', { sessionId, cwd: project, mcpServers: [] })
    return updates.filter(update => update.sessionUpdate.endsWith('_message_chunk'))
  }
  const loaded = await load()
  expect(loaded.map(update => update.sessionUpdate)).toEqual(['user_message_chunk', 'agent_message_chunk'])
  expect(await load()).toEqual(loaded)
})

// Claude's daemon lists the session as working, as it does through a turn.
function working() {
  const agents = JSON.parse(readFileSync(join(dir, 'agents'), 'utf8'))
  writeFileSync(join(dir, 'agents'), JSON.stringify(agents.map((agent: object) => ({ ...agent, status: 'busy' }))))
}

test('a Stop interrupts the turn the way Esc does: the prompt answers as cancelled, the session keeps running, and the next prompt reaches it', async () => {
  const { agent } = await t3()
  const { sessionId, hex } = await kept(agent)
  working()
  const answer = agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'run for a while' }] })
  await until(() => hex.inbound.length === 2)
  await hex.busy()
  await agent.notify('session/cancel', { sessionId })
  expect(await answer).toEqual({ stopReason: 'cancelled' })
  expect(hex.read()).toContain('[Request interrupted by user')
  void agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'what did you find?' }] })
  await until(() => hex.inbound.length === 3)
  expect(hex.inbound[2]).toMatchObject({ type: 'inbound', content: 'what did you find?' })
  expect(lines('launched')).toHaveLength(1)
  expect(lines('calls').filter(line => line.startsWith('["stop"'))).toEqual([])
})

test('a Stop that comes before the session reports its turn interrupts the turn once it does', async () => {
  const { agent } = await t3()
  const { sessionId, hex } = await kept(agent)
  working()
  const answer = agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'run for a while' }] })
  await until(() => hex.inbound.length === 2)
  await agent.notify('session/cancel', { sessionId })
  expect(hex.read()).not.toContain('[Request interrupted by user')
  await hex.busy()
  expect(await answer).toEqual({ stopReason: 'cancelled' })
  expect(hex.read()).toContain('[Request interrupted by user')
  expect(lines('calls').filter(line => line.startsWith('["stop"'))).toEqual([])
})

// T3's own records while it restarts a turn of this session to steer it.
function steering(sessionId: string) {
  const userdata = join(dir, '.t3', 'userdata')
  mkdirSync(userdata, { recursive: true })
  const db = new Database(join(userdata, 'statev2.sqlite'))
  db.run('create table orchestration_v2_projection_runs (status text, payload_json text)')
  db.run('create table orchestration_v2_projection_run_attempts (attempt_id text, provider_thread_id text, payload_json text)')
  db.run('create table orchestration_v2_projection_provider_threads (provider_thread_id text, payload_json text)')
  db.run("insert into orchestration_v2_projection_runs values ('starting', ?)", [JSON.stringify({ activeAttemptId: 'attempt:2' })])
  db.run("insert into orchestration_v2_projection_run_attempts values ('attempt:2', 'provider-thread:1', ?)", [JSON.stringify({ reason: 'steering_restart' })])
  db.run("insert into orchestration_v2_projection_provider_threads values ('provider-thread:1', ?)", [JSON.stringify({ nativeThreadRef: { nativeId: sessionId } })])
  db.close()
}

test('a steer leaves the session running, its message reaches the session mid-turn, and its turn ends with the session\'s', async () => {
  const { agent, updates } = await t3()
  const { sessionId, hex } = await kept(agent)
  const first = agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'run for a while' }] })
  await until(() => hex.inbound.length === 2)
  await hex.busy()
  hex.write({ ...prompt, timestamp: now() })
  steering(sessionId)
  await agent.notify('session/cancel', { sessionId })
  expect(await first).toEqual({ stopReason: 'cancelled' })
  const steered = agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'and check the tests' }] })
  await until(() => hex.inbound.length === 3)
  expect(hex.inbound[2]).toMatchObject({ type: 'inbound', content: 'and check the tests' })
  hex.write(
    { type: 'attachment', timestamp: now(), attachment: { type: 'queued_command', origin: { kind: 'channel' }, prompt: '<channel source="t3">and check the tests</channel>' } },
    { type: 'assistant', timestamp: now(), message: { id: 'm2', content: [{ type: 'text', text: 'tests pass' }] } },
    { ...done, timestamp: now() },
  )
  await hex.idle()
  expect(await steered).toEqual({ stopReason: 'end_turn' })
  expect(texts(updates)).toContain('tests pass')
  expect(lines('calls').filter(line => line.startsWith('["stop"'))).toEqual([])
})

test('a chat with no project works in hex\'s folder', async () => {
  const { agent } = await t3()
  for (const cwd of [dir, join(dir, '.t3', 'scratch', 'chat'), project]) {
    const { sessionId } = await agent.request('session/new', { cwd, mcpServers: [] })
    agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] }).catch(() => {})
  }
  await until(() => lines('cwd').length === 3)
  expect(lines('cwd').sort()).toEqual([join(dir, 'hex'), join(dir, 'hex'), project])
})

test('a session that fails to start fails the prompt with its reason', async () => {
  writeFileSync(join(dir, 'broken'), '')
  const { agent } = await t3()
  const { sessionId } = await agent.request('session/new', { cwd: project, mcpServers: [] })
  expect(agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] })).rejects.toThrow('Workspace not trusted.')
})

test('images and files reach the session as paths it can read', async () => {
  const { agent } = await t3()
  const { sessionId } = await agent.request('session/new', { cwd: project, mcpServers: [] })
  const hex = await session(sessionId)
  agent.request('session/prompt', {
    sessionId,
    prompt: [
      { type: 'text', text: 'look' },
      { type: 'image', data: Buffer.from('png bytes').toString('base64'), mimeType: 'image/png' },
      { type: 'resource_link', name: 'notes.md', uri: 'file:///work/notes.md' },
      { type: 'resource', resource: { uri: 'file:///work/a.ts', text: 'export {}' } },
    ],
  }).catch(() => {})
  await until(() => hex.inbound.length)
  const [text, image, link, file] = hex.inbound[0].content.split('\n\n')
  expect(text).toBe('look')
  const saved = image.match(/^\[image: (.+\.png)\]$/)[1]
  expect(readFileSync(saved, 'utf8')).toBe('png bytes')
  expect(link).toBe('[notes.md](/work/notes.md)')
  expect(file).toBe('<file path="/work/a.ts">\nexport {}\n</file>')
})

// T3 Code's own server and CLI, as hex reaches them: a token from `t3 auth session issue`, a
// websocket ticket for it, and Effect RPC requests over /ws, each answered with what T3 would.
function t3Server() {
  const userdata = join(dir, '.t3', 'userdata')
  mkdirSync(join(dir, '.t3', 'bin'), { recursive: true })
  mkdirSync(userdata, { recursive: true })
  writeFileSync(join(dir, '.t3', 'bin', 't3'), `#!/bin/sh\necho "$@" >> "${dir}/t3-cli"\n[ "$3" = issue ] && echo "{\\"sessionId\\":\\"s$(grep -c '^auth session issue' "${dir}/t3-cli")\\",\\"token\\":\\"tok\\"}"\nexit 0\n`)
  chmodSync(join(dir, '.t3', 'bin', 't3'), 0o755)
  writeFileSync(join(userdata, 'environment-id'), 'env-1\n')
  const db = new Database(join(userdata, 'statev2.sqlite'))
  db.run('create table projection_projects (project_id text, workspace_root text, created_at text, deleted_at text)')
  db.run("insert into projection_projects values ('project-1', ?, '2026-10-06', null)", [project])
  db.close()
  const requests: { tag: string; payload: any }[] = []
  const listener = Bun.serve({
    port: 0,
    fetch: (request, server) => {
      const url = new URL(request.url)
      if (url.pathname === '/api/auth/websocket-ticket') return request.headers.get('authorization') === 'Bearer tok' ? Response.json({ ticket: 'tick' }) : new Response(null, { status: 401 })
      if (url.pathname === '/ws' && url.searchParams.get('wsTicket') === 'tick' && server.upgrade(request)) return
      return new Response(null, { status: 404 })
    },
    websocket: {
      message: (ws, data) => {
        const { id, tag, payload } = JSON.parse(String(data))
        requests.push({ tag, payload })
        const value = tag === 'server.importAcpRegistrySession' ? { threadId: `thread:imported:${payload.sessionId}`, imported: true } : { sequence: requests.length }
        ws.send(JSON.stringify([{ _tag: 'Exit', requestId: id, exit: { _tag: 'Success', value } }]))
      },
    },
  })
  writeFileSync(join(userdata, 'server-runtime.json'), JSON.stringify({ origin: `http://127.0.0.1:${listener.port}` }))
  return { requests, stop: () => listener.stop(true) }
}

// A T3 thread whose session has said something, mirrored back into T3 with these turns as its history.
async function mirrored(turns: [string, string][]) {
  const server = t3Server()
  const { agent } = await t3()
  const { sessionId: source } = await agent.request('session/new', { cwd: project, mcpServers: [] })
  const first = agent.request('session/prompt', { sessionId: source, prompt: [{ type: 'text', text: 'hi' }] })
  await until(() => lines('launched').length)
  const saved = join(dir, 'config', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(saved, { recursive: true })
  writeFileSync(join(saved, `${SESSION}.jsonl`), '')
  const hex = await session(source)
  await until(() => JSON.stringify(registered()).includes(SESSION))
  await hex.busy()
  hex.write(prompt, reply, done)
  await hex.idle()
  await first
  const db = new Database(join(dir, 'hex', 'state', 'hex.db'))
  db.query('delete from messages where "to" = ?').run(source)
  for (const [i, [author, body]] of turns.entries())
    db.query(`insert into messages (key, "to", "from", author, body, at, taken_by, taken_at) values (?, ?, 'telegram', ?, ?, ?, ?, ?)`).run(`telegram:${i}`, source, author, body, `2026-10-06T10:0${i}:00.000Z`, SESSION, `2026-10-06T10:0${i}:00.000Z`)
  const sock = await open(join(dir, 'state', 'hub.sock'))
  sock.write(JSON.stringify({ type: 'mirror', thread: source, to: 't3' }) + '\n')
  await until(() => server.requests.some(request => request.tag === 'orchestration.dispatchCommand'))
  return { server, agent, thread: server.requests[0]!.payload.sessionId as string }
}

test('a thread mirrored into T3 is imported as a hex session in its project, with its chat sent in as turns its replies answer', async () => {
  const { server, agent, thread } = await mirrored([
    ['hex', 'Anchors are in.'],
    ['owner', 'how full is your context?'],
    ['hex', 'Roomy.'],
    ['hex', 'Still roomy.'],
    ['owner', 'thanks'],
  ])
  await until(() => server.requests.filter(request => request.tag === 'orchestration.dispatchCommand').length === 3)
  const [imported, ...sent] = server.requests
  expect(imported).toEqual({ tag: 'server.importAcpRegistrySession', payload: { instanceId: 'hex', projectId: 'project-1', sessionId: thread, title: 'project' } })
  expect(sent.map(({ payload }) => [payload.threadId, payload.text, payload.createdBy, payload.dispatchMode.type])).toEqual([
    [`thread:imported:${thread}`, '(hex started this thread)', 'user', 'queue_after_active'],
    [`thread:imported:${thread}`, 'how full is your context?', 'user', 'queue_after_active'],
    [`thread:imported:${thread}`, 'thanks', 'user', 'queue_after_active'],
  ])
  // Each token is revoked once its call is done, which hex doesn't wait for.
  const cli = await until(() => lines('t3-cli').filter(line => line.startsWith('auth session revoke')).length === 2 && lines('t3-cli'))
  const issued = cli.flatMap((line, at) => (line.startsWith('auth session issue') ? [at] : []))
  expect(issued).toHaveLength(2)
  issued.forEach((at, n) => expect(cli.indexOf(`auth session revoke s${n + 1}`)).toBeGreaterThan(at))
  expect((await agent.request('session/list', { cwd: project })).sessions).toEqual([{ sessionId: thread, cwd: project, title: 'project' }])

  const { agent: importer, updates } = await t3()
  await importer.request('session/load', { sessionId: thread, cwd: project, mcpServers: [] })
  const turn = async (text: string) => {
    updates.splice(0)
    expect(await importer.request('session/prompt', { sessionId: thread, prompt: [{ type: 'text', text }, { type: 'text', text: '<runtime_info>In T3 Code.</runtime_info>' }] })).toEqual({ stopReason: 'end_turn' })
    return updates.flatMap(update => (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : []))
  }
  expect(await turn('<t3_code_instructions>\nBe brief.\n</t3_code_instructions>\n\n<user_request>\n(hex started this thread)\n</user_request>')).toEqual(['Anchors are in.'])
  expect(await turn('how full is your context?')).toEqual(['Roomy.', 'Still roomy.'])
  expect(await turn('thanks')).toEqual([])
  expect(lines('launched')).toHaveLength(1)
  importer.request('session/prompt', { sessionId: thread, prompt: [{ type: 'text', text: 'and now?' }] }).catch(() => {})
  await until(() => lines('launched').length === 2)
  const forked = JSON.parse(lines('launched')[1]!)
  expect(forked.slice(forked.indexOf('--resume'), forked.indexOf('--resume') + 3)).toEqual(['--resume', SESSION, '--fork-session'])
  server.stop()
})

test('a T3 prompt that isn\'t the next message of a backfill drops what is left of it and reaches the session', async () => {
  const { server, thread } = await mirrored([['owner', 'anchors?'], ['hex', 'In.']])
  const { agent: importer, updates } = await t3()
  await importer.request('session/load', { sessionId: thread, cwd: project, mcpServers: [] })
  updates.splice(0)
  importer.request('session/prompt', { sessionId: thread, prompt: [{ type: 'text', text: 'something else' }] }).catch(() => {})
  await until(() => lines('launched').length === 2)
  importer.request('session/prompt', { sessionId: thread, prompt: [{ type: 'text', text: 'anchors?' }] }).catch(() => {})
  await Bun.sleep(200)
  expect(updates.some(update => update.sessionUpdate === 'agent_message_chunk')).toBe(false)
  server.stop()
})
