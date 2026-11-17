import { afterEach, beforeEach, expect, test } from "bun:test";

import { Cause, Effect } from "effect";

import { manual } from "./clock.ts";
import { ownedWork } from "./fibers.ts";

let time: ReturnType<typeof manual>;

beforeEach(() => {
  time = manual(() => Promise.resolve());
});

afterEach(() => {
  time.restore();
});

const unbroken = (cause: Cause.Cause<unknown>) => {
  throw new Error(Cause.pretty(cause));
};

test("work runs up to its first wait before start returns, and its sleep is a timer on the hub's clock", async () => {
  const steps: string[] = [];

  ownedWork().start(
    Effect.gen(function* napping() {
      steps.push("began");
      yield* Effect.sleep(50);
      steps.push("woke");
    }),
    unbroken,
  );

  expect(steps).toEqual(["began"]);
  await time.advance(49);
  expect(steps).toEqual(["began"]);
  await time.advance(1);
  expect(steps).toEqual(["began", "woke"]);
});

test("work goes on in the turn of the answer it waited on, before anything that asked later hears it", async () => {
  const heard: string[] = [];
  const asked = Promise.withResolvers<string>();

  ownedWork().start(
    Effect.gen(function* asking() {
      heard.push(yield* Effect.promise(() => asked.promise));
    }),
    unbroken,
  );

  asked.resolve("yes");
  await asked.promise;
  expect(heard).toEqual(["yes"]);
});

test("ending its owner interrupts work at once: it closes what it held open and never wakes", async () => {
  const steps: string[] = [];
  const work = ownedWork();

  work.start(
    Effect.gen(function* napping() {
      yield* Effect.sleep(50);
      steps.push("woke");
    }).pipe(Effect.ensuring(Effect.sync(() => steps.push("closed")))),
    unbroken,
  );

  work.end();
  expect(steps).toEqual(["closed"]);
  await time.advance(50);
  expect(steps).toEqual(["closed"]);
});

test("work whose first steps end its owner doesn't go on", async () => {
  const steps: string[] = [];
  const work = ownedWork();

  work.start(
    Effect.gen(function* ending() {
      work.end();
      yield* Effect.sleep(50);
      steps.push("woke");
    }),
    unbroken,
  );

  await time.advance(50);
  expect(steps).toEqual([]);
});

test("its owner hears of work that fails or throws, and not of work it ended", () => {
  const broke: unknown[] = [];
  const work = ownedWork<string>();

  const hears = (cause: Cause.Cause<string>) => {
    broke.push(Cause.squash(cause));
  };

  work.start(Effect.fail("failed"), hears);

  work.start(
    Effect.sync(() => {
      throw new Error("threw");
    }),
    hears,
  );

  work.start(Effect.never, hears);
  work.end();
  expect(broke).toEqual(["failed", new Error("threw")]);
});
