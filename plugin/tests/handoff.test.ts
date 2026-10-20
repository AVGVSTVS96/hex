import { afterEach, beforeEach, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { open } from '../../hub/store.ts'

const HEX = join(import.meta.dir, '../..')
const SESSION = 'a4d76227-0000-4000-8000-000000000000'
const THREAD = 'discord:1561893634448695446'
const LOG = (home: string) => join(home, 'log/threads/2026-10-19-a4d76227.md')
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HEX_')))

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'handoff-'))
  mkdirSync(join(home, '.hex/bin'), { recursive: true })
  for (const script of ['handoff', 'log']) copyFileSync(join(HEX, 'bin', script), join(home, '.hex/bin', script))
  symlinkSync(join(HEX, 'hub'), join(home, '.hex/hub'))
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 19, 23, minute)).toISOString()
  const lines = [
    { type: 'user', message: { content: '<channel source="plugin:discord:discord" user="avgvstvs96" user_id="1">cut prompts down to the absolute bare minimum</channel>' }, timestamp: at(38) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Telling the builder.' }] }, timestamp: at(39) },
    { type: 'user', message: { content: '<channel source="plugin:discord:discord" user="avgvstvs96" user_id="1">macroscope left the best PR summaries!!!</channel>' }, timestamp: at(44) },
  ]
  writeFileSync(join(home, 'transcript.jsonl'), lines.map(line => JSON.stringify(line)).join('\n') + '\n')
})

afterEach(() => rmSync(home, { recursive: true, force: true }))

function hand(tool_name: string, tool_input: Record<string, unknown>, extra: Record<string, string> = {}) {
  const run = Bun.spawnSync([join(home, '.hex/bin/handoff')], {
    stdin: Buffer.from(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: SESSION, transcript_path: join(home, 'transcript.jsonl'), tool_name, tool_input })),
    env: { ...env, TZ: 'UTC', TMPDIR: home, HEX_STORE: join(home, 'state'), HEX_THREAD: THREAD, ...extra },
  })
  expect(run.exitCode).toBe(0)
  const out = run.stdout.toString()
  return out ? JSON.parse(out).hookSpecificOutput.updatedInput : undefined
}

test('a T3 Code launch points the builder at the whole conversation, written up to the latest message', () => {
  const input = hand('mcp__t3-code__t3_thread_launch', { title: 'microscope', message: 'Build phase 1.', projectId: 'p' })
  expect(input.title).toBe('microscope')
  expect(input.projectId).toBe('p')
  expect(input.message).toStartWith('Build phase 1.\n\n---\n')
  expect(input.message).toContain(`is in ${LOG(home)}, kept current`)
  expect(input.message).toContain('their newest message there is from 2026-10-19 23:44')
  expect(readFileSync(LOG(home), 'utf8')).toContain('macroscope left the best PR summaries!!!')
})

test('every way of handing off gets the pointer in its prompt', () => {
  expect(hand('mcp__t3-code__t3_thread_send', { threadId: 't', message: 'He added to it.' }).message).toContain(LOG(home))
  expect(hand('mcp__t3-code__delegate_task', { task: 'Review.' }).task).toContain(LOG(home))
  expect(hand('mcp__plugin_discord_discord__new_thread', { title: 'Docs', prompt: 'Read the docs.', about: 'x' }).prompt).toContain(LOG(home))
  expect(hand('Agent', { description: 'd', prompt: 'Find it.' }).prompt).toContain(LOG(home))
  const threads = hand('mcp__t3-code__create_threads', { threads: [{ prompt: 'One.' }, { title: 'idle' }] }).threads
  expect(threads[0].prompt).toContain(LOG(home))
  expect(threads[1]).toEqual({ title: 'idle' })
})

test('the thread\'s open tasks come with it', () => {
  const store = open(join(home, 'state'))
  store.deliver({ key: 'discord:7', to: THREAD, from: 'discord', body: 'replicate the PR summaries', meta: { user: 'avgvstvs96', user_id: '1' } })
  const task = store.createTask({ message: 'discord:7', owner: THREAD })
  expect(hand('Agent', { description: 'd', prompt: 'Go.' }).prompt).toContain(`Its open tasks, each with the owner's words: ${task.id} (\``)
})

test('a fork, which already has the conversation, and an idle launch are left as they are', () => {
  expect(hand('Agent', { description: 'd', prompt: 'Go.', subagent_type: 'fork' })).toBeUndefined()
  expect(hand('mcp__t3-code__t3_thread_launch', { title: 'idle' })).toBeUndefined()
})

test('a session with nothing said yet hands off unchanged', () => {
  writeFileSync(join(home, 'transcript.jsonl'), '')
  expect(hand('Agent', { description: 'd', prompt: 'Go.' })).toBeUndefined()
})
