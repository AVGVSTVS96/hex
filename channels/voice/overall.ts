import { realpathSync } from 'fs'
import { basename, join } from 'path'
import type { Session } from '../../hub/running.ts'
import type { Run } from './board.ts'
import { clip, type Question } from './questions.ts'

// A bin/job unit running now: its name, the thread it's for (<app>:<key>) and when it started.
export type Job = { unit: string; owner: string; since: number }

const SHOWN = 8

// Every bin/job unit running now, found as `hex status` finds them: a user service whose stop
// runs bin/job --ended, which names the unit's thread.
export async function jobs(): Promise<Job[]> {
  const job = join(import.meta.dir, '..', '..', 'bin', 'job')
  const units = (await systemctl('list-units', '--type=service', '--state=running', '--no-legend', '--plain'))
    .split('\n')
    .map(line => line.split(/\s/)[0]!)
    .filter(Boolean)
  return units.length ? jobsOf(await systemctl('show', ...units, '-p', 'Id,ActiveEnterTimestamp,ExecStopPost'), real(job)) : []
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

// Everything hex runs, as the call says it: what waits on the caller (threads blocked on them, and
// the questions hex keeps for them that no such thread asked), then each thread at work with its
// newest step and the agents working for it, each job no session at work on the board runs for, and
// busy sessions no thread holds. The call's own thread counts only for the agents it runs.
export function overall(runs: Run[], strays: Session[], jobs: Job[], names: Record<string, string>, now = Date.now(), asks: Pick<Question, 'task' | 'question'>[] = []) {
  // A job's Claude Code session is named <thread>/<unit>; one that has stopped working, but whose
  // run still keeps it among its agents, says nothing of whether the job still runs.
  const shown = new Set(
    runs
      .filter(run => run.state === 'working' || run.state === 'needs')
      .flatMap(run => [run.name, ...run.agents.filter(agent => agent.state === 'working').map(agent => agent.label)])
      .concat(strays.flatMap(one => one.name ?? [])),
  )
  const needs = runs.filter(run => run.state === 'needs')
  const asked = asks.filter(ask => !needs.some(run => run.id === ask.task))
  const lines = [
    ...needs.map(run => `${place(run)} waits on you${(run.needs ?? run.line) ? `: ${run.needs ?? run.line}` : ''}`),
    ...(asked.length ? [`${asked.length === 1 ? 'A question waits' : `${asked.length} questions wait`} on you${asked.length === 1 ? '' : ', the first'}: ${clip(asked[0]!.question.replace(/\s+/g, ' ').trim(), 140)}`] : []),
    ...runs.filter(run => run.state === 'working').flatMap(run => {
      const agents = run.agents.filter(agent => agent.state === 'working')
      if (run.app === 'voice') return agents.length ? [`This call's agents: ${agents.map(agent => agent.label).join(', ')}`] : []
      const line = agents.find(agent => agent.line)?.line ?? run.line
      return [`${place(run)}, working for ${lasted(Date.parse(run.since), now)}${line ? `: ${line}` : ''}${agents.length ? `; ${agentsOf(agents.map(agent => agent.label))}` : ''}`]
    }),
    ...jobs
      .filter(job => ![...shown].some(name => name.endsWith(`/${job.unit}`)))
      .map(job => {
        const thread = names[job.owner.slice(job.owner.indexOf(':') + 1)]
        return `The job ${job.unit}${thread ? ` for ${thread}` : ''}, running for ${lasted(job.since, now)}`
      }),
    ...strays.map(one => {
      const where = one.cwd && basename(one.cwd)
      const what = one.name ? `${one.name}, a Claude Code session outside any thread` : `A Claude Code session${where ? ` in ${where}` : ''} outside any thread`
      return `${what}, busy for ${lasted(one.updated ?? one.started, now)}`
    }),
  ]
  if (!lines.length) return 'Nothing is running anywhere in hex right now.'
  const working = runs.filter(run => run.state === 'working' && run.app !== 'voice').length
  const waiting = needs.length + asked.length
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

// Off the event loop, which carries a phone call's audio both ways; with timestamps in UTC, since
// systemctl writes them in the local zone's abbreviation, which Date.parse can't read for most zones (CET, JST).
async function systemctl(...args: string[]) {
  try {
    const run = Bun.spawn(['systemctl', '--user', ...args], { stdout: 'pipe', stderr: 'ignore', env: { ...process.env, TZ: 'UTC' }, timeout: 5000 })
    const [out, code] = await Promise.all([new Response(run.stdout).text(), run.exited])
    return code === 0 ? out : ''
  } catch {
    return ''
  }
}
