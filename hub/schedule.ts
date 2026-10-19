import { readFileSync } from 'fs'
import { join } from 'path'
import { open, type Store } from './store.ts'

// A job in schedules.json wakes its thread (the main one, unless it names another) with
// "[name] prompt" at each minute its five-field cron names and at each "YYYY-MM-DD HH:MM" its at
// lists, on the owner's clock. A job with a task fires only while that task is open.
export type Job = { cron?: string; at?: string | string[]; thread?: string; task?: string; prompt: string }

const FIELDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const
const PART = /^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/
const AT = /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d$/
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MINUTE = 60_000

// A part of a cron field names values inside the field's bounds, low to high, every step of one or more.
function fits(part: string, [min, max]: readonly [number, number]) {
  const match = PART.exec(part)
  if (!match) return false
  const [, from = String(min), to = from, step = '1'] = match
  return Number(from) >= min && Number(to) <= max && Number(from) <= Number(to) && Number(step) > 0
}

function isCron(cron: unknown) {
  const fields = typeof cron === 'string' ? cron.trim().split(/\s+/) : []
  return fields.length === 5 && fields.every((field, index) => field.split(',').every(part => fits(part, FIELDS[index]!)))
}

function isAt(at: unknown) {
  try {
    return typeof at === 'string' && AT.test(at) && !!Temporal.PlainDateTime.from(at)
  } catch {
    return false
  }
}

export function parse(text: string): Record<string, Job> {
  const jobs: Record<string, Job> = JSON.parse(text)
  for (const [name, job] of Object.entries(jobs)) {
    if (typeof job?.prompt !== 'string' || job.prompt === '') throw new Error(`${name}: prompt is missing`)
    if (job.cron === undefined && job.at === undefined) throw new Error(`${name}: it needs a cron or an at`)
    if (job.cron !== undefined && !isCron(job.cron)) throw new Error(`${name}: ${JSON.stringify(job.cron)} is not a five-field cron expression`)
    if (![job.at ?? []].flat().every(isAt)) throw new Error(`${name}: at must be "YYYY-MM-DD HH:MM", or a list of them`)
    if (job.thread !== undefined && typeof job.thread !== 'string') throw new Error(`${name}: thread must be a thread's id`)
    if (job.task !== undefined && (typeof job.task !== 'string' || !/^t-\d+$/.test(job.task))) throw new Error(`${name}: task must be a task's id, like t-12`)
  }
  return jobs
}

// A minute as a clock in the zone reads it.
type Wall = { minute: number; hour: number; day: number; month: number; weekday: number }

const clocks = new Map<string | undefined, Intl.DateTimeFormat>()

function wall(minute: number, zone?: string): Wall {
  let clock = clocks.get(zone)
  if (!clock) clocks.set(zone, (clock = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', weekday: 'short', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })))
  const part = Object.fromEntries(clock.formatToParts(minute * MINUTE).map(({ type, value }) => [type, value]))
  return { minute: Number(part.minute), hour: Number(part.hour), day: Number(part.day), month: Number(part.month), weekday: DAYS.indexOf(part.weekday!) }
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

// The minute an at comes on the owner's clock, read as Temporal reads a wall time: the first of
// the two when clocks go back, and as far past the jump as it was set when they skip it.
function minuteOf(at: string, zone = Temporal.Now.timeZoneId()) {
  return Temporal.PlainDateTime.from(at).toZonedDateTime(zone).epochMilliseconds / MINUTE
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
// nothing, and a schedules.json that can't be read or doesn't load fires nothing until it does,
// telling the main thread once what's wrong with one that doesn't load. An at is its own minute;
// only a cron is looked for minute by minute, back from now, before the store is held for the write.
export function check(storeDir: string, hexDir: string, main: string, now = Math.floor(Date.now() / MINUTE)) {
  const store = open(storeDir)
  let text: string
  try {
    text = readFileSync(join(hexDir, 'schedules.json'), 'utf8')
  } catch {
    return
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
  const since = store.checked() ?? now
  const slots = new Map<string, number>()
  const found = (name: string, minute: number) => {
    if (minute > since && minute <= now && minute > (slots.get(name) ?? -Infinity)) slots.set(name, minute)
  }
  for (const [name, job] of Object.entries(jobs)) for (const at of [job.at ?? []].flat()) found(name, minuteOf(at, zone))
  const left = new Map(Object.entries(jobs).filter(([, job]) => job.cron !== undefined))
  for (let minute = now; minute > since && left.size; minute--) {
    const at = wall(minute, zone)
    for (const [name, job] of left) {
      if (!onCron(job.cron!, at)) continue
      left.delete(name)
      found(name, minute)
    }
  }
  store.write(() => {
    for (const [name, minute] of slots) if (!jobs[name]!.task || standing(store, jobs[name]!.task!)) store.fire(name, minute, jobs[name]!.thread ?? main, `[${name}] ${jobs[name]!.prompt}`, minute < now)
    store.check(now)
  })
}

// The task, or the one it was merged into, is still open.
function standing(store: Store, id: string) {
  let task = store.task(id)
  while (task?.mergedInto) task = store.task(task.mergedInto)
  return task?.status === 'open'
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
