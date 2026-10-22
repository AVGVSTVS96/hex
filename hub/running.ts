import { readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Store } from './store.ts'

// A Claude Code session whose process runs, from the record Claude Code keeps of it while it lives
// (sessions/<pid>.json): its status (busy, shell, idle) and kind (bg for a background session), and
// a background session's job state (working, blocked on the owner, done), status line and what it
// needs, from jobs/<id>/state.json, and when Claude Code last changed its status, where it says. The
// thread it works for, as <app>:<key>, from the environment it started with (served), unless it's a
// background session: Claude Code's daemon starts those with its own environment, whoever started
// it. From hex's own record of its turns (hex.db's turns): when its latest turn began, and when that
// turn ended, if it has.
export type Session = { id: string; pid: number; status: string; state?: string; detail?: string; needs?: string; kind?: string; name?: string; cwd?: string; started: number; updated?: number; thread?: string; began?: string; ended?: string }

export const CLAUDE = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const BUSY = new Set(['busy', 'shell'])

export const busy = (session?: Session) => !!session && BUSY.has(session.status)
const busyness = (status: string) => (status === 'busy' ? 2 : status === 'shell' ? 1 : 0)

// Every running session by id. Two records of one session count as the busiest (mid-turn, then a
// shell still running, then anything else), and of two as busy, the newer.
export function running(store: Store, claude = CLAUDE): Map<string, Session> {
  const sessions = new Map<string, Session>()
  const dir = join(claude, 'sessions')
  for (const file of list(dir)) {
    const record = file.endsWith('.json') ? readJson(join(dir, file)) : undefined
    if (!record?.sessionId || !alive(record.pid)) continue
    const { sessionId: id, pid, status = 'idle', kind, name, cwd, startedAt: started = 0, statusUpdatedAt } = record
    const kept = sessions.get(id)
    if (kept && (busyness(kept.status) > busyness(status) || (busyness(kept.status) === busyness(status) && (kept.updated ?? kept.started) >= (statusUpdatedAt ?? started)))) continue
    const { state, detail, needs } = readJson(join(claude, 'jobs', id.slice(0, 8), 'state.json')) ?? {}
    const job = Object.fromEntries(Object.entries({ state, detail, needs }).filter(([, value]) => typeof value === 'string' && value))
    sessions.set(id, { id, pid, status, ...job, kind, name, cwd, started, ...(typeof statusUpdatedAt === 'number' && { updated: statusUpdatedAt }), thread: kind === 'bg' ? undefined : served(environ(pid)), ...store.turn(id) })
  }
  return sessions
}

// The thread a session works for, as <app>:<key>: the one it serves (held maps each thread's
// session to it), else the one it started for.
export const serving = (session: Session, held: Map<string, string>) => held.get(session.id) ?? session.thread

// The thread a process works for, as <app>:<key>: the one its hub started its session for, or its
// job's owner. A session started from another's shell has its environment, so works for it too.
export function served(env = process.env): string | undefined {
  const app = env.HEX_CHANNEL?.match(/^plugin:([^@]+)/)?.[1]
  if (app && env.HEX_THREAD) return `${app}:${env.HEX_THREAD}`
  return env.HEX_OWNER?.includes(':') ? env.HEX_OWNER : undefined
}

function environ(pid: number): Record<string, string> {
  try {
    return Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]))
  } catch {
    return {}
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
