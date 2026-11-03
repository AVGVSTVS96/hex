import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { open } from './store.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'origin-'))
  mkdirSync(join(dir, 'telegram'))
  const store = open(dir)
  store.keepThreads('telegram', { '-100:7': { name: 'Website' } })
  store.deliver({ key: 'telegram:-100:50', to: '-100:7', from: 'telegram', body: 'Fix the login page.', author: 'owner', meta: { user: 'bassim' } })
  store.take('telegram:-100:50', 's')
  store.deliver({ key: 'telegram:-100:51', to: '-100:7', from: 'telegram', body: 'On it.', author: 'hex' })
  store.deliver({ key: 'telegram:-100:51+👍', to: '-100:7', from: 'telegram', body: '(reaction: 👍)', author: 'owner', meta: { user: 'bassim', reaction: '👍' } })
  store.take('telegram:-100:51+👍', 's')
  store.deliver({ key: 'telegram:-100:52', to: '-100:7', from: 'telegram', body: 'Also the signup page.', author: 'owner', meta: { user: 'bassim' } })
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function hook(event: string, env: Record<string, string>) {
  const run = Bun.spawn(['bun', join(import.meta.dir, 'origin.ts')], { stdin: new Blob([JSON.stringify({ hook_event_name: event, session_id: 's' })]), stdout: 'pipe', env: { PATH: process.env.PATH!, HEX_STORE: dir, ...env } })
  expect(await run.exited).toBe(0)
  const out = await new Response(run.stdout).text()
  return out && JSON.parse(out).hookSpecificOutput
}

test("a subagent of a thread's session is told the conversation it works for and the owner's newest message its session took, past reactions", async () => {
  const told = await hook('SubagentStart', { HEX_CHANNEL: 'plugin:telegram@hex', HEX_THREAD: '-100:7' })
  expect(told.hookEventName).toBe('SubagentStart')
  expect(told.additionalContext).toContain("in Website: `")
  expect(told.additionalContext).toContain("/bin/hex log -- '-100:7'`")
  expect(told.additionalContext).toContain('/bin/hex message telegram:-100:50`')
})

test("a job's session is told where its work came from, and the thread's own session isn't told its own thread", async () => {
  const job = await hook('SessionStart', { HEX_OWNER: 'telegram:-100:7' })
  expect(job.hookEventName).toBe('SessionStart')
  expect(job.additionalContext).toContain('/bin/hex message telegram:-100:50`')
  expect(await hook('SessionStart', { HEX_CHANNEL: 'plugin:telegram@hex', HEX_THREAD: '-100:7' })).toBe('')
  expect(await hook('SubagentStart', {})).toBe('')
})
