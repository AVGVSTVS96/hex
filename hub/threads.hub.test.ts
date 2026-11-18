import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  settled,
  heard,
  SESSION,
  message,
  dir,
  hub,
  states,
  time,
  fold,
  start,
  calls,
  launched,
  session,
  saved,
  registry,
} from "./hub.testing.ts";
import { file } from "./store.ts";
import { until } from "./until.ts";

test("a thread's model and effort are kept, and a running session takes them by starting again with its next message", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, status: "idle" }],
  });
  const { received } = await session("chat:7");
  await hub.deliver("chat:7", "Desk anchors", message);
  await until(() => received.length);
  fold(received);
  hub.configure("chat:7", { model: "fable", effort: "xhigh" });
  await hub.synced();
  expect(registry()["chat:7"]).toEqual({
    name: "Desk anchors",
    session: SESSION,
    model: "fable",
    effort: "xhigh",
  });
  await hub.deliver("chat:7", "Desk anchors", { author: "owner", content: "again", meta: {} });
  const args = await launched();
  expect([
    args[args.indexOf("--model") + 1],
    args[args.indexOf("--effort") + 1],
    args[args.indexOf("--resume") + 1],
  ]).toEqual(["fable", "xhigh", SESSION]);
  expect(heard(received).map((payload) => payload.content)).toEqual(["hi"]);
  const fresh = await session("chat:7");
  await until(() => fresh.received.length);
  expect(fresh.received[0]).toMatchObject({ type: "inbound", content: "again" });
});

test("a thread a client opens with its settings is in hex.db before its first message, so a restart still knows it", async () => {
  await start();
  hub.register("chat:7", "Desk anchors", join(dir, "desk"));
  hub.configure("chat:7", {});
  await hub.synced();
  expect(registry()["chat:7"]).toEqual({ name: "Desk anchors", cwd: join(dir, "desk") });
});

test("a thread saved with a full model id runs its family's alias, so it gets the newest model", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION, model: "claude-opus-5-5" } },
    agents: [],
  });
  await hub.deliver("chat:7", "Desk anchors", message);
  const args = await launched();
  expect(args[args.indexOf("--model") + 1]).toBe("opus");
});

test("closing an idle thread stops its session right away, then forgets the thread", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  const { close } = await session("chat:7");
  void hub.retire("chat:7");
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  expect(registry()["chat:7"]).toBeDefined();
  close();
  await until(() => !registry()["chat:7"]);
});

test("a forgotten thread's settings file goes with it", async () => {
  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
  const settings = (await launched()).at(-1) ?? "";
  const { close, send } = await session("chat:7");
  expect(existsSync(settings)).toBe(true);
  await send({ type: "state", thread: "chat:7", busy: false });
  await until(() => states.length === 2);
  void hub.retire("chat:7");
  await until(() => calls().find((each) => each[0] === "stop"));
  close();
  await until(() => !existsSync(settings));
});

test("closing a thread with no live session forgets it at once", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  await settled();
  const callsBefore = calls().length;
  void hub.retire("chat:7");
  await hub.synced();
  expect(registry()["chat:7"]).toBeUndefined();
  await settled();
  expect(calls().slice(callsBefore)).toEqual([]);
});

test("closing a thread whose session Claude reports busy waits for its next idle", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, status: "busy" }],
  });
  const { send } = await session("chat:7");
  void hub.retire("chat:7");
  await time.advance(100);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
  await send({ type: "state", thread: "chat:7", busy: false });
  await until(() => calls().find((each) => each[0] === "stop"));
});

test("closing a busy thread stops its session at its next idle, not before", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: true });
  await until(() => states.length);
  void hub.retire("chat:7");
  await time.advance(100);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
  await send({ type: "state", thread: "chat:7", busy: false });
  await until(() => calls().find((each) => each[0] === "stop"));
});

