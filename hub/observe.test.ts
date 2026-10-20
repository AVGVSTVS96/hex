import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { clock, drain, observe, type Answer } from './observe.ts'
import { about, profile, profileOf } from './profile.ts'
import { open } from './store.ts'

let dir: string
const none: Answer = { notes: [], profile: null }
let memo: string
const noted = () => (existsSync(join(dir, 'noted')) ? readFileSync(join(dir, 'noted'), 'utf8').trim().split('\n') : [])

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'observe-'))
  memo = join(dir, 'memo')
  writeFileSync(join(dir, 'memories'), '#1 2026-10-19 Oct 19 9pm: the owner wants "the login page fixed first" [telegram:-100:40]\n')
  writeFileSync(memo, `#!/bin/sh\ncase "$1" in\n  note) printf '%s\\n' "$2" >> "${dir}/noted" ;;\n  recall) grep -E -- "$2" "${dir}/memories" ;;\nesac\n`)
  chmodSync(memo, 0o755)
  const store = open(dir)
  store.deliver({ key: 'telegram:-100:40', to: '-100:7', from: 'telegram', body: 'get the login page fixed first', meta: { user_id: '1' } })
  store.deliver({ key: 'telegram:-100:50', to: '-100:7', from: 'telegram', body: 'ship it on fridays only, my team reviews thursdays', meta: { user_id: '1', ts: '2026-10-20T06:31:00.000Z' } })
  store.deliver({ key: 'schedule:nightly:1', to: '-100:7', from: 'schedule', body: '[nightly] run the backup', meta: {} })
  for (const key of ['telegram:-100:40', 'telegram:-100:50', 'schedule:nightly:1']) store.take(key, 's')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test("the turn's messages reach the pass, which writes notes for the owner's no note names yet", async () => {
  const seen: string[] = []
  const ask = async (input: string) => {
    seen.push(input)
    return { notes: ['Oct 19 11:31pm: ships "on fridays only, my team reviews thursdays" [telegram:-100:50]'], profile: null }
  }
  expect(await observe(dir, 's', 'Done, Friday deploys only.', { ask, memo })).toHaveLength(1)
  expect(seen[0]).toContain('[telegram:-100:50]')
  expect(seen[0]).toContain("The session's reply:\nDone, Friday deploys only.")
  expect(seen[0]).toContain('get the login page fixed first\n(a note already names this message: write no note for it)')
  expect(seen[0]).toContain('From schedule, not the owner,')
  expect(seen[0]).toContain('[nightly] run the backup')
  expect(noted()).toEqual(['Oct 19 11:31pm: ships "on fridays only, my team reviews thursdays" [telegram:-100:50]'])
  expect(await observe(dir, 's', '', { ask, memo })).toEqual([])
  expect(seen).toHaveLength(1)
})

test("a note that misquotes the owner, quotes without naming the message, or doesn't fit isn't written, one about what happened needs neither, and one is written without the date memo adds", async () => {
  const ask = async () => ({ profile: null, notes: [
    'Oct 19: ships "only on fridays" [telegram:-100:50]',
    'Oct 19: ships "on fridays only"',
    'Oct 19: the nightly backup ran',
    `Oct 19: "ship it on fridays only" ${'x'.repeat(280)} [telegram:-100:50]`,
    '2026-10-19 Oct 19: "ship it on fridays only" [telegram:-100:50]',
  ] })
  expect(await observe(dir, 's', '', { ask, memo })).toEqual(['Oct 19: the nightly backup ran', 'Oct 19: "ship it on fridays only" [telegram:-100:50]'])
  expect(noted()).toHaveLength(2)
})

