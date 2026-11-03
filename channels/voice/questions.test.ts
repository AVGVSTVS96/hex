import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { Questions, fromLedger } from './questions.ts'
import { before, vet } from './check.ts'
import { T3 } from './t3.ts'
import { until } from '../../hub/until.ts'
import type { Pin, Question } from '../../hub/ledger.ts'
import { open } from '../../hub/store.ts'

const GROUP = '-1001234'
const DESK = `${GROUP}:5`
let state: string
let questions: Questions
let hub: Server
let lines: any[]
let checks: string[]

function ledger(kept: Omit<Question, 'app'>[], pins: Record<string, Omit<Pin, 'app' | 'thread' | 'note'> & { note?: string }> = {}) {
  const store = open(state)
  store.write(() => {
    store.db.run('delete from questions')
    store.db.run('delete from pins')
    for (const question of kept) store.ask({ app: 'telegram', ...question })
    for (const [thread, pin] of Object.entries(pins)) store.pinned({ app: 'telegram', thread, note: pin.text, ...pin })
  })
}

function asked(message: number, text: string, options: string[], fields: Partial<Question> = {}) {
  return { thread: DESK, message, text, options, at: `2026-10-13T1${message % 10}:00:00.000Z`, ...fields }
}

beforeEach(async () => {
  state = mkdtempSync(join(tmpdir(), 'questions-'))
  mkdirSync(join(state, 'telegram'))
  mkdirSync(join(state, 'voice'))
  open(state).keepThreads('telegram', { [GROUP]: { name: 'hex', link: 'https://t.me/c/1234/1' }, [DESK]: { name: 'desk', link: 'https://t.me/c/1234/5' } })
  lines = []
  checks = []
  hub = createServer(socket => {
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => lines.push(...chunk.trim().split('\n').map(line => JSON.parse(line))))
  })
  await new Promise<void>(resolve => hub.listen(join(state, 'telegram', 'hub.sock'), resolve))
})

afterEach(() => {
  questions?.close()
  hub.close()
  rmSync(state, { recursive: true, force: true })
})

test('a question asked with buttons reads as its first line, its context and the pick its thread marked', () => {
  const question = fromLedger('telegram', asked(1, '**Music for the Saves video?**\n\nThree new takes, no cost.\n```\nA  Deep\n```', ['Deep (my pick)', 'French touch', 'Minimal']))
  expect(question).toMatchObject({
    id: `telegram:${DESK}:1`,
    kind: 'pick',
    task: `telegram:${DESK}`,
    question: 'Music for the Saves video?',
    context: 'Three new takes, no cost.',
    options: [{ label: 'Deep', value: 'Deep (my pick)', pick: true }, { label: 'French touch', value: 'French touch' }, { label: 'Minimal', value: 'Minimal' }],
  })
})

test('a question keeps all of its context, line by line, so the app can open the rest', () => {
  const context = `- A: ${'what it costs. '.repeat(20).trim()}\n- B: what it takes away.`
  expect(fromLedger('telegram', asked(1, `Ship it?\n${context}`, ['Yes', 'No'])).context).toBe(context)
})

test('a long first line ends at its last sentence that fits, and the rest opens its context whole', () => {
  const first = 'The line graphic next to each project in Tasks (you picked it Oct 15/18) has been deleted since you underlined it. What did you mean? My pick: bring it back, drawn cleanly.'
  const question = fromLedger('telegram', asked(1, `${first}\nMore.`, ['A', 'B']))
  expect(question.question).toBe('The line graphic next to each project in Tasks (you picked it Oct 15/18) has been deleted since you underlined it. What did you mean?')
  expect(question.context).toBe('My pick: bring it back, drawn cleanly.\nMore.')
})

test('a long first line ends at its last question that fits, however short', () => {
  const question = fromLedger('telegram', asked(1, `Should we ship tonight? ${'The redesign brings a calmer palette and bigger type. '.repeat(3).trim()}`, ['Yes', 'No']))
  expect(question.question).toBe('Should we ship tonight?')
  expect(question.context!.startsWith('The redesign')).toBe(true)
})

test('a long first line with no sentence end is cut at a word, and the rest opens its context', () => {
  const first = `Which way ${'one option costs this and the other takes that away '.repeat(4).trim()}`
  const question = fromLedger('telegram', asked(1, `${first}\nMore.`, ['A', 'B']))
  const [shown, rest] = [question.question.slice(0, -1), question.context!.split('\n')[0]!.slice(1)]
  expect(question.question.length).toBeLessThanOrEqual(160)
  expect(`${shown} ${rest}`).toBe(first)
  expect(question.context!.endsWith('\nMore.')).toBe(true)
})

test('a long first line is cut at a word when its only sentence end is an abbreviation, too early, or would leave the question out', () => {
  const tail = 'and here the line keeps going well past the limit with plenty of words to spare for the cut'
  for (const first of [
    `Ship the redesign with the calmer palette and the bigger type, e.g. Inter at sixteen points ${tail}`,
    `Ok. Ship the redesign with the calmer palette and the bigger type and the new spacing ${tail}`,
    `The redesign has a calmer palette and bigger type. ${'It also changes the spacing everywhere. '.repeat(2)}Ship it tonight ${tail}?`,
  ]) {
    const question = fromLedger('telegram', asked(1, first, ['A', 'B']))
    expect(question.question.endsWith('…')).toBe(true)
    expect(`${question.question.slice(0, -1)} ${question.context!.slice(1)}`).toBe(first)
  }
})

