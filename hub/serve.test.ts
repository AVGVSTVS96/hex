import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listen } from './hub.ts'
import { until } from './until.ts'

// A hub a stop left running, finishing a call, as KillMode=process left one: it holds the port
// until it exits.
const OLD = `const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: () => new Response('old hub') })
console.log(listener.port)
setInterval(() => {}, 1000)`

let dir: string
let old: ReturnType<typeof Bun.spawn> | undefined
let hub: ReturnType<typeof Bun.spawn> | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'serve-'))
})

afterEach(async () => {
  for (const child of [hub, old]) child?.kill('SIGKILL')
  await Promise.all([hub?.exited, old?.exited])
  hub = old = undefined
  rmSync(dir, { recursive: true, force: true })
})

async function oldHub() {
  old = Bun.spawn(['bun', '-e', OLD], { stdout: 'pipe' })
  const { value } = await (old.stdout as ReadableStream<Uint8Array>).getReader().read()
  return Number(new TextDecoder().decode(value))
}

test("a hub that finds the port held waits for it instead of exiting, which bin/hex would count as a failed start, and a stop ends it while it waits", async () => {
  const port = await oldHub()
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HEX_') && !name.endsWith('_TOKEN')))
  const states = Object.fromEntries(['TELEGRAM', 'DISCORD', 'BUZZ', 'T3', 'VOICE'].map(app => [`${app}_STATE_DIR`, join(dir, app)]))
  const waiting = (hub = Bun.spawn(['bun', join(import.meta.dir, 'serve.ts')], { env: { ...env, ...states, HEX_DIR: dir, HEX_PORT: String(port) }, stdout: 'ignore', stderr: 'pipe' }))
  let said = ''
  void (async () => {
    for await (const chunk of waiting.stderr) said += new TextDecoder().decode(chunk)
  })()
  await until(() => said.includes(`port ${port} is in use`) || waiting.exitCode !== null, 15_000)
  await Bun.sleep(1500)
  expect(waiting.exitCode).toBeNull()
  waiting.kill('SIGTERM')
  expect(await waiting.exited).toBe(0)
}, 20_000)

test('the next hub listens once the one holding the port exits', async () => {
  const port = await oldHub()
  let server: ReturnType<typeof Bun.serve> | undefined
  const listening = listen(port).then(listener => (server = listener))
  await Bun.sleep(1500)
  expect(server).toBeUndefined()
  old!.kill('SIGTERM')
  await listening
  try {
    const response = await fetch(`http://127.0.0.1:${port}/nowhere`)
    expect(await response.text()).toBe('Not Found')
  } finally {
    server!.stop(true)
  }
}, 15_000)
