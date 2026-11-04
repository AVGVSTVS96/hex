import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { open } from './store.ts'
import { until } from './until.ts'
import { endpoint, local } from './mcp.ts'

test("a message's time reaches the session on the owner's clock, with its offset", () => {
  expect(local({ chat_id: '1', ts: '2026-10-20T06:31:05.123Z' }, 'America/Los_Angeles')).toEqual({ chat_id: '1', ts: '2026-10-19T23:31:05-07:00' })
  expect(local({ ts: '2026-01-15T20:00:00Z' }, 'America/Los_Angeles').ts).toBe('2026-01-15T12:00:00-08:00')
})

test('meta without a time or a zone it can read passes through as it is', () => {
  expect(local({ chat_id: '1' }, 'UTC')).toEqual({ chat_id: '1' })
  expect(local({ ts: 'soon' }, 'UTC')).toEqual({ ts: 'soon' })
  expect(local({ ts: '2026-10-20T06:31:05Z' }, 'Bogus/Zone')).toEqual({ ts: '2026-10-20T06:31:05Z' })
})

const SERVER = { title: 'Telegram', instructions: '', tools: [
    { name: 'fetch_messages', description: 'Read.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'canvas', description: 'Read or write.', inputSchema: { type: 'object' }, reads: (args: Record<string, unknown>) => args.text === undefined },
    { name: 'reply', description: 'Send.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  ],
}
const TOKEN = 'secret'
type Answer = { result: { content: { text: string }[]; isError?: true } }

// A channel whose reply tool answers when the test says, counting how often it ran. A call made with
// gaveUp is one the session stops waiting on, as Claude Code does at its timeout.
function channel(fails = false, store = open(mkdtempSync(join(tmpdir(), 'operations-')))) {
  let ran = 0
  const waiting: (() => void)[] = []
  const serve = endpoint('telegram', 'chat', TOKEN, SERVER, {
    call: async () => {
      ran++
      await new Promise<void>(resolve => waiting.push(resolve))
      if (fails) throw new Error('Telegram said no')
      return 'sent (id: 5389)'
    },
    permission: () => {},
    open: () => {},
    close: () => {},
  }, store)
  function call(args: object, gaveUp?: AbortController, name = 'reply'): Promise<Answer> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { operation_id: 'report', ...args } } })
    const headers = { authorization: `Bearer ${TOKEN}`, 'x-hex-channel': 'chat', 'x-hex-thread': '-100:7' }
    return serve(new Request('http://127.0.0.1/telegram', { method: 'POST', headers, body, signal: gaveUp?.signal })).then(response => response.json() as Promise<Answer>)
  }
  // Resolves once n calls are waiting in the tool.
  const reached = (n = 1) => until(() => waiting.length >= n)
  // Answers every call underway, once at least one has reached the tool.
  async function answer() {
    await reached()
    await Bun.sleep(5)
    for (const resolve of waiting.splice(0)) resolve()
  }
  // Answers every call waiting in the tool right away, without letting anything else run first.
  const answerNow = () => waiting.splice(0).forEach(resolve => resolve())
  return { ran: () => ran, call, answer, answerNow, reached, store, serve }
}

const text = (answer: Answer) => answer.result.content[0]!.text

test('an operation shares its running result and keeps it after an aborted request and a restart', async () => {
  const { ran, call, answer, reached, store } = channel()
  const gaveUp = new AbortController()
  const first = call({ text: 'report' }, gaveUp)
  await reached()
  gaveUp.abort()
  const again = call({ text: 'report' })
  await answer()
  expect(text(await first)).toBe('sent (id: 5389)')
  expect(text(await again)).toBe('sent (id: 5389)')
  expect(text(await call({ text: 'report' }))).toBe('sent (id: 5389)')
  expect(ran()).toBe(1)
  const restarted = channel(false, store)
  expect(text(await restarted.call({ text: 'report' }))).toBe('sent (id: 5389)')
  expect(restarted.ran()).toBe(0)
})

test('a deliberate identical send uses a new operation id, while a reused id cannot change the call', async () => {
  const { ran, call, answer } = channel()
  for (const operation_id of ['first', 'second']) {
    const sending = call({ text: 'report', operation_id })
    await answer()
    await sending
  }
  expect(ran()).toBe(2)
  expect(text(await call({ text: 'different', operation_id: 'first' }))).toContain('different call')
  expect(text(await call({ text: 'report', operation_id: '' }))).toContain('supply operation_id')
  expect(ran()).toBe(2)
})

test('an unfinished persisted operation is uncertain and is never sent again', async () => {
  const { store, call, ran } = channel()
  store.operation('chat:-100:7', 'report', JSON.stringify(['reply', { text: 'report' }]))
  expect(text(await call({ text: 'report' }))).toContain('uncertain outcome')
  expect(ran()).toBe(0)
})

