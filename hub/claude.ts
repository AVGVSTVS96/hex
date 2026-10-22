import { execFile, spawn } from 'child_process'
import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync, watch } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { sleep } from './clock.ts'

// A background session as `claude agents --json` lists it.
// state: working through a turn, and while the turn waits on background agents.
export type Agent = { sessionId: string; id?: string; pid: number; status?: string; state?: string; startedAt?: number }
// The context a session's last request sent and when; short: it wrote the five-minute cache.
export type Usage = { sent: number; at?: number; short?: boolean }

const home = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const short = (session: string) => session.slice(0, 8)

// What a Claude process the hub starts never inherits from it: the bots' tokens and hex's own settings.
const PRIVATE = /_BOT_TOKEN$|^HEX_|^BUZZ_/

export function inherited(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !PRIVATE.test(name)))
}

// Where systemd runs hex, sessions run in a slice of their own (HEX_SESSIONS_SLICE), so one that
// runs out of memory can't take the hub down with it. Claude's daemon starts every session as its
// own child, and several claude commands start the daemon, so every one the hub runs goes there.
// systemd 254 began expanding ${VARIABLE} in a scope's command, which would rewrite a thread's
// name or prompt, and added --expand-environment to turn that off; older ones pass it as given.
let verbatim: string[] | undefined
function contained(command: string, args: string[]): [string, string[]] {
  const slice = process.env.HEX_SESSIONS_SLICE
  if (!slice) return [command, args]
  verbatim ??= Bun.spawnSync(['systemd-run', '--help']).stdout.toString().includes('--expand-environment') ? ['--expand-environment=no'] : []
  return ['systemd-run', ['--user', '--scope', '--quiet', '--collect', `--slice=${slice}`, '--property=OOMPolicy=continue', ...verbatim, command, ...args]]
}

// The claude commands the hub has running.
const running = new Set<Promise<unknown>>()

function tracked<T>(command: Promise<T>): Promise<T> {
  running.add(command)
  const done = () => void running.delete(command)
  command.then(done, done)
  return command
}

// Resolves once no claude command is running and nothing waiting on one has started another, so
// what the hub does next waits on something outside it: a session, a hook, its clock.
export async function settled() {
  for (;;) {
    await new Promise(resolve => setImmediate(resolve))
    if (!running.size) return
    await Promise.allSettled(running)
  }
}

function run(args: string[]): Promise<string | undefined> {
  const [command, argv] = contained('claude', args)
  return tracked(new Promise(resolve => execFile(command, argv, { env: inherited(), timeout: 15_000 }, (error, stdout) => resolve(error ? undefined : stdout))))
}

async function listed(): Promise<Agent[] | undefined> {
  try {
    const list = JSON.parse((await run(['agents', '--json'])) ?? '')
    return Array.isArray(list) ? list.filter((agent: Agent) => agent.pid) : undefined
  } catch {
    return undefined
  }
}

// Claude's daemon runs every background session. While it's down it lists none, even with
// sessions still running, and it comes back only for the next new session; started here instead,
// it takes the running ones back as it comes up.
async function awake(asking: () => boolean) {
  if ((await run(['daemon', 'status'])) !== undefined) return true
  if (!asking()) return false
  process.stderr.write("hub: Claude's daemon isn't answering, so the hub starts it\n")
  const [command, args] = contained('claude', ['daemon', 'run'])
  spawn(command, args, { detached: true, stdio: 'ignore', env: inherited() }).on('error', () => {}).unref()
  return false
}

// Only what Claude's daemon says is running: an answer that failed or can't be read, and an empty
// list from a daemon that's down, are asked again until it can say, never read as nothing running.
// A caller that stops asking (a closed hub) gets no answer at all, even to a question already asked.
export async function agents(asking = () => true): Promise<Agent[]> {
  for (let tries = 0; asking(); tries++) {
    const running = await listed()
    if (!asking()) break
    if (running?.length || (running && (await awake(asking)) && asking())) return running
    if (!asking()) break
    if (!running && !tries) process.stderr.write("hub: claude agents didn't answer, so the hub asks again\n")
    await sleep(Math.min(1000 * 2 ** tries, 30_000))
  }
  return new Promise(() => {})
}

export async function agent(session: string, asking?: () => boolean): Promise<Agent | undefined> {
  return (await agents(asking)).find(agent => agent.sessionId === session)
}