test('a short first line that ends in an ellipsis keeps no context of its own', () => {
  expect(fromLedger('telegram', asked(1, 'Ship it…', ['Yes', 'No'])).context).toBeUndefined()
})

// Messages kept in DESK on Oct 13, each at its time ('18:01:00') and with its id in the chat.
type Said = [string, string, Partial<{ id: number; author: 'hex' | 'owner'; to: string; meta: Record<string, string> }>?]
function said(lines: Said[]) {
  const store = open(state)
  const key = (n: number, id?: number) => `telegram:${GROUP}:${id ?? 100 + n}`
  store.past(lines.map(([time, body, { id, author = 'hex', to = DESK, meta } = {}], n) => [{ key: key(n, id), to, from: 'telegram', author, body, ...(meta && { meta }) }, `2026-10-13T${time}.000Z`]), 'session')
}

test("a question comes with hex's last two messages in the hour before it in its thread, and only what the owner read there as hex's explanation", () => {
  said([
    ['16:59:00', 'Too old.'],
    ['18:01:00', 'Old news.'],
    ['18:02:00', 'Caddy gives a short domain.', { id: 50 }],
    ['18:03:00', 'which one?', { author: 'owner' }],
    ['18:04:00', '(file: plan.png)', { meta: { file: 'plan.png' } }],
    ['18:04:30', 'The plan, A on the left.', { meta: { file: 'plan.png' } }],
    ['18:05:00', 'Caddy gives a short domain, Tailscale none.', { meta: { edited: 'true', message_id: '50' } }],
    ['18:06:00', 'Elsewhere.', { to: GROUP }],
    ['18:07:00', '🔐 Bash: rm -rf build', { meta: { permission: 'p1' } }],
    ['18:08:00', 'Forwarded words.', { meta: { forwarded: 'true' } }],
    ['18:09:00', 'Pages\n\n**🔴 Blocked on you**\n- Ship it?'],
    ['18:10:00', 'Ship it?', { id: 8 }],
    ['18:59:58', '**Which one serves the pages?**'],
    ['18:59:59', 'A or B', { id: 9 }],
  ])
  ledger([asked(8, 'Ship it?', ['Yes', 'No'])])
  const question = asked(9, '**Which one serves the pages?**\nA or B', ['Caddy', 'Tailscale'], { at: '2026-10-13T19:00:00.000Z' })
  expect(before(open(state), 'telegram', question)).toEqual(['Caddy gives a short domain.', 'The plan, A on the left.'])
  expect(before(open(state), 'telegram', question, 10)).toEqual(['Caddy giv…', 'The plan,…'])
  expect(before(open(state), 'telegram', { ...question, at: '2026-10-13T18:01:30.000Z' })).toEqual(['Old news.'])
})

test("a question the check hasn't rewritten yet opens hex's message before it as context", () => {
  said([['18:30:00', '**Caddy** gives a short domain.\n\n  It needs a server.']])
  ledger([asked(9, 'Caddy or Tailscale?\nCaddy is mine.', ['Caddy', 'Tailscale'], { at: '2026-10-13T19:00:00.000Z' })])
  questions = new Questions(state, { t3Database: '/nonexistent', t3Home: '/nonexistent', check: why => checks.push(why) })
  expect(questions.view.asks[0]!.context).toBe('Caddy is mine.\nCaddy gives a short domain.\nIt needs a server.')
})

test('open questions come newest first with a link to each, answered and settled ones drop out', () => {
  ledger([asked(1, 'Ship it?', ['Yes', 'No']), asked(2, 'Rename it?', ['Yes', 'No'], { answer: { label: 'No', at: '', via: 'telegram' } }), asked(3, 'Which color?', ['Mint', 'Coral'])])
  questions = new Questions(state, { t3Database: '/nonexistent', t3Home: '/nonexistent', check: why => checks.push(why) })
  expect(questions.view.asks.map(question => [question.question, question.app, question.topic, question.places])).toEqual([
    ['Which color?', 'telegram', 'desk', [{ app: 'telegram', place: 'desk', task: `telegram:${DESK}`, link: 'https://t.me/c/1234/5/3' }]],
    ['Ship it?', 'telegram', 'desk', [{ app: 'telegram', place: 'desk', task: `telegram:${DESK}`, link: 'https://t.me/c/1234/5/1' }]],
  ])
})

test("General's questions sit under General, the name its places and its run go by, not the name hex.db keeps", () => {
  ledger([{ thread: GROUP, message: 7, text: 'Ship it?', options: ['Yes', 'No'], at: '2026-10-13T12:00:00.000Z' }])
  questions = new Questions(state, { t3Database: '/nonexistent', t3Home: '/nonexistent', check: why => checks.push(why) })
  expect(questions.view.asks.map(question => [question.topic, question.places.map(place => place.place)])).toEqual([['General', ['General']]])
})