test('reads run every time, while a write retains its result including a failure', async () => {
  const { call, answer, reached, ran } = channel(true)
  for (const [name, args] of [['fetch_messages', {}], ['canvas', {}], ['canvas', { text: 'plan' }]] as const) {
    const first = call(args, undefined, name)
    await reached()
    const again = call(args, undefined, name)
    await answer()
    await Promise.all([first, again])
  }
  expect(ran()).toBe(5)
  expect((await call({ text: 'plan' }, undefined, 'canvas')).result.isError).toBe(true)
})

test("a call whose client left while the hub was too busy to read it doesn't run", async () => {
  const { ran, serve, answer } = channel()
  const hub = Bun.serve({ port: 0, fetch: serve })
  const left = join(mkdtempSync(join(tmpdir(), 'mcp-')), 'left')
  try {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'reply', arguments: { text: 'report', operation_id: 'report' } } })
    const headers = { authorization: `Bearer ${TOKEN}`, 'x-hex-channel': 'chat', 'x-hex-thread': '-100:7' }
    const client = `const gaveUp = new AbortController()
      fetch(${JSON.stringify(`http://127.0.0.1:${hub.port}/telegram`)}, { method: 'POST', headers: ${JSON.stringify(headers)}, body: ${JSON.stringify(body)}, signal: gaveUp.signal }).catch(() => {})
      await Bun.sleep(300)
      gaveUp.abort()
      await Bun.sleep(100)
      require('fs').writeFileSync(${JSON.stringify(left)}, '')`
    Bun.spawn(['bun', '-e', client], { stdout: 'ignore', stderr: 'ignore' })
    for (const end = Date.now() + 20_000; !existsSync(left) && Date.now() < end; ) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    expect(existsSync(left)).toBe(true)
    await Bun.sleep(200)
    expect(ran()).toBe(0)
    const heard = fetch(`http://127.0.0.1:${hub.port}/telegram`, { method: 'POST', headers, body })
    await answer()
    expect(text((await (await heard).json()) as Answer)).toBe('sent (id: 5389)')
    expect(ran()).toBe(1)
  } finally {
    hub.stop(true)
  }
})

test('a call whose client left while the hub was too busy to send its answer counts as missed', async () => {
  const { ran, serve, answerNow, reached } = channel()
  const hub = Bun.serve({ port: 0, fetch: serve })
  const left = join(mkdtempSync(join(tmpdir(), 'mcp-')), 'left')
  const gave = `${left}-asked`
  try {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'reply', arguments: { text: 'report', operation_id: 'report' } } })
    const headers = { authorization: `Bearer ${TOKEN}`, 'x-hex-channel': 'chat', 'x-hex-thread': '-100:7' }
    const client = `const fs = require('fs')
      const gaveUp = new AbortController()
      fetch(${JSON.stringify(`http://127.0.0.1:${hub.port}/telegram`)}, { method: 'POST', headers: ${JSON.stringify(headers)}, body: ${JSON.stringify(body)}, signal: gaveUp.signal }).catch(() => {})
      while (!fs.existsSync(${JSON.stringify(gave)})) await Bun.sleep(10)
      gaveUp.abort()
      await Bun.sleep(100)
      fs.writeFileSync(${JSON.stringify(left)}, '')`
    Bun.spawn(['bun', '-e', client], { stdout: 'ignore', stderr: 'ignore' })
    await reached()
    writeFileSync(gave, '')
    for (const end = Date.now() + 20_000; !existsSync(left) && Date.now() < end; ) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    expect(existsSync(left)).toBe(true)
    answerNow()
    await Bun.sleep(200)
    const again = fetch(`http://127.0.0.1:${hub.port}/telegram`, { method: 'POST', headers, body })
    expect(text((await (await again).json()) as Answer)).toBe('sent (id: 5389)')
    expect(ran()).toBe(1)
  } finally {
    hub.stop(true)
  }
})

test('an SDK tool connection never takes the topic delivery stream', async () => {
  let opened = 0
  const serve = endpoint('telegram', 'chat', TOKEN, SERVER, {
    call: async () => 'read', permission: () => {}, open: () => { opened++ }, close: () => {},
  }, open(mkdtempSync(join(tmpdir(), 'operations-'))))
  const headers = { Authorization: `Bearer ${TOKEN}`, 'X-Hex-Channel': 'chat', 'X-Hex-Thread': 'topic', 'X-Hex-Tools-Only': '1' }
  const response = await serve(new Request('http://127.0.0.1/telegram', { headers }))
  expect(response.status).toBe(200)
  expect(opened).toBe(0)
  await response.body!.cancel()
})
