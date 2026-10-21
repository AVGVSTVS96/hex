import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { zoneOf } from './schedule.ts'
import { asked, open, type NewRow, type Store } from './store.ts'

// Before hex.db kept hex's replies, each session's conversation was kept as markdown in log/. This
// brings those into hex.db once, so a thread's history has both sides: each turn under its session's
// thread, already taken and looked over for memories, and none that hex.db already has.
const HEAD = /^## (.+?) · (\w+) · (?:(\d{4}-\d{2}-\d{2}) )?(\d{1,2}):(\d{2})\n/gm
const OWNER = new Set(['me', 'hex app', 'hex call'])
// In log/, hex's replies are the assistant's; a turn written by "hex" is what hex told the session.
const authorOf = (who: string) => (OWNER.has(who) ? 'owner' : who === 'assistant' ? 'hex' : who === 'hex' ? 'prompt' : who)

export function importLogs(store: Store, dir: string, zone: string): number {
  const files = [join(dir, 'threads'), dir].flatMap(each => (existsSync(each) ? readdirSync(each).filter(name => name.endsWith('.md')).map(name => join(each, name)) : []))
  const threads = new Map<string, Map<string, number>>()
  // What hex.db kept, by thread and words, with when: a log turn is one of these only within a minute or two of it.
  const said = new Map<string, string[]>()
  for (const row of store.since()) {
    if (row.taken) threads.set(row.taken.by, (threads.get(row.taken.by) ?? new Map()).set(row.to, (threads.get(row.taken.by)?.get(row.to) ?? 0) + 1))
    const words = `${row.to}\n${(row.from === 't3' ? asked(row.body) : row.body).trim()}`
    said.set(words, [...(said.get(words) ?? []), row.at, ...(row.taken ? [row.taken.at] : [])])
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
    const to = [...(threads.get(id) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1])[0]?.[0] ?? id
    const heads = [...log.matchAll(HEAD)]
    const rows: [NewRow, string][] = []
    // log/ gives minutes, so a turn goes just after the one before it, which hex.db may have to the millisecond.
    let last = ''
    // Older logs give each turn only its time, so a turn earlier in the day than the one before it is the next day's.
    let today = Temporal.PlainDate.from(day)
    let clock = ''
    heads.forEach((head, i) => {
      const [, who, app, dated, hour, minute] = head as unknown as string[]
      const time = `${hour!.padStart(2, '0')}:${minute}`
      if (!dated && clock && time < clock) today = today.add({ days: 1 })
      clock = time
      const date = dated ?? today.toString()
      const body = log.slice(head.index! + head[0].length, heads[i + 1]?.index).trim()
      const author = authorOf(who!)
      const minuteAt = Temporal.PlainDateTime.from(`${date}T${time}`).toZonedDateTime(zone).toInstant().toString({ fractionalSecondDigits: 3 })
      const ats = author === 'hex' ? undefined : said.get(`${to}\n${(app === 't3' ? asked(body) : body).trim()}`)
      const near = ats?.findIndex(at => Math.abs(Date.parse(at) - Date.parse(minuteAt)) < 2 * 60_000) ?? -1
      const known = near >= 0 ? ats!.splice(near, 1)[0] : undefined
      if (known) last = known > last ? known : last
      const turn = `${to}\n${author}\n${minuteAt}\n${body}`
      // In Buzz, which is shared, log/ wrote every sender as "me", so only hex.db can say who it was.
      if (!body || seen.has(turn)) return
      seen.add(turn)
      if (known || (app === 'buzz' && author === 'owner')) return
      last = last && last >= minuteAt ? new Date(Date.parse(last) + 1).toISOString() : minuteAt
      rows.push([{ key: `${app}:past:${id}:${i}`, to, from: app!, author, body, meta: { log: file.slice(dir.length + 1) } }, last])
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
