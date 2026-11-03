import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// bin/away against a fake T3 Code MCP server that records each tool call.

const HEX = join(import.meta.dir, '../..')
const home = mkdtempSync(join(tmpdir(), 'away-'))
let calls: { name: string; arguments: Record<string, any> }[] = []
let waits: object[] = []
let drop = 0

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { id?: number; method: string; params: { name: string; arguments: Record<string, any> } }
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: {} }, { headers: { 'mcp-session-id': 's1' } })
    if (body.method !== 'tools/call') return new Response(null, { status: 202 })
    calls.push(body.params)
    if (body.params.name === 't3_thread_wait' && drop-- > 0) return new Response('gone', { status: 502 })
    const answers: Record<string, () => unknown> = {
      orchestrator_capabilities: () => ({ providers: [{ providerInstanceId: 'claudeAgent', models: [{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }] }] }),
      t3_thread_launch: () => ({ threadId: 't1', link: '<t3-thread://v2/env-mac/t1>' }),
      t3_thread_wait: () => waits.shift() ?? { status: 'completed', timedOut: false },
      t3_thread_read: () => ({ items: [{ type: 'user_message', text: 'go' }, { type: 'assistant_message', text: 'Built the Usage tab.' }], hasMore: false }),
      t3_thread_interrupt: () => ({}),
    }
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(answers[body.params.name]!()) }], isError: false } })
  },
})

beforeAll(() => {
  mkdirSync(join(home, '.hex/bin'), { recursive: true })
  cpSync(join(HEX, 'bin/away'), join(home, '.hex/bin/away'))
  writeFileSync(join(home, '.hex/bin/identity'), '#!/bin/sh\necho "You are hex."\n')
  chmodSync(join(home, '.hex/bin/identity'), 0o755)
  writeFileSync(join(home, '.mcp.json'), JSON.stringify({ mcpServers: { 't3-code': { type: 'http', url: server.url.href, headersHelper: 'echo {}' } } }))
})
afterAll(() => {
  server.stop()
  rmSync(home, { recursive: true })
})

const away = (...args: string[]) => Bun.spawn(['bun', join(home, '.hex/bin/away'), 'mac', 'env-mac', 'hex/deck', ...args], { cwd: home, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, INVOCATION_ID: 'inv1' } })

test("a job runs as a T3 Code thread on that machine, waits it out through dropped calls, and prints the thread's last answer", async () => {
  calls = []
  waits = [{ status: 'running', timedOut: true }]
  drop = 1
  const run = away('-p', 'Build the Usage tab.', '--model', 'opus', '--effort', 'high')
  expect(await run.exited).toBe(0)
  expect(await new Response(run.stdout).text()).toBe('hex/deck runs on mac as T3 Code thread <t3-thread://v2/env-mac/t1>\nBuilt the Usage tab.\n')
  const launch = calls.find(({ name }) => name === 't3_thread_launch')!.arguments
  expect(launch).toMatchObject({ environmentId: 'env-mac', title: 'hex/deck', scratch: true, runtimeMode: 'full-access', clientRequestId: 'hex-job-hex/deck-inv1' })
  expect(launch.modelSelection).toEqual({ provider: 'claudeAgent', model: 'claude-opus-5-5', options: [{ id: 'effort', value: 'high' }] })
  expect(launch.message).toStartWith('You are hex.')
  expect(launch.message).toEndWith('Build the Usage tab.')
  expect(calls.filter(({ name }) => name === 't3_thread_wait')).toHaveLength(3)
}, 20_000)

test('stopping the job stops its thread', async () => {
  calls = []
  waits = Array(100).fill({ status: 'running', timedOut: true })
  const run = away('-p', 'Build it.')
  while (!calls.some(({ name }) => name === 't3_thread_wait')) await Bun.sleep(50)
  run.kill('SIGTERM')
  expect(await run.exited).toBe(143)
  expect(calls.find(({ name }) => name === 't3_thread_interrupt')!.arguments).toMatchObject({ environmentId: 'env-mac', threadId: 't1', stop: true })
})