test('the check’s version of a question stands in for every place that asked it, and newer questions lead', async () => {
  ledger([asked(1, 'Twilio?', ['Upgrade', 'Not yet']), asked(2, 'Upgrade Twilio now?', ['Go', 'Wait']), asked(9, 'Brand new?', ['Yes', 'No'])])
  writeFileSync(
    join(state, 'voice', 'check.json'),
    JSON.stringify({
      at: '2026-10-13T15:00:00.000Z',
      why: 'a pinned post changed',
      read: {},
      fixed: [],
      flagged: [],
      stuck: [],
      asks: [
        {
          id: 'check:twilio',
          kind: 'do',
          task: `telegram:${DESK}`,
          at: '2026-10-11T00:00:00.000Z',
          question: 'Upgrade Twilio from trial',
          options: [{ label: 'Upgrade', value: 'Upgrade', pick: true }, { label: 'Use the app', value: 'Not yet' }],
          tag: 'unblocks 3',
          refs: [{ app: 'telegram', thread: DESK, message: 1 }, { app: 'telegram', thread: DESK, message: 2 }],
        },
        { id: 'check:read', kind: 'look', task: `telegram:${DESK}`, at: '2026-10-13T00:00:00.000Z', question: 'Read the launch review', options: [{ label: 'Open' }] },
      ],
    }),
  )
  questions = new Questions(state, { t3Database: '/nonexistent', t3Home: '/nonexistent', check: why => checks.push(why) })
  expect(questions.view.asks.map(question => question.id)).toEqual([`telegram:${DESK}:9`, 'check:twilio', 'check:read'])
  expect(questions.view.asks.map(question => question.app)).toEqual(['telegram', 'telegram', 'telegram'])
  expect(questions.view.check).toEqual({ at: '2026-10-13T15:00:00.000Z', why: 'a pinned post changed', fixed: 0, flagged: 0 })

  expect(await questions.answer('check:twilio', 'Use the app', 'app')).toEqual({ thread: `telegram:${DESK}`, topic: 'desk', settled: 2, missed: 0 })
  await until(() => lines.length === 2)
  expect(lines).toEqual([
    { type: 'answer', thread: DESK, message: 1, label: 'Not yet', via: 'app' },
    { type: 'settle', thread: DESK, message: 2, note: '✓ Answered in the app: Use the app' },
  ])

  expect(await questions.answer('check:read', 'Open', 'app')).toEqual({ thread: `telegram:${DESK}`, topic: 'desk', settled: 0, missed: 0 })
  expect(await until(() => lines.find(line => line.type === 'inbound'))).toEqual({ type: 'inbound', thread: DESK, content: '(answered in the app) Read the launch review: Open', author: 'owner', meta: { user: 'hex app' } })
  await until(() => !questions.find('check:read'))
  await questions.undo('check:read', 'app')
  await until(() => questions.find('check:read'))
})

test('an answer that lands in the ledger takes the question off the list, and undo asks for its buttons back', async () => {
  ledger([asked(1, 'Ship it?', ['Yes', 'No'])])
  questions = new Questions(state, { t3Database: '/nonexistent', t3Home: '/nonexistent', check: why => checks.push(why) })
  const version = questions.version
  await questions.answer(`telegram:${DESK}:1`, 'Yes', 'app')
  expect(await until(() => lines[0])).toEqual({ type: 'answer', thread: DESK, message: 1, label: 'Yes', via: 'app' })
  ledger([asked(1, 'Ship it?', ['Yes', 'No'], { answer: { label: 'Yes', at: '', via: 'app' } })])
  await questions.changes(version, 2000)
  expect(questions.view.asks).toEqual([])
  await questions.undo(`telegram:${DESK}:1`, 'app')
  expect(await until(() => lines[1])).toEqual({ type: 'reopen', thread: DESK, message: 1, via: 'app' })
})

test('a note reaches the thread that asked and leaves the question open, with nothing settled', async () => {
  ledger([asked(1, 'Ship it?', ['Yes', 'No'])])
  writeFileSync(
    join(state, 'voice', 'check.json'),
    JSON.stringify({ at: '', why: '', read: {}, fixed: [], flagged: [], stuck: [], asks: [{ id: 'check:read', kind: 'look', task: `telegram:${DESK}`, at: '', question: 'Read the review', options: [{ label: 'Open' }] }] }),
  )
  questions = new Questions(state, { t3Database: '/nonexistent', t3Home: '/nonexistent', check: why => checks.push(why) })
  expect(await questions.note(`telegram:${DESK}:1`, 'i wish i could get more context', 'app')).toEqual({ thread: `telegram:${DESK}`, topic: 'desk', settled: 0, missed: 0 })
  await questions.note('check:read', 'which one?', 'app')
  await until(() => lines.length === 2)
  expect(lines).toEqual([
    { type: 'inbound', thread: DESK, content: '(note written in the app) Ship it?: i wish i could get more context', author: 'owner', meta: { user: 'hex app' } },
    { type: 'inbound', thread: DESK, content: '(note written in the app) Read the review: which one?', author: 'owner', meta: { user: 'hex app' } },
  ])
  await Bun.sleep(60)
  expect(questions.view.asks.map(question => question.id)).toEqual([`telegram:${DESK}:1`, 'check:read'])
})

