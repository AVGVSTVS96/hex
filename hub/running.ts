import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Store } from './store.ts'

// A Claude Code session whose process runs, from the record Claude Code keeps of it while it lives
// (sessions/<pid>.json): its status (busy, shell, idle) and kind (bg for a background session), and
// a background session's job state (working, blocked on the owner, done), status line and what it
// needs, from jobs/<id>/state.json, and when Claude Code last changed its status, where it says. The
// thread it works for, as <app>:<key>, from the environment it started with (served); a background
// session's from the settings its job started it with, since Claude Code's daemon starts those with
// its own environment, whoever started it. The session that launched it (parent), when its process
// runs under another session's, unless it's a background session, for the same reason. Which of
// hex's own helpers it is (HEX_HELPER: its check, its memory agent), which are nobody's work.
// From hex's own record of its turns (hex.db's turns): when its latest turn began, and when that
// turn ended, if it has.
export type Session = { id: string; pid: number; job?: string; status: string; state?: string; detail?: string; needs?: string; kind?: string; name?: string; cwd?: string; started: number; updated?: number; thread?: string; parent?: string; helper?: string; began?: string; ended?: string }

export const CLAUDE = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const BUSY = new Set(['busy', 'shell'])

export const busy = (session?: Session) => !!session && BUSY.has(session.status)
const busyness = (status: string) => (status === 'busy' ? 2 : status === 'shell' ? 1 : 0)

// Every running session by id. Two records of one session count as the busiest (mid-turn, then a
// shell still running, then anything else), and of two as busy, the newer.
export function running(store: Store, claude = CLAUDE): Map<string, Session> {
  const sessions = new Map<string, Session>()
  const pids = new Map<number, string>()
  const dir = join(claude, 'sessions')
  for (const file of list(dir)) {
    const record = file.endsWith('.json') ? readJson(join(dir, file)) : undefined
    if (!record?.sessionId || !alive(record.pid, record.procStart)) continue
    const { sessionId: id, pid, jobId, status = 'idle', kind, name, cwd, startedAt: started = 0, statusUpdatedAt } = record
    pids.set(pid, id)
    const updated = typeof statusUpdatedAt === 'number' ? statusUpdatedAt : undefined
    const kept = sessions.get(id)
    if (kept && (busyness(kept.status) > busyness(status) || (busyness(kept.status) === busyness(status) && (kept.updated ?? kept.started) >= (updated ?? started)))) continue
    const job: string | undefined = (typeof jobId === 'string' && jobId) || kept?.job
    const { state, detail, needs, respawnFlags } = readJson(join(claude, 'jobs', job || id.slice(0, 8), 'state.json')) ?? {}
    const progress = Object.fromEntries(Object.entries({ state, detail, needs }).filter(([, value]) => typeof value === 'string' && value))
    const env = kind === 'bg' ? launched(respawnFlags) : environ(pid)
    sessions.set(id, { id, pid, ...(job && { job }), status, ...progress, kind, name, cwd, started, ...(updated !== undefined && { updated }), thread: served(env), ...(env.HEX_HELPER && { helper: env.HEX_HELPER }), ...store.turn(id) })
  }
  for (const session of sessions.values()) {
    const parent = session.kind === 'bg' ? undefined : launcher(session.pid, pids, session.id)
    if (parent) session.parent = parent
  }
  return sessions
}

// Resolve ownership and the highest unheld session together. A T3 boundary makes its
// handoff authoritative for the whole subtree, including inherited environments.
export function ownership(session: Session, held: Map<string, string>, sessions: Map<string, Session>, { owners = held, boundary = (_: string) => false, display = (thread: string) => thread } = {}): { thread?: string; top: Session } {
  const chain: Session[] = []
  const seen = new Set<string>()
  let cyclic = false
  for (let one: Session | undefined = session; one; one = one.parent ? sessions.get(one.parent) : undefined) {
    if (seen.has(one.id)) { cyclic = true; break }
    seen.add(one.id)
    chain.push(one)
    if (held.has(one.id) || one.helper || boundary(one.id)) break
  }
  let thread: string | undefined
  let top = session
  let parent: Session | undefined
  let t3 = false
  for (const one of chain.reverse()) {
    t3 ||= boundary(one.id)
    let owner = owners.get(one.id) ?? (one.helper ? undefined : t3 ? thread : one.thread ?? thread)
    if (owner && !held.has(one.id)) owner = display(owner)
    if (!parent || held.has(parent.id) || owner !== thread) top = one
    thread = owner
    parent = one
  }
  return { thread, top: cyclic ? session : top }
}

export function serving(session: Session, held: Map<string, string>, sessions = new Map<string, Session>()): string | undefined {
  return ownership(session, held, sessions).thread
}

// The thread a process works for, as <app>:<key>: the one its hub started its session for, or its
// job's owner. A session started from another's shell has its environment, so works for it too.
export function served(env = process.env): string | undefined {
  const app = env.HEX_CHANNEL?.match(/^plugin:([^@]+)/)?.[1]
  if (app && env.HEX_THREAD) return `${app}:${env.HEX_THREAD}`
  return env.HEX_OWNER?.includes(':') ? env.HEX_OWNER : undefined
}

// The environment a background session's settings gave it: what its job passes to --settings, a
// file or the settings themselves.
function launched(flags: unknown): Record<string, string> {
  const at = Array.isArray(flags) ? flags.lastIndexOf('--settings') : -1
  const settings = at >= 0 && typeof flags[at + 1] === 'string' ? (flags[at + 1] as string) : ''
  const env = (settings.startsWith('{') ? parse(settings) : settings.startsWith('/') ? readFile(settings) : undefined)?.env
  return env && typeof env === 'object' ? Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}
}

function environ(pid: number): Record<string, string> {
  try {
    return Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]))
  } catch {
    return {}
  }
}

// The nearest other session above a process in the process tree.
function launcher(pid: number, sessions: Map<number, string>, self: string) {
  for (let above = parentOf(pid); above > 0; above = parentOf(above)) if (sessions.has(above) && sessions.get(above) !== self) return sessions.get(above)
}

function parentOf(pid: number) {
  return Number(stat(pid)?.[1]) || 0
}

// A process's /proc stat fields from its state on, past a name that may hold spaces.
function stat(pid: number) {
  try {
    const line = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return line.slice(line.lastIndexOf(')') + 2).split(' ')
  } catch {}
}

// Claude Code's sessions are this user's processes, so a pid this user can't signal is another's,
// and, where /proc can be read, one that started at another time than the record says (procStart)
// took over a dead session's pid, and a zombie is dead.
function alive(pid: unknown, procStart?: unknown) {
  try {
    if (!Number.isInteger(pid) || (pid as number) <= 0 || !process.kill(pid as number, 0)) return false
  } catch {
    return false
  }
  const fields = stat(pid as number)
  if (fields?.[0] === 'Z') return false
  return typeof procStart !== 'string' || !stat(process.pid) || fields?.[19] === procStart
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
    return parse(readFileSync(path, 'utf8'))
  } catch {}
}

// A JSON file, read only when it's a regular one: opened without blocking, so a pipe can't stall the read.
function readFile(path: string) {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    if (fstatSync(fd).isFile()) return parse(readFileSync(fd, 'utf8'))
  } catch {
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function parse(text: string) {
  try {
    return JSON.parse(text)
  } catch {}
}
