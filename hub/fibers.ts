import { Cause, Clock, Context, Duration, Effect, Exit } from "effect";
import type { Fiber } from "effect";

import { clock } from "./clock.ts";

const millis = () => clock.now();
const nanos = () => BigInt(clock.now()) * 1_000_000n;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Effect's time is hex's clock, so a sleep is a timer on it: one a test's manual clock holds, of the length slept.
const hexClock: Clock.Clock = {
  currentTimeMillisUnsafe: millis,
  currentTimeMillis: Effect.sync(millis),
  currentTimeNanosUnsafe: nanos,
  currentTimeNanos: Effect.sync(nanos),
  monotonicTimeNanosUnsafe: nanos,
  monotonicTimeNanos: Effect.sync(nanos),
  sleep: (duration) =>
    Effect.callback((resume) => {
      const timer = clock.setTimeout(() => {
        resume(Effect.void);
      }, Duration.toMillis(duration));

      return Effect.sync(() => {
        clock.clearTimeout(timer);
      });
    }),
};

const fork = Effect.runForkWith(Context.make(Clock.Clock, hexClock));

export type Work<E> = ReturnType<typeof ownedWork<E>>;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What the hub does for one owner, like a phase of a session: Effects started from its synchronous code, each running up to its first wait before start returns. end interrupts them all, which drops what they wait on and closes what they hold open, so none acts for an owner that's over, not even one whose first steps ended it. broke: what the hub does about one that fails or throws, since nothing else hears of it, not even as an unhandled rejection.
export function ownedWork<E>() {
  let running = new Set<Fiber.Fiber<unknown, E>>();

  function end() {
    const over = running;
    running = new Set();

    for (const fiber of over) {
      fiber.interruptUnsafe();
    }
  }

  function start(effect: Effect.Effect<unknown, E>, broke: (cause: Cause.Cause<E>) => void) {
    const mine = running;
    const fiber = fork(effect);

    if (running === mine) {
      mine.add(fiber);
    } else {
      fiber.interruptUnsafe();
    }

    fiber.addObserver((exit) => {
      mine.delete(fiber);

      if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
        broke(exit.cause);
      }
    });
  }

  return { start, end };
}