test("threads are found by name or id, and renames are kept, in hex.db too", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION }, "chat:8": { name: "Clips" } },
  });
  expect(hub.find("desk anchors")).toBe("chat:7");
  expect(hub.find("chat:8")).toBe("chat:8");
  expect(() => hub.find("Nope")).toThrow('no thread named "Nope"');
  hub.rename("chat:8", "Video clips");
  expect(hub.find("Video clips")).toBe("chat:8");
  expect(hub.name("chat:8")).toBe("Video clips");
  expect(hub.name("chat:9")).toBeUndefined();
  await hub.synced();
  expect(registry()["chat:8"]?.name).toBe("Video clips");
  expect(file(dir).threads.list()).toEqual([
    { app: "telegram", thread: "chat:7", name: "Desk anchors", session: SESSION, open: true },
    { app: "telegram", thread: "chat:8", name: "Video clips", open: true },
  ]);
});

test("a thread hex.db keeps comes back with its folder and settings, and a closed one keeps its row", async () => {
  await start({
    registry: {
      "chat:7": { name: "Desk anchors", session: SESSION, cwd: "/work", model: "claude-opus-5-5" },
    },
  });
  expect(hub.threads()).toEqual(["chat:7"]);
  expect(hub.cwd("chat:7")).toBe("/work");
  await hub.retire("chat:7");
  expect(file(dir).threads.list()).toEqual([
    {
      app: "telegram",
      thread: "chat:7",
      name: "Desk anchors",
      session: SESSION,
      cwd: "/work",
      model: "opus",
      open: false,
    },
  ]);
});

test("a thread opened in a project starts its session there, and keeps that folder when it resumes", async () => {
  const project = join(dir, "project");
  mkdirSync(project);
  const launcher = join(dir, "launch");
  writeFileSync(
    launcher,
    `#!/bin/sh
pwd >> "${dir}/cwd"
exec claude "$@"
`,
  );
  chmodSync(launcher, 0o755);
  await start({ launcher, agents: [] });
  hub.open("t3:1", "project", undefined, project);
  await launched();
  saved(SESSION, project);
  const { close } = await session("t3:1");
  await until(() => registry()["t3:1"]);
  expect(registry()["t3:1"]).toEqual({ name: "project", cwd: project, session: SESSION });
  expect(hub.cwd("t3:1")).toBe(project);
  close();
  await until(() => states.some(([thread, busy]) => thread === "t3:1" && !busy));
  await hub.deliver("t3:1", "project", message);
  await until(() => readFileSync(join(dir, "cwd"), "utf-8").split("\n").length > 2);
  expect(readFileSync(join(dir, "cwd"), "utf-8").trim().split("\n")).toEqual([project, project]);
});

test("a thread in the hex folder keeps no folder of its own", async () => {
  await start();
  hub.open("chat:7", "Desk anchors", "go");
  await launched();
  saved();
  await session("chat:7");
  await until(() => registry()["chat:7"]);
  expect(registry()["chat:7"]).toEqual({ name: "Desk anchors", session: SESSION });
  expect(hub.cwd("chat:7")).toBeUndefined();
});

test("releasing an idle thread stops its session, then forgets it once the socket closes", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  const { close } = await session("chat:7");
  let released: string | undefined;
  void hub.release("chat:7").then((id) => (released = id));
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  await time.advance(50);
  expect(released).toBeUndefined();
  expect(registry()["chat:7"]).toBeDefined();
  close();
  expect(await until(() => released)).toBe(SESSION);
  expect(registry()["chat:7"]).toBeUndefined();
});

test("releasing a busy thread waits for its next idle", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  const { close, send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: true });
  await until(() => states.length);
  let released: string | undefined;
  void hub.release("chat:7").then((id) => (released = id));
  await time.advance(100);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
  await send({ type: "state", thread: "chat:7", busy: false });
  await until(() => calls().find((each) => each[0] === "stop"));
  close();
  expect(await until(() => released)).toBe(SESSION);
  expect(registry()["chat:7"]).toBeUndefined();
});

test("releasing a thread with no live session resolves at once", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  expect(await hub.release("chat:7")).toBe(SESSION);
  expect(registry()["chat:7"]).toBeUndefined();
  expect(calls().filter(([command]) => command === "stop" || command === "--bg")).toEqual([]);
});

test("the main thread cannot be closed or released, nor a thread without a session", async () => {
  await start({ main: "chat", registry: { "chat:8": { name: "Clips" } } });
  expect(() => hub.retire("chat")).toThrow("the main thread stays open");
  expect(() => hub.release("chat")).toThrow("the main thread stays here");
  expect(() => hub.release("chat:8")).toThrow("this thread has no session yet");
});
