import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { until } from '../../hub/until.ts'

const ID = 'sess_app'

// An app call against a stand-in for OpenAI's live API whose attach the test can hold back, so the
// engine's connection to the call can be dropped and kept from coming back. open: a record of a
// call still going when the engine starts, which it attaches back to. The test calls the voice
// session's tools through lines on the engine's stdin, and their answers come back on its stdout.
async function appCall({ open = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'reconnect-'))
  const voiceDir = join(home, '.claude', 'channels', 'voice')
  const state = join(home, 'hex', 'state')
  mkdirSync(join(voiceDir, 'calls'), { recursive: true })
  mkdirSync(state, { recursive: true })
  // Each session.close the stand-in got, as `<session id> <event id>`.
  const closes: string[] = []
  let voice: Bun.ServerWebSocket<unknown> | undefined
  let hold = open
  let held = false
  let made = 0
  const waiting: (() => void)[] = []
  const openai = Bun.serve({
    port: 0,
    async fetch(request, server) {
      if (request.method === 'POST') return Response.json({ session: { id: made++ ? `${ID}-${made}` : ID, expires_at: Date.now() / 1000 + 3600 }, transport: { sdp: 'answer' } }, { status: 201 })
      if (hold) {
        held = true
        await new Promise<void>(resolve => waiting.push(resolve))
        held = false
      }
      return server.upgrade(request, { data: { id: new URL(request.url).pathname.split('/').at(-2) } }) ? undefined : new Response('no', { status: 400 })
    },
    websocket: {
      open: socket => void (voice = socket),
      message(socket, raw) {
        const event = JSON.parse(String(raw))
        if (event.type === 'session.thinking.append') socket.send(JSON.stringify({ type: 'session.thinking.appended', client_event_id: event.event_id }))
        if (event.type !== 'session.close') return
        closes.push(`${(socket.data as { id: string }).id} ${event.event_id}`)
        socket.send(JSON.stringify({ type: 'session.closed', reason: 'close_requested', client_event_id: event.event_id }))
      },
    },
  })
  writeFileSync(join(voiceDir, '.env'), ['OPENAI_API_KEY=test', `OPENAI_BASE_URL=http://127.0.0.1:${openai.port}/v1`, 'VOICE_PORT=0'].join('\n'))
  if (open) writeFileSync(join(voiceDir, 'calls', `${ID}.json`), JSON.stringify({ id: ID, started: new Date().toISOString(), from: 'app', turns: [], tasks: [] }))
  const engine = `import { serve, tool } from ${JSON.stringify(join(import.meta.dir, 'server.ts'))}
const server = serve({ deliver() {}, keep: async () => {}, renew() {}, renewal: async () => {}, session: () => 'brain' }, ${JSON.stringify(state)})
console.log(JSON.stringify({ port: server.port }))
for await (const line of console) {
  const { name, args } = JSON.parse(line)
  tool(name, args).then(result => console.log(JSON.stringify({ result })), error => console.log(JSON.stringify({ error: error.message })))
}`
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(VOICE|TWILIO|OPENAI|CALLER|HEX)_/.test(key)))
  const plugin = Bun.spawn(['bun', '-e', engine], { env: { ...env, HOME: home, CLAUDE_CONFIG_DIR: join(home, 'claude') }, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
  const answers: ((line: any) => void)[] = []
  let listening!: (port: number) => void
  const port = new Promise<number>(resolve => (listening = resolve))
  void (async () => {
    let buffer = ''
    for await (const chunk of plugin.stdout) {
      buffer += new TextDecoder().decode(chunk)
      const lines = buffer.split('\n')
      buffer = lines.pop()!
      for (const line of lines.map(line => JSON.parse(line))) line.port ? listening(line.port) : answers.shift()?.(line)
    }
  })()
  const base = `http://127.0.0.1:${await port}`
  const call = () => fetch(`${base}/calls/${ID}`).then(r => r.json())
  return {
    base,
    closes,
    call,
    live: async () => (await fetch(`${base}/calls`).then(r => r.json())).live,
    tool: (name: string, args: object = {}) => {
      plugin.stdin.write(JSON.stringify({ name, args }) + '\n')
      plugin.stdin.flush()
      return new Promise<{ result?: string; error?: string }>(resolve => answers.push(resolve))
    },
    attached: () => until(() => voice),
    // The engine's connection to the call drops, and its next attach waits until the test lets it.
    drop: async () => {
      hold = true
      voice!.close()
      voice = undefined
      await until(() => held)
    },
    attaching: () => until(() => held),
    // The engine's next attach waits until the test lets it.
    hold: () => void (hold = true),
    back: () => {
      hold = false
      for (const resolve of waiting.splice(0)) resolve()
    },
    hangUp: () => fetch(`${base}/session`, { method: 'DELETE', body: JSON.stringify({ sessionId: ID }) }),
    [Symbol.asyncDispose]: async () => {
      plugin.kill()
      await plugin.exited
      openai.stop(true)
      rmSync(home, { recursive: true, force: true })
    },
  }
}

type Engine = Awaited<ReturnType<typeof appCall>>

async function started(engine: Engine) {
  expect((await fetch(`${engine.base}/session`, { method: 'POST', body: JSON.stringify({ sdp: 'offer', from: 'app' }) })).status).toBe(201)
  expect(await engine.live()).toBe(ID)
  await engine.attached()
}

async function ends(engine: Engine) {
  for (let tries = 0; !(await engine.call()).ended; tries++) {
    expect(tries).toBeLessThan(100)
    await Bun.sleep(50)
  }
  return engine.call()
}

test('hanging up while the connection to the call is coming back ends the call once it is back', async () => {
  await using engine = await appCall()
  await started(engine)
  await engine.drop()
  expect((await engine.hangUp()).status).toBe(204)
  expect(engine.closes).toEqual([])
  engine.back()
  expect(await ends(engine)).toMatchObject({ end: 'you' })
  expect(engine.closes).toEqual([`${ID} close-you-app`])
}, 20_000)

test('hanging up a new call before its connection has opened ends it once open', async () => {
  await using engine = await appCall()
  engine.hold()
  expect((await fetch(`${engine.base}/session`, { method: 'POST', body: JSON.stringify({ sdp: 'offer', from: 'app' }) })).status).toBe(201)
  await engine.attaching()
  expect((await engine.hangUp()).status).toBe(204)
  engine.back()
  expect(await ends(engine)).toMatchObject({ end: 'you' })
  expect(engine.closes).toEqual([`${ID} close-you-app`])
}, 20_000)

test('a call a new one replaces before its connection opened is still closed', async () => {
  await using engine = await appCall()
  engine.hold()
  const start = () => fetch(`${engine.base}/session`, { method: 'POST', body: JSON.stringify({ sdp: 'offer', from: 'app' }) })
  expect((await start()).status).toBe(201)
  await engine.attaching()
  expect((await start()).status).toBe(201)
  engine.back()
  await until(() => engine.closes.length)
  await Bun.sleep(200)
  expect(engine.closes).toEqual([`${ID} close-you-moved`])
  expect(await engine.call()).toMatchObject({ end: 'you', reason: 'moved to a new call' })
}, 20_000)

test('a hung-up call a new one replaces before its connection opened ends as hung up', async () => {
  await using engine = await appCall()
  engine.hold()
  const start = () => fetch(`${engine.base}/session`, { method: 'POST', body: JSON.stringify({ sdp: 'offer', from: 'app' }) })
  expect((await start()).status).toBe(201)
  await engine.attaching()
  expect((await engine.hangUp()).status).toBe(204)
  expect((await start()).status).toBe(201)
  engine.back()
  await until(() => engine.closes.length)
  await Bun.sleep(200)
  expect(engine.closes).toEqual([`${ID} close-you-app`])
  expect(await engine.call()).toMatchObject({ end: 'you', reason: 'close_requested' })
}, 20_000)

test('hanging up a call the engine is attaching back to after a restart ends it once attached, from the app or from hex', async () => {
  const ways = [
    { hangUp: (engine: Engine) => engine.hangUp(), end: 'you', close: 'close-you-app' },
    { hangUp: (engine: Engine) => engine.tool('hang_up'), end: 'hex', close: 'close_hex_' },
  ]
  for (const { hangUp, end, close } of ways) {
    await using engine = await appCall({ open: true })
    await engine.attaching()
    await hangUp(engine)
    engine.back()
    expect(await ends(engine)).toMatchObject({ end })
    await until(() => engine.closes.length)
    await Bun.sleep(200)
    expect(engine.closes).toHaveLength(1)
    expect(engine.closes[0]).toStartWith(`${ID} ${close}`)
  }
}, 30_000)