test('a pass that fails hands its messages to the next one, and one that died does once its lease runs out', async () => {
  const fail = async (): Promise<Answer> => {
    throw new Error('limit')
  }
  expect(await observe(dir, 's', '', { ask: fail, memo })).toEqual([])
  let asked = 0
  const count = async () => (asked++, none)
  await observe(dir, 's', '', { ask: count, memo })
  expect(asked).toBe(1)

  const store = open(dir)
  store.deliver({ key: 'telegram:-100:60', to: '-100:7', from: 'telegram', body: 'move standup to 10', meta: { user_id: '1' } })
  store.take('telegram:-100:60', 's')
  expect(store.observe('s', new Date().toISOString()).map(row => row.key)).toEqual(['telegram:-100:60'])
  expect(store.observe('s', new Date().toISOString())).toEqual([])
  await Bun.sleep(2)
  expect(store.observe('s', new Date().toISOString(), undefined, 0).map(row => row.key)).toEqual(['telegram:-100:60'])
})

test("a pass takes what the session had taken when its turn ended, not the next turn's message", async () => {
  const by = new Date().toISOString()
  await Bun.sleep(2)
  const store = open(dir)
  store.deliver({ key: 'telegram:-100:70', to: '-100:7', from: 'telegram', body: 'and add a dark mode', meta: { user_id: '1' } })
  store.take('telegram:-100:70', 's')
  const seen: string[] = []
  await observe(dir, 's', '', { ask: async input => (seen.push(input), none), memo, by })
  expect(seen[0]).toContain('[telegram:-100:50]')
  expect(seen[0]).not.toContain('dark mode')
  await observe(dir, 's', '', { ask: async input => (seen.push(input), none), memo })
  expect(seen[1]).toContain('and add a dark mode')
})

test("a later session in the thread takes what an earlier one's pass left", async () => {
  const fail = async (): Promise<Answer> => {
    throw new Error('limit')
  }
  await observe(dir, 's', '', { ask: fail, memo })
  const seen: string[] = []
  await observe(dir, 't', '', { ask: async input => (seen.push(input), none), memo, thread: '-100:7' })
  expect(seen[0]).toContain('[telegram:-100:50]')
})

test("a note may only name this pass's messages", async () => {
  const ask = async () => ({ notes: ['Oct 19: "get the login page fixed first" [telegram:-100:40]', 'Oct 19: "run the backup" [schedule:nightly:1]'], profile: null })
  expect(await observe(dir, 's', '', { ask, memo })).toEqual([])
})

test('the profile is rewritten to the current truth, and one that misquotes the owner goes back to be fixed', async () => {
  const profile = '# Always\n- Ships "on fridays only" [telegram:-100:50]\n\n# Now\n- Login page first'
  const seen: string[] = []
  await observe(dir, 's', '', { ask: async input => (seen.push(input), { notes: [], profile }), memo })
  expect(seen[0]).toContain('<profile>\n(none yet)\n</profile>')
  expect(profileOf(dir)).toBe(profile)

  const store = open(dir)
  store.deliver({ key: 'telegram:-100:80', to: '-100:7', from: 'telegram', body: 'actually ship any day now', meta: { user_id: '1' } })
  store.take('telegram:-100:80', 's')
  const answers = ['# Always\n- Ships "whenever" [telegram:-100:80]', '# Always\n- Ships "any day now" [telegram:-100:80]']
  const asked: string[] = []
  await observe(dir, 's', '', { ask: async input => (asked.push(input), { notes: [], profile: answers.shift()! }), memo })
  expect(asked[1]).toContain("Your last profile wasn't kept")
  expect(asked[1]).toContain('- Ships "whenever" [telegram:-100:80]')
  expect(profileOf(dir)).toBe('# Always\n- Ships "any day now" [telegram:-100:80]')
})

