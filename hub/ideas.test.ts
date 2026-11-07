import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { checks, research, type Found } from './ideas.ts'
import { open, Store } from './store.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ideas-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const minute = Date.UTC(2026, 10, 9, 17) / 60_000
const sent = () => open(dir).untaken().filter(row => row.from === 'schedule')
const job = { cron: '0 9 * * 1', idea: 't-1', prompt: 'Is GPT Live 1.1 on the API yet?' }

function idea() {
  const store = new Store(dir)
  store.deliver({ key: 'telegram:-100:5', to: '-100:7', from: 'telegram', author: 'owner', body: 'swap in GPT Live 1.1 once it is on the API', meta: { user: 'owner' } })
  return store.createTask({ title: 'Swap in GPT Live 1.1', message: 'telegram:-100:5', owner: '-100:7', status: 'idea' })
}

test("news reaches the idea's thread; a check without news wakes no one, and the next one starts from both", async () => {
  idea()
  const inputs: string[] = []
  const ask = (found: Found) => async (input: string) => (inputs.push(input), found)
  await research(dir, 'gpt-live', job, 'general', minute, ask({ news: false, finding: 'Only in ChatGPT so far, per the OpenAI changelog.', tokens: 900 }))
  expect(sent()).toEqual([])
  await research(dir, 'gpt-live', job, 'general', minute + 7 * 1440, ask({ news: true, finding: 'gpt-live-1.1 is on the API: https://platform.openai.com/docs/models' }))

  expect(inputs[0]).toContain('swap in GPT Live 1.1 once it is on the API')
  expect(inputs[0]).toContain('What to look into: Is GPT Live 1.1 on the API yet?')
  expect(inputs[0]).toContain('This is its first check.')
  expect(inputs[1]).toContain('Only in ChatGPT so far, per the OpenAI changelog.')
  expect(sent()).toMatchObject([{ to: '-100:7', from: 'schedule', body: '[gpt-live] News for t-1 (Swap in GPT Live 1.1): gpt-live-1.1 is on the API: https://platform.openai.com/docs/models' }])
  expect(checks(dir, 't-1').map(check => [check.news, check.tokens])).toEqual([[false, 900], [true, undefined]])
})

test('a check that fails is kept with its error and wakes no one', async () => {
  idea()
  await research(dir, 'gpt-live', job, 'general', minute, async () => {
    throw new Error('rate limited')
  })
  expect(sent()).toEqual([])
  expect(checks(dir, 't-1')[0]!.error).toContain('rate limited')
})

test("an idea that's done has nothing to look into: its thread hears once to take the job out", async () => {
  const { id } = idea()
  open(dir).editTask(id, { status: 'done', proof: 'shipped' })
  const ask = async () => ({ news: true, finding: 'never asked' })
  await research(dir, 'gpt-live', job, 'general', minute, ask)
  await research(dir, 'gpt-live', job, 'general', minute + 1440, ask)
  expect(sent()).toMatchObject([{ to: '-100:7', body: '[gpt-live] t-1 is done, so its check in schedules.json has nothing left to look into: take the job out.' }])
  expect(checks(dir, 't-1')).toEqual([])
})
