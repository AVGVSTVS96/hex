import type { EngineInterface, Register } from 'claude-code'

type Job = { cron: string; prompt: string }

const FIELDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const
const PART = /^(\*|\d+(-\d+)?)(\/\d+)?$/
const MINUTE = 60_000

let path = ''
let checked = 0
const queued = new Set<string>()

function parse(text: string) {
  const jobs: Record<string, Job> = JSON.parse(text)
  for (const [name, job] of Object.entries(jobs)) {
    const fields = String(job.cron).trim().split(/\s+/)
    if (fields.length !== 5 || !fields.every(field => field.split(',').every(part => PART.test(part))))
      throw new Error(`${name}: "${job.cron}" is not a five-field cron expression`)
    if (typeof job.prompt !== 'string' || job.prompt === '') throw new Error(`${name}: prompt is missing`)
  }
  return jobs
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

function isDue(cron: string, at: Date) {
  const [minute = '', hour = '', monthDay = '', month = '', weekDay = ''] = cron.trim().split(/\s+/)
  const onMonthDay = inField(monthDay, FIELDS[2], at.getDate())
  const onWeekDay = inField(weekDay, FIELDS[4], at.getDay()) || (at.getDay() === 0 && inField(weekDay, FIELDS[4], 7))
  const onDay = monthDay !== '*' && weekDay !== '*' ? onMonthDay || onWeekDay : onMonthDay && onWeekDay
  return onDay
    && inField(minute, FIELDS[0], at.getMinutes())
    && inField(hour, FIELDS[1], at.getHours())
    && inField(month, FIELDS[3], at.getMonth() + 1)
}

function submit($: EngineInterface, name: string, prompt: string) {
  if (queued.has(name)) return
  queued.add(name)
  $.prompt.submit({ text: `[${name}] ${prompt}` })
    .catch(error => $.ui.status(`${name}: ${(error as Error).message}`))
    .finally(() => queued.delete(name))
}

async function tick($: EngineInterface) {
  const since = checked
  checked = Math.floor((await $.clock.now()) / MINUTE)
  let jobs: Record<string, Job>
  try {
    jobs = parse(await $.fs.read(path))
  } catch (error) {
    $.ui.status(`schedules.json: ${(error as Error).message}`)
    return
  }
  $.ui.status(undefined)
  for (const [name, job] of Object.entries(jobs)) {
    for (let minute = since + 1; minute <= checked; minute++) {
      if (isDue(job.cron, new Date(minute * MINUTE))) {
        submit($, name, job.prompt)
        break
      }
    }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    path = `${e.cwd}/schedules.json`
    checked = Math.floor((await $.clock.now()) / MINUTE)
    $.clock.every(MINUTE, () => tick($))
    return next(e)
  })

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const ran = await next(e)
    if (e.file_path !== path || ran.deny !== undefined || ran.isError) return ran
    try {
      parse(await $.fs.read(path))
      return ran
    } catch (error) {
      return { ...ran, context: [`schedules.json no longer loads, so no job runs until it's fixed: ${(error as Error).message}`] }
    }
  })
}
