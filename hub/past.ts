import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { zoneOf } from './schedule.ts'
import { asked, open, type Author, type NewRow, type Store } from './store.ts'

// Before hex.db kept hex's replies, each session's conversation was kept as markdown in log/. This
// brings those into hex.db once, so a thread's history has both sides: each turn under its session's
// thread, already taken and looked over for memories, and none that hex.db already has.
const HEAD = /^## (.+?) · (\w+) · (?:(\d{4}-\d{2}-\d{2}) )?(\d{1,2}):(\d{2})\n/gm
const OWNER = new Set(['me', 'hex app', 'hex call'])
// In log/, hex's replies are the assistant's, and any other sender (hex itself, a job, another
// thread) is hex telling the session.
const authorOf = (who: string): Author => (OWNER.has(who) ? 'owner' : who === 'assistant' ? 'hex' : 'prompt')

export function importLogs(store: Store, dir: string, zone: string): number {
  const files = [join(dir, 'threads'), dir].flatMap(each => (existsSync(each) ? readdirSync(each).filter(name => name.endsWith('.md')).map(name => join(each, name)) : []))
  const threads = new Map<string, Map<string, number>>()
  // A session that took nothing hex.db kept is still the session of its thread.
  const registered = new Map(store.threads().flatMap(({ thread, session }) => (session ? [[session, thread] as const] : [])))
  // What hex.db kept, by words, with where, when and by whom: a log turn is one of these only within a minute or two of it.
  const said = new Map<string, { to: string; at: string; by?: string }[]>()
  for (const row of store.since()) {
    if (row.taken) threads.set(row.taken.by, (threads.get(row.taken.by) ?? new Map()).set(row.to, (threads.get(row.taken.by)?.get(row.to) ?? 0) + 1))
    const words = (row.from === 't3' ? asked(row.body) : row.body).trim()
    const times = [row.at, ...(row.taken ? [row.taken.at] : [])].map(at => ({ to: row.to, at, by: row.taken?.by }))
    said.set(words, [...(said.get(words) ?? []), ...times])
  }
  // A session resumed or forked from another starts with its turns, so its log repeats them.
  const seen = new Set<string>()
  let added = 0
  store.write(() => {
    for (const file of files) {
      try {
        added += take(file)
      } catch (error) {
        process.stderr.write(`hex couldn't read ${file} into hex.db: ${error}\n`)
      }
    }
  })
  return added

  function take(file: string): number {
    const log = readFileSync(file, 'utf8')
    const session = log.match(/^# (\d{4}-\d{2}-\d{2}) · session (\S+)/)
    if (!session) return 0
    const [, day, id] = session as unknown as [string, string, string]
    // A session can serve more than one thread: each turn goes where the last turn this session took from hex.db was said.
    let to = [...(threads.get(id) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1])[0]?.[0] ?? registered.get(id) ?? id
    const heads = [...log.matchAll(HEAD)]
    // In an app's session, log/ also kept hex's notes in its terminal, which never reached the app.
    const inApp = heads.some(head => head[2] !== 'terminal')
    const rows: [NewRow, string][] = []
    // log/ gives minutes, so a turn goes just after the one before it, which hex.db may have to the millisecond.
    let last = ''
    // Older logs give each turn only its time, so a turn earlier in the day than the one before it is the next day's.
    let today = Temporal.PlainDate.from(day)
    let clock = ''
    heads.forEach((head, i) => {
      const [, who, via, dated, hour, minute] = head as unknown as string[]
      const time = `${hour!.padStart(2, '0')}:${minute}`
      if (!dated && clock && time < clock) today = today.add({ days: 1 })
      clock = time
      const date = dated ?? today.toString()
      const body = log.slice(head.index! + head[0].length, heads[i + 1]?.index).trim()
      const author = authorOf(who!)
      if (inApp && via === 'terminal' && author === 'hex') return
      const minuteAt = Temporal.PlainDateTime.from(`${date}T${time}`).toZonedDateTime(zone).toInstant().toString({ fractionalSecondDigits: 3 })
      const ats = author === 'hex' ? undefined : said.get((via === 't3' ? asked(body) : body).trim())
      const close = (each: { at: string }) => Math.abs(Date.parse(each.at) - Date.parse(minuteAt)) < 2 * 60_000
      const mine = ats?.findIndex(each => close(each) && each.by === id) ?? -1
      const near = mine >= 0 ? mine : (ats?.findIndex(each => close(each) && each.to === to) ?? -1)
      const known = near >= 0 ? ats!.splice(near, 1)[0] : undefined
      if (known) {
        to = known.to
        last = known.at > last ? known.at : last
      }
      const turn = `${to}\n${who}\n${minuteAt}\n${body}`
      // In Buzz, which is shared, log/ wrote every sender as "me", so only hex.db can say who it was.
      if (!body || seen.has(turn)) return
      seen.add(turn)
      if (known || (via === 'buzz' && author === 'owner')) return
      last = last && last >= minuteAt ? new Date(Date.parse(last) + 1).toISOString() : minuteAt
      rows.push([{ key: `${via}:past:${id}:${i}`, to, from: via!, author, body, meta: { log: file.slice(dir.length + 1), ...(author === 'prompt' && { user: who! }) } }, last])
    })
    const fresh = rows.filter(([row]) => store.deliver(row, id)).map(([row, at]) => [row.key, at] as [string, string])
    store.past(fresh)
    return fresh.length
  }
}

if (import.meta.main) {
  const home = process.argv[2]!
  const added = importLogs(open(join(home, 'state')), join(home, 'log'), zoneOf(home) ?? Temporal.Now.timeZoneId())
  if (added) console.log(`hex.db took in ${added} messages from log/`)
}