test('not needed takes a question off the list, settles its copies and tells its thread, and undo brings it back', async () => {
  ledger([asked(1, 'Ship it?', ['Yes', 'No'])])
  writeFileSync(
    join(state, 'voice', 'check.json'),
    JSON.stringify({ at: '', why: '', read: {}, fixed: [], flagged: [], stuck: [], asks: [{ id: 'check:read', kind: 'look', task: `telegram:${DESK}`, at: '', question: 'Read the review', options: [{ label: 'Open' }] }] }),
  )
  questions = new Questions(state, { t3Database: '/nonexistent', t3Home: '/nonexistent', check: why => checks.push(why) })
  expect(await questions.dismiss(`telegram:${DESK}:1`, 'app')).toEqual({ thread: `telegram:${DESK}`, topic: 'desk', settled: 1, missed: 0 })
  await until(() => lines.length === 2)
  expect(lines).toEqual([
    { type: 'inbound', thread: DESK, content: '(not needed, said in the app) Ship it?', author: 'owner', meta: { user: 'hex app' } },
    { type: 'settle', thread: DESK, message: 1, note: '✓ Not needed, said in the app' },
  ])
  await expect(questions.dismiss(`telegram:${DESK}:1`, 'app')).rejects.toThrow('already answered or settled')
  await expect(questions.answer(`telegram:${DESK}:1`, 'Yes', 'app')).rejects.toThrow('already answered or settled')
  ledger([asked(1, 'Ship it?', ['Yes', 'No'], { settled: { note: '✓ Not needed, said in the app', at: '' } })])
  await until(() => questions.view.asks.length === 1)
  await questions.undo(`telegram:${DESK}:1`, 'app')
  await until(() => lines.length === 4)
  expect(lines.slice(2)).toEqual([
    { type: 'reopen', thread: DESK, message: 1, via: 'app' },
    { type: 'inbound', thread: DESK, content: '(took back) Ship it?: Not needed', author: 'owner', meta: { user: 'hex app' } },
  ])

  lines = []
  expect(await questions.dismiss('check:read', 'app')).toEqual({ thread: `telegram:${DESK}`, topic: 'desk', settled: 0, missed: 0 })
  await until(() => !questions.find('check:read'))
  await questions.undo('check:read', 'app')
  await until(() => questions.find('check:read'))
  expect(lines.map(line => line.content)).toEqual(['(not needed, said in the app) Read the review', '(took back) Read the review: Not needed'])
  await expect(questions.undo('check:read', 'app')).rejects.toThrow('there is no answer here to take back')
})

test('an answer its buttons can’t take settles every copy, and undo reopens them and tells the thread it no longer stands, even right away', async () => {
  ledger([asked(1, 'Twilio?', ['Upgrade', 'Not yet']), asked(2, 'Upgrade Twilio now?', ['Go', 'Wait'])])
  writeFileSync(
    join(state, 'voice', 'check.json'),
    JSON.stringify({
      at: '',
      why: '',
      read: {},
      fixed: [],
      flagged: [],
      stuck: [],
      asks: [{ id: 'check:twilio', kind: 'do', task: `telegram:${DESK}`, at: '', question: 'Upgrade Twilio', options: [{ label: 'Upgrade' }], refs: [{ app: 'telegram', thread: DESK, message: 1 }, { app: 'telegram', thread: DESK, message: 2 }] }],
    }),
  )
  questions = new Questions(state, { t3Database: '/nonexistent', t3Home: '/nonexistent', check: why => checks.push(why) })
  expect(await questions.answer('check:twilio', 'after the launch', 'app')).toEqual({ thread: `telegram:${DESK}`, topic: 'desk', settled: 2, missed: 0 })
  await questions.undo('check:twilio', 'app')
  await until(() => lines.length === 6)
  expect(lines).toEqual([
    { type: 'inbound', thread: DESK, content: '(answered in the app) Upgrade Twilio: after the launch', author: 'owner', meta: { user: 'hex app' } },
    { type: 'settle', thread: DESK, message: 1, note: '✓ Answered in the app: after the launch' },
    { type: 'settle', thread: DESK, message: 2, note: '✓ Answered in the app: after the launch' },
    { type: 'reopen', thread: DESK, message: 1, via: 'app' },
    { type: 'reopen', thread: DESK, message: 2, via: 'app' },
    { type: 'inbound', thread: DESK, content: '(took back) Upgrade Twilio: after the launch', author: 'owner', meta: { user: 'hex app' } },
  ])
})

const TWO_HUBS = {
  at: '',
  why: '',
  read: {},
  fixed: [],
  flagged: [],
  stuck: [],
  asks: [
    {
      id: 'check:twilio',
      kind: 'do',
      task: `telegram:${DESK}`,
      at: '',
      question: 'Upgrade Twilio',
      options: [{ label: 'Upgrade', value: 'Upgrade' }, { label: 'Not yet', value: 'Not yet' }],
      refs: [{ app: 'telegram', thread: DESK, message: 1 }, { app: 'discord', thread: DESK, message: 2 }],
    },
  ],
}

async function discordHub() {
  mkdirSync(join(state, 'discord'), { recursive: true })
  const heard: any[] = []
  const server = createServer(socket => {
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => heard.push(...chunk.trim().split('\n').map(line => JSON.parse(line))))
  })
  await new Promise<void>(resolve => server.listen(join(state, 'discord', 'hub.sock'), resolve))
  return { heard, stop: () => new Promise<void>(resolve => server.close(() => (rmSync(join(state, 'discord', 'hub.sock'), { force: true }), resolve()))) }
}

