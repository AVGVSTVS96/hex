import { until } from "./until.ts";

type Handle = ReturnType<typeof setTimeout>;

export const clock = {
  now: () => Date.now(),
  setTimeout: <A extends unknown[]>(run: (...args: A) => void, ms: number, ...args: A): Handle =>
    setTimeout(run, ms, ...args),
  clearTimeout: (timer: Handle | undefined) => {
    clearTimeout(timer);
  },
};

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    clock.setTimeout(resolve, ms);
  });

const wall = { ...clock };

function inertHandle(): Handle {
  const handle = setTimeout(() => {
    clearTimeout(handle);
  }, 0);

  clearTimeout(handle);

  return handle;
}

export function manual(settled: () => Promise<void>) {
  let now = Date.now();
  const timers = new Map<Handle, { at: number; ms: number; run: () => void }>();
  Object.assign(clock, {
    now: () => now,
    setTimeout: (run: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
      const handle = inertHandle();
      timers.set(handle, {
        at: now + Math.max(0, ms),
        ms,
        run: () => {
          run(...args);
        },
      });

      return handle;
    },
    clearTimeout: (timer: Handle | undefined) => {
      if (timer !== undefined) {
        timers.delete(timer);
      }
    },
  });

  const firstDue = (end: number) =>
    [...timers].filter(([, timer]) => timer.at <= end).toSorted(([, x], [, y]) => x.at - y.at)[0];

  async function advance(ms: number) {
    await settled();
    const end = now + ms;

    for (let due = firstDue(end); due !== undefined; due = firstDue(end)) {
      timers.delete(due[0]);
      now = due[1].at;
      due[1].run();
      await settled();
    }

    now = end;
  }

  const armed = (ms: number) => until(() => [...timers.values()].find((timer) => timer.ms === ms));

  return {
    advance,
    armed,
    async lapse(ms: number) {
      await advance((await armed(ms)).at - now);
    },
    restore: () => void Object.assign(clock, wall),
  };
}
