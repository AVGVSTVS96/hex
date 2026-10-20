import { expect, test } from 'bun:test'
import { local } from './mcp.ts'

test("a message's time reaches the session on the owner's clock, with its offset", () => {
  expect(local({ chat_id: '1', ts: '2026-10-20T06:31:05.123Z' }, 'America/Los_Angeles')).toEqual({ chat_id: '1', ts: '2026-10-19T23:31:05-07:00' })
  expect(local({ ts: '2026-01-15T20:00:00Z' }, 'America/Los_Angeles').ts).toBe('2026-01-15T12:00:00-08:00')
})

test('meta without a time or a zone it can read passes through as it is', () => {
  expect(local({ chat_id: '1' }, 'UTC')).toEqual({ chat_id: '1' })
  expect(local({ ts: 'soon' }, 'UTC')).toEqual({ ts: 'soon' })
  expect(local({ ts: '2026-10-20T06:31:05Z' }, 'Bogus/Zone')).toEqual({ ts: '2026-10-20T06:31:05Z' })
})
