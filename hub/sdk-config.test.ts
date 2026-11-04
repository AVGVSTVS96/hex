import { expect, test } from 'bun:test'
import { runtime } from './sdk-config.ts'

test('the bridge requires an explicit API key before making any request', async () => {
  await expect(runtime({ proxy: 'http://127.0.0.1:1', prefix: 'credit', env: {}, models: {} })).rejects.toThrow('explicit API key')
})

test('the proxy decides the runtime; the bridge rejects unknown answers', async () => {
  let mode = 'sdk'
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => {
    expect(request.headers.get('Authorization')).toBe('Bearer test-client-key')
    expect(new URL(request.url).searchParams.get('prefix')).toBe('credit')
    return Response.json({ runtime: mode })
  } })
  const config = { proxy: server.url.toString(), prefix: 'credit', env: { ANTHROPIC_API_KEY: 'test-client-key' }, models: {} }
  try {
    expect(await runtime(config)).toBe('sdk')
    mode = 'interactive'
    expect(await runtime(config)).toBe('interactive')
    mode = 'subscription-sdk'
    await expect(runtime(config)).rejects.toThrow('invalid runtime')
  } finally { server.stop(true) }
})

test('one switch can disable the bridge and the pilot can select one topic', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('fs')
  const { tmpdir } = await import('os')
  const { join } = await import('path')
  const { bridgeFile } = await import('./sdk-config.ts')
  const dir = mkdtempSync(join(tmpdir(), 'sdk-switch-'))
  const file = join(dir, 'bridge.json')
  const saved = process.env.HEX_AGENT_SDK
  process.env.HEX_AGENT_SDK = file
  try {
    writeFileSync(file, JSON.stringify({ enabled: true, threads: ['credits'] }))
    expect(bridgeFile('telegram', 'credits')).toBe(file)
    expect(bridgeFile('telegram', 'other')).toBeUndefined()
    expect(bridgeFile('discord', 'credits')).toBeUndefined()
    writeFileSync(file, JSON.stringify({ enabled: false }))
    expect(bridgeFile('telegram', 'credits')).toBeUndefined()
  } finally {
    if (saved === undefined) delete process.env.HEX_AGENT_SDK
    else process.env.HEX_AGENT_SDK = saved
    rmSync(dir, { recursive: true })
  }
})
