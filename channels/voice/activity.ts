import { closeSync, fstatSync, mkdirSync, openSync, readSync, statSync, watch } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { toAcpNotifications } from '@agentclientprotocol/claude-agent-acp'
import type { SessionNotification, ToolCall } from '@agentclientprotocol/sdk'
import { open } from '../../hub/store.ts'

export type Update = SessionNotification['update']
export type Step = { line?: string; end?: 'done' | 'failed' }
export type Thread = { app: string; id: string; name: string; cwd?: string; state: string }

const projects = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
const client = { sessionUpdate: async () => {} } as unknown as Parameters<typeof toAcpNotifications>[4]
const logger = { log: () => {}, error: (...args: unknown[]) => process.stderr.write(`voice: activity: ${args.join(' ')}\n`) }
const ID = /^[\w-]+$/

export type Kind = 'think' | 'say' | 'plan' | 'run' | 'read' | 'edit' | 'search' | 'web' | 'agent' | 'tool'
export type State = 'running' | 'done' | 'failed'

// What an agent did, as a kind of step and a few words for it. A tool call keeps its id, what it acted
// on, and once it's back, whether it worked, the first lines it said and the agent it started.
export type Did = { kind: Kind; text: string; id?: string; detail?: string; state?: State; result?: string; agent?: string }
// A T3 Code task's or thread's name by its id, where it's known.
export type Names = (id: string) => string | undefined
// One of T3 Code's turn items: a provider's own record of one thing in its turn, as Codex keeps them.
export type Item = { id: string; type: string; status: string; payload: any }

const QUIET = /^(Read|Edit|MultiEdit|Write|NotebookEdit|Agent|Task|ToolSearch|mcp__t3-code__(delegate_task|task_\w+|t3_thread_\w+))$/
const RUNNING = new Set(['pending', 'running', 'waiting'])
const PAST: Record<string, string> = { Reading: 'Read', Editing: 'Edited', Writing: 'Wrote', Searching: 'Searched', Running: 'Ran', Waiting: 'Waited', Using: 'Used', Listing: 'Listed', Looking: 'Looked' }
const READS = new Set(['cat', 'sed', 'head', 'tail', 'nl', 'less', 'bat'])
const SEARCHES = new Set(['rg', 'grep'])
const LISTS = new Set(['ls', 'fd', 'find', 'tree'])
const SETUP = new Set(['cd', 'pwd', 'echo', 'set', 'export', 'true'])
const VALUED = new Set(['-g', '--glob', '-t', '--type', '-A', '-B', '-C', '-m', '--max-count'])
const nobody: Names = () => undefined

// What an agent is doing right now, from one ACP session/update. A thought keeps its own words.
export function stepOf(update: Update, names = nobody): Did | undefined {
  switch (update.sessionUpdate) {
    case 'tool_call': {
      const did = step(update, names)
      return did && { ...did, id: update.toolCallId }
    }
    case 'agent_message_chunk': {
      const text = update.content.type === 'text' ? firstLine(update.content.text) : undefined
      return text ? { kind: 'say', text } : undefined
    }
    case 'agent_thought_chunk':
      return { kind: 'think', text: (update.content.type === 'text' && plain(update.content.text)) || 'Thinking' }
    case 'plan': {
      const text = update.entries.find(entry => entry.status === 'in_progress')?.content
      return text ? { kind: 'plan', text } : undefined
    }
  }
}

// How a tool call came back, from its last update: whether it worked, the first lines it said where
// they're worth reading (not a file's body or a hand-off's receipt), and the agent it started.
export function backOf(update: Update): Pick<Did, 'state' | 'result' | 'agent'> | undefined {
  if (update.sessionUpdate !== 'tool_call_update' || (update.status !== 'completed' && update.status !== 'failed')) return
  const tool: string = (update._meta as any)?.claudeCode?.toolName ?? ''
  const state = update.status === 'failed' ? 'failed' : 'done'
  const text = said(update.rawOutput)
  const agent = tool === 'Agent' || tool === 'Task' ? text.match(/agentId: (\w+)/)?.[1] : tool === 'mcp__t3-code__delegate_task' ? json(text)?.childThreadId : undefined
  const result = state === 'failed' || !QUIET.test(tool) ? firstLines(text) : undefined
  return { state, ...(result && { result }), ...(agent && { agent }) }
}

// A finished step's words: what it was doing, now done.
export function past(text: string) {
  const [first, rest] = [text.split(' ')[0]!, text.slice(text.indexOf(' '))]
  return PAST[first] && text.includes(' ') ? `${PAST[first]}${rest}` : text
}

