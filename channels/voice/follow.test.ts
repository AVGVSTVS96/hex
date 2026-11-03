import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { until } from '../../hub/until.ts'
import { open } from '../../hub/store.ts'

const CALL = 'sess_past'
const SESSION = 'aaaaaaaa-general'
const OTHER = 'bbbbbbbb-other'

// A task an ended call sent to a thread, picked back up as the engine starts: the thread already
// took the message in and ended its turn, and is still working on what came after.
async function resumed() {
  const home = mkdtempSync(join(tmpdir(), 'follow-'))
  const claude = join(home, 'claude')
  const hex = join(home, 'hex')
  const state = join(hex, 'state')
  const calls = join(home, '.claude', 'channels', 'voice', 'calls')
  const project = join(claude, 'projects', hex.replace(/[^a-zA-Z0-9]/g, '-'))
  for (const dir of [calls, project, join(claude, 'sessions'), join(state, 'telegram')]) mkdirSync(dir, { recursive: true })
  open(state).keepThreads('telegram', { '-100123': { name: 'General', session: SESSION }, '-100123:7': { name: 'Other', session: OTHER } })
  const started = new Date(Date.now() - 60 * 60_000).toISOString()
  const task = { id: 'look-into-it', state: 'running', text: 'Look into it', to: 'General', agent: 'telegram:-100123', at: 1000 }
  writeFileSync(join(calls, `${CALL}.json`), JSON.stringify({ id: CALL, started, ended: started, end: 'you', from: 'app', turns: [], tasks: [task] }))
  const entries = [
    { type: 'user', origin: { kind: 'channel' }, message: { role: 'user', content: `<channel voice_task="${CALL}:look-into-it">look into it</channel>` } },
    { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'On it.' }] } },
    { type: 'system', subtype: 'turn_duration' },
  ]
  writeFileSync(join(project, `${SESSION}.jsonl`), entries.map(entry => JSON.stringify(entry) + '\n').join(''))
  const status = (session: string, status: string) =>
    writeFileSync(join(claude, 'sessions', `${session.slice(0, 8)}.json`), JSON.stringify({ pid: process.pid, sessionId: session, status, statusUpdatedAt: Date.now() }))
  status(SESSION, 'busy')

  const engine = `import { serve } from ${JSON.stringify(join(import.meta.dir, 'server.ts'))}
const server = serve({ deliver() {}, keep: async () => {}, renew() {}, renewal: async () => {}, session: () => undefined }, ${JSON.stringify(state)})
console.log(server.port)`
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(VOICE|TWILIO|OPENAI|CALLER|HEX)_/.test(key)))
  writeFileSync(join(home, '.claude', 'channels', 'voice', '.env'), 'VOICE_PORT=0\n')
  const plugin = Bun.spawn(['bun', '-e', engine], { env: { ...env, HOME: home, CLAUDE_CONFIG_DIR: claude }, stdout: 'pipe', stderr: 'ignore' })
  await plugin.stdout.getReader().read()
  return {
    status,
    record: () => JSON.parse(readFileSync(join(calls, `${CALL}.json`), 'utf8')),
    // Another thread's turn starting or ending, which changes the board and nothing about the task.
    elsewhere: (n: number) => status(OTHER, n % 2 ? 'busy' : 'idle'),
    [Symbol.asyncDispose]: async () => {
      plugin.kill()
      await plugin.exited
      rmSync(home, { recursive: true, force: true })
    },
  }
}

test('a task picked back up after a restart is done once its thread rests, and stays done however often the board changes after', async () => {
  await using engine = await resumed()
  await Bun.sleep(300)
  expect(engine.record().tasks.map((task: any) => task.state)).toEqual(['running'])

  engine.status(SESSION, 'idle')
  await until(() => engine.record().tasks.length === 2)
  for (let n = 1; n <= 6; n++) {
    engine.elsewhere(n)
    await Bun.sleep(150)
  }
  expect(engine.record().tasks.map((task: any) => task.state)).toEqual(['running', 'done'])
}, 20_000)
