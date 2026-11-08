import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { running, served, serving } from "./running.ts";
import { open } from "./store.ts";
import { until } from "./until.ts";

const claude = mkdtempSync(join(tmpdir(), "running-"));
const store = open(join(claude, "state"));
afterEach(() => rmSync(join(claude, "sessions"), { recursive: true, force: true }));

function record(name: string, session: object) {
  mkdirSync(join(claude, "sessions"), { recursive: true });
  writeFileSync(join(claude, "sessions", `${name}.json`), JSON.stringify(session));
}

test("a session runs while its process lives, works for the thread it serves or the one it started for (a background session has the daemon's environment), and its turns are hex's record", async () => {
  const job = Bun.spawn(["sleep", "30"], {
    env: { ...process.env, HEX_CHANNEL: "", HEX_THREAD: "", HEX_OWNER: "telegram:-100:65" },
  });
  afterAll(() => job.kill());
  await until(() =>
    readFileSync(`/proc/${job.pid}/environ`, "utf8").includes("HEX_OWNER=telegram:-100:65"),
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
  store.turned("bbbbbbbb-1", true);
  const sessions = running(store, claude);
  expect([...sessions.keys()].sort()).toEqual([
    "aaaaaaaa-1",
    "bbbbbbbb-1",
    "dddddddd-1",
    "ffffffff-1",
  ]);
  expect(sessions.get("ffffffff-1")!.thread).toBeUndefined();
  expect(sessions.get("aaaaaaaa-1")).toMatchObject({
    status: "idle",
    kind: "bg",
    name: "General",
    cwd: "/hex",
    started: 1,
  });
  expect(sessions.get("bbbbbbbb-1")).toMatchObject({
    thread: "telegram:-100:65",
    began: expect.any(String),
  });
  expect(sessions.get("bbbbbbbb-1")!.ended).toBeUndefined();
  expect(sessions.get("dddddddd-1")!.status).toBe("busy");
  const held = new Map([["aaaaaaaa-1", "discord:7"]]);
  expect(serving(sessions.get("aaaaaaaa-1")!, held)).toBe("discord:7");
  expect(serving(sessions.get("bbbbbbbb-1")!, held)).toBe("telegram:-100:65");
  store.turned("bbbbbbbb-1", false);
  const ended = running(store, claude).get("bbbbbbbb-1")!;
  expect(ended.status).toBe("busy");
  expect(Date.parse(ended.ended!)).toBeGreaterThanOrEqual(Date.parse(ended.began!));
});

test("a session whose process runs under another's works for what that one works for, and hex's own helper, launched the same way, for nothing", async () => {
  const tree = Bun.spawn(["sh", "-c", "sleep 30 & HEX_HELPER=check sleep 30 & wait"], {
    env: { ...process.env, HEX_CHANNEL: "", HEX_THREAD: "", HEX_OWNER: "" },
  });
  const kids = await until(() => children(tree.pid).length === 2 && children(tree.pid));
  afterAll(() => [tree.pid, ...kids].forEach(stop));
  const helper = kids.find((pid) =>
    readFileSync(`/proc/${pid}/environ`, "utf8").includes("HEX_HELPER=check"),
  )!;
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
  expect(sessions.get("aaaaaaaa-2")!.parent).toBeUndefined();
  expect(sessions.get("bbbbbbbb-2")).toMatchObject({ parent: "aaaaaaaa-2" });
  expect(sessions.get("cccccccc-2")).toMatchObject({ parent: "aaaaaaaa-2", helper: "check" });
  const held = new Map([["aaaaaaaa-2", "discord:7"]]);
  expect(serving(sessions.get("bbbbbbbb-2")!, held, sessions)).toBe("discord:7");
  expect(serving(sessions.get("bbbbbbbb-2")!, held)).toBeUndefined();
  expect(serving(sessions.get("cccccccc-2")!, held, sessions)).toBeUndefined();
});

test("a background session works for the thread its job's settings name, before any thread holds it", () => {
  writeFileSync(
    join(claude, "thread-settings.json"),
    JSON.stringify({ env: { HEX_CHANNEL: "plugin:telegram@hex", HEX_THREAD: "-100:65" } }),
  );
  mkdirSync(join(claude, "jobs", "aaaaaaaa"), { recursive: true });
  writeFileSync(
    join(claude, "jobs", "aaaaaaaa", "state.json"),
    JSON.stringify({
      state: "working",
      respawnFlags: ["--name", "Theo", "--settings", join(claude, "thread-settings.json")],
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
  expect(sessions.get("aaaaaaaa-4")!.thread).toBe("telegram:-100:65");
  expect(sessions.get("bbbbbbbb-4")!.thread).toBeUndefined();
  rmSync(join(claude, "jobs"), { recursive: true });
});

test("a background session whose settings are a pipe or can't be opened works for no thread, without blocking", () => {
  Bun.spawnSync(["mkfifo", join(claude, "settings-pipe")]);
  for (const [id, settings] of [
    ["cccccccc", join(claude, "settings-pipe")],
    ["dddddddd", "/proc/1/environ"],
    ["eeeeeeee", `/${"x".repeat(5000)}`],
  ]) {
    mkdirSync(join(claude, "jobs", id!), { recursive: true });
    writeFileSync(
      join(claude, "jobs", id!, "state.json"),
      JSON.stringify({ state: "working", respawnFlags: ["--settings", settings] }),
    );
    record(id!, {
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
  const since = readFileSync(`/proc/${process.pid}/stat`, "utf8").split(") ")[1].split(" ")[19];
  record("same", { pid: process.pid, sessionId: "aaaaaaaa-3", status: "busy", procStart: since });
  record("reused", { pid: process.pid, sessionId: "bbbbbbbb-3", status: "busy", procStart: "1" });
  expect([...running(store, claude).keys()]).toEqual(["aaaaaaaa-3"]);
});

function stop(pid: number) {
  try {
    process.kill(pid);
  } catch {}
}

function children(pid: number) {
  return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map(Number);
}

test("a session works for the thread its hub started it for, else its job owner", () => {
  expect(served({ HEX_CHANNEL: "plugin:t3@hex", HEX_THREAD: "x", HEX_OWNER: "discord:1" })).toBe(
    "t3:x",
  );
  expect(served({ HEX_OWNER: "discord:1" })).toBe("discord:1");
  expect(served({ HEX_THREAD: "x", HEX_OWNER: "stray" })).toBeUndefined();
});
