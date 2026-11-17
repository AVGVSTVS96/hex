import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { transcript } from "./claude.ts";
import { study } from "./ideas.ts";
import type { Session } from "./running.ts";
import { check, nextRun, parse } from "./schedule.ts";
import type { Job } from "./schedule.ts";
import { file } from "./store.ts";

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

function jobs(table: Record<string, Job>) {
  schedulesJson(JSON.stringify(table));
}

const nobody = () => Promise.resolve(new Map<string, Session>());

async function checkWith(minute: number, sessions: () => Promise<Map<string, Session>> = nobody) {
  await check(dir, hexDir, "general", minute, study, sessions);
}

const working = () =>
  Promise.resolve(
    new Map<string, Session>([["run-1", { id: "run-1", pid: 1, status: "busy", started: 0 }]]),
  );

const runs = () => fired().filter((key) => key.startsWith("schedule:"));

async function checkEachMinuteAndListFired(from: number, to: number) {
  for (let minute = from; minute <= to; minute++) {
    await checkWith(minute);
  }

  return fired();
}

function fired() {
  return file(dir)
    .messages.untaken()
    .map((row) => row.key);
}

function takeAll() {
  for (const row of file(dir).messages.untaken()) {
    file(dir).messages.take(row.key, "session");
  }
}

test("a job fires at its minute on the owner's clock, once, beside the main thread", async () => {
  jobs({ heartbeat: { cron: "45 * * * *", prompt: "Hourly check" } });
  expect(await checkEachMinuteAndListFired(at(18, 14, 40), at(18, 14, 50))).toEqual([
    "schedule:heartbeat@2026-10-18T21:45Z",
  ]);
  expect(file(dir).messages.get("schedule:heartbeat@2026-10-18T21:45Z")).toMatchObject({
    to: "beside:general",
    from: "schedule",
    body: "[heartbeat] Hourly check",
  });
  expect(
    file(dir).messages.get("schedule:heartbeat@2026-10-18T21:45Z")?.meta?.late,
  ).toBeUndefined();
});

test("steps, ranges, lists and Sunday as 0 or 7 fire where cron does", async () => {
  jobs({
    leisure: { cron: "17 */3 * * *", prompt: "Leisure" },
    weekdays: { cron: "0 9 * * 1-5", prompt: "Morning" },
    sunday: { cron: "0 8 * * 7", prompt: "Sunday" },
    either: { cron: "0 10 1 * 0", prompt: "First or Sunday" },
  });
  const keys: string[] = [];

  for (let minute = at(18, 0); minute < at(19, 0); minute++) {
    await check(dir, hexDir, "general", minute);
    keys.push(...fired());
    takeAll();
  }

  expect(keys.filter((key) => key.startsWith("schedule:leisure@"))).toHaveLength(8);
  expect(keys).toContain("schedule:sunday@2026-10-18T15:00Z");
  expect(keys).toContain("schedule:either@2026-10-18T17:00Z");
  expect(keys.some((key) => key.startsWith("schedule:weekdays@"))).toBe(false);
});

test("an at fires once at each time it lists, and never again after", async () => {
  jobs({
    treat: {
      at: ["2026-10-20 16:00", "2026-10-20T18:00"],
      prompt: "Water the plants",
      thread: "topic",
    },
  });
  const keys: string[] = [];

  for (let minute = at(20, 15, 59); minute <= at(20, 18, 1); minute++) {
    await check(dir, hexDir, "general", minute);
    keys.push(...fired());
    takeAll();
  }

  expect(keys).toEqual(["schedule:treat@2026-10-20T23:00Z", "schedule:treat@2026-10-21T01:00Z"]);
  expect(file(dir).messages.get(keys[0] ?? "")?.to).toBe("topic");
});

test("an at fires once when clocks go back, and as far past the jump as it was set when they skip it", async () => {
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
      await check(dir, hexDir, "general", minute);
      keys.push(...fired());
      takeAll();
    }
  }

  expect(keys).toEqual(["schedule:back@2026-11-01T08:30Z", "schedule:ahead@2027-03-14T10:30Z"]);
});

