import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { manual } from './clock.ts'
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
  ],
}
const TOKEN = 'secret'
type Answer = { result: { content: { text: string }[]; isError?: true } }

// A channel whose reply tool answers when the test says, counting how often it ran. A call made with
// gaveUp is one the session stops waiting on, as Claude Code does at its timeout.
function channel(fails = false) {
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
  })
  function call(args: object, gaveUp?: AbortController, name = 'reply'): Promise<Answer> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
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
  return { ran: () => ran, call, answer, answerNow, reached, rested: serve.rested, serve }
}

const text = (answer: Answer) => answer.result.content[0]!.text

test('a call made again after the session gave up on it runs once, and the repeat hears how it went', async () => {
  const { ran, call, answer, reached } = channel()
  const gaveUp = new AbortController()
  const first = call({ text: 'report', format: 'markdown' }, gaveUp)
  await reached()
  gaveUp.abort()
  const again = call({ format: 'markdown', text: 'report' })
  await answer()
  await first
  expect((await again).result).toEqual({ content: [{ type: 'text', text: 'this same reply call came before and its answer never reached you, so it ran once: sent (id: 5389)' }] })
  expect(ran()).toBe(1)
  const third = call({ text: 'report', format: 'markdown' })
  await answer()
  expect(text(await third)).toBe('sent (id: 5389)')
  expect(ran()).toBe(2)
})

test('a call the session gave up on before the hub read it never runs, so its repeat runs once', async () => {
  const { ran, call, answer, reached } = channel()
  const gaveUp = new AbortController()
  gaveUp.abort()
  expect((await call({ text: 'report' }, gaveUp)).result).toEqual({ content: [{ type: 'text', text: "reply didn't run: you stopped waiting before the hub read it" }], isError: true })
  const again = call({ text: 'report' })
  await answer()
  expect(text(await again)).toBe('sent (id: 5389)')
  expect(ran()).toBe(1)
})

test('a tool that only reads runs every time', async () => {
  const { ran, call, answer, reached } = channel()
  const gaveUp = new AbortController()
  const first = call({ chat: '1' }, gaveUp, 'fetch_messages')
  await reached()
  gaveUp.abort()
  const again = call({ chat: '1' }, undefined, 'fetch_messages')
  await answer()
  await Promise.all([first, again])
  expect(ran()).toBe(2)
})

test("a missed answer still answers its repeat after the thread's turn ends, while a heard slow one goes", async () => {
  const time = manual(async () => {})
  try {
    const { ran, call, answer, reached, rested } = channel()
    const gaveUp = new AbortController()
    const missed = call({ text: 'report' }, gaveUp)
    await reached()
    gaveUp.abort()
    await answer()
    await missed
    const slow = call({ text: 'slow report' })
    await reached()
    await time.advance(2 * 60_000)
    await answer()
    await slow
    rested('-100:7')
    expect(text(await call({ text: 'report' }))).toStartWith('this same reply call came before')
    const again = call({ text: 'slow report' })
    await answer()
    expect(text(await again)).toBe('sent (id: 5389)')
    expect(ran()).toBe(3)
  } finally {
    time.restore()
  }
})

test('a missed answer in a thread whose turns the hub never sees is let go a quarter of an hour after it came', async () => {
  const time = manual(async () => {})
  try {
    const { ran, call, answer, reached } = channel()
    const miss = async () => {
      const gaveUp = new AbortController()
      const first = call({ text: 'report' }, gaveUp)
      await reached()
      gaveUp.abort()
      await answer()
      await first
    }
    await miss()
    await time.advance(15 * 60_000)
    expect(text(await call({ text: 'report' }))).toStartWith('this same reply call came before')
    await miss()
    await time.advance(15 * 60_000 + 1)
    const later = call({ text: 'report' })
    await answer()
    expect(text(await later)).toBe('sent (id: 5389)')
    expect(ran()).toBe(3)
  } finally {
    time.restore()
  }
})

test('the same call made again after its answer was heard runs again', async () => {
  const { ran, call, answer, reached } = channel()
  for (let i = 0; i < 2; i++) {
    const each = call({ text: 'report' })
    await answer()
    expect(text(await each)).toBe('sent (id: 5389)')
  }
  expect(ran()).toBe(2)
})

test('a repeat of a missed call that failed hears the failure instead of acting again, and the call after runs', async () => {
  const failing = channel(true)
  const gaveUp = new AbortController()
  const first = failing.call({ text: 'report' }, gaveUp)
  await failing.reached()
  gaveUp.abort()
  const joined = failing.call({ text: 'report' })
  await failing.answer()
  await first
  expect((await joined).result).toEqual({ content: [{ type: 'text', text: 'this same reply call came before and its answer never reached you, so it ran once: reply failed: Telegram said no' }], isError: true })
  expect(failing.ran()).toBe(1)
  const after = failing.call({ text: 'report' })
  await failing.answer()
  expect(text(await after)).toBe('reply failed: Telegram said no')
  expect(failing.ran()).toBe(2)
})

