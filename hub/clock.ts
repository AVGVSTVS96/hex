import { until } from './until.ts'

// The hub's time: the wall clock, unless a test runs it by hand (manual). Then it moves only when
// the test moves it, and each timer that comes due fires once everything the last one started is done.
type Handle = ReturnType<typeof setTimeout>

export const clock = {
  now: () => Date.now(),
  setTimeout: <A extends unknown[]>(run: (...args: A) => void, ms: number, ...args: A): Handle => setTimeout(run, ms, ...args),
  clearTimeout: (timer: Handle | undefined) => clearTimeout(timer),
}

export const sleep = (ms: number) => new Promise<void>(resolve => clock.setTimeout(resolve, ms))

const wall = { ...clock }

// settled: resolves once the work a timer started is done.
export function manual(settled: () => Promise<void>) {
  let now = Date.now()
  let ids = 0
  const timers = new Map<number, { at: number; ms: number; run: () => void }>()
  Object.assign(clock, {
    now: () => now,
    setTimeout: (run: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
      timers.set(++ids, { at: now + Math.max(0, ms), ms, run: () => run(...args) })
      return ids as unknown as Handle
    },
    clearTimeout: (timer: Handle | undefined) => void timers.delete(timer as unknown as number),
  })
  const next = (end: number) => [...timers].filter(([, timer]) => timer.at <= end).sort(([a, x], [b, y]) => x.at - y.at || a - b)[0]
  // Lets what's underway finish, then moves the clock on by ms, firing what comes due on the way.
  async function advance(ms: number) {
    await settled()
    const end = now + ms
    for (let due = next(end); due; due = next(end)) {
      timers.delete(due[0])
      now = due[1].at
      due[1].run()
      await settled()
    }
    now = end
  }
  // Resolves once the hub is waiting ms on its clock, for something only time ends.
  const armed = (ms: number) => until(() => [...timers.values()].find(timer => timer.ms === ms))
  return {
    advance,
    armed,
    // Lets that wait run out, firing what comes due before it too.
    async lapse(ms: number) {
      await advance((await armed(ms)).at - now)
    },
    restore: () => void Object.assign(clock, wall),
  }
}