test("after the hub was down, each job fires its newest missed slot once, marked late", async () => {
  jobs({
    heartbeat: { cron: "45 * * * *", prompt: "Hourly check" },
    nightly: { cron: "0 3 * * *", prompt: "Nightly" },
  });
  await check(dir, hexDir, "general", at(18, 9));
  await check(dir, hexDir, "general", at(18, 14, 50));
  expect(fired()).toEqual(["schedule:heartbeat@2026-10-18T21:45Z"]);
  expect(file(dir).messages.get("schedule:heartbeat@2026-10-18T21:45Z")?.meta?.late).toBe("true");
});

test("the first check ever fires nothing from before it", async () => {
  jobs({ heartbeat: { cron: "* * * * *", prompt: "Every minute" } });
  await check(dir, hexDir, "general", at(18, 9));
  expect(fired()).toEqual([]);
  await check(dir, hexDir, "general", at(18, 9, 1));
  expect(fired()).toEqual(["schedule:heartbeat@2026-10-18T16:01Z"]);
});

test("a job fires every time it comes due, even while its last message waits to be taken", async () => {
  jobs({ heartbeat: { cron: "45 * * * *", prompt: "Hourly check" } });
  await checkEachMinuteAndListFired(at(18, 9), at(18, 12));
  expect(fired()).toEqual([
    "schedule:heartbeat@2026-10-18T16:45Z",
    "schedule:heartbeat@2026-10-18T17:45Z",
    "schedule:heartbeat@2026-10-18T18:45Z",
  ]);
});

test("a broken schedules.json fires nothing, says why once, and its jobs catch up once it loads", async () => {
  jobs({ heartbeat: { cron: "45 * * * *", prompt: "Hourly check" } });
  await check(dir, hexDir, "general", at(18, 9));
  schedulesJson('{ "heartbeat": { "cron": "hourly", "prompt": "x" } }');
  await checkEachMinuteAndListFired(at(18, 9, 40), at(18, 9, 50));
  const [broken, ...rest] = file(dir).messages.untaken();
  expect(rest).toEqual([]);
  expect(broken?.body).toContain('"hourly" is not a five-field cron expression');
  expect(broken?.to).toBe("beside:general");
  takeAll();
  jobs({ heartbeat: { cron: "45 * * * *", prompt: "Hourly check" } });
  await check(dir, hexDir, "general", at(18, 9, 51));
  expect(fired()).toEqual(["schedule:heartbeat@2026-10-18T16:45Z"]);
  expect(file(dir).messages.get("schedule:heartbeat@2026-10-18T16:45Z")?.meta?.late).toBe("true");
});

test("a schedules.json gone for a while leaves its jobs to catch up once it is back", async () => {
  jobs({ heartbeat: { cron: "45 * * * *", prompt: "Hourly check" } });
  await check(dir, hexDir, "general", at(18, 9));
  rmSync(join(hexDir, "schedules.json"));
  await checkEachMinuteAndListFired(at(18, 9, 40), at(18, 9, 50));
  jobs({ heartbeat: { cron: "45 * * * *", prompt: "Hourly check" } });
  await check(dir, hexDir, "general", at(18, 9, 51));
  expect(fired()).toEqual(["schedule:heartbeat@2026-10-18T16:45Z"]);
});

