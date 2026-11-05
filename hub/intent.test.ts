import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { asked, brief, check, type Verdict } from './intent.ts'
import { open, type Store } from './store.ts'

let dir: string
let store: Store

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'intent-'))
  mkdirSync(join(dir, 'telegram'))
  store = open(dir)
  store.keepThreads('telegram', { '-100:7': { name: 'Website' } })
  store.deliver({ key: 'telegram:-100:50', to: '-100:7', from: 'telegram', body: 'Make the login page load fast.', author: 'owner', meta: { user: 'owner' } })
  store.deliver({ key: 'telegram:-100:51', to: '-100:7', from: 'telegram', body: 'On it.', author: 'hex' })
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('a brief is what starts another agent on work', () => {
  writeFileSync(join(dir, 'prompt.md'), 'Fix the login page.')
  const job = brief({ tool_name: 'Bash', tool_input: { command: `cd ~/hex && .hex/bin/job login claude -p "$(cat ${dir}/prompt.md)"` } })
  expect(job).toContain('Fix the login page.')
  expect(brief({ tool_name: 'Bash', tool_input: { command: 'git status' } })).toBeUndefined()
  expect(brief({ tool_name: 'Agent', tool_input: { prompt: 'Read the store and tell me how tasks work.' } })).toBeUndefined()
  expect(brief({ tool_name: 'Agent', tool_input: { prompt: 'Task t-3: fix the login page.' } })).toContain('t-3')
  expect(brief({ tool_name: 'mcp__plugin_telegram_telegram__new_thread', tool_input: { prompt: 'Fix it.' } })).toContain('Fix it.')
})

test('the words a brief is checked against: its tasks and the newest of the owner', () => {
  const task = store.createTask({ title: 'Fast login', message: 'telegram:-100:50', owner: '-100:7' })
  const words = asked(store, 'telegram:-100:7', `Task ${task.id}: make login fast.`)
  expect(words).toContain(`${task.id} (open`)
  expect(words).toContain('Make the login page load fast.')
  expect(words).not.toContain('On it.')
})

test('a brief sent back once goes through the next time', async () => {
  const hook = { session_id: 's', tool_name: 'Agent', tool_input: { prompt: 'Task t-1: rewrite the whole site.' } }
  const revise = async (): Promise<Verdict> => ({ verdict: 'revise', notes: 'He asked for the login page only.' })
  expect((await check(hook, store, 'telegram:-100:7', revise))?.verdict).toEqual({ verdict: 'revise', notes: 'He asked for the login page only.' })
  expect((await check(hook, store, 'telegram:-100:7', revise))?.verdict).toBe('again')
  expect((await check(hook, store, 'telegram:-100:7', revise))?.verdict).toMatchObject({ verdict: 'revise' })
})

test('a check that fails lets the work start', async () => {
  const hook = { session_id: 's', tool_name: 'Agent', tool_input: { prompt: 'Task t-1: fix login.' } }
  const result = await check(hook, store, undefined, async () => {
    throw new Error('out of usage')
  })
  expect(result?.verdict).toBe('failed')
})