test('a not needed with one hub down still reaches the rest and says what it missed, and the copy left open can be settled later', async () => {
  ledger([asked(1, 'Twilio?', ['Upgrade', 'Not yet']), { ...asked(2, 'Upgrade Twilio now?', ['Go', 'Wait']), app: 'discord' } as any])
  writeFileSync(join(state, 'voice', 'check.json'), JSON.stringify(TWO_HUBS))
  questions = new Questions(state, { t3Database: '/nonexistent', t3Home: '/nonexistent', check: why => checks.push(why) })
  await until(() => questions.find('check:twilio'))
  expect(await questions.dismiss('check:twilio', 'app')).toEqual({ thread: `telegram:${DESK}`, topic: 'desk', settled: 1, missed: 2 })
  await until(() => lines.length === 2)
  expect(lines.map(line => line.type)).toEqual(['inbound', 'settle'])
  await expect(questions.dismiss('check:twilio', 'app')).rejects.toThrow('already answered or settled')

  ledger([{ ...asked(1, 'Twilio?', ['Upgrade', 'Not yet']), settled: { note: '✓ Not needed, said in the app', at: '' } }, { ...asked(2, 'Upgrade Twilio now?', ['Go', 'Wait']), app: 'discord' } as any])
  await Bun.sleep(150)
  const discord = await discordHub()
  try {
    expect(await questions.dismiss('check:twilio', 'app')).toEqual({ thread: `discord:${DESK}`, topic: '5', settled: 1, missed: 0 })
    await until(() => discord.heard.length === 2)
    expect(discord.heard.map(line => line.type)).toEqual(['inbound', 'settle'])
    expect(lines.map(line => line.type)).toEqual(['inbound', 'settle'])
    await questions.undo('check:twilio', 'app')
    await until(() => discord.heard.length === 4 && lines.length === 4)
    expect(lines.slice(2).map(line => line.type)).toEqual(['reopen', 'inbound'])
    expect(discord.heard.slice(2).map(line => line.type)).toEqual(['reopen', 'inbound'])
    await Bun.sleep(50)
    expect([lines.length, discord.heard.length]).toEqual([4, 4])
  } finally {
    await discord.stop()
  }
})

test('an answer that missed a copy is finished by the same answer, which only settles it, and no other answer goes over it', async () => {
  ledger([asked(1, 'Twilio?', ['Upgrade', 'Not yet']), { ...asked(2, 'Upgrade Twilio now?', ['Upgrade', 'Not yet']), app: 'discord' } as any])
  writeFileSync(join(state, 'voice', 'check.json'), JSON.stringify(TWO_HUBS))
  questions = new Questions(state, { t3Database: '/nonexistent', t3Home: '/nonexistent', check: why => checks.push(why) })
  await until(() => questions.find('check:twilio'))
  expect(await questions.answer('check:twilio', 'Upgrade', 'app')).toEqual({ thread: `telegram:${DESK}`, topic: 'desk', settled: 1, missed: 1 })
  ledger([{ ...asked(1, 'Twilio?', ['Upgrade', 'Not yet']), answer: { label: 'Upgrade', at: '', via: 'app' } }, { ...asked(2, 'Upgrade Twilio now?', ['Upgrade', 'Not yet']), app: 'discord' } as any])
  await Bun.sleep(150)
  await expect(questions.answer('check:twilio', 'Not yet', 'app')).rejects.toThrow('part of "Upgrade" went out')
  await expect(questions.dismiss('check:twilio', 'app')).rejects.toThrow('part of "Upgrade" went out')
  const discord = await discordHub()
  try {
    expect(await questions.answer('check:twilio', 'Upgrade', 'app')).toMatchObject({ settled: 1, missed: 0 })
    await until(() => discord.heard.length === 1)
    expect(discord.heard).toEqual([{ type: 'settle', thread: DESK, message: 2, note: '✓ Answered in the app: Upgrade' }])
  } finally {
    await discord.stop()
  }
})

test('an undo with a hub down takes back what it can, keeps the rest, and finishes when tried again', async () => {
  ledger([asked(1, 'Twilio?', ['Upgrade', 'Not yet']), { ...asked(2, 'Upgrade Twilio now?', ['Go', 'Wait']), app: 'discord' } as any])
  writeFileSync(join(state, 'voice', 'check.json'), JSON.stringify(TWO_HUBS))
  let discord = await discordHub()
  questions = new Questions(state, { t3Database: '/nonexistent', t3Home: '/nonexistent', check: why => checks.push(why) })
  await until(() => questions.find('check:twilio'))
  expect(await questions.answer('check:twilio', 'Upgrade', 'app')).toEqual({ thread: `telegram:${DESK}`, topic: 'desk', settled: 2, missed: 0 })
  await discord.stop()
  await expect(questions.undo('check:twilio', 'app')).rejects.toThrow('undo again to finish')
  await until(() => lines.some(line => line.type === 'reopen'))
  ledger([asked(1, 'Twilio?', ['Upgrade', 'Not yet']), { ...asked(2, 'Upgrade Twilio now?', ['Go', 'Wait']), app: 'discord', settled: { note: '✓ Answered in the app: Upgrade', at: '' } } as any])
  await Bun.sleep(150)
  await expect(questions.answer('check:twilio', 'Not yet', 'app')).rejects.toThrow('undo it again first')
  discord = await discordHub()
  try {
    await questions.undo('check:twilio', 'app')
    await until(() => discord.heard.some(line => line.type === 'reopen'))
    ledger([asked(1, 'Twilio?', ['Upgrade', 'Not yet']), { ...asked(2, 'Upgrade Twilio now?', ['Go', 'Wait']), app: 'discord' } as any])
    await Bun.sleep(150)
    await expect(questions.undo('check:twilio', 'app')).rejects.toThrow('no answer here to take back')
    expect(await questions.answer('check:twilio', 'Not yet', 'app')).toMatchObject({ settled: 2, missed: 0 })
  } finally {
    await discord.stop()
  }
})

