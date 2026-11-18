import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import {
  SESSION,
  SERVER,
  EXITED,
  dir,
  hub,
  time,
  start,
  calls,
  launched,
  session,
  said,
} from "./hub.testing.ts";
import { stamp } from "./start.ts";
import { until } from "./until.ts";

test("a thread that asks to renew starts over as a new session once its turn ends", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "idle" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  const { send } = await session("voice");
  await send({ type: "state", thread: "voice", busy: true });
  hub.renew("voice");
  await time.advance(100);
  expect(calls().some((each) => each[0] === "stop" || each[0] === "--bg")).toBe(false);
  await send({ type: "state", thread: "voice", busy: false });
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  old.kill();
  expect(await launched()).not.toContain("--resume");
});

test("a renew waits out background agents the turn ended with, then starts over at the next idle", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "busy" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  const { send } = await session("voice");
  hub.renew("voice");
  await send({ type: "state", thread: "voice", busy: false, background: true });
  await time.advance(150);
  expect(calls().some((each) => each[0] === "stop" || each[0] === "--bg")).toBe(false);
  await send({ type: "state", thread: "voice", busy: false });
  await until(() => calls().find((each) => each[0] === "stop"));
  old.kill();
  expect(await launched()).not.toContain("--resume");
});

test("a renew goes through at a rest the Stop hook reports, though Claude still calls the session busy (its status lags, and a running shell counts)", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "busy" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  const { send } = await session("voice");
  await send({ type: "state", thread: "voice", busy: true });
  hub.renew("voice");
  await send({ type: "state", thread: "voice", busy: false });
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  old.kill();
  expect(await launched()).not.toContain("--resume");
});

test("a session that started with what the hub no longer gives and runs a shell renews only once Claude reports it idle, since it never asked", async () => {
  await start({
    stale: true,
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, status: "busy", startedAt: 1 }],
  });
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: false });
  await time.advance(150);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
});

test("a thread that asked to renew keeps running when it asks to keep before its turn ends (a new call started)", async () => {
  await start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, status: "idle" }],
    reconnect: 50,
    fresh: () => true,
    capacity: 0,
  });
  const { send } = await session("voice");
  await send({ type: "state", thread: "voice", busy: true });
  hub.renew("voice");
  void hub.keep("voice");
  await send({ type: "state", thread: "voice", busy: false });
  await time.advance(150);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
});

test("a session that started with what the hub no longer gives stops at its next rest, so its next message resumes it on the current code", async () => {
  await start({
    stale: true,
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, status: "busy", startedAt: 1 }],
  });
  const { send } = await session("chat:7");
  await time.advance(150);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ sessionId: SESSION, pid: 42, status: "idle", startedAt: 1 }]),
  );
  await send({ type: "state", thread: "chat:7", busy: false });
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  expect(calls().some((each) => each[0] === "--bg")).toBe(false);
});

test("a change to only the hooks a session loads renews it at its next rest", async () => {
  const hooks = join(dir, "hooks.json");
  writeFileSync(hooks, '{"hooks":{}}');
  const stamped = stamp([], SERVER, [hooks]);
  expect(stamp([], SERVER, [hooks])).toBe(stamped);
  writeFileSync(hooks, '{"hooks":{"Stop":[]}}');
  expect(stamp([], SERVER, [hooks])).not.toBe(stamped);
  await start({
    startup: [hooks],
    registry: { "chat:7": { name: "Desk anchors", session: SESSION, launched: stamped } },
    agents: [{ sessionId: SESSION, pid: 42, status: "idle", startedAt: 1 }],
  });
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: false });
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
});

test("a new skill in a folder the session loads at start renews it at its next rest", async () => {
  const skills = join(dir, "skills");
  mkdirSync(join(skills, "echo"), { recursive: true });
  writeFileSync(join(skills, "echo/SKILL.md"), "Restate the ask.");
  const stamped = stamp([], SERVER, [skills]);
  mkdirSync(join(skills, "vault"));
  writeFileSync(join(skills, "vault/SKILL.md"), "Secrets go through the vault.");
  expect(stamp([], SERVER, [skills])).not.toBe(stamped);
  await start({
    startup: [skills],
    registry: { "chat:7": { name: "Desk anchors", session: SESSION, launched: stamped } },
    agents: [{ sessionId: SESSION, pid: 42, status: "idle", startedAt: 1 }],
  });
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: false });
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
});

test("a file an update removes midway, or a dangling link, reads as missing rather than stopping the hub", () => {
  const skills = join(dir, "skills");
  mkdirSync(skills);
  symlinkSync(join(dir, "gone"), join(skills, "SKILL.md"));
  expect(stamp([], SERVER, [skills, join(dir, "nothing")])).toHaveLength(16);
});

test("a session whose hooks are unchanged keeps running across a hub restart", async () => {
  const hooks = join(dir, "hooks.json");
  writeFileSync(hooks, '{"hooks":{}}');
  await start({
    startup: [hooks],
    registry: {
      "chat:7": { name: "Desk anchors", session: SESSION, launched: stamp([], SERVER, [hooks]) },
    },
    agents: [{ sessionId: SESSION, pid: 42, status: "idle", startedAt: 1 }],
  });
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: false });
  await time.advance(150);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
});

test("a main thread whose session started with what the hub no longer gives starts over as soon as it rests", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await start({
    stale: true,
    main: "chat",
    registry: { chat: { name: "hex", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "idle", startedAt: 1 }],
    reconnect: 60_000,
  });
  await session("chat");
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  writeFileSync(join(dir, "agents"), "[]");
  old.kill();
  expect(await launched()).toContain("--resume");
});

test("a voice session that started with what the hub no longer gives waits out its call before starting over", async () => {
  await start({
    stale: true,
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, status: "busy", startedAt: 1 }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  const { send } = await session("voice");
  said(500);
  await hub.keep("voice");
  await time.advance(100);
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ sessionId: SESSION, pid: EXITED, status: "idle", startedAt: 1 }]),
  );
  await send({ type: "state", thread: "voice", busy: false });
  await time.advance(150);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
  hub.renew("voice");
  await send({ type: "state", thread: "voice", busy: false });
  await until(() => calls().find((each) => each[0] === "stop"));
});
