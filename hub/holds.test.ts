import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { holding, instant, place, wake } from "./holds.ts";
import { open } from "./store.ts";
import type { Store } from "./store.ts";
import { pending } from "./tasks.ts";
import { until } from "./until.ts";

let dir: string;
let store: Store;
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "holds-"));
  mkdirSync(join(dir, "telegram"));
  store = open(dir);
  store.keepThreads("telegram", {
    "-100:1": { name: "General" },
    "-100:2": { name: "Machines" },
    "-100:3": { name: "Extensions" },
    "-100:4": { name: "Cloth" },
    "-100:5": { name: "DM" },
  });
  store.deliver({
    key: "telegram:-100:70",
    to: "-100:1",
    from: "telegram",
    body: "lots happening wait",
    author: "owner",
    meta: { user: "owner" },
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const told = (thread: string) => store.untaken(thread).filter((row) => row.from === "hold");

function takeAllAndFinishTurn(thread: string, session: string) {
  for (const row of store.untaken(thread)) {
    store.take(row.key, session);
  }

  store.turned(session, true);
  store.turned(session, false);
}

const all = new Set(["-100:2", "-100:3", "-100:4"]);

test("a hold tells each thread it holds that is at work, and every session sees it with the words it came from", () => {
  const hold = place(
    store,
    {
      threads: ["-100:1", "-100:2", "-100:3", "-100:4"],
      by: "-100:1",
      why: "focus on priorities",
      message: "telegram:-100:70",
      until: inAnHour(),
    },
    { working: new Set(["-100:3"]) },
  );

  expect(hold.id).toBe("h-1");
  expect(hold.threads.map((held) => held.thread)).toEqual(["-100:2", "-100:3", "-100:4"]);
  expect(told("-100:2")).toEqual([]);
  expect(told("-100:3")[0]?.body).toStartWith(
    "[hold h-1] General put this thread on hold: focus on priorities. Finish the step you're on",
  );

  for (const thread of ["-100:5", "-100:3", undefined]) {
    const { text } = pending(dir, thread);
    expect(text).toContain("- h-1 holds Machines, Extensions, Cloth · by General");
    expect(text).toContain('my words [telegram:-100:70]: "lots happening wait"');
  }
});

test("a hold ends at its time, and the threads it freed wake two at a time, each next once one's turn ends, its later turns not counted as waking", () => {
  place(
    store,
    {
      threads: ["-100:2", "-100:3", "-100:4", "-100:5"],
      by: "-100:1",
      why: "focus on priorities",
      until: inAnHour(),
    },
    { working: all },
  );

  for (const thread of ["-100:2", "-100:3", "-100:4"]) {
    takeAllAndFinishTurn(thread, `s${thread}`);
  }

  expect(store.due(new Date(Date.now() + 1_800_000).toISOString())).toEqual([]);
  expect(store.due(new Date(Date.now() + 3_600_001).toISOString())).toEqual([
    "-100:2",
    "-100:3",
    "-100:4",
    "-100:5",
  ]);
  expect(store.holds()).toEqual([]);
  wake(store);
  expect(told("-100:2")[0]?.body).toBe(
    "[hold h-1 ended] its time came. The hold on this thread (focus on priorities) is over: pick up where you stopped.",
  );
  expect(told("-100:3")).toHaveLength(1);
  expect(told("-100:4")).toEqual([]);

  for (const row of store.untaken("-100:2")) {
    store.take(row.key, "s-100:2");
  }

  store.turned("s-100:2", true);
  wake(store);
  expect(told("-100:4")).toEqual([]);
  store.turned("s-100:2", false);
  wake(store);
  expect(told("-100:4")).toHaveLength(1);
  store.turned("s-100:2", true);
  takeAllAndFinishTurn("-100:4", "s-100:4");
  expect(store.waking(60_000).count).toBe(1);
  wake(store);
  expect(told("-100:2")).toEqual([]);

  const dmAtRestTookNothingWhileHeld = "-100:5";

  expect(told(dmAtRestTookNothingWhileHeld)).toEqual([]);
  expect(store.freed()).toEqual([]);
});

test("a wake nobody takes stops counting once it has waited its patience, so the next thread still wakes", () => {
  place(
    store,
    { threads: ["-100:2", "-100:3", "-100:4"], by: "-100:1", why: "focus on priorities" },
    { working: all },
  );

  for (const thread of ["-100:2", "-100:3", "-100:4"]) {
    takeAllAndFinishTurn(thread, `s${thread}`);
  }

  store.unhold("h-1", "go");
  expect(wake(store)).toBeDefined();
  expect(told("-100:4")).toEqual([]);
  wake(store, new Date(Date.now() + 15 * 60_000 + 1000).toISOString());
  expect(told("-100:4")).toHaveLength(1);
});

test("the owner's word lifts a hold on some threads; one another hold still holds waits for that one", () => {
  place(
    store,
    { threads: ["-100:2", "-100:3"], by: "-100:1", why: "focus on priorities" },
    { working: all },
  );
  place(
    store,
    { threads: ["-100:3"], by: "-100:5", why: "the build is out of room" },
    { working: all },
  );
  expect(
    store.unhold("h-1", "he said go on the side projects [telegram:-100:71]", ["-100:3"]),
  ).toEqual(["-100:3"]);
  takeAllAndFinishTurn("-100:3", "s3");
  wake(store);
  expect(told("-100:3")).toEqual([]);
  expect(pending(dir).text).toContain("- h-1 holds Machines · freed Extensions");
  store.unhold("h-2", "the build finished");
  wake(store);
  expect(told("-100:3").map((row) => row.body)).toEqual([
    "[hold h-2 ended] the build finished. The hold on this thread (the build is out of room) is over: pick up where you stopped.",
  ]);
  expect(() => store.unhold("h-1", "go", ["-100:4"])).toThrow("h-1 doesn't hold -100:4");

  const unholdNow = (id: string) => () => store.unhold(id, "go");

  for (const id of ["h1", "1", "H-1"]) {
    expect(unholdNow(id)).toThrow("isn't a hold's id");
  }

  expect(store.unhold("h-2", "again")).toEqual([]);
});

test("a thread told of a hold that lifts before it reads the notice still wakes", () => {
  place(
    store,
    { threads: ["-100:2", "-100:4"], by: "-100:1", why: "focus on priorities" },
    { working: new Set(["-100:2"]) },
  );
  store.unhold("h-1", "go");
  wake(store);
  expect(told("-100:2").map((row) => row.key)).toEqual([
    "hold:h-1@-100:2",
    "hold:h-1@-100:2:ended",
  ]);
  expect(told("-100:4")).toEqual([]);
});

test("the hub ends a hold the moment its time comes and wakes what it freed", async () => {
  place(
    store,
    {
      threads: ["-100:2"],
      by: "-100:1",
      why: "wait for the reset",
      until: new Date(Date.now() + 300).toISOString(),
    },
    { working: all },
  );
  takeAllAndFinishTurn("-100:2", "s2");
  const stop = holding(dir);

  try {
    await until(() => told("-100:2").length);
    expect(told("-100:2")[0]?.body).toStartWith("[hold h-1 ended] its time came.");
  } finally {
    stop();
  }
});

test("a time reads on the owner's clock unless it names its offset", () => {
  expect(instant("2026-11-07 16:20", "America/Los_Angeles")).toBe("2026-11-08T00:20:00.000Z");
  expect(instant("2026-11-08T00:20:00Z")).toBe("2026-11-08T00:20:00.000Z");
  expect(instant("2026-11-07 16:20-08", "Europe/Paris")).toBe("2026-11-08T00:20:00.000Z");
  expect(() => instant("after the reset")).toThrow("isn't a time");
  expect(() =>
    place(
      store,
      { threads: ["-100:2"], by: "-100:1", why: "x", until: "2020-01-01T00:00:00.000Z" },
      { working: all },
    ),
  ).toThrow("has passed");
});