test('a question asked again over an earlier answer can be answered, and one undo takes back both', async () => {
  ledger([asked(1, 'Ship it?', ['Yes', 'No']), asked(3, 'Ship it now?', ['Yes', 'No'])])
  const check = (refs: number[]) =>
    writeFileSync(
      join(state, 'voice', 'check.json'),
      JSON.stringify({ ...TWO_HUBS, asks: [{ id: 'check:ship', kind: 'yesno', task: `telegram:${DESK}`, at: '', question: 'Ship it', options: [{ label: 'Yes', value: 'Yes' }, { label: 'No', value: 'No' }], refs: refs.map(message => ({ app: 'telegram', thread: DESK, message })) }] }),
    )
  check([1])
  questions = new Questions(state, { t3Database: '/nonexistent', t3Home: '/nonexistent', check: why => checks.push(why) })
  await until(() => questions.find('check:ship'))
  await questions.dismiss('check:ship', 'app')
  ledger([{ ...asked(1, 'Ship it?', ['Yes', 'No']), settled: { note: '✓ Not needed, said in the app', at: '' } }, asked(3, 'Ship it now?', ['Yes', 'No'])])
  check([1, 3])
  await Bun.sleep(150)
  expect(await questions.answer('check:ship', 'Yes', 'app')).toEqual({ thread: `telegram:${DESK}`, topic: 'desk', settled: 1, missed: 0 })
  await questions.undo('check:ship', 'app')
  await until(() => lines.length === 6)
  expect(lines.slice(2)).toEqual([
    { type: 'answer', thread: DESK, message: 3, label: 'Yes', via: 'app' },
    { type: 'reopen', thread: DESK, message: 3, via: 'app' },
    { type: 'reopen', thread: DESK, message: 1, via: 'app' },
    { type: 'inbound', thread: DESK, content: '(took back) Ship it: Not needed', author: 'owner', meta: { user: 'hex app' } },
  ])
})

test('a stuck item with a request goes to General, one without is put away', async () => {
  writeFileSync(
    join(state, 'voice', 'check.json'),
    JSON.stringify({
      at: '2026-10-13T15:00:00.000Z', why: 'a call ended', read: {}, asks: [], fixed: [], flagged: [],
      stuck: [
        { id: 'disk', title: 'cloud’s disk fails every read', why: 'Since 1:10am.', action: 'Restore', mark: 'failed', at: '', request: 'Restore cloud from checkpoint v7.' },
        { id: 'runs', title: '5 T3 runs ended in an error', why: 'Their work landed.', action: 'Settle', mark: 'failed', at: '' },
      ],
    }),
  )
  questions = new Questions(state, { t3Database: '/nonexistent', t3Home: '/nonexistent', check: why => checks.push(why) })
  await questions.act('disk')
  expect(await until(() => lines[0])).toEqual({ type: 'inbound', thread: GROUP, content: 'Restore cloud from checkpoint v7.', author: 'prompt', meta: { user: 'hex app' } })
  await questions.act('runs')
  await until(() => questions.view.stuck.length === 1)
  expect(questions.view.stuck[0]).toMatchObject({ id: 'disk', app: 'hex', sent: expect.any(String) })
  expect(JSON.parse(readFileSync(join(state, 'voice', 'marks.json'), 'utf8')).dismissed.runs).toBeString()
})

test('T3 Code’s records give what waits on a limit, what never started, what failed unseen, and what finished since you looked', () => {
  const path = join(state, 't3.sqlite')
  const db = new Database(path)
  db.run(`create table orchestration_v2_projection_threads (thread_id text, project_id text, title text, archived_at text, deleted_at text, payload_json text)`)
  db.run(`create table projection_projects (project_id text, title text)`)
  db.run(`create table orchestration_v2_projection_runs (thread_id text, ordinal int, status text, requested_at text, completed_at text)`)
  db.run(`create table orchestration_v2_projection_messages (thread_id text, role text, created_at text, payload_json text)`)
  db.run(`insert into projection_projects values ('p', 'hex')`)
  const thread = (id: string, payload: object) => db.run(`insert into orchestration_v2_projection_threads values (?, 'p', ?, null, null, ?)`, [id, `${id} thread`, JSON.stringify(payload)])
  thread('parked', { limitRecovery: { resetAt: '2026-10-18T19:00:00.000Z' } })
  thread('queued', {})
  thread('broken', { lastVisitedAt: '2026-10-13T08:00:00.000Z' })
  thread('finished', { createdBy: 'user', lastVisitedAt: '2026-10-13T08:00:00.000Z' })
  thread('seen', { createdBy: 'user', lastVisitedAt: '2026-10-13T12:00:00.000Z' })
  const run = (id: string, ordinal: number, status: string, completed: string | null) => db.run(`insert into orchestration_v2_projection_runs values (?, ?, ?, '2026-10-09T23:00:00.000Z', ?)`, [id, ordinal, status, completed])
  run('parked', 1, 'failed', '2026-10-13T10:00:00.000Z')
  run('queued', 1, 'queued', null)
  run('broken', 1, 'failed', '2026-10-13T10:00:00.000Z')
  run('finished', 1, 'completed', '2026-10-13T10:00:00.000Z')
  run('seen', 1, 'completed', '2026-10-13T10:00:00.000Z')
  db.run(`insert into orchestration_v2_projection_messages values ('finished', 'assistant', '2026-10-13T10:00:00.000Z', ?)`, [JSON.stringify({ text: '## Done\n\n**Shipped** the memory fix.' })])
  db.close()

  const t3 = new T3(() => {}, path)
  const { stuck, fresh } = t3.query(Date.parse('2026-10-13T20:00:00.000Z'))
  t3.close()
  expect(stuck.map(item => [item.title, item.action, item.mark])).toEqual([
    ['1 T3 thread waits for Oct 18', 'Switch plan', 'paused'],
    ['queued thread: queued since Oct 9', 'Resume', 'paused'],
    ['broken thread ended in an error', 'Look', 'failed'],
  ])
  expect(stuck.every(item => item.request)).toBe(true)
  expect(fresh).toEqual([{ id: expect.stringMatching(/^t3-done-/), app: 't3', topic: 'hex', title: 'finished thread', where: 'T3 · hex', line: 'Done', at: '2026-10-13T10:00:00.000Z' }])
  expect(stuck.every(item => item.app === 't3')).toBe(true)
})

