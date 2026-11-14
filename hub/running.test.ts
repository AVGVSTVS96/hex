import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { running, served, serving } from "./running.ts";
import type { Session } from "./running.ts";
import { open } from "./store.ts";
import { until } from "./until.ts";

const claude = mkdtempSync(join(tmpdir(), "running-"));
const store = open(join(claude, "state"));

afterEach(() => {
  rmSync(join(claude, "sessions"), { recursive: true, force: true });
});

function found(sessions: Map<string, Session>, id: string): Session {
  const session = sessions.get(id);

  if (session === undefined) {
    throw new Error(`${id} isn't running`);
  }

  return session;
}

type SessionFile = {
  pid: number | undefined;
  sessionId: string;
  status: string;
  kind?: string;
  name?: string;
  cwd?: string;
  startedAt?: number;
  procStart?: string | undefined;
};

function record(name: string, session: SessionFile) {
  mkdirSync(join(claude, "sessions"), { recursive: true });
  writeFileSync(join(claude, "sessions", `${name}.json`), JSON.stringify(session));
}

test("a session runs while its process lives, works for the thread it serves or the one it started for (a background session has the daemon's environment), and its turns are hex's record", async () => {
  const job = Bun.spawn(["sleep", "30"], {
    env: { ...process.env, HEX_CHANNEL: "", HEX_THREAD: "", HEX_OWNER: "telegram:-100:103" },
  });

  afterAll(() => {
    job.kill();
  });
  await until(() =>
    readFileSync(`/proc/${job.pid}/environ`, "utf-8").includes("HEX_OWNER=telegram:-100:103"),
  );
  record("thread", {
    pid: process.pid,
    sessionId: "aaaaaaaa-1",
    status: "idle",
    kind: "bg",
    name: "General",
    cwd: "/hex",
    startedAt: 1,
  });
  record("job", {
    pid: job.pid,
    sessionId: "bbbbbbbb-1",
    status: "busy",
    kind: "interactive",
    startedAt: 2,
  });
  record("worker", {
    pid: job.pid,
    sessionId: "ffffffff-1",
    status: "busy",
    kind: "bg",
    startedAt: 3,
  });
  record("gone", { pid: 2 ** 22 + 1, sessionId: "cccccccc-1", status: "busy" });
  record("old", { pid: process.pid, sessionId: "dddddddd-1", status: "idle" });
  record("new", { pid: process.pid, sessionId: "dddddddd-1", status: "busy" });
  store.turns.turned("bbbbbbbb-1", true);
  const sessions = running(store, claude);
  expect([...sessions.keys()].toSorted()).toEqual([
    "aaaaaaaa-1",
    "bbbbbbbb-1",
    "dddddddd-1",
    "ffffffff-1",
  ]);
  expect(found(sessions, "ffffffff-1").thread).toBeUndefined();
  expect(sessions.get("aaaaaaaa-1")).toMatchObject({
    status: "idle",
    kind: "bg",
    name: "General",
    cwd: "/hex",
    started: 1,
  });
  expect(sessions.get("bbbbbbbb-1")).toMatchObject({ thread: "telegram:-100:103" });
  expect(found(sessions, "bbbbbbbb-1").began).toBeString();
  expect(found(sessions, "bbbbbbbb-1").ended).toBeUndefined();
  expect(found(sessions, "dddddddd-1").status).toBe("busy");
  const held = new Map([["aaaaaaaa-1", "discord:7"]]);
  expect(serving(found(sessions, "aaaaaaaa-1"), held)).toBe("discord:7");
  expect(serving(found(sessions, "bbbbbbbb-1"), held)).toBe("telegram:-100:103");
  store.turns.turned("bbbbbbbb-1", false);
  const ended = found(running(store, claude), "bbbbbbbb-1");
  expect(ended.status).toBe("busy");
  expect(Date.parse(ended.ended ?? "")).toBeGreaterThanOrEqual(Date.parse(ended.began ?? ""));
});

test("a session whose process runs under another's works for what that one works for, and hex's own helper, launched the same way, for nothing", async () => {
  const tree = Bun.spawn(["sh", "-c", "sleep 30 & HEX_HELPER=check sleep 30 & wait"], {
    env: { ...process.env, HEX_CHANNEL: "", HEX_THREAD: "", HEX_OWNER: "" },
  });

  const kids = await until(() => {
    const pids = children(tree.pid);

    return pids.length === 2 && pids.every(runsSleep) ? pids : undefined;
  });

  afterAll(() => {
    for (const pid of [tree.pid, ...kids]) {
      stop(pid);
    }
  });

  const helper = kids.find((pid) =>
    readFileSync(`/proc/${pid}/environ`, "utf-8").includes("HEX_HELPER=check"),
  );

  record("topic", {
    pid: tree.pid,
    sessionId: "aaaaaaaa-2",
    status: "idle",
    kind: "bg",
    startedAt: 1,
  });
  record("build", {
    pid: kids.find((pid) => pid !== helper),
    sessionId: "bbbbbbbb-2",
    status: "busy",
    startedAt: 2,
  });
  record("check", { pid: helper, sessionId: "cccccccc-2", status: "busy", startedAt: 3 });
  const sessions = running(store, claude);
  expect(found(sessions, "aaaaaaaa-2").parent).toBeUndefined();
  expect(sessions.get("bbbbbbbb-2")).toMatchObject({ parent: "aaaaaaaa-2" });
  expect(sessions.get("cccccccc-2")).toMatchObject({ parent: "aaaaaaaa-2", helper: "check" });
  const held = new Map([["aaaaaaaa-2", "discord:7"]]);
  expect(serving(found(sessions, "bbbbbbbb-2"), held, sessions)).toBe("discord:7");
  expect(serving(found(sessions, "bbbbbbbb-2"), held)).toBeUndefined();
  expect(serving(found(sessions, "cccccccc-2"), held, sessions)).toBeUndefined();
});

