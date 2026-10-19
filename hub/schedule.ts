import { readFileSync } from 'fs'
import { join } from 'path'
import { open } from './store.ts'

// A job in schedules.json wakes its thread (the main one, unless it names another) with
// "[name] prompt" at each minute its five-field cron names and at each "YYYY-MM-DD HH:MM" its at
// lists, on the owner's clock.
export type Job = { cron?: string; at?: string | string[]; thread?: string; prompt: string }

const FIELDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const
const PART = /^(\*|\d+(-\d+)?)(\/\d+)?$/
const AT = /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d$/
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MINUTE = 60_000

export function parse(text: string): Record<string, Job> {
  const jobs: Record<string, Job> = JSON.parse(text)
  for (const [name, job] of Object.entries(jobs)) {
    if (typeof job?.prompt !== 'string' || job.prompt === '') throw new Error(`${name}: prompt is missing`)
    if (job.cron === undefined && job.at === undefined) throw new Error(`${name}: it needs a cron or an at`)
    const fields = String(job.cron ?? '* * * * *').trim().split(/\s+/)
    if (fields.length !== 5 || !fields.every(field => field.split(',').every(part => PART.test(part)))) throw new Error(`${name}: "${job.cron}" is not a five-field cron expression`)
    if (![job.at ?? []].flat().every(at => typeof at === 'string' && AT.test(at))) throw new Error(`${name}: at must be "YYYY-MM-DD HH:MM", or a list of them`)
    if (job.thread !== undefined && typeof job.thread !== 'string') throw new Error(`${name}: thread must be a thread's id`)
  }
  return jobs
}

// A minute as a clock in the zone reads it.
type Wall = { minute: number; hour: number; day: number; month: number; weekday: number; at: string }

const clocks = new Map<string | undefined, Intl.DateTimeFormat>()

function wall(minute: number, zone?: string): Wall {
  let clock = clocks.get(zone)
  if (!clock) clocks.set(zone, (clock = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })))
  const part = Object.fromEntries(clock.formatToParts(minute * MINUTE).map(({ type, value }) => [type, value]))
  return { minute: Number(part.minute), hour: Number(part.hour), day: Number(part.day), month: Number(part.month), weekday: DAYS.indexOf(part.weekday!), at: `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}` }
}

function inField(spec: string, [min, max]: readonly [number, number], value: number) {
  return spec.split(',').some(part => {
    const [range = '', step = '1'] = part.split('/')
    const [from, to] = range.split('-')
    const lo = range === '*' ? min : Number(from)
    const hi = range === '*' || (to === undefined && part.includes('/')) ? max : Number(to ?? from)
    return value >= lo && value <= hi && (value - lo) % Number(step) === 0
  })
}

function onCron(cron: string, at: Wall) {
  const [minute = '', hour = '', monthDay = '', month = '', weekDay = ''] = cron.trim().split(/\s+/)
  const onMonthDay = inField(monthDay, FIELDS[2], at.day)
  const onWeekDay = inField(weekDay, FIELDS[4], at.weekday) || (at.weekday === 0 && inField(weekDay, FIELDS[4], 7))
  const onDay = monthDay !== '*' && weekDay !== '*' ? onMonthDay || onWeekDay : onMonthDay && onWeekDay
  return onDay && inField(minute, FIELDS[0], at.minute) && inField(hour, FIELDS[1], at.hour) && inField(month, FIELDS[3], at.month)
}

function due(job: Job, at: Wall) {
  return (job.cron !== undefined && onCron(job.cron, at)) || [job.at ?? []].flat().some(when => when.replace(' ', 'T') === at.at)
}

// The owner's time zone: TZ in the hex folder's .claude/settings.json, or else this machine's.
function zoneOf(hexDir: string): string | undefined {
  try {
    return JSON.parse(readFileSync(join(hexDir, '.claude', 'settings.json'), 'utf8')).env?.TZ || undefined
  } catch {
    return undefined
  }
}

// One check at minute now (since the epoch): each job's newest slot since the last check fires,
// which after the hub was down is the newest one it missed, marked late. The first check ever fires
// nothing, and a schedules.json that doesn't load fires nothing until it does, telling the main
// thread once what's wrong with it.
export function check(storeDir: string, hexDir: string, main: string, now = Math.floor(Date.now() / MINUTE)) {
  const store = open(storeDir)
  let text: string
  try {
    text = readFileSync(join(hexDir, 'schedules.json'), 'utf8')
  } catch {
    return store.check(now)
  }
  let jobs: Record<string, Job>
  try {
    jobs = parse(text)
  } catch (error) {
    const body = `[schedules] schedules.json no longer loads, so no job runs until it's fixed: ${(error as Error).message}`
    store.deliver({ key: `schedule:broken@${Bun.hash(text).toString(36)}`, to: main, from: 'schedule', body, meta: { user: 'schedule' } })
    return
  }
  const zone = zoneOf(hexDir)
  store.write(() => {
    const since = store.checked() ?? now
    const left = new Map(Object.entries(jobs))
    for (let minute = now; minute > since && left.size; minute--) {
      const at = wall(minute, zone)
      for (const [name, job] of left) {
        if (!due(job, at)) continue
        left.delete(name)
        store.fire(name, minute, job.thread ?? main, `[${name}] ${job.prompt}`, minute < now)
      }
    }
    store.check(now)
  })
}

// The hub's scheduler: a check at its start, then at the top of every minute.
export function schedule(storeDir: string, hexDir: string, main: string): () => void {
  let timer: ReturnType<typeof setTimeout>
  const tick = () => {
    try {
      check(storeDir, hexDir, main)
    } catch (error) {
      process.stderr.write(`hub: the scheduler couldn't check schedules.json: ${error}\n`)
    }
    timer = setTimeout(tick, MINUTE - (Date.now() % MINUTE))
  }
  tick()
  return () => clearTimeout(timer)
}