test('a check’s verdict is held to the ledger: real open refs and buttons only, and nothing both settled and listed', () => {
  const ledgers = { telegram: [asked(1, 'Twilio?', ['Upgrade', 'Not yet']), asked(2, 'Old?', ['Yes', 'No'], { settled: { note: 'x', at: '' } }), asked(3, 'Music?', ['A', 'B'])] }
  const ref = (message: number) => ({ app: 'telegram', thread: DESK, message })
  const verdict = vet(
    {
      asks: [
        {
          id: 'twilio',
          kind: 'do',
          task: `telegram:${DESK}`,
          at: '',
          question: 'Upgrade Twilio',
          options: [{ label: 'Upgrade', value: 'Upgrade' }, { label: 'Later', value: 'Wait' }],
          from: [ref(1), ref(2), ref(9), { app: 'telegram', thread: GROUP }, { app: 'telegram', thread: '-100999' }, { app: 'voice', call: 'live_1' }, { app: 'voice', call: 'live_made_up' }],
        },
      ],
      settle: [{ ...ref(1), note: 'Settled' }, { ...ref(2), note: 'Settled' }, { ...ref(3), note: 'Settled: Tech Live, picked on a call with a very long note' }],
      fixed: [],
      flagged: [],
      stuck: [{ id: 'disk', title: 'disk', why: '', action: 'Look', mark: 'failed', at: '' }],
    },
    ledgers,
    { threads: { [`telegram:${GROUP}`]: 'hex', [`telegram:${DESK}`]: 'desk' }, calls: [{ id: 'live_1' }] },
  )
  expect(verdict.asks[0]).toMatchObject({
    id: 'check:twilio',
    refs: [ref(1)],
    from: [ref(1), ref(2), ref(9), { app: 'telegram', thread: GROUP }, { app: 'voice', call: 'live_1' }],
    options: [{ label: 'Upgrade', value: 'Upgrade' }, { label: 'Later' }],
  })
  expect(verdict.settle).toEqual([{ ...ref(3), note: 'Settled: Tech Live, picked on a call with a very long note'.slice(0, 60) }])
  expect(verdict.stuck[0]!.id).toBe('check-disk')
})

test("a closed thread's open question stays a check's ref, so answering the question settles it", () => {
  const closed = { app: 'telegram', thread: `${GROUP}:7`, message: 4 }
  const verdict = vet(
    { asks: [{ id: 'music', kind: 'pick', task: `telegram:${GROUP}:7`, at: '', question: 'Music?', options: [{ label: 'A', value: 'A' }], from: [closed] }], settle: [], fixed: [], flagged: [], stuck: [] },
    { telegram: [asked(4, 'Music?', ['A', 'B'], { thread: closed.thread })] },
    { threads: {}, calls: [] },
  )
  expect(verdict.asks[0]).toMatchObject({ refs: [closed], from: [closed], options: [{ label: 'A', value: 'A' }] })
})

test('a question names every place it was asked, each thread once at its open question, pinned post or message, with the best link its app has, the ones that open first, and its pages apart from its answers', () => {
  const DM = '777'
  const THREAD = '1560277464146644992'
  open(state).keepThreads('telegram', { [GROUP]: { name: 'hex', link: 'https://t.me/c/1234/1' }, [DESK]: { name: 'desk', link: 'https://t.me/c/1234/5' }, [DM]: { name: 'DM', link: 'https://t.me/hexbot' } })
  mkdirSync(join(state, 'discord'))
  open(state).keepThreads('discord', { [THREAD]: { name: 'fix hex NOW', link: `https://discord.com/channels/42/${THREAD}` } })
  const calls = join(state, 'calls')
  mkdirSync(calls)
  writeFileSync(join(calls, 'live_1.json'), JSON.stringify({ id: 'live_1', title: 'Apple charges', started: '2026-10-13T18:00:00.000Z' }))
  ledger([asked(1, 'Order the Duo?', ['Ordered', 'Not yet']), { thread: GROUP, message: 3451, text: 'Duo ordered?', options: ['Yes', 'No'], at: '2026-10-13T12:00:00.000Z' }], { [GROUP]: { message: 2693, text: 'Blocked on you: the Duo order', at: '2026-10-13T19:00:00.000Z' }, [DESK]: { message: 4, text: 'Duo order', at: '2026-10-13T21:00:00.000Z' } })
  writeFileSync(
    join(state, 'voice', 'check.json'),
    JSON.stringify({
      at: '2026-10-13T20:00:00.000Z', why: 'a call ended', read: {}, fixed: [], flagged: [], stuck: [],
      asks: [
        {
          id: 'check:duo',
          kind: 'yesno',
          task: `telegram:${DESK}`,
          at: '2026-10-13T11:00:00.000Z',
          question: 'Is the Duo ordered?',
          options: [{ label: 'Ordered', value: 'Ordered' }, { label: 'Not yet', value: 'Not yet' }],
          links: [{ label: 'Apple Store', url: 'https://apple.com/store' }],
          from: [
            { app: 'telegram', thread: DESK, message: 4 },
            { app: 'telegram', thread: DESK, message: 1 },
            { app: 'telegram', thread: GROUP, message: 2693 },
            { app: 'telegram', thread: GROUP, message: 3000 },
            { app: 'voice', call: 'live_1' },
            { app: 'telegram', thread: DM, message: 585 },
            { app: 'discord', thread: THREAD },
            { app: 'telegram', thread: DESK },
            { app: 'telegram', thread: DM },
          ],
          refs: [{ app: 'telegram', thread: DESK, message: 1 }],
        },
      ],
    }),
  )
  questions = new Questions(state, { t3Database: '/nonexistent', t3Home: '/nonexistent', calls, check: why => checks.push(why) })
  const [duo] = questions.view.asks
  expect(duo).toMatchObject({ options: [{ label: 'Ordered', value: 'Ordered' }, { label: 'Not yet', value: 'Not yet' }], links: [{ label: 'Apple Store', url: 'https://apple.com/store' }] })
  expect(duo!.places).toEqual([
    { app: 'telegram', place: 'General', task: `telegram:${GROUP}`, link: 'https://t.me/c/1234/2693' },
    { app: 'telegram', place: 'desk', task: `telegram:${DESK}`, link: 'https://t.me/c/1234/5/1' },
    { app: 'telegram', place: 'DM', task: `telegram:${DM}`, link: 'https://t.me/hexbot' },
    { app: 'discord', place: 'fix hex NOW', task: `discord:${THREAD}`, link: `https://discord.com/channels/42/${THREAD}` },
    { app: 'voice', place: 'Apple charges', call: 'live_1' },
  ])
  writeFileSync(join(calls, 'live_1.json'), JSON.stringify({ id: 'live_1', title: 'Apple refund', started: '2026-10-13T18:00:00.000Z' }))
  ;(questions as unknown as { build(): void }).build()
  expect(questions.view.asks[0]!.places.at(-1)).toEqual({ app: 'voice', place: 'Apple refund', call: 'live_1' })
})