// The session as Claude's daemon lists it in one answer, for a caller that can't wait for a daemon
// that's down: no answer finds none.
export async function listing(session: string): Promise<Agent | undefined> {
  return (await listed())?.find(agent => agent.sessionId === session)
}

export const stop = (session: string) => run(['stop', short(session)])
// Presses Esc in the session's own terminal, as a terminal attached to it would: the turn ends, and
// the session and what it started in the background keep running. interrupted once the transcript
// records it; exited when the attach ends first (the session is gone), let go when the caller does.
export function interrupt(cwd: string, session: string, until: AbortSignal): Promise<'interrupted' | 'exited' | 'let go'> {
  const file = transcript(cwd, session)
  const from = sizeOf(file)
  if (from === undefined) return Promise.resolve('exited')
  if (until.aborted) return Promise.resolve('let go')
  return new Promise((resolve, reject) => {
    let attach: ReturnType<typeof Bun.spawn> | undefined
    const watcher = watch(dirname(file), (_, name) => name === `${session}.jsonl` && recorded(file, from) && done('interrupted'))
    let over = false
    const done = (how: 'interrupted' | 'exited' | 'let go') => {
      if (over) return
      over = true
      watcher.close()
      until.removeEventListener('abort', letGo)
      attach?.kill('SIGHUP')
      attach?.terminal?.close()
      resolve(how)
    }
    watcher.on('error', () => done('exited'))
    const letGo = () => done('let go')
    let shown = ''
    let pressed = false
    try {
      // Claude Code has no command to interrupt a session's turn from outside, and an interrupt runs no Stop hook.
      const [command, args] = contained('claude', ['attach', short(session)])
      attach = Bun.spawn([command, ...args], {
        env: inherited(),
        terminal: {
          cols: 120,
          rows: 40,
          // Attach shows its own Attaching line before it reaches the session, which drops keys
          // until then; the session's screen follows it.
          data: (terminal, output) => {
            if (pressed) return
            shown += Buffer.from(output).toString('latin1')
            if (!/Attaching[^\n]*\n[^]/.test(shown)) return
            pressed = true
            terminal.write('\x1b')
          },
        },
      })
    } catch (error) {
      watcher.close()
      return reject(error)
    }
    until.addEventListener('abort', letGo)
    void attach.exited.then(() => done(recorded(file, from) ? 'interrupted' : 'exited'))
  })
}

function sizeOf(file: string) {
  try {
    return statSync(file).size
  } catch {
    return undefined
  }
}

// Whether the transcript recorded an interrupt of the session's own turn after its first `from`
// bytes. Its records of requests repeat earlier interrupts, so only the user line counts.
function recorded(file: string, from: number) {
  try {
    const size = statSync(file).size
    if (size <= from) return false
    const added = Buffer.alloc(size - from)
    const fd = openSync(file, 'r')
    try {
      readSync(fd, added, 0, added.length, from)
    } finally {
      closeSync(fd)
    }
    return added.toString('utf8').split('\n').some(interruption)
  } catch {
    return false
  }
}

function interruption(line: string) {
  if (!line.includes('[Request interrupted by user')) return false
  try {
    return interrupted(JSON.parse(line))
  } catch {
    return false
  }
}

// Whether a transcript entry is the line Claude Code writes when Esc interrupts the session's turn.
export function interrupted(entry: { type?: string; isSidechain?: boolean; message?: { content?: unknown } }) {
  const content = entry.message?.content
  const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.map((block: { text?: string }) => block.text ?? '') : []
  return entry.type === 'user' && !entry.isSidechain && texts.some(text => text.startsWith('[Request interrupted by user'))
}

// `claude --bg --resume` copies the conversation to a new id while the old session's job record
// exists, even once stopped; this clears the record and keeps the conversation.
export const rm = (session: string) => run(['rm', short(session)])
// Restarts a running session in place from the flags it started with, running a turn it was on again.
export const respawn = (agent: Agent) => run(['respawn', job(agent)])