test("a session hex runs beside a thread works for that thread, and says it runs beside it", async () => {
  const run = Bun.spawn(["sleep", "30"], {
    env: {
      ...process.env,
      HEX_CHANNEL: "plugin:telegram@hex",
      HEX_THREAD: "-100:103",
      HEX_BESIDE: "eeeeeeee-1",
      HEX_OWNER: "",
    },
  });

  afterAll(() => {
    run.kill();
  });
  await until(() =>
    readFileSync(`/proc/${run.pid}/environ`, "utf-8").includes("HEX_BESIDE=eeeeeeee-1"),
  );
  record("beside", { pid: run.pid, sessionId: "eeeeeeee-1", status: "busy", startedAt: 1 });
  const sessions = running(store, claude);
  expect(sessions.get("eeeeeeee-1")).toMatchObject({
    thread: "telegram:-100:103",
    beside: "eeeeeeee-1",
  });
  expect(serving(found(sessions, "eeeeeeee-1"), new Map(), sessions)).toBe("telegram:-100:103");
});

test("a background session works for the thread its job's settings name, before any thread holds it", () => {
  writeFileSync(
    join(claude, "thread-settings.json"),
    JSON.stringify({ env: { HEX_CHANNEL: "plugin:telegram@hex", HEX_THREAD: "-100:103" } }),
  );
  mkdirSync(join(claude, "jobs", "aaaaaaaa"), { recursive: true });
  writeFileSync(
    join(claude, "jobs", "aaaaaaaa", "state.json"),
    JSON.stringify({
      state: "working",
      respawnFlags: ["--name", "Video", "--settings", join(claude, "thread-settings.json")],
    }),
  );
  record("fresh", {
    pid: process.pid,
    sessionId: "aaaaaaaa-4",
    status: "busy",
    kind: "bg",
    startedAt: 1,
  });
  record("plain", {
    pid: process.pid,
    sessionId: "bbbbbbbb-4",
    status: "busy",
    kind: "bg",
    startedAt: 1,
  });
  const sessions = running(store, claude);
  expect(found(sessions, "aaaaaaaa-4").thread).toBe("telegram:-100:103");
  expect(found(sessions, "bbbbbbbb-4").thread).toBeUndefined();
  rmSync(join(claude, "jobs"), { recursive: true });
});

test("a background session whose settings are a pipe or can't be opened works for no thread, without blocking", () => {
  Bun.spawnSync(["mkfifo", join(claude, "settings-pipe")]);

  const unreadable: [string, string][] = [
    ["cccccccc", join(claude, "settings-pipe")],
    ["dddddddd", "/proc/1/environ"],
    ["eeeeeeee", `/${"x".repeat(5000)}`],
  ];

  for (const [id, settings] of unreadable) {
    mkdirSync(join(claude, "jobs", id), { recursive: true });
    writeFileSync(
      join(claude, "jobs", id, "state.json"),
      JSON.stringify({ state: "working", respawnFlags: ["--settings", settings] }),
    );
    record(id, {
      pid: process.pid,
      sessionId: `${id}-5`,
      status: "busy",
      kind: "bg",
      startedAt: 1,
    });
  }

  const sessions = running(store, claude);
  expect(["cccccccc-5", "dddddddd-5", "eeeeeeee-5"].map((id) => sessions.get(id)?.thread)).toEqual([
    undefined,
    undefined,
    undefined,
  ]);
  expect(sessions.size).toBe(3);
  rmSync(join(claude, "jobs"), { recursive: true });
  rmSync(join(claude, "settings-pipe"));
});

test("a record whose pid now belongs to a process that started at another time isn't running", () => {
  const since = readFileSync(`/proc/${process.pid}/stat`, "utf-8").split(") ")[1]?.split(" ")[19];
  expect(since).toMatch(/^\d+$/u);
  record("same", { pid: process.pid, sessionId: "aaaaaaaa-3", status: "busy", procStart: since });
  record("reused", { pid: process.pid, sessionId: "bbbbbbbb-3", status: "busy", procStart: "1" });
  expect([...running(store, claude).keys()]).toEqual(["aaaaaaaa-3"]);
});

function stop(pid: number) {
  try {
    return process.kill(pid);
  } catch {
    return false;
  }
}

function children(pid: number) {
  return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf-8")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map(Number);
}

const runsSleep = (pid: number) => readFileSync(`/proc/${pid}/comm`, "utf-8") === "sleep\n";

test("a session works for the thread its hub started it for, else its job owner", () => {
  expect(served({ HEX_CHANNEL: "plugin:t3@hex", HEX_THREAD: "x", HEX_OWNER: "discord:1" })).toBe(
    "t3:x",
  );
  expect(served({ HEX_OWNER: "discord:1" })).toBe("discord:1");
  expect(served({ HEX_THREAD: "x", HEX_OWNER: "stray" })).toBeUndefined();
});