// The same in a few plain words, for a call's agent line, where a thought is just Thinking.
export function headline(update: Update): string | undefined {
  const did = stepOf(update)
  return did?.kind === 'think' ? 'Thinking' : did?.text
}

// A turn item as a step, from what T3 Code keeps of it: its words, what it acted on and what came back.
export function itemStep({ id, type, status, payload: item }: Item, names = nobody): (Did & { at: string; end?: string }) | undefined {
  const did = itemDid(type, item, names)
  if (!did) return
  const tool = !['think', 'say', 'plan'].includes(did.kind)
  const state: State = did.state ?? (status === 'completed' ? 'done' : RUNNING.has(status) ? 'running' : 'failed')
  return {
    ...did,
    ...(tool && state !== 'running' && { text: past(did.text) }),
    id,
    at: item.startedAt ?? item.updatedAt,
    ...(tool && state !== 'running' && item.completedAt && { end: item.completedAt }),
    ...(tool && { state }),
  }
}

function itemDid(type: string, item: any, names: Names): Did | undefined {
  switch (type) {
    case 'command_execution': {
      const command = unwrap((item.input ?? '').trim())
      return {
        kind: 'run',
        text: commandWords(command),
        ...clipped({ detail: command, result: firstLines(item.output ?? '') }),
        ...(typeof item.exitCode === 'number' && item.exitCode !== 0 && { state: 'failed' }),
      }
    }
    case 'web_search': {
      const patterns: string[] = [...new Set<string>(item.patterns ?? (item.query ? [item.query] : []))]
      const [, what, page] = patterns.map(pattern => pattern.match(/^'(.+)' in (https?:\/\/\S+)$/)).find(Boolean) ?? []
      const text = what
        ? `Looking for ${what} on ${host(page!)}`
        : /^https?:\/\//.test(patterns[0] ?? '')
          ? `Reading ${host(patterns[0]!)}`
          : patterns[0]
            ? `Searching the web for ${patterns[0]}`
            : 'Searching the web'
      return { kind: 'web', text, ...clipped({ detail: patterns.join('\n') }) }
    }
    case 'file_change': {
      const diff: string[] = (item.diffStr ?? '').split('\n')
      const added = diff.filter(line => line.startsWith('+') && !line.startsWith('+++')).length
      const removed = diff.filter(line => line.startsWith('-') && !line.startsWith('---')).length
      return { kind: 'edit', text: `Editing ${basename(item.fileName ?? 'a file')}`, ...clipped({ detail: item.fileName && tilde(item.fileName), result: `+${added} −${removed}` }) }
    }
    case 'dynamic_tool': {
      const name: string = item.toolName ?? ''
      const [, server, tool] = name.match(/^mcp__(.+?)__(.+)$/) ?? name.match(/^([^.]+)\.(.+)$/) ?? []
      const input = item.input ?? {}
      const did: Did | undefined =
        server && tool
          ? called(server, tool, input, names)
          : name === 'Read'
            ? { kind: 'read', text: `Reading ${basename(input.file_path ?? 'a file')}`, ...clipped({ detail: input.file_path && tilde(input.file_path) }) }
            : name === 'ToolSearch' || !name
              ? undefined
              : { kind: 'tool', text: name, ...clipped({ detail: pairs(input) }) }
      const quiet = name === 'Read' || QUIET.test(server && tool ? `mcp__${server}__${tool}` : name)
      const error = item.output?.error
      const result = error ? said(typeof error === 'string' ? error : (error.message ?? error)) : quiet ? '' : said(item.output)
      return did && { ...did, ...clipped({ result: firstLines(result) }), ...(error && { state: 'failed' }) }
    }
    case 'reasoning':
      return { kind: 'think', text: plain((item.text ?? '').replace(/^\*\*(.+?)\*\*\s*/, '$1. ')) || 'Thinking' }
    case 'assistant_message': {
      const text = firstLine(item.text ?? '')
      return text ? { kind: 'say', text } : undefined
    }
    case 'subagent':
      return { kind: 'agent', text: `Handed off ${item.title ?? 'a task'}`, ...clipped({ detail: firstLine(item.prompt ?? '') }), ...(item.childThreadId && { agent: item.childThreadId }) }
    case 'error':
      return { kind: 'tool', text: item.title ?? 'Something failed', state: 'failed', ...clipped({ result: firstLines(item.failure?.message ?? '') }) }
  }
}