test('a check written before places and links were typed still gives each question its places, and its url options as links', () => {
  ledger([asked(1, 'Read the review?', ['Done', 'Later'])])
  writeFileSync(
    join(state, 'voice', 'check.json'),
    JSON.stringify({
      at: '2026-10-13T20:00:00.000Z', why: 'a call ended', read: {}, fixed: [], flagged: [], stuck: [],
      asks: [
        { id: 'check:review', kind: 'do', task: `telegram:${DESK}`, at: '', question: 'Read the review', options: [{ label: 'Done', value: 'Done' }, { label: 'Open PR #2', url: 'https://github.com/x/pull/2' }], places: ['desk', 'hex'], refs: [{ app: 'telegram', thread: DESK, message: 1 }] },
        { id: 'check:pin', kind: 'do', task: `telegram:${GROUP}`, at: '', question: 'File the claim', options: [{ label: 'Done' }], places: ['hex'] },
      ],
    }),
  )
  questions = new Questions(state, { t3Database: '/nonexistent', t3Home: '/nonexistent', check: why => checks.push(why) })
  expect(questions.view.asks.map(question => [question.id, question.options, question.links, question.places])).toEqual([
    ['check:review', [{ label: 'Done', value: 'Done' }], [{ label: 'Open PR #2', url: 'https://github.com/x/pull/2' }], [{ app: 'telegram', place: 'desk', task: `telegram:${DESK}`, link: 'https://t.me/c/1234/5/1' }]],
    ['check:pin', [{ label: 'Done' }], undefined, [{ app: 'telegram', place: 'General', task: `telegram:${GROUP}`, link: 'https://t.me/c/1234/1' }]],
  ])
})

test("a status post's page is read from hex.db as it opens, and only a new note starts a check, not the lines hex rewrites", async () => {
  const pin = { message: 7, text: 'Site: example.com\n\n**🔴 Blocked on you:** no questions waiting', at: '2026-10-13T10:00:00.000Z', note: 'Site: example.com' }
  const byHand = { message: 2, text: 'Status: by hand', at: '2026-10-13T10:00:00.000Z' }
  ledger([asked(1, 'Ship it?', ['Yes', 'No'])], { [DESK]: pin, [GROUP]: byHand })
  const store = open(state)
  store.deliver({ key: 'telegram:-1001234:40', to: DESK, from: 'telegram', body: 'Fix the login page', author: 'owner', meta: { user: 'owner' } })
  const task = store.createTask({ title: 'Fix the login page', message: 'telegram:-1001234:40', owner: DESK })
  questions = new Questions(state, { t3Database: '/nonexistent', t3Home: '/nonexistent', check: why => checks.push(why) })
  expect(questions.of(`telegram:${DESK}`).pin).toBe(`Site: example.com\n\n**🔴 Blocked on you**\n- Ship it?\n\n**🟡 Pending**\n- ${task.title}\n\n**🟢 Done:** no tasks done yet`)
  expect(questions.of(`telegram:${GROUP}`).pin).toBe('Status: by hand\n\n**🔴 Blocked on you:** no questions waiting\n\n**🟡 Pending:** no open tasks\n\n**🟢 Done:** no tasks done yet')

  store.pinned({ app: 'telegram', thread: DESK, ...pin, text: questions.of(`telegram:${DESK}`).pin! })
  await Bun.sleep(150)
  expect(checks).toEqual([])
  store.pinned({ app: 'telegram', thread: DESK, ...pin, note: 'Site: example.org' })
  await until(() => checks.length)
  expect(checks).toEqual(['a pinned post changed'])
})