test('another call in the thread, a read or a reaction, leaves a missed reply protected', async () => {
  const { ran, call, answer, reached } = channel()
  const gaveUp = new AbortController()
  const first = call({ text: 'report' }, gaveUp)
  await reached()
  gaveUp.abort()
  await answer()
  await first
  const between = [call({ emoji: '👍' }), call({ chat: '1' }, undefined, 'fetch_messages')]
  await answer()
  await Promise.all(between)
  expect(text(await call({ text: 'report' }))).toStartWith('this same reply call came before')
  expect(ran()).toBe(3)
})

test('calls made side by side that both went unheard each answer their own repeat', async () => {
  const { ran, call, answer, reached } = channel()
  const gaveUp = new AbortController()
  const both = [call({ text: 'report' }, gaveUp), call({ emoji: '👍' }, gaveUp)]
  await reached(2)
  gaveUp.abort()
  await answer()
  await Promise.all(both)
  const repeats = await Promise.all([call({ emoji: '👍' }), call({ text: 'report' })])
  expect(repeats.map(text).every(each => each.startsWith('this same reply call came before'))).toBe(true)
  expect(ran()).toBe(2)
})

test('a call that took as long as the session waits counts as missed, even with no abort seen', async () => {
  const time = manual(async () => {})
  try {
    const { ran, call, answer, reached } = channel()
    const first = call({ text: 'report' })
    await reached()
    await time.advance(4 * 60_000)
    await answer()
    expect(text(await first)).toBe('sent (id: 5389)')
    expect(text(await call({ text: 'report' }))).toStartWith('this same reply call came before')
    expect(ran()).toBe(1)
  } finally {
    time.restore()
  }
})

test("a missed call still running when the thread's turn ends holds its repeat in the next", async () => {
  const { ran, call, answer, reached, rested } = channel()
  const gaveUp = new AbortController()
  const first = call({ text: 'report' }, gaveUp)
  await reached()
  gaveUp.abort()
  rested('-100:7')
  const nextTurn = call({ text: 'report' })
  await answer()
  await first
  expect(text(await nextTurn)).toStartWith('this same reply call came before')
  expect(ran()).toBe(1)
})

test('a missed call still running holds its repeats until a quarter of an hour after it started', async () => {
  const time = manual(async () => {})
  try {
    const { ran, call, answer, reached } = channel()
    const gaveUp = new AbortController()
    const first = call({ text: 'report' }, gaveUp)
    await reached()
    gaveUp.abort()
    await time.advance(15 * 60_000)
    const again = call({ text: 'report' })
    await Bun.sleep(5)
    expect(ran()).toBe(1)
    await time.advance(1)
    const stuck = call({ text: 'report' })
    await reached(2)
    expect(ran()).toBe(2)
    await answer()
    await Promise.all([first, again, stuck])
  } finally {
    time.restore()
  }
})

test('a repeat that joined a call keeps it unheard, even when the first request hears its answer', async () => {
  const { ran, call, answer, reached } = channel()
  const first = call({ text: 'report' })
  const joined = new AbortController()
  const again = call({ text: 'report' }, joined)
  await reached()
  await Bun.sleep(5)
  joined.abort()
  await answer()
  await Promise.all([first, again])
  expect(text(await call({ text: 'report' }))).toStartWith('this same reply call came before')
  expect(ran()).toBe(1)
})

test("a call whose client left while the hub was too busy to read it doesn't run", async () => {
  const { ran, serve, answer } = channel()
  const hub = Bun.serve({ port: 0, fetch: serve })
  const left = join(mkdtempSync(join(tmpdir(), 'mcp-')), 'left')
  try {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'reply', arguments: { text: 'report' } } })
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

test("an answer that came after the session's whole wait was missed, and outlasts the turn's end", async () => {
  const time = manual(async () => {})
  try {
    const { ran, call, answer, reached, rested } = channel()
    const first = call({ text: 'report' })
    await reached()
    await time.advance(5 * 60_000)
    await answer()
    await first
    rested('-100:7')
    expect(text(await call({ text: 'report' }))).toStartWith('this same reply call came before')
    expect(ran()).toBe(1)
  } finally {
    time.restore()
  }
})

test('the latest of several repeats says whether the session heard, so a later missed one keeps the call', async () => {
  const { ran, call, answer, reached } = channel()
  const gaveUp = new AbortController()
  const first = call({ text: 'report' }, gaveUp)
  await reached()
  gaveUp.abort()
  const heard = call({ text: 'report' })
  const missed = new AbortController()
  const last = call({ text: 'report' }, missed)
  await Bun.sleep(5)
  missed.abort()
  await answer()
  await Promise.all([first, heard, last])
  expect(text(await call({ text: 'report' }))).toStartWith('this same reply call came before')
  expect(ran()).toBe(1)
})

test('a call whose client left while the hub was too busy to send its answer counts as missed', async () => {
  const { ran, serve, answerNow, reached } = channel()
  const hub = Bun.serve({ port: 0, fetch: serve })
  const left = join(mkdtempSync(join(tmpdir(), 'mcp-')), 'left')
  const gave = `${left}-asked`
  try {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'reply', arguments: { text: 'report' } } })
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
    expect(text((await (await again).json()) as Answer)).toStartWith('this same reply call came before')
    expect(ran()).toBe(1)
  } finally {
    hub.stop(true)
  }
})
