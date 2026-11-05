import { realpathSync } from 'fs'
import { join } from 'path'
import type { Session } from '../../hub/running.ts'
import type { Run } from './board.ts'

// A bin/job unit running now: its name, the thread it's for (<app>:<key>) and when it started.
export type Job = { unit: string; owner: string; since: number }

const SHOWN = 8

// Every bin/job unit running now, found as `hex status` finds them: a user service whose stop
// runs bin/job --ended, which names the unit's thread.
export function jobs(): Job[] {
  const job = join(import.meta.dir, '..', '..', 'bin', 'job')
  const units = systemctl('list-units', '--type=service', '--state=running', '--no-legend', '--plain')
    .split('\n')
    .map(line => line.split(/\s/)[0]!)
    .filter(Boolean)
  return units.length ? jobsOf(systemctl('show', ...units, '-p', 'Id,ActiveEnterTimestamp,ExecStopPost'), real(job)) : []
}

export function jobsOf(shown: string, job: string): Job[] {
  return shown.split('\n\n').flatMap(unit => {
    const field = (name: string) => unit.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1] ?? ''
    const stop = field('ExecStopPost')
    const mark = ` ${job} --ended `
    const at = stop.indexOf(mark)
    const [name, owner] = at < 0 ? [] : stop.slice(at + mark.length).split(' ')
    return name && owner ? [{ unit: name, owner, since: Date.parse(field('ActiveEnterTimestamp')) || 0 }] : []
  })
}

// Everything hex runs, as the call says it: what waits on the caller, then each thread at work with
// its newest step and the agents working for it, each job the board shows no session for, and
// busy sessions no thread holds. The call's own thread counts only for the agents it runs.
export function overall(runs: Run[], strays: Session[], jobs: Job[], names: Record<string, string>, now = Date.now()) {
  const shown = new Set(runs.flatMap(run => [run.name, ...run.agents.map(agent => agent.label)]).concat(strays.flatMap(one => one.name ?? [])))
  const lines = [
    ...runs.filter(run => run.state === 'needs').map(run => `${place(run)} waits on you${(run.needs ?? run.line) ? `: ${run.needs ?? run.line}` : ''}`),
    ...runs.filter(run => run.state === 'working').flatMap(run => {
      const agents = run.agents.filter(agent => agent.state === 'working')
      if (run.app === 'voice') return agents.length ? [`This call's agents: ${agents.map(agent => agent.label).join(', ')}`] : []
      const line = agents.find(agent => agent.line)?.line ?? run.line
      return [`${place(run)}, working for ${lasted(Date.parse(run.since), now)}${line ? `: ${line}` : ''}${agents.length ? `; ${agentsOf(agents.map(agent => agent.label))}` : ''}`]
    }),
    ...jobs
      .filter(job => ![...shown].some(name => name.endsWith(`/${job.unit}`)))
      .map(job => `The job ${job.unit} for ${names[job.owner.slice(job.owner.indexOf(':') + 1)] ?? job.owner}, running for ${lasted(job.since, now)}`),
    ...strays.map(one => `${one.name ?? one.id.slice(0, 8)}, a Claude Code session outside any thread, busy for ${lasted(one.updated ?? one.started, now)}`),
  ]
  if (!lines.length) return 'Nothing is running anywhere in hex right now.'
  const working = runs.filter(run => run.state === 'working' && run.app !== 'voice').length
  const waiting = runs.filter(run => run.state === 'needs').length
  const counts = [working && `${count(working, 'thread')} working`, waiting && `${waiting} waiting on you`].filter(Boolean).join(', ')
  const more = lines.length > SHOWN ? [`and ${lines.length - SHOWN} more`] : []
  return [`Everything hex is running${counts ? `, ${counts}` : ''}:`, ...lines.slice(0, SHOWN).map(line => `- ${line}`), ...more].join('\n')
}

function place(run: Run) {
  return run.where === run.name || run.app === 'claude' ? run.name : `${run.name} (${run.where})`
}

function agentsOf(labels: string[]) {
  const named = labels.slice(0, 3).join(', ')
  return `${labels.length === 1 ? 'an agent' : `${labels.length} agents`}: ${named}${labels.length > 3 ? ' and more' : ''}`
}

// How long since a moment, as said aloud.
export function lasted(since: number, now = Date.now()) {
  if (!since) return 'a while'
  const minutes = Math.max(1, Math.round((now - since) / 60_000))
  const hours = Math.round(minutes / 60)
  return minutes < 60 ? count(minutes, 'minute') : hours < 48 ? count(hours, 'hour') : count(Math.round(hours / 24), 'day')
}

function count(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function real(path: string) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function systemctl(...args: string[]) {
  try {
    const { stdout, success } = Bun.spawnSync(['systemctl', '--user', ...args], { stderr: 'ignore', timeout: 5000 })
    return success ? stdout.toString() : ''
  } catch {
    return ''
  }
}
