import { appendFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { hexDir, open } from './store.ts'
import type { Job } from './schedule.ts'
import { render } from './tasks.ts'

// An idea's check: a schedules.json job that names an idea runs this instead of waking a session.
// A small model reads the idea, what its last checks found and what the job asks it to look into,
// searches the web, and says whether there's news. Only news reaches the idea's thread. Every check
// goes in ideas.jsonl, with what it found and what it spent, and the next one starts from there.

const MODEL = 'opus'
const CALL = 10 * 60_000
const KEPT = 5

const SYSTEM = `You keep one of my ideas moving while it waits on me. Below are my words for it, what to look into, and what your last checks found. Look on the web for what's new since then. When there's something I'd want to hear, answer news: true with a finding of a line or two and its links. Otherwise answer news: false, with what you looked at as the finding, so the next check goes further.`

const SCHEMA = { type: 'object', properties: { news: { type: 'boolean' }, finding: { type: 'string' } }, required: ['news', 'finding'] }

export type Found = { news: boolean; finding: string; tokens?: number; cost?: number }
export type Check = { at: string; schedule: string; idea: string; news?: boolean; finding?: string; tokens?: number; cost?: number; error?: string }

export async function look(input: string): Promise<Found> {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HEX_') && !name.startsWith('CLAUDECODE'))), CLAUDE_CODE_ENTRYPOINT: 'hex', HEX_HELPER: 'ideas' }
  const run = Bun.spawn(
    ['claude', '-p', '--safe-mode', '--model', MODEL, '--effort', 'low', '--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch', 'WebFetch', '--json-schema', JSON.stringify(SCHEMA), '--system-prompt', SYSTEM, '--output-format', 'json', '--no-session-persistence'],
    { cwd: hexDir(), env, stdin: new Blob([input]), stdout: 'pipe', stderr: 'pipe', timeout: CALL },
  )
  const [out, code] = await Promise.all([new Response(run.stdout).text(), run.exited])
  const result = JSON.parse(out || '{}')
  if (code !== 0 || result.is_error || !result.structured_output) throw new Error(`claude exited ${code}: ${String(result.result ?? '').slice(0, 300)}`)
  const { input_tokens = 0, output_tokens = 0, cache_read_input_tokens = 0, cache_creation_input_tokens = 0 } = result.usage ?? {}
  return { ...result.structured_output, tokens: input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens, cost: result.total_cost_usd }
}

export function checks(state: string, idea: string): Check[] {
  try {
    return readFileSync(join(state, 'ideas.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Check)
      .filter(check => check.idea === idea)
  } catch {
    return []
  }
}

// One check of the idea a job names, at its slot. An idea that's done, dropped or gone has
// nothing left to look into, and its thread hears once to take the job out.
export async function research(state: string, name: string, job: Job, main: string, minute: number, ask = look) {
  const store = open(state)
  const id = job.idea!
  const task = store.task(id)
  const to = job.thread ?? task?.owner ?? main
  if (!task || task.status === 'done' || task.status === 'dropped') {
    const body = `[${name}] ${id} is ${task?.status ?? 'gone'}, so its check in schedules.json has nothing left to look into: take the job out.`
    store.deliver({ key: `schedule:${name}:${id}-${task?.status ?? 'gone'}`, to, from: 'schedule', author: 'prompt', body, meta: { user: 'schedule', schedule: name } })
    return
  }
  const past = checks(state, id).filter(check => check.finding).slice(-KEPT)
  const input = [
    render(task, store.names()),
    `What to look into: ${job.prompt}`,
    past.length ? `What the last checks found:\n${past.map(check => `- ${check.at.slice(0, 10)}: ${check.finding}`).join('\n')}` : 'This is its first check.',
    `Today is ${new Date(minute * 60_000).toISOString().slice(0, 10)}.`,
  ].join('\n\n')
  const record: Check = { at: new Date().toISOString(), schedule: name, idea: id }
  try {
    Object.assign(record, await ask(input))
    if (record.news) store.fire(name, minute, to, `[${name}] News for ${id} (${task.title}): ${record.finding}`)
  } catch (error) {
    record.error = String(error)
  }
  appendFileSync(join(state, 'ideas.jsonl'), `${JSON.stringify(record)}\n`)
}

// Checks run one at a time, in the order they came due.
let line = Promise.resolve()

export function study(state: string, name: string, job: Job, main: string, minute: number) {
  line = line.then(() => research(state, name, job, main, minute)).catch(error => process.stderr.write(`hub: ${name}'s idea check failed: ${error}\n`))
}
