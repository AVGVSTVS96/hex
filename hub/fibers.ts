import { Cause, Clock, Context, Duration, Effect, Exit } from "effect";
import type { Fiber } from "effect";

import { clock } from "./clock.ts";

const millis = () => clock.now();
const nanos = () => BigInt(clock.now()) * 1_000_000n;

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
