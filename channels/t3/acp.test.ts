import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createServer, type Server, type Socket } from 'net'
import { createInterface } from 'readline'
import { Readable } from 'stream'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Subprocess } from 'bun'
import { until } from '../../hub/until.ts'

let dir: string
let path: string
const servers: Server[] = []
const proxies: Subprocess[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 't3-acp-'))
  path = join(dir, 'acp.sock')
})

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  for (const proxy of proxies.splice(0)) proxy.kill()
  rmSync(dir, { recursive: true, force: true })
})

// A hub on acp.sock that answers each request with what `answer` writes back.
function hub(answer: (request: any, socket: Socket) => void) {
  const server = createServer(socket => createInterface({ input: socket }).on('line', line => answer(JSON.parse(line), socket)))
  servers.push(server)
  return new Promise<Server>(resolve => server.listen(path, () => resolve(server)))
}

const write = (socket: Socket, message: object) => socket.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const said = (text: string) => ({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', messageId: text, content: { type: 'text', text } } } })

test('a thread\'s history a hub restart cut short loads again without repeating what T3 has', async () => {
  const first = await hub((request, socket) => {
    if (request.method !== 'session/load') return
    write(socket, said('one'))
    write(socket, said('two'))
    setTimeout(() => {
      first.close()
      socket.destroy()
    }, 100)
  })
  const proxy = Bun.spawn(['bun', join(import.meta.dir, 'acp.ts'), path], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
  proxies.push(proxy)
  const out: any[] = []
  createInterface({ input: Readable.fromWeb(proxy.stdout as any) }).on('line', line => out.push(JSON.parse(line)))
  await Bun.sleep(100)
  proxy.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/load', params: { sessionId: 's1', cwd: dir, mcpServers: [] } })}\n`)
  proxy.stdin.flush()
  await until(() => out.length === 2)
  await new Promise(resolve => first.on('close', resolve))
  await hub((request, socket) => {
    if (request.method !== 'session/load') return write(socket, { id: request.id, result: {} })
    for (const text of ['one', 'two', 'three']) write(socket, said(text))
    write(socket, { id: request.id, result: {} })
  })
  await until(() => out.some(message => message.id === 1))
  expect(out.map(message => message.params?.update.content.text ?? message.id)).toEqual(['one', 'two', 'three', 1])
})
