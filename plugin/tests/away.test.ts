import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// bin/away against a fake T3 Code MCP server that records each tool call.

const HEX = join(import.meta.dir, '../..')
const home = mkdtempSync(join(tmpdir(), 'away-'))
let calls: { name: string; arguments: Record<string, any> }[] = []
let waits: object[] = []
let drop = 0
let refuse: string | undefined
let running = false
let refused = 0
let asked: string[] = []
let flaky = 0
let launchDrop = 0
let launchSlow = 0

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { id?: number; method: string; params: { name: string; arguments: Record<string, any> } }
    // As MCP's Streamable HTTP asks: a new session starts without the old one's id.
    if (body.method === 'initialize' && request.headers.has('mcp-session-id')) return new Response('already initialized', { status: 400 })
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: {} }, { headers: { 'mcp-session-id': 's1' } })
    if (body.method !== 'tools/call') return new Response(null, { status: 202 })
    calls.push(body.params)
    if (body.params.name === 't3_thread_launch' && launchSlow-- > 0) await Bun.sleep(3_000)
    if (body.params.name === 't3_thread_launch' && launchDrop-- > 0) return new Response('relay timed out', { status: 504 })
    if (body.params.name === 't3_thread_wait' && drop-- > 0) return new Response('gone', { status: 502 })
    if (body.params.name === 't3_thread_wait' && refused-- > 0) return new Response('expired', { status: 401 })
    if (body.params.name === 't3_thread_wait' && flaky-- > 0) return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'mac is not answering' }], isError: true } })
    if (body.params.name === refuse) return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{"code":"capability_denied","message":"no link"}' }], isError: true } })
    const answers: Record<string, () => unknown> = {
      orchestrator_capabilities: () => ({ providers: [{ providerInstanceId: 'claudeAgent', models: [{ id: 'claude-opus-4-1' }, { id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }] }] }),
      t3_thread_launch: () => ({ threadId: 't1', runId: 'r1', link: '<t3-thread://v2/env-mac/t1>' }),
      t3_thread_wait: () => waits.shift() ?? (running ? { status: 'running', timedOut: true } : { status: 'completed', timedOut: false }),
      t3_thread_read: () => ({ thread: { pendingRequestCount: asked.length }, items: [{ type: 'user_message', text: 'go' }, { type: 'assistant_message', text: 'Built the Usage tab.' }], hasMore: false }),
      t3_thread_interrupt: () => ({}),
      t3_pending_request: () => (body.params.arguments.action === 'list' ? { requestIds: asked } : { requestId: asked[0], questions: [{ question: 'Which branch should I push to?' }] }),
    }
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(answers[body.params.name]!()) }], isError: false } })
  },
})

const script = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

beforeAll(() => {
  mkdirSync(join(home, '.hex/bin'), { recursive: true })
  mkdirSync(join(home, '.t3/userdata'), { recursive: true })
  cpSync(join(HEX, 'bin/away'), join(home, '.hex/bin/away'))
  script(join(home, '.hex/bin/identity'), 'echo "You are hex."')
  script(join(home, '.hex/bin/t3-mcp-headers'), `echo "sign-in $*\${T3_REFUSED:+ refused=\$T3_REFUSED}" >> "${home}/signed"; echo '{"Authorization":"Bearer t"}'`)
  writeFileSync(join(home, '.t3/userdata/server-runtime.json'), JSON.stringify({ port: server.port }))
})
afterAll(() => {
  server.stop()
  rmSync(home, { recursive: true })
})

const away = (args: string[], stdin = '') => {
  const run = Bun.spawn(['bun', join(home, '.hex/bin/away'), 'mac', 'env-mac', 'hex/deck', ...args], { cwd: home, stdin: Buffer.from(stdin), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, HOME: home, INVOCATION_ID: 'inv1' } })
  return { run, out: () => new Response(run.stdout).text(), error: () => new Response(run.stderr).text() }
}
const reset = () => {
  calls = []
  waits = []
  drop = 0
  refuse = undefined
  running = false
  refused = 0
  flaky = 0
  launchDrop = 0
  launchSlow = 0
  asked = []
  rmSync(join(home, 'signed'), { force: true })
}

test("a job runs as a T3 Code thread on that machine, follows its run through early and dropped waits, and prints the thread's last answer", async () => {
  reset()
  waits = [{ status: 'preparing', timedOut: false }, { status: 'running', timedOut: true }]
  drop = 1
  const { run, out } = away(['-p', 'Build the Usage tab.', '--model', 'opus', '--effort', 'high'], 'the log')
  expect(await run.exited).toBe(0)
  expect(await out()).toBe('hex/deck runs on mac as T3 Code thread <t3-thread://v2/env-mac/t1>\nBuilt the Usage tab.\n')
  const launch = calls.find(({ name }) => name === 't3_thread_launch')!.arguments
  expect(launch).toMatchObject({ environmentId: 'env-mac', title: 'hex/deck', scratch: true, runtimeMode: 'full-access', clientRequestId: 'hex-job-hex/deck-mac-inv1' })
  expect(launch.modelSelection).toEqual({ provider: 'claudeAgent', model: 'claude-opus-5-5', options: [{ id: 'effort', value: 'high' }] })
  expect(launch.message).toStartWith('You are hex.')
  expect(launch.message).toEndWith('Build the Usage tab.\n\nthe log')
  const waited = calls.filter(({ name }) => name === 't3_thread_wait')
  expect(waited).toHaveLength(4)
  expect(waited.every(({ arguments: input }) => input.runId === 'r1')).toBe(true)
}, 20_000)