test("a job needs a prompt and a cron or an at it can read", () => {
  expect(() => parse(JSON.stringify({ a: { cron: "* * * * *" } }))).toThrow("a: prompt is missing");
  expect(() => parse(JSON.stringify({ a: { prompt: "x" } }))).toThrow(
    "a: it needs a cron, an at or an on",
  );
  expect(() => parse(JSON.stringify({ a: { on: [], prompt: "x" } }))).toThrow("on must list");
  expect(parse(JSON.stringify({ a: { on: ["job-failed"], prompt: "x" } }))).toEqual({
    a: { on: ["job-failed"], prompt: "x" },
  });
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
    "@daily",
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

test("a job that names an idea is handed to its check every minute, with its slot when one came due, and at most daily", async () => {
  expect(() =>
    parse(JSON.stringify({ broken: { cron: "0 9 * * 1", idea: "four", prompt: "x" } })),
  ).toThrow("idea must be");
  expect(() =>
    parse(JSON.stringify({ hourly: { cron: "0 * * * *", idea: "t-4", prompt: "x" } })),
  ).toThrow("at most daily");
  jobs({ "gpt-live": { cron: "0 9 * * 1", idea: "t-4", prompt: "Is GPT Live 1.1 on the API?" } });
  const checked: [string, string | undefined, number | undefined][] = [];

  for (let minute = at(19, 8, 59); minute <= at(19, 9, 1); minute++) {
    await check(dir, hexDir, "general", minute, (_, name, job, __, slot) => {
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

test("a check job runs beside its thread, where a job with a thread runs in it", async () => {
  expect(() =>
    parse(JSON.stringify({ broken: { cron: "45 * * * *", check: "yes", prompt: "x" } })),
  ).toThrow("check must be true or false");
  jobs({
    mail: { cron: "45 * * * *", check: true, thread: "topic", prompt: "Check my mail." },
    standup: { cron: "45 * * * *", thread: "topic", prompt: "Standup." },
  });
  await check(dir, hexDir, "general", at(19, 8, 44));
  await check(dir, hexDir, "general", at(19, 8, 45));
  const slot = `${new Date(at(19, 8, 45) * 60_000).toISOString().slice(0, 16)}Z`;

  expect(file(dir).messages.get(`schedule:mail@${slot}`)?.to).toBe("beside:topic");
  expect(file(dir).messages.get(`schedule:standup@${slot}`)?.to).toBe("topic");
});

test("a daily cron fires once on the day clocks skip its minute, and once on the day they repeat it", () => {
  const zone = "America/Los_Angeles";
  const ahead = { cron: "30 2 * * *", prompt: "Ahead" };
  const back = { cron: "30 1 * * *", prompt: "Back" };

  expect(nextRun(ahead, zone, utc(2027, 3, 14, 8))).toBe(utc(2027, 3, 14, 10) + 30);
  expect(nextRun(ahead, zone, utc(2027, 3, 14, 10) + 30)).toBe(utc(2027, 3, 15, 9) + 30);
  expect(nextRun(back, zone, utc(2027, 11, 7, 7))).toBe(utc(2027, 11, 7, 8) + 30);
  expect(nextRun(back, zone, utc(2027, 11, 7, 8) + 30)).toBe(utc(2027, 11, 8, 9) + 30);
});

test("a job's next run is the next minute it would fire, on the owner's clock", () => {
  const zone = "America/Los_Angeles";

  expect(nextRun({ cron: "0 9 * * *", prompt: "Daily" }, zone, at(18, 10))).toBe(at(19, 9));
  expect(nextRun({ cron: "20 8-23 * * *", prompt: "Hourly" }, zone, at(18, 23, 30))).toBe(
    at(19, 8, 20),
  );
  expect(nextRun({ cron: "0 10 * * 1", prompt: "Mondays" }, zone, at(18, 10))).toBe(at(19, 10));
  expect(
    nextRun({ at: ["2026-10-20 18:30", "2026-10-19 07:00"], prompt: "Twice" }, zone, at(18, 0)),
  ).toBe(at(19, 7));
  expect(nextRun({ at: "2026-10-01 09:00", prompt: "Past" }, zone, at(18, 0))).toBeUndefined();
});

test("a watch is a job with the name the owner knows it by", () => {
  expect(
    parse(JSON.stringify({ rail: { cron: "0 9 * * *", prompt: "Look", watch: "Rail strike" } }))
      .rail?.watch,
  ).toBe("Rail strike");
  expect(() =>
    parse(JSON.stringify({ rail: { cron: "0 9 * * *", prompt: "Look", watch: "" } })),
  ).toThrow("watch must be");
});

test("signals that come in a burst fire a job that runs on them once, beside the main thread, saying why", async () => {
  jobs({ "catch-up": { on: ["job-failed", "pace"], cron: "4 7 * * *", prompt: "Catch up." } });
  await checkWith(at(19, 8, 0));

  for (const unit of ["a", "b", "c"]) {
    file(dir).scheduler.signal("job-failed", `[job] ${unit} ended: failed (exit 1).\nits output`);
  }

  file(dir).scheduler.signal("nobody-listens", "x");
  await checkWith(at(19, 8, 1));

  const [run, ...more] = file(dir).messages.untaken();
  expect(more).toEqual([]);
  expect(run).toMatchObject({ to: "beside:general", meta: { schedule: "catch-up" } });
  expect(run?.body).toBe(
    "[catch-up] Catch up.\n\nWhy now:\n- [job] a ended: failed (exit 1).\n- [job] b ended: failed (exit 1).\n- [job] c ended: failed (exit 1).",
  );
  expect(file(dir).scheduler.signals()).toEqual([]);
});

test("signals that come while a run waits or works fold into one run after it", async () => {
  jobs({ "catch-up": { on: ["stalled"], prompt: "Catch up." } });
  await checkWith(at(19, 8, 0));
  file(dir).scheduler.signal("stalled", "one");
  await checkWith(at(19, 8, 1));
  file(dir).scheduler.signal("stalled", "two");
  await checkWith(at(19, 8, 2));
  expect(runs()).toHaveLength(1);

  const [first] = file(dir).messages.untaken();
  file(dir).messages.take(first?.key ?? "", "run-1");
  file(dir).turns.turned("run-1", true);
  file(dir).scheduler.signal("stalled", "three");

  await checkWith(at(19, 8, 3), working);
  expect(runs()).toEqual([]);

  file(dir).turns.turned("run-1", false);
  await checkWith(at(19, 8, 4), working);
  const [next, ...others] = file(dir).messages.untaken();
  expect(others).toEqual([]);
  expect(next?.body).toBe("[catch-up] Catch up.\n\nWhy now:\n- two\n- three");
});

test("a run whose session died mid-turn doesn't hold signals back", async () => {
  jobs({ "catch-up": { on: ["stalled"], prompt: "Catch up." } });
  await checkWith(at(19, 8, 0));
  file(dir).scheduler.signal("stalled", "one");
  await checkWith(at(19, 8, 1));
  takeAll();
  file(dir).turns.turned("session", true);
  file(dir).scheduler.signal("stalled", "two");
  await checkWith(at(19, 8, 2));
  expect(
    file(dir)
      .messages.untaken()
      .map((row) => row.body),
  ).toEqual(["[catch-up] Catch up.\n\nWhy now:\n- two"]);
});

test("a session of hex's mid-turn that writes nothing for half an hour signals stalled once each quiet stretch", async () => {
  const claude = join(dir, "claude");
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claude;

  try {
    const log = transcript("/work", "quiet");
    mkdirSync(join(log, ".."), { recursive: true });
    writeFileSync(log, "{}\n");
    const minute = at(19, 8, 0);

    const wrote = (minutesBefore: number) => {
      const when = (minute - minutesBefore) * 60;
      utimesSync(log, when, when);
    };

    const session: Session = {
      id: "quiet",
      pid: 1,
      status: "busy",
      cwd: "/work",
      started: 0,
      thread: "telegram:topic",
      name: "Topic",
    };

    const sessions = () => Promise.resolve(new Map([["quiet", session]]));
    jobs({ "catch-up": { on: ["stalled"], prompt: "Catch up." } });

    wrote(29);
    await checkWith(minute, sessions);
    expect(fired()).toEqual([]);

    wrote(31);
    await checkWith(minute + 1, sessions);
    await checkWith(minute + 2, sessions);
    takeAll();
    await checkWith(minute + 3, sessions);
    expect(fired()).toEqual([]);

    expect(
      file(dir)
        .messages.since()
        .filter((row) => row.to === "signal:stalled"),
    ).toHaveLength(1);

    await checkWith(minute + 4, () =>
      Promise.resolve(new Map([["quiet", { ...session, status: "idle" }]])),
    );
    wrote(40);
    await checkWith(minute + 5, () =>
      Promise.resolve(new Map([["quiet", { ...session, thread: undefined }]])),
    );
    expect(fired()).toEqual([]);
  } finally {
    if (before === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = before;
    }
  }
});
