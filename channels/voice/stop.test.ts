import { expect, test } from "bun:test";

import { until } from "@hex/hub/testing";

import { stopping } from "./stop.ts";

function judged(wants: (said: string) => number) {
  const asked: string[] = [];
  const stops: string[] = [];

  const stop = stopping(
    async ({ said = "" }) => {
      asked.push(said);
      await Bun.sleep(5);

      return wants(said);
    },
    (delegation) => {
      stops.push(delegation);
    },
    (error) => {
      stops.push(error.message);
    },
  );

  return { stop, asked, stops };
}

const callingOff = (said: string) => (said.includes("don't") ? 0.9 : 0.1);

test("calling off a handoff hex is working on stops that handoff, once", async () => {
  const { stop, stops } = judged(callingOff);
  stop.handed("d1", "you: start a topic for Brim");
  stop.heard("Never mind, ");
  stop.heard("don't do that");
  await until(() => stops.length);
  stop.heard(" really, don't");
  await Bun.sleep(30);

  expect(stops).toEqual(["d1"]);
});

test("words go to Jev only while hex works on a handoff", async () => {
  const { stop, asked } = judged(callingOff);
  stop.heard("what's the weather");
  stop.handed("d1", "you: start a topic for Brim");
  stop.heard("call it brim");
  await until(() => asked.length);
  stop.answered("d1");
  stop.heard(", don't");
  await Bun.sleep(30);

  expect(asked).toEqual(["call it brim"]);
});

test("a stop answer about an older handoff stops nothing", async () => {
  const { stop, stops } = judged(callingOff);
  stop.handed("d1", "you: start a topic for Brim");
  stop.heard("don't");
  stop.handed("d2", "you: what's running");
  await Bun.sleep(30);

  expect(stops).toEqual([]);
});