function step({ title, kind, rawInput, locations, _meta }: ToolCall, names: Names): Did | undefined {
  const input = (rawInput ?? {}) as Record<string, any>
  const tool: string = (_meta as any)?.claudeCode?.toolName ?? title
  const file: string | undefined = locations?.[0]?.path ?? input.file_path ?? input.notebook_path
  switch (kind) {
    case 'execute':
      return { kind: 'run', text: input.description || `Running ${firstLine(input.command ?? title)}`, ...clipped({ detail: input.command }) }
    case 'read':
      return { kind: 'read', text: file ? `Reading ${basename(file)}` : title, ...clipped({ detail: file && tilde(file) }) }
    case 'edit':
      return { kind: 'edit', text: `${tool === 'Write' ? 'Writing' : 'Editing'} ${basename(file ?? title)}`, ...clipped({ detail: file && tilde(file) }) }
    case 'search':
      return { kind: 'search', text: input.pattern ? `Searching for ${input.pattern}` : title, ...clipped({ detail: [input.pattern, input.path && tilde(input.path)].filter(Boolean).join('\n') }) }
    case 'fetch':
      return {
        kind: 'web',
        text: input.query ? `Searching the web for ${input.query}` : input.url ? `Reading ${host(input.url)}` : title,
        ...clipped({ detail: input.query ?? input.url }),
      }
    case 'think':
      return input.description
        ? { kind: 'agent', text: `Started ${input.description}`, ...clipped({ detail: [input.subagent_type, firstLine(input.prompt ?? '')].filter(Boolean).join('\n') }) }
        : undefined
  }
  const mcp = tool.match(/^mcp__(.+?)__(.+)$/)
  if (mcp) return called(mcp[1], mcp[2], input, names)
  if (input.skill) return { kind: 'tool', text: `Using the ${input.skill} skill`, ...clipped({ detail: input.args }) }
  return title === tool ? undefined : { kind: 'tool', text: title }
}

// An MCP tool in a few words: T3 Code's hand-offs by the agent or thread they're about, any other by
// its app and its name, with what it was given.
function called(server: string, tool: string, input: Record<string, any>, names: Names): Did {
  if (server === 't3-code')
    switch (tool) {
      case 'delegate_task':
        return { kind: 'agent', text: `Handed off ${input.title ?? 'a task'}`, ...clipped({ detail: firstLine(input.task ?? '') }) }
      case 'task_status':
        return { kind: 'tool', text: `Checked on ${names(input.taskId) ?? 'an agent'}` }
      case 'task_cancel':
        return { kind: 'tool', text: `Stopped ${names(input.taskId) ?? 'an agent'}`, ...clipped({ detail: input.reason }) }
      case 't3_thread_wait':
        return { kind: 'tool', text: 'Waiting on agents' }
      case 't3_thread_send':
        return { kind: 'tool', text: `Wrote to ${names(input.threadId) ?? 'a thread'}`, ...clipped({ detail: input.message }) }
      case 't3_thread_read':
        return { kind: 'tool', text: `Read ${names(input.threadId) ?? 'a thread'}` }
    }
  const app = server
    .split('_')
    .at(-1)!
    .split('-')
    .map(word => word.replace(/^./, letter => letter.toUpperCase()))
    .join(' ')
  return { kind: 'tool', text: `${app}: ${tool.replaceAll('_', ' ')}`, ...clipped({ detail: pairs(input) }) }
}