test('a refused token is renewed and a tool error without a final code is retried', async () => {
  reset()
  refused = 1
  flaky = 1
  const { run } = away(['-p', 'Build it.'])
  expect(await run.exited).toBe(0)
  expect(readFileSync(join(home, 'signed'), 'utf8')).toBe('sign-in \nsign-in --refresh refused=t\n')
}, 30_000)

test('a job whose thread stops at a question ends there, with the question as its answer', async () => {
  reset()
  running = true
  asked = ['q1']
  const { run, out } = away(['-p', 'Build it.'])
  expect(await run.exited).toBe(1)
  expect(await out()).toEndWith("hex/deck stopped on mac at a question, which a job can't answer: Which branch should I push to?\n")
  expect(calls.at(-1)).toMatchObject({ name: 't3_thread_interrupt', arguments: { threadId: 't1', stop: true } })
})

test("a job can't run there, having started nothing, with claude flags a thread has no place for, or a link that's gone", async () => {
  reset()
  const flagged = away(['-p', 'Build it.', '--permission-mode', 'plan'])
  expect(await flagged.run.exited).toBe(76)
  expect(await flagged.error()).toContain('--permission-mode has no place in a T3 Code thread')
  refuse = 'orchestrator_capabilities'
  expect(await away(['-p', 'Build it.']).run.exited).toBe(76)
  expect(calls.some(({ name }) => name === 't3_thread_launch')).toBe(false)

})

test('stopping the job stops its thread', async () => {
  reset()
  running = true
  const { run } = away(['-p', 'Build it.'])
  while (!calls.some(({ name }) => name === 't3_thread_wait')) await Bun.sleep(50)
  run.kill('SIGTERM')
  expect(await run.exited).toBe(143)
  expect(calls.find(({ name }) => name === 't3_thread_interrupt')!.arguments).toMatchObject({ environmentId: 'env-mac', threadId: 't1', stop: true })
})

test("a sign-in that fails here is this machine's fault, named at once, and starts nothing", async () => {
  reset()
  const helper = join(home, '.hex/bin/t3-mcp-headers')
  const kept = readFileSync(helper, 'utf8')
  script(helper, 'echo "no pairing code" >&2; exit 1')
  const { run, error } = away(['-p', 'Build it.'])
  expect(await run.exited).toBe(77)
  expect(await error()).toContain('this machine: couldn\'t sign in: no pairing code')
  expect(calls).toHaveLength(0)
  writeFileSync(helper, kept)
})

test('a job stopped while its launch may have reached the other machine gets that thread back and stops it', async () => {
  reset()
  launchDrop = 1
  const { run, error } = away(['-p', 'Build it.'])
  while (!calls.some(({ name }) => name === 't3_thread_launch')) await Bun.sleep(50)
  await Bun.sleep(200)
  run.kill('SIGTERM')
  expect(await run.exited).toBe(143)
  expect(calls.filter(({ name }) => name === 't3_thread_launch')).toHaveLength(2)
  expect(calls.at(-1)).toMatchObject({ name: 't3_thread_interrupt', arguments: { threadId: 't1', stop: true } })
  expect(await error()).toContain('trying again')
}, 20_000)

test("a job stopped while its launch is on its way doesn't wait for the answer: it gets the thread back and stops it", async () => {
  reset()
  launchSlow = 1
  const { run } = away(['-p', 'Build it.'])
  while (!calls.some(({ name }) => name === 't3_thread_launch')) await Bun.sleep(50)
  const stopped = Date.now()
  run.kill('SIGTERM')
  expect(await run.exited).toBe(143)
  expect(Date.now() - stopped).toBeLessThan(2_500)
  expect(calls.filter(({ name }) => name === 't3_thread_launch')).toHaveLength(2)
  expect(calls.at(-1)).toMatchObject({ name: 't3_thread_interrupt', arguments: { threadId: 't1', stop: true } })
}, 20_000)

test('a launch that was tried and refused fails the job there, rather than moving it to a machine where it could run twice', async () => {
  reset()
  refuse = 't3_thread_launch'
  const refused = away(['-p', 'Build it.'])
  expect(await refused.run.exited).toBe(1)
  expect(await refused.error()).toContain("hex/deck couldn't start on mac")
})