test("a profile line may only quote the owner, by the key of the message it quotes", async () => {
  const answers = ['# Always\n- Wants "the login page fixed first"', '# Now\n- "run the backup" [schedule:nightly:1]', '# Always\n- Ships "on fridays only" [telegram:-100:50]']
  const asked: string[] = []
  await observe(dir, 's', '', { ask: async input => (asked.push(input), { notes: [], profile: answers.shift()! }), memo })
  expect(asked[1]).toContain("names no message of the owner's for its quote")
  expect(asked[2]).toContain("[schedule:nightly:1] isn't the owner's message")
  expect(profileOf(dir)).toBe('# Always\n- Ships "on fridays only" [telegram:-100:50]')
})

test('a session sees the whole profile once, then only the lines that changed', () => {
  expect(about('', '# Always\n- a')).toContain('# Always\n- a')
  const kept = `- ${'a'.repeat(200)}`
  expect(about(`# Always\n${kept}\n- b`, `# Always\n${kept}\n- c`)).toBe("My profile changed, as the memory agent keeps it current from my own words:\n# Always\n- c\nNo longer in it:\n# Always\n- b")
  expect(about(`# Always\n${kept}\n# Now\n- b`, `# Always\n${kept}\n- b\n# Now`)).toContain('# Always\n- b\nNo longer in it:\n# Now\n- b')
  expect(about('# Always\n- b', '# Always for now\n- b')).toContain("Who I am")
  expect(about('# Always\n- b', '')).toBe('My profile was cleared: what it said no longer stands.')
  expect(about('# Always\n- b', '# Always\n- c')).toBe("Who I am and what's going on now, kept current by the memory agent from my own words:\n\n# Always\n- c")
})

test('a profile that kept misquoting is logged and its turn is done, so it costs no more calls', async () => {
  const asked: string[] = []
  await observe(dir, 's', '', { ask: async input => (asked.push(input), { notes: [], profile: '# Always\n- Wants "whatever" [telegram:-100:50]' }), memo })
  expect(profileOf(dir)).toBe('')
  await observe(dir, 's', '', { ask: async input => (asked.push(input), none), memo })
  expect(asked).toHaveLength(3)
})

test('a time reads the way notes write it, on the owner’s clock', () => {
  expect(clock('2026-10-20T06:31:00.000Z', 'America/Los_Angeles')).toBe('Oct 19 11:31pm')
  expect(clock('2026-10-20T19:05:00.000Z', 'America/Los_Angeles')).toBe('Oct 20 12:05pm')
})

test('a turn that took no message still gets a pass from its reply, and a retry writes no note twice', async () => {
  await observe(dir, 's', '', { ask: async () => none, memo })
  let asked = 0
  const ask = async (): Promise<Answer> => (asked++, { notes: ['Oct 20: deck redo shipped'], profile: '- Wants "whatever" [telegram:-100:50]' })
  expect(await observe(dir, 's', 'Shipped the deck redo.', { ask, memo })).toEqual(['Oct 20: deck redo shipped'])
  expect(asked).toBe(3)
  expect(noted()).toEqual(['Oct 20: deck redo shipped'])
})

test('turns wait in hex.db and one drainer works through them oldest first, while a lease is held the turn waits for its holder', async () => {
  const store = open(dir)
  const seen: string[] = []
  store.wait({ session: 'a', reply: '', by: '' })
  store.wait({ session: 'b', reply: '', by: '' })
  await Promise.all([drain(dir, async pass => void seen.push(pass.session)), drain(dir, async pass => void seen.push(`2${pass.session}`))])
  expect(seen).toEqual(['a', 'b'])
  expect(store.waiting()).toBeUndefined()

  expect(store.lease('observe', 'other', 60_000)).toBe(true)
  store.wait({ session: 'c', reply: '', by: '' })
  await drain(dir, async pass => void seen.push(pass.session))
  expect(store.waiting()?.pass).toEqual({ session: 'c', reply: '', by: '' })
  store.release('observe', 'other')
  expect(store.lease('observe', 'dead', 0)).toBe(true)
  await Bun.sleep(2)
  await drain(dir, async pass => void seen.push(pass.session))
  expect(seen).toEqual(['a', 'b', 'c'])
})