// A command in a few plain words, for a provider that gives none: the file it reads or writes, what
// it looks for or lists, or the program it runs, from its first command past any setup like cd or
// one whose output is thrown away.
function commandWords(command: string) {
  const tokens = command.match(/'[^']*'|"(?:\\.|[^"\\])*"|&&|\|\||[;|\n]|\d*>>?|[^\s;|&'"<>]+/g) ?? []
  const parts: string[][] = [[]]
  for (const token of tokens) /^(&&|\|\||[;|\n])$/.test(token) ? parts.push([]) : parts.at(-1)!.push(token.replace(/^(['"])([\s\S]*)\1$/, '$2'))
  const silent = (part: string[]) => part.some((token, i) => /^1?>>?$/.test(token) && part[i + 1] === '/dev/null')
  const [name, ...args] = parts.find(part => part.length && !SETUP.has(part[0]!) && !silent(part)) ?? []
  if (!name) return `Running ${firstLine(command)}`
  const redirect = (arg = '') => /^\d*>>?$/.test(arg)
  const out = args.findIndex(arg => arg === '>' || arg === '>>')
  const into = out >= 0 ? args[out + 1] : undefined
  const plain = args.filter((arg, i) => !arg.startsWith('-') && !redirect(arg) && !redirect(args[i - 1]) && !VALUED.has(args[i - 1]!))
  if (into && (READS.has(name) || name === 'tee')) return `Writing ${basename(into)}`
  if (READS.has(name) && plain.length) return `Reading ${basename(plain.at(-1)!)}`
  const place = plain.find(arg => arg !== '.')
  if (LISTS.has(name) || args.includes('--files')) return `Listing ${place ? basename(place) : 'files'}`
  if (SEARCHES.has(name) && plain.length) return `Searching for ${plain[0]}`
  return `Running ${name}${/^[a-z][a-z-]*$/.test(args[0] ?? '') ? ` ${args[0]}` : ''}`
}

// A step's detail and result, kept to what a line on a phone can show, and left out when empty.
function clipped({ detail, result }: { detail?: string; result?: string }) {
  const cut = (text: string, size: number) => (text.length > size ? `${text.slice(0, size - 1)}…` : text)
  return { ...(detail?.trim() && { detail: cut(detail.trim(), 240) }), ...(result?.trim() && { result: cut(result.trim(), 400) }) }
}

// What a tool said, as text: its own words, the text of its blocks, or its fields.
function said(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) return output.flatMap(block => (block?.type === 'text' ? [block.text] : [])).join('\n')
  return output && typeof output === 'object' ? pairs(output as Record<string, unknown>) : ''
}

// An input or an output's plain fields as `key: value` lines.
function pairs(input: Record<string, unknown>) {
  return Object.entries(input)
    .flatMap(([key, value]) => (['string', 'number', 'boolean'].includes(typeof value) && value !== '' ? [`${key}: ${firstLine(String(value)) ?? ''}`] : []))
    .join('\n')
}

function firstLines(text: string) {
  return text.trim().split('\n').slice(0, 6).join('\n')
}

// A command as it was typed, without the `bash -lc "…"` Codex wraps it in.
function unwrap(command: string) {
  const [, quote, inner] = command.match(/^(?:\S*\/)?(?:ba|z)?sh -l?c (["'])([\s\S]*)\1$/) ?? []
  if (!inner) return command
  return quote === '"' ? inner.replace(/\\(["\\$`])/g, '$1') : inner.replaceAll(`'"'"'`, `'`)
}

function host(url: string) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function tilde(path: string) {
  return path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path
}

function json(text: string) {
  try {
    return JSON.parse(text)
  } catch {}
}

function plain(text: string) {
  return text.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim()
}

// A text's first line, without its markdown or a list marker.
export function firstLine(text: string) {
  const line = unmark(
    text
      .trim()
      .split('\n')[0]
      .replace(/^(#+|[-*>]|\d+\.)\s+/, ''),
  ).trim()
  return line ? line.slice(0, 160) : undefined
}

// Markdown's marks dropped and its links read as their words, for text shown plain.
export function unmark(text: string) {
  return text.replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
}

// Follows one Claude Code transcript as Claude Code writes it (a file change, not a timer), from
// a byte offset or its end: every new line, and the ACP updates its assistant content and tool
// results make, converted when asked for. A line cut in half by the offset is skipped.
export function followTranscript(path: string, from: number | 'end', onEntry: (entry: any, updates: () => Update[]) => void) {
  const tools = {}
  const tasks = new Map()
  let offset = from === 'end' ? sizeOf(path) : from
  let rest = Buffer.alloc(0)
  let closed = false
  mkdirSync(dirname(path), { recursive: true })
  const watcher = watch(dirname(path), (_, file) => file === basename(path) && read())
  read()

  function read() {
    if (closed) return
    let fd
    try {
      fd = openSync(path, 'r')
    } catch {
      return
    }
    try {
      const size = fstatSync(fd).size
      if (size <= offset) return
      const chunk = Buffer.alloc(size - offset)
      readSync(fd, chunk, 0, chunk.length, offset)
      offset = size
      const data = Buffer.concat([rest, chunk])
      const last = data.lastIndexOf(10)
      rest = data.subarray(last + 1)
      if (last >= 0) for (const line of data.subarray(0, last).toString('utf8').split('\n')) if (!closed) take(line)
    } finally {
      closeSync(fd)
    }
  }

  function take(line: string) {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      return
    }
    const content = entry.type === 'assistant' || (entry.type === 'user' && Array.isArray(entry.message?.content)) ? entry.message.content : undefined
    onEntry(entry, () =>
      content
        ? toAcpNotifications(content, entry.type, entry.sessionId ?? '', tools, client, logger, {
            registerHooks: false,
            replay: true,
            cwd: entry.cwd ?? '',
            taskState: tasks,
            messageId: entry.message.id,
            toolUseResult: entry.toolUseResult,
          }).map(notification => notification.update)
        : [],
    )
  }

  return () => {
    closed = true
    watcher.close()
  }
}

// A background subagent's live steps, by the agentId its Agent call returned. Its own session's
// subagents come first; any session's will do.
export function followAgent(agent: string, session: string | undefined, onStep: (step: Step) => void) {
  if (!ID.test(agent)) return
  const patterns = [...(session && ID.test(session) ? [`*/${session}/subagents/agent-${agent}.jsonl`] : []), `*/*/subagents/agent-${agent}.jsonl`]
  for (const pattern of patterns)
    for (const path of new Bun.Glob(pattern).scanSync({ cwd: projects(), absolute: true }))
      return followTranscript(path, 0, (_, updates) => lines(updates(), onStep))
}

// An open hex thread (a Telegram topic, a Discord, Buzz or T3 Code thread) from hex.db, by its id as
// `hex threads --json` gives it (app:key), else its bare key, else its name.
export function findThread(state: string, wanted: string): Thread | undefined {
  const lower = wanted.toLowerCase()
  const all = open(state).threads({ open: true }).filter(({ app }) => app !== 'voice')
  const ways = [all.filter(({ app, thread }) => `${app}:${thread}` === wanted), all.filter(({ thread }) => thread === wanted), all.filter(({ name }) => name.toLowerCase() === lower)]
  const matches = ways.find(found => found.length) ?? []
  if (matches.length > 1) throw new Error(`more than one hex thread goes by ${wanted}, in ${[...new Set(matches.map(({ app }) => app))].join(' and ')}: pass its app:key id, from hex threads --json`)
  const found = matches[0]
  return found && { app: found.app, id: found.thread, name: found.name, cwd: found.cwd, state }
}

// One message sent to a hex thread, followed through its session's transcript: it waits until the
// session takes in the message carrying `tag`, shows each step after that (its background agents'
// steps too), and ends when a turn ends with none of those agents still out. A new session for the
// thread (a renewal or a restart) shows up in hex.db and is followed from its start; so is
// the first one when following resumes a message sent earlier.
export function followThread(thread: Thread, hexDir: string, tag: string, resumed: boolean, onStep: (step: Step) => void) {
  const agents = new Map<string, () => void>()
  let session: string | undefined
  let project = ''
  let stopSession = () => {}
  let picked = false
  let failed = false
  let ended = false

  const store = open(thread.state)
  const stopState = store.watch(locate)
  locate()

  function locate() {
    const next = store.threads({ app: thread.app, open: true }).find(({ thread: id }) => id === thread.id)?.session
    if (ended || !next || next === session || !ID.test(next)) return
    const fresh = resumed || session !== undefined
    stopSession()
    session = next
    project = join(projects(), (thread.cwd ?? hexDir).replace(/[^a-zA-Z0-9]/g, '-'))
    stopSession = followTranscript(join(project, `${session}.jsonl`), fresh ? 0 : 'end', take)
  }

  function take(entry: any, updates: () => Update[]) {
    if (!picked) {
      const content = entry.message?.content
      picked = entry.type === 'user' && entry.origin?.kind === 'channel' && (typeof content === 'string' ? content : JSON.stringify(content)).includes(tag)
      return
    }
    const launched = entry.toolUseResult?.isAsync && entry.toolUseResult.agentId
    if (launched && ID.test(launched) && !agents.has(launched))
      agents.set(launched, followTranscript(join(project, session!, 'subagents', `agent-${launched}.jsonl`), 0, (_, updates) => lines(updates(), onStep)))
    const back = entry.origin?.kind === 'task-notification' && JSON.stringify(entry.message?.content).match(/<task-id>([\w-]+)<\/task-id>/)?.[1]
    if (back) {
      agents.get(back)?.()
      agents.delete(back)
    }
    if (entry.type === 'assistant') failed = entry.isApiErrorMessage === true
    lines(updates(), onStep)
    if (entry.type === 'system' && entry.subtype === 'turn_duration' && !agents.size) {
      close()
      onStep({ end: failed ? 'failed' : 'done' })
    }
  }

  function close() {
    ended = true
    stopState()
    stopSession()
    for (const stop of agents.values()) stop()
    agents.clear()
  }

  return close
}

function lines(updates: Update[], onStep: (step: Step) => void) {
  for (const update of updates) {
    const line = headline(update)
    if (line) onStep({ line })
  }
}

export function sizeOf(path: string) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
