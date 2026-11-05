import { appendFileSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { served } from './running.ts'
import { hexDir, open, spoken, stateDir, type Store } from './store.ts'
import { render } from './tasks.ts'

// The intent check: before a session hands the owner's work to another agent, a quick model reads the
// brief next to the owner's words for it, their rules and hex's memory, and says whether the brief
// asks for what they asked. A brief that drifts goes back to its session with notes, once: the
// session's next handoff within AGAIN goes through, so a wrong note costs one rewrite, never a stall.

const MODEL = 'opus'
const CALL = 90_000
const AGAIN = 15 * 60_000

const SYSTEM = `One of my hex sessions wrote this brief to hand my work to another agent, and you read it before that agent starts, so the work hex proposes is the work I asked for: my words for the task and my newest messages, my rules below, and what hex's memory says was decided.

The agent that gets it is as capable as you, loads my rules itself, and gets a link to my conversation. Every wall a brief puts up costs it performance: a plan for how to do the work, a guess or lead handed over as where to look, a limit or caution I didn't give for this ask. Those steer a smarter agent away from solving what I asked, even when worded as something to check. So the brief that works carries every part of what I asked, my words where the wording matters, the facts it has checked, and where the result goes, and leaves the how to the agent.

Answer ok when it does; wording, order and a stray wrong detail are the session's call. Answer revise when the brief drops or changes part of my ask, steers the how, or goes against my rules or a decision in memory: a note per problem, a line or two each, quoting my words where they settle it.`

const SCHEMA = { type: 'object', properties: { verdict: { enum: ['ok', 'revise'] }, notes: { type: 'string' } }, required: ['verdict', 'notes'] }

const named = (text: string) => [...new Set(text.match(/\bt-\d+\b/g))]

type Hook = { session_id?: string; tool_name?: string; tool_input?: Record<string, unknown> }
export type Verdict = { verdict: 'ok' | 'revise'; notes: string }

// The brief a tool call hands to another agent, if it starts one: an agent job, a new thread, a T3
// Code thread, or a subagent sent to work on a task (most subagents only read, and name none).
export function brief({ tool_name: tool = '', tool_input: input = {} }: Hook): string | undefined {
  if (tool === 'Bash') {
    const command = String(input.command ?? '')
    if (!/\bjob\s+\S+\s+(\S+\s+)?claude\b/.test(command)) return
    return [command, ...files(command).map(([path, text]) => `${path}:\n${text}`)].join('\n\n')
  }
  if (tool === 'Agent') {
    const prompt = String(input.prompt ?? '')
    return named(prompt).length ? prompt : undefined
  }
  if (/new_thread$|^mcp__t3.code__(t3_thread_launch|delegate_task|create_threads)$/.test(tool)) return JSON.stringify(input, null, 1)
}

// The files a job's command reads its prompt from, like "$(cat ~/scratch/x/prompt.md)", as they are now.
function files(command: string): [string, string][] {
  const paths = [...new Set(command.match(/(~|\/)[\w.~/-]+/g))].map(path => path.replace(/^~/, homedir()))
  return paths.flatMap(path => {
    try {
      return statSync(path).isFile() && statSync(path).size < 100_000 && !path.includes('/bin/') ? [[path, readFileSync(path, 'utf8')] as [string, string]] : []
    } catch {
      return []
    }
  })
}

// What the owner said this brief should serve: each task it names, in their words, and their newest
// messages in the thread it comes from.
export function asked(store: Store, thread: string | undefined, text: string): string {
  const tasks = named(text).map(id => store.task(id)).filter(task => task !== null)
  const key = thread && store.key(thread)
  const latest = key ? store.said(key, 40).filter(row => spoken(row)).slice(-4) : []
  return [
    tasks.length && `The tasks it names, with his words:\n\n${tasks.map(task => render(task, store.names())).join('\n\n')}`,
    latest.length && `His newest messages in the thread it comes from:\n\n${latest.map(row => `[${row.key} · ${row.at.slice(0, 16)}Z]\n${spoken(row)}`).join('\n\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export async function judge(input: string): Promise<Verdict> {
  const rules = Bun.spawnSync([join(import.meta.dir, '../bin/instructions')], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString()
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HEX_') && !name.startsWith('CLAUDECODE'))), CLAUDE_CODE_ENTRYPOINT: 'hex', HEX_HELPER: 'intent' }
  const run = Bun.spawn(
    ['claude', '-p', '--safe-mode', '--model', MODEL, '--effort', 'medium', '--tools', '', '--json-schema', JSON.stringify(SCHEMA), '--system-prompt', `${SYSTEM}\n\n${rules}`, '--output-format', 'json', '--no-session-persistence'],
    { cwd: hexDir(), env, stdin: new Blob([input]), stdout: 'pipe', stderr: 'pipe', timeout: CALL },
  )
  const [out, code] = await Promise.all([new Response(run.stdout).text(), run.exited])
  const result = JSON.parse(out || '{}')
  if (code !== 0 || result.is_error || !result.structured_output) throw new Error(`claude exited ${code}: ${String(result.result ?? '').slice(0, 300)}`)
  return result.structured_output
}

export async function check(hook: Hook, store: Store, thread: string | undefined, decide = judge): Promise<{ verdict: Verdict | 'again' | 'failed'; text: string; error?: string } | undefined> {
  const text = brief(hook)
  if (!text) return
  const session = hook.session_id ?? ''
  const last = Number(store.seen(session, 'intent')) || 0
  if (Date.now() - last < AGAIN) {
    store.unshow(session, 'intent')
    return { verdict: 'again', text }
  }
  const words = asked(store, thread, text)
  try {
    const verdict = await decide(`${words || 'No task or message of his was found for this brief; judge it by his rules and memory.'}\n\nThe brief (${hook.tool_name}):\n\n${text.slice(0, 40_000)}`)
    if (verdict.verdict === 'revise') store.show(session, 'intent', String(Date.now()))
    return { verdict, text }
  } catch (error) {
    return { verdict: 'failed', text, error: String(error) }
  }
}

// The PreToolUse hook. Every outcome is logged to state/intent.jsonl, so a later audit can check the
// checker too; a check that fails or runs long lets the work start.
if (import.meta.main) {
  try {
    const hook = JSON.parse((await Bun.stdin.text()) || '{}') as Hook
    const thread = served({ HEX_CHANNEL: process.env.HEX_CHANNEL, HEX_THREAD: process.env.HEX_THREAD }) ?? process.env.HEX_FROM ?? process.env.HEX_OWNER
    const began = Date.now()
    const result = await check(hook, open(stateDir()), thread)
    if (result) {
      const { verdict, text, error } = result
      const record = { at: new Date().toISOString(), ms: Date.now() - began, session: hook.session_id, thread, tool: hook.tool_name, tasks: named(text), verdict: typeof verdict === 'string' ? verdict : verdict.verdict, notes: typeof verdict === 'string' ? error : verdict.notes, brief: text.slice(0, 4000) }
      appendFileSync(join(stateDir(), 'intent.jsonl'), `${JSON.stringify(record)}\n`)
      if (typeof verdict === 'object' && verdict.verdict === 'revise') {
        const reason = `Intent check: this brief drifts from what Bassim asked.\n\n${verdict.notes}\n\nRewrite the brief and start it again; your next handoff goes through without a check, so weigh these notes yourself.`
        console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }))
      }
    }
  } catch (error) {
    console.error(`hex couldn't check this brief: ${error}`)
  }
}
