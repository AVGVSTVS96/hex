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

test('a brief is what hands work to another agent', () => {
  writeFileSync(join(dir, 'prompt.md'), 'Fix the login page.')
  const job = brief({ tool_name: 'Bash', tool_input: { command: `cd ~/hex && .hex/bin/job login claude -p "$(cat ${dir}/prompt.md)"` } })
  expect(job).toContain('Fix the login page.')
  expect(brief({ tool_name: 'Bash', cwd: dir, tool_input: { command: 'claude -p --model opus "$(cat ./prompt.md)"' } })).toContain('Fix the login page.')
  expect(brief({ tool_name: 'Bash', tool_input: { command: "cd ~/hex && .hex/bin/hex deliver hex --to=-100:7 --user 'hex General' 'Make login fast.'" } })).toContain('Make login fast.')
  expect(brief({ tool_name: 'Bash', tool_input: { command: 'ssh mac codex exec "Fix login."' } })).toContain('Fix login.')
  expect(brief({ tool_name: 'SendMessage', tool_input: { to: 'login-fix', message: 'Also the signup page.' } })).toContain('signup')
  expect(brief({ tool_name: 'mcp__t3-code__t3_thread_send', tool_input: { threadId: 't', message: 'Look again.' } })).toContain('Look again.')
  expect(brief({ tool_name: 'Bash', tool_input: { command: 'git status' } })).toBeUndefined()
  expect(brief({ tool_name: 'Bash', tool_input: { command: 'rg "hex deliver" hub; pgrep -f claude' } })).toBeUndefined()
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

test('a delivery is checked against the words it cites and the thread it goes to', () => {
  store.keepThreads('telegram', { '-100:7': { name: 'Website' }, '-100:9': { name: 'General' } })
  store.deliver({ key: 'telegram:-100:90', to: '-100:9', from: 'telegram', body: 'Dark mode too, please.', author: 'owner', meta: { user: 'owner' } })
  const words = asked(store, 'telegram:-100:9', ".hex/bin/hex deliver hex --to=Website 'Add dark mode (telegram:-100:90).'")
  expect(words).toContain('His messages it cites:\n\n[telegram:-100:90')
  expect(words).toContain('the thread it goes to:\n\n[telegram:-100:50')
  expect(words).not.toContain('the thread it comes from')
})

test('a rewrite is checked next to the notes it answers, and goes through after two sendbacks', async () => {
  const hook = { session_id: 's', tool_name: 'Agent', tool_input: { prompt: 'Task t-1: rewrite the whole site.' } }
  const seen: string[] = []
  const revise = async (input: string): Promise<Verdict> => (seen.push(input), { verdict: 'revise', notes: 'He asked for the login page only.' })
  expect(await check(hook, store, 'telegram:-100:7', revise)).toMatchObject({ round: 1, verdict: { verdict: 'revise' } })
  expect(seen[0]).not.toContain('went back with your notes')
  expect(await check(hook, store, 'telegram:-100:7', revise)).toMatchObject({ round: 2, verdict: { verdict: 'revise' } })
  expect(seen[1]).toContain('went back with your notes')
  expect(seen[1]).toContain('He asked for the login page only.')
  expect(await check(hook, store, 'telegram:-100:7', revise)).toMatchObject({ round: 3, through: true })
  expect(await check(hook, store, 'telegram:-100:7', revise)).toMatchObject({ round: 1 })
  const ok = async (): Promise<Verdict> => ({ verdict: 'ok', notes: '' })
  expect(await check(hook, store, 'telegram:-100:7', ok)).toMatchObject({ round: 2, verdict: { verdict: 'ok' } })
  expect(await check(hook, store, 'telegram:-100:7', revise)).toMatchObject({ round: 1 })
})

test('a check that fails lets the work start', async () => {
  const hook = { session_id: 's', tool_name: 'Agent', tool_input: { prompt: 'Task t-1: fix login.' } }
  const result = await check(hook, store, undefined, async () => {
    throw new Error('out of usage')
  })
  expect(result?.verdict).toBe('failed')
})
