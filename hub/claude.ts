import { execFile, spawn } from 'child_process'
import { closeSync, fstatSync, openSync, readFileSync, readSync, watch } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// A background session as `claude agents --json` lists it.
export type Agent = { sessionId: string; id?: string; pid: number; status?: string; startedAt?: number }
// The context a session's last request sent and when; short: it wrote the five-minute cache.
export type Usage = { sent: number; at?: number; short?: boolean }

const home = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
const short = (session: string) => session.slice(0, 8)

// What a Claude process the hub starts never inherits from it: the bots' tokens and hex's own settings.
const PRIVATE = /_BOT_TOKEN$|^HEX_|^BUZZ_/

export function inherited(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !PRIVATE.test(name)))
}

// Where systemd runs hex, sessions run in a slice of their own (HEX_SESSIONS_SLICE), so one that
// runs out of memory can't take the hub down with it. Claude's daemon starts every session as its
// own child, so the daemon goes there too, whichever of these starts it.
function contained(command: string, args: string[]): [string, string[]] {
  const slice = process.env.HEX_SESSIONS_SLICE
  if (!slice) return [command, args]
  return ['systemd-run', ['--user', '--scope', '--quiet', '--collect', `--slice=${slice}`, '--property=OOMPolicy=continue', command, ...args]]
}

function run(args: string[]): Promise<string | undefined> {
  return new Promise(resolve => execFile('claude', args, (error, stdout) => resolve(error ? undefined : stdout)))
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
async function awake() {
  if ((await run(['daemon', 'status'])) !== undefined) return true
  process.stderr.write("hub: Claude's daemon isn't answering, so the hub starts it\n")
  const [command, args] = contained('claude', ['daemon', 'run'])
  spawn(command, args, { detached: true, stdio: 'ignore', env: inherited() }).on('error', () => {}).unref()
  return false
}

// Only what Claude's daemon says is running: an answer that failed or can't be read, and an empty
// list from a daemon that's down, are asked again until it can say, never read as nothing running.
// A caller that stops asking (a closed hub) gets no answer at all.
export async function agents(asking = () => true): Promise<Agent[]> {
  for (let tries = 0; asking(); tries++) {
    const running = await listed()
    if (running?.length || (running && (await awake()))) return running
    if (!running && !tries) process.stderr.write("hub: claude agents didn't answer, so the hub asks again\n")
    await Bun.sleep(Math.min(1000 * 2 ** tries, 30_000))
  }
  return new Promise(() => {})
}

export async function agent(session: string, asking?: () => boolean): Promise<Agent | undefined> {
  return (await agents(asking)).find(agent => agent.sessionId === session)
}

export const stop = (session: string) => run(['stop', short(session)])
// `claude --bg --resume` copies the conversation to a new id while the old session's job record
// exists, even once stopped; this clears the record and keeps the conversation.
export const rm = (session: string) => run(['rm', short(session)])
// Restarts a running session in place from the flags it started with, running a turn it was on again.
export const respawn = (agent: Agent) => run(['respawn', job(agent)])

// Resolves with the new session's job once Claude has put it in the background.
export function start(launcher: string, args: string[], options: { cwd: string; env: Record<string, string | undefined> }): Promise<string> {
  return new Promise((resolve, reject) => {
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
  })
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
