import { expect, test } from 'bun:test'
import { manual } from './clock.ts'
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

const SERVER = { title: 'Telegram', instructions: '', tools: [{ name: 'fetch_messages', description: 'Read.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }
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
  // Answers every call underway, once each has reached the tool.
  async function answer() {
    await Bun.sleep(1)
    for (const resolve of waiting.splice(0)) resolve()
  }
  return { ran: () => ran, call, answer }
}

const text = (answer: Answer) => answer.result.content[0]!.text

test('a call made again after the session gave up on it runs once, and the repeat hears how it went', async () => {
  const { ran, call, answer } = channel()
  const gaveUp = new AbortController()
  const first = call({ text: 'report', format: 'markdown' }, gaveUp)
  await Bun.sleep(1)
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

test('a call the session gave up on before the hub read it counts as missed', async () => {
  const { ran, call, answer } = channel()
  const gaveUp = new AbortController()
  gaveUp.abort()
  const first = call({ text: 'report' }, gaveUp)
  await answer()
  await first
  const again = call({ text: 'report' })
  expect(text(await again)).toStartWith('this same reply call came before')
  expect(ran()).toBe(1)
})

test('a tool that only reads runs every time', async () => {
  const { ran, call, answer } = channel()
  const gaveUp = new AbortController()
  const first = call({ chat: '1' }, gaveUp, 'fetch_messages')
  await Bun.sleep(1)
  gaveUp.abort()
  const again = call({ chat: '1' }, undefined, 'fetch_messages')
  await answer()
  await Promise.all([first, again])
  expect(ran()).toBe(2)
})

test("an answer the session missed answers its repeat for ten minutes", async () => {
  const time = manual(async () => {})
  try {
    const { ran, call, answer } = channel()
    const gaveUp = new AbortController()
    const first = call({ text: 'report' }, gaveUp)
    await Bun.sleep(1)
    gaveUp.abort()
    await answer()
    await first
    await time.advance(10 * 60_000)
    const missedAgain = new AbortController()
    const again = call({ text: 'report' }, missedAgain)
    missedAgain.abort()
    expect(text(await again)).toStartWith('this same reply call came before')
    expect(ran()).toBe(1)
    await time.advance(1)
    const later = call({ text: 'report' })
    await answer()
    expect(text(await later)).toBe('sent (id: 5389)')
    expect(ran()).toBe(2)
  } finally {
    time.restore()
  }
})

test('the same call made again after its answer was heard runs again, as does one the session gave up on that failed', async () => {
  const heard = channel()
  for (let i = 0; i < 2; i++) {
    const each = heard.call({ text: 'report' })
    await heard.answer()
    expect(text(await each)).toBe('sent (id: 5389)')
  }
  expect(heard.ran()).toBe(2)

  const failing = channel(true)
  const gaveUp = new AbortController()
  const first = failing.call({ text: 'report' }, gaveUp)
  await Bun.sleep(1)
  gaveUp.abort()
  await failing.answer()
  expect((await first).result.isError).toBe(true)
  const again = failing.call({ text: 'report' })
  await failing.answer()
  expect(text(await again)).toBe('reply failed: Telegram said no')
  expect(failing.ran()).toBe(2)
})

test('a repeat that joined a run that then failed tries again itself', async () => {
  const failing = channel(true)
  const gaveUp = new AbortController()
  const first = failing.call({ text: 'report' }, gaveUp)
  await Bun.sleep(1)
  gaveUp.abort()
  const again = failing.call({ text: 'report' })
  await failing.answer()
  await first
  await failing.answer()
  expect(text(await again)).toBe('reply failed: Telegram said no')
  expect(failing.ran()).toBe(2)
})

test('a run that never answers stops holding its repeats ten minutes after it started', async () => {
  const time = manual(async () => {})
  try {
    const { ran, call, answer } = channel()
    const gaveUp = new AbortController()
    void call({ text: 'report' }, gaveUp)
    await Bun.sleep(1)
    gaveUp.abort()
    await time.advance(10 * 60_000 + 1)
    const later = call({ text: 'report' })
    await Bun.sleep(1)
    expect(ran()).toBe(2)
    await answer()
    expect(text(await later)).toBe('sent (id: 5389)')
  } finally {
    time.restore()
  }
})
