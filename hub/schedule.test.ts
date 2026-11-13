import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { check, parse } from "./schedule.ts";
import type { Job } from "./schedule.ts";
import { open } from "./store.ts";

let dir: string;
let hexDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "schedule-"));
  hexDir = join(dir, "hex");
  mkdirSync(join(hexDir, ".claude"), { recursive: true });
  writeFileSync(
    join(hexDir, ".claude", "settings.json"),
    JSON.stringify({ env: { TZ: "America/Los_Angeles" } }),
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const LOS_ANGELES_HOURS_BEHIND_UTC_IN_OCTOBER_2026 = 7;

const at = (day: number, hour: number, minute = 0) =>
  Date.UTC(2026, 9, day, hour + LOS_ANGELES_HOURS_BEHIND_UTC_IN_OCTOBER_2026, minute) / 60_000;

const utc = (year: number, month: number, day: number, hour: number) =>
  Date.UTC(year, month - 1, day, hour) / 60_000;

function schedulesJson(text: string) {
  writeFileSync(join(hexDir, "schedules.json"), text);
}

function jobs(file: Record<string, Job>) {
  schedulesJson(JSON.stringify(file));
}

function checkEachMinuteAndListFired(from: number, to: number) {
  for (let minute = from; minute <= to; minute++) {
    check(dir, hexDir, "general", minute);
  }

  return fired();
}

function fired() {
  return open(dir)
    .messages.untaken()
    .map((row) => row.key);
}

function takeAll() {
  for (const row of open(dir).messages.untaken()) {
    open(dir).messages.take(row.key, "session");
  }
}

test("a job fires at its minute on the owner's clock, once, beside the main thread", () => {
  jobs({ heartbeat: { cron: "45 * * * *", prompt: "Hourly check" } });
  expect(checkEachMinuteAndListFired(at(18, 14, 40), at(18, 14, 50))).toEqual([
    "schedule:heartbeat@2026-10-18T21:45Z",
  ]);
  expect(open(dir).messages.get("schedule:heartbeat@2026-10-18T21:45Z")).toMatchObject({
    to: "beside:general",
    from: "schedule",
    body: "[heartbeat] Hourly check",
  });
  expect(
    open(dir).messages.get("schedule:heartbeat@2026-10-18T21:45Z")?.meta?.late,
  ).toBeUndefined();
});

test("steps, ranges, lists and Sunday as 0 or 7 fire where cron does", () => {
  jobs({
    leisure: { cron: "17 */3 * * *", prompt: "Leisure" },
    weekdays: { cron: "0 9 * * 1-5", prompt: "Morning" },
    sunday: { cron: "0 8 * * 7", prompt: "Sunday" },
    either: { cron: "0 10 1 * 0", prompt: "First or Sunday" },
  });
  const keys: string[] = [];

  for (let minute = at(18, 0); minute < at(19, 0); minute++) {
    check(dir, hexDir, "general", minute);
    keys.push(...fired());
    takeAll();
  }

  expect(keys.filter((key) => key.startsWith("schedule:leisure@"))).toHaveLength(8);
  expect(keys).toContain("schedule:sunday@2026-10-18T15:00Z");
  expect(keys).toContain("schedule:either@2026-10-18T17:00Z");
  expect(keys.some((key) => key.startsWith("schedule:weekdays@"))).toBe(false);
});

test("an at fires once at each time it lists, and never again after", () => {
  jobs({
    treat: {
      at: ["2026-10-20 16:00", "2026-10-20T18:00"],
      prompt: "Water the plants",
      thread: "topic",
    },
  });
  const keys: string[] = [];

  for (let minute = at(20, 15, 59); minute <= at(20, 18, 1); minute++) {
    check(dir, hexDir, "general", minute);
    keys.push(...fired());
    takeAll();
  }

  expect(keys).toEqual(["schedule:treat@2026-10-20T23:00Z", "schedule:treat@2026-10-21T01:00Z"]);
  expect(open(dir).messages.get(keys[0] ?? "")?.to).toBe("topic");
});

test("an at fires once when clocks go back, and as far past the jump as it was set when they skip it", () => {
  jobs({
    back: { at: "2026-11-01 01:30", prompt: "Back" },
    ahead: { at: "2027-03-14 02:30", prompt: "Ahead" },
  });
  const keys: string[] = [];

  for (const [from, to] of [
    [utc(2026, 11, 1, 7), utc(2026, 11, 1, 11)],
    [utc(2027, 3, 14, 8), utc(2027, 3, 14, 12)],
  ] as const) {
    for (let minute = from; minute <= to; minute++) {
      check(dir, hexDir, "general", minute);
      keys.push(...fired());
      takeAll();
    }
  }

  expect(keys).toEqual(["schedule:back@2026-11-01T08:30Z", "schedule:ahead@2027-03-14T10:30Z"]);
});

test("after the hub was down, each job fires its newest missed slot once, marked late", () => {
  jobs({
    heartbeat: { cron: "45 * * * *", prompt: "Hourly check" },
    nightly: { cron: "0 3 * * *", prompt: "Nightly" },
  });
  check(dir, hexDir, "general", at(18, 9));
  check(dir, hexDir, "general", at(18, 14, 50));
  expect(fired()).toEqual(["schedule:heartbeat@2026-10-18T21:45Z"]);
  expect(open(dir).messages.get("schedule:heartbeat@2026-10-18T21:45Z")?.meta?.late).toBe("true");
});

test("the first check ever fires nothing from before it", () => {
  jobs({ heartbeat: { cron: "* * * * *", prompt: "Every minute" } });
  check(dir, hexDir, "general", at(18, 9));
  expect(fired()).toEqual([]);
  check(dir, hexDir, "general", at(18, 9, 1));
  expect(fired()).toEqual(["schedule:heartbeat@2026-10-18T16:01Z"]);
});

test("a job fires every time it comes due, even while its last message waits to be taken", () => {
  jobs({ heartbeat: { cron: "45 * * * *", prompt: "Hourly check" } });
  checkEachMinuteAndListFired(at(18, 9), at(18, 12));
  expect(fired()).toEqual([
    "schedule:heartbeat@2026-10-18T16:45Z",
    "schedule:heartbeat@2026-10-18T17:45Z",
    "schedule:heartbeat@2026-10-18T18:45Z",
  ]);
});

test("a broken schedules.json fires nothing, says why once, and its jobs catch up once it loads", () => {
  jobs({ heartbeat: { cron: "45 * * * *", prompt: "Hourly check" } });
  check(dir, hexDir, "general", at(18, 9));
  schedulesJson('{ "heartbeat": { "cron": "hourly", "prompt": "x" } }');
  checkEachMinuteAndListFired(at(18, 9, 40), at(18, 9, 50));
  const [broken, ...rest] = open(dir).messages.untaken();
  expect(rest).toEqual([]);
  expect(broken?.body).toContain('"hourly" is not a five-field cron expression');
  expect(broken?.to).toBe("beside:general");
  takeAll();
  jobs({ heartbeat: { cron: "45 * * * *", prompt: "Hourly check" } });
  check(dir, hexDir, "general", at(18, 9, 51));
  expect(fired()).toEqual(["schedule:heartbeat@2026-10-18T16:45Z"]);
  expect(open(dir).messages.get("schedule:heartbeat@2026-10-18T16:45Z")?.meta?.late).toBe("true");
});

test("a schedules.json gone for a while leaves its jobs to catch up once it is back", () => {
  jobs({ heartbeat: { cron: "45 * * * *", prompt: "Hourly check" } });
  check(dir, hexDir, "general", at(18, 9));
  rmSync(join(hexDir, "schedules.json"));
  checkEachMinuteAndListFired(at(18, 9, 40), at(18, 9, 50));
  jobs({ heartbeat: { cron: "45 * * * *", prompt: "Hourly check" } });
  check(dir, hexDir, "general", at(18, 9, 51));
  expect(fired()).toEqual(["schedule:heartbeat@2026-10-18T16:45Z"]);
});

test("a job needs a prompt and a cron or an at it can read", () => {
  expect(() => parse(JSON.stringify({ a: { cron: "* * * * *" } }))).toThrow("a: prompt is missing");
  expect(() => parse(JSON.stringify({ a: { prompt: "x" } }))).toThrow(
    "a: it needs a cron or an at",
  );
  expect(() => parse(JSON.stringify({ a: { at: "tomorrow", prompt: "x" } }))).toThrow("at must be");
  expect(() => parse(JSON.stringify({ a: { at: "2026-02-30 10:00", prompt: "x" } }))).toThrow(
    "at must be",
  );

  for (const cron of [
    ["* * * * *"],
    "60 * * * *",
    "*/0 * * * *",
    "0 5-2 * * *",
    "0 0 0 * *",
    "0 0 * 13 *",
    "0 0 * * 8",
  ]) {
    expect(() => parse(JSON.stringify({ a: { cron, prompt: "x" } }))).toThrow(
      `a: ${JSON.stringify(cron)} is not a five-field cron expression`,
    );
  }

  expect(parse(JSON.stringify({ a: { cron: "5/15 0-23/2 1,15 */3 0-7", prompt: "x" } }))).toEqual({
    a: { cron: "5/15 0-23/2 1,15 */3 0-7", prompt: "x" },
  });
  expect(parse(JSON.stringify({ a: { at: "2026-10-20 16:00", prompt: "x" } }))).toEqual({
    a: { at: "2026-10-20 16:00", prompt: "x" },
  });
});

test("a job that names an idea is handed to its check every minute, with its slot when one came due, and at most daily", () => {
  expect(() =>
    parse(JSON.stringify({ broken: { cron: "0 9 * * 1", idea: "four", prompt: "x" } })),
  ).toThrow("idea must be");
  expect(() =>
    parse(JSON.stringify({ hourly: { cron: "0 * * * *", idea: "t-4", prompt: "x" } })),
  ).toThrow("at most daily");
  jobs({ "gpt-live": { cron: "0 9 * * 1", idea: "t-4", prompt: "Is GPT Live 1.1 on the API?" } });
  const checked: [string, string | undefined, number | undefined][] = [];

  for (let minute = at(19, 8, 59); minute <= at(19, 9, 1); minute++) {
    check(dir, hexDir, "general", minute, (_, name, job, __, slot) => {
      checked.push([name, job.idea, slot]);
    });
  }

  expect(checked).toEqual([
    ["gpt-live", "t-4", undefined],
    ["gpt-live", "t-4", at(19, 9)],
    ["gpt-live", "t-4", undefined],
  ]);
  expect(fired()).toEqual([]);
});

test("a check job runs beside its thread, where a job with a thread runs in it", () => {
  expect(() =>
    parse(JSON.stringify({ broken: { cron: "45 * * * *", check: "yes", prompt: "x" } })),
  ).toThrow("check must be true or false");
  jobs({
    mail: { cron: "45 * * * *", check: true, thread: "topic", prompt: "Check my mail." },
    standup: { cron: "45 * * * *", thread: "topic", prompt: "Standup." },
  });
  check(dir, hexDir, "general", at(19, 8, 44));
  check(dir, hexDir, "general", at(19, 8, 45));
  const slot = `${new Date(at(19, 8, 45) * 60_000).toISOString().slice(0, 16)}Z`;

  expect(open(dir).messages.get(`schedule:mail@${slot}`)?.to).toBe("beside:topic");
  expect(open(dir).messages.get(`schedule:standup@${slot}`)?.to).toBe("topic");
});