// Claude's daemon moves to a new version only when the claude it started from changes, so one started
// through a wrapper stays on its version, and starts no session at all once that version is deleted.
// Stopped with its sessions kept, it comes back current with the next session and takes them back.
let checking: Promise<void> | undefined
function current() {
  return (checking ??= (async () => {
    const [status, version] = await Promise.all([run(['daemon', 'status']), run(['--version'])])
    const running = status?.match(/^version:\s*(\S+)/m)?.[1]
    const installed = version?.match(/^\S+/)?.[0]
    if (!running || !installed || running === installed) return
    process.stderr.write(`hub: Claude's daemon runs ${running} while claude is ${installed}, so the hub restarts it\n`)
    await run(['daemon', 'stop', '--any', '--keep-workers'])
  })().finally(() => (checking = undefined)))
}

// Resolves with the new session's job once Claude has put it in the background.
export async function start(launcher: string, args: string[], options: { cwd: string; env: Record<string, string | undefined> }): Promise<string> {
  await current()
  return tracked(new Promise((resolve, reject) => {
    const [command, argv] = contained(launcher, ['--bg', ...args])
    const child = spawn(command, argv, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => (output += chunk))
    child.stderr.on('data', chunk => (output += chunk))
    child.on('error', reject)
    child.on('close', code => {
      const job = output.match(/backgrounded · (\w+)/)?.[1]
      if (job) resolve(job)
      else reject(new Error(output.trim() || `claude --bg exited with code ${code}`))
    })
  }))
}

// Node can't wait on a process it didn't start, and pidwait isn't on every system (macOS has
// none), so the process is checked until it's gone.
export function exited(pid: number): Promise<void> {
  return new Promise(resolve => {
    const check = () => {
      try {
        process.kill(pid, 0)
        setTimeout(check, 100)
      } catch {
        resolve()
      }
    }
    check()
  })
}

function job(agent: Agent) {
  return agent.id ?? short(agent.sessionId)
}

export type Job = { state?: string; detail?: string; sessionId?: string; respawnFlags?: string[] }

export function record(id: string): Job {
  try {
    return JSON.parse(readFileSync(join(home(), 'jobs', id, 'state.json'), 'utf8'))
  } catch {
    return {}
  }
}

export function watchJob(id: string, change: () => void) {
  return watch(join(home(), 'jobs', id), change)
}

type Launch = { enabledPlugins?: object; env?: Record<string, string> }

// Claude keeps the flags a session started with, since it respawns from them.
function settingsFlag(agent: Agent) {
  const flags = record(job(agent)).respawnFlags ?? []
  return flags.includes('--settings') ? flags[flags.lastIndexOf('--settings') + 1]! : ''
}

// The settings file a session started with, which a respawn reads again.
export function settingsOf(agent: Agent): Launch | undefined {
  try {
    return JSON.parse(readFileSync(settingsFlag(agent), 'utf8'))
  } catch {
    return undefined
  }
}

export function transcript(cwd: string, session: string) {
  return join(home(), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`)
}

// Whether any project folder has the session's conversation, or it can't be told: with no projects
// folder at all, or one it can't read, Claude Code's config isn't where the hub looks.
export function saved(session: string) {
  const projects = join(home(), 'projects')
  try {
    return readdirSync(projects).some(project => {
      try {
        return !!statSync(join(projects, project, `${session}.jsonl`))
      } catch (error) {
        return !['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code!)
      }
    })
  } catch {
    return true
  }
}

// From the newest usage or compaction in the session's transcript.
export function usage(cwd: string, session: string): Usage {
  let file: number
  try {
    file = openSync(transcript(cwd, session), 'r')
  } catch {
    return { sent: 0 }
  }
  try {
    const size = fstatSync(file).size
    const tail = Buffer.alloc(Math.min(size, 1 << 20))
    readSync(file, tail, 0, tail.length, size - tail.length)
    for (const line of tail.toString('utf8').split('\n').reverse()) {
      if (!line.includes('"usage"') && !line.includes('"compact_boundary"')) continue
      let entry: any
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      const at = entry.timestamp ? Date.parse(entry.timestamp) : undefined
      if (entry.type === 'system' && entry.subtype === 'compact_boundary') return { sent: entry.compactMetadata?.postTokens ?? 0, at }
      const usage = entry.type === 'assistant' && !entry.isSidechain ? entry.message?.usage : undefined
      const sent = usage ? (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) : 0
      if (sent) return { sent, at, short: !!usage.cache_creation?.ephemeral_5m_input_tokens && !usage.cache_creation?.ephemeral_1h_input_tokens }
    }
    return { sent: 0 }
  } finally {
    closeSync(file)
  }
}
