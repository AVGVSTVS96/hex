import type { On, PromptSubmitResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const CWD = '/home/me/hex'
const PATH = `${CWD}/schedules.json`
const MINUTE = 60_000
const HEARTBEAT = JSON.stringify({ heartbeat: { cron: '45 * * * *', prompt: 'Hourly check' } })
const START = new Date(2026, 9, 4, 9, 44, 30).getTime()

function world(on: On, file: string) {
  const state = { file, busy: false, release: () => {}, sent: [] as string[], status: undefined as string | undefined }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('fs.read', ($, e) => {
    expect(e.path).toBe(PATH)
    return { value: state.file }
  })
  on('ui.status', ($, e) => {
    state.status = e.text
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    state.sent.push(e.text)
    if (!state.busy) return { text: e.text }
    return new Promise<PromptSubmitResult>(resolve => {
      state.release = () => resolve({ text: e.text })
    })
  })
  return state
}

const start = { cwd: CWD, surface: 'terminal', isInteractive: true } as const

test('fires a job at its minute, once, and never stacks a second one behind a busy session', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const state = world(on, HEARTBEAT)
  state.busy = true
  await $.session.start(start)

  await clock.advance(MINUTE)
  expect(state.sent).toEqual(['[heartbeat] Hourly check'])

  await clock.advance(60 * MINUTE)
  expect(state.sent).toHaveLength(1)

  state.release()
  await clock.advance(60 * MINUTE)
  expect(state.sent).toHaveLength(2)
})

test('steps, ranges and lists fire where cron does', async ($, on) => {
  const clock = mock.clock(on, { now: new Date(2026, 9, 4, 0, 0, 30).getTime() })
  const state = world(on, JSON.stringify({
    leisure: { cron: '17 */3 * * *', prompt: 'Leisure' },
    weekdays: { cron: '0 9 * * 1-5', prompt: 'Morning' },
    sunday: { cron: '0 8 * * 7', prompt: 'Sunday' },
  }))
  await $.session.start(start)

  await clock.advance(24 * 60 * MINUTE)
  expect(state.sent.filter(text => text.startsWith('[leisure]'))).toHaveLength(8)
  expect(state.sent).toContain('[sunday] Sunday')
  expect(state.sent).not.toContain('[weekdays] Morning')
})

test('a broken schedules.json shows in the status line and fires nothing until fixed', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const state = world(on, '{ "heartbeat": ')
  await $.session.start(start)

  await clock.advance(MINUTE)
  expect(state.sent).toEqual([])
  expect(state.status).toMatch(/^schedules\.json: /)

  state.file = HEARTBEAT
  await clock.advance(60 * MINUTE)
  expect(state.status).toBeUndefined()
  expect(state.sent).toEqual(['[heartbeat] Hourly check'])
})

test('saving a broken schedules.json tells the model in the same tool result', async ($, on) => {
  mock.clock(on, { now: START })
  const state = world(on, HEARTBEAT)
  on('tool.call', { tool: 'Write' }, ($, e) => {
    state.file = e.content
    return { result: { type: 'update', filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null } }
  })
  await $.session.start(start)

  const broken = await $.tool.call({ tool: 'Write', file_path: PATH, content: '{ "heartbeat": { "cron": "hourly", "prompt": "x" } }' })
  expect(broken.context?.[0]).toMatch(/"hourly" is not a five-field cron expression/)

  const fixed = await $.tool.call({ tool: 'Write', file_path: PATH, content: HEARTBEAT })
  expect(fixed.context).toBeUndefined()
})
