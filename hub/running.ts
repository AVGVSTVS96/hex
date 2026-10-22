import { readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// A Claude Code session whose process runs, from the record Claude Code keeps of it while it lives
// (sessions/<pid>.json): its status (busy, shell, idle) and kind (bg for a background session), and
// a background session's job state (working, blocked on the owner, done), status line and what it
// needs, from jobs/<id>/state.json.
// owner: the thread a bin/job job runs for, from its HEX_OWNER as <app>:<key>; parent, for any
// other: the nearest running session above it in the process tree.
export type Session = { id: string; pid: number; status: string; state?: string; detail?: string; needs?: string; kind?: string; name?: string; cwd?: string; started: number; at: number; owner?: string; parent?: string }

export const CLAUDE = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const BUSY = new Set(['busy', 'shell'])

export const busy = (session?: Session) => !!session && BUSY.has(session.status)
const busyness = (status: string) => (status === 'busy' ? 2 : status === 'shell' ? 1 : 0)

// Every running session by id. Two records of one session count as the busiest (mid-turn, then a
// shell still running, then anything else), and of two as busy, the newer.
export function running(claude = CLAUDE): Map<string, Session> {
  const sessions = new Map<string, Session>()
  const dir = join(claude, 'sessions')
  for (const name of list(dir)) {
    if (!name.endsWith('.json')) continue
    const record = readJson(join(dir, name))
    if (!record?.sessionId || !alive(record.pid)) continue
    const { sessionId: id, pid, status = 'idle', kind, name: title, cwd, startedAt = 0 } = record
    const at = record.statusUpdatedAt ?? startedAt
    const kept = sessions.get(id)
    if (kept && (busyness(kept.status) > busyness(status) || (busyness(kept.status) === busyness(status) && kept.at >= at))) continue
    const { state, detail, needs } = readJson(join(claude, 'jobs', id.slice(0, 8), 'state.json')) ?? {}
    const job = Object.fromEntries(Object.entries({ state, detail, needs }).filter(([, value]) => typeof value === 'string' && value))
    sessions.set(id, { id, pid, status, ...job, kind, name: title, cwd, started: startedAt, at })
  }
  const byPid = new Map([...sessions.values()].map(session => [session.pid, session.id]))
  const parents = processParents()
  for (const session of sessions.values()) {
    session.owner = ownerOf(session.pid)
    if (session.owner) continue
    for (let pid = parents.get(session.pid); pid && pid > 1 && !session.parent; pid = parents.get(pid)) session.parent = byPid.get(pid)
  }
  return sessions
}

// The thread a session works for, as <app>:<key>: the one it serves (held maps each thread's session
// to it), else the one the session it runs under works for, else its job's owner.
export function serving(session: Session, sessions: Map<string, Session>, held: Map<string, string>): string | undefined {
  for (let at: Session | undefined = session; at; at = at.parent ? sessions.get(at.parent) : undefined) {
    const thread = held.get(at.id)
    if (thread) return thread
    if (!at.parent) return at.owner
  }
}

function ownerOf(pid: number) {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find(entry => entry.startsWith('HEX_OWNER='))?.slice('HEX_OWNER='.length) || undefined
  } catch {}
}

function processParents() {
  try {
    const out = Bun.spawnSync(['ps', '-A', '-o', 'pid=,ppid=']).stdout.toString()
    return new Map(out.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number) as [number, number]))
  } catch {
    return new Map<number, number>()
  }
}

function alive(pid: unknown) {
  try {
    return Number.isInteger(pid) && (pid as number) > 0 && process.kill(pid as number, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function list(dir: string) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function readJson(path: string) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {}
}
