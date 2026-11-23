import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  settled,
  SESSION,
  message,
  dir,
  hub,
  states,
  time,
  sleepers,
  start,
  settles,
  calls,
  launched,
  session,
  registry,
} from "./hub.testing.ts";
import { file } from "./store.ts";
import { until } from "./until.ts";

test("stopping a thread ends its session now, and its next message resumes it", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  const { close, send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: true });
  await until(() => states.length);
  void hub.stop("chat:7");
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  close();
  await until(() => states.length === 2);
  writeFileSync(join(dir, "agents"), "[]");
  await hub.deliver("chat:7", "Desk anchors", message);
  const args = await launched();
  expect(args[args.indexOf("--resume") + 1]).toBe(SESSION);
  expect(registry()["chat:7"]).toEqual({ name: "Desk anchors", session: SESSION });
});

function conversation() {
  const path = join(
    dir,
    "projects",
    join(dir, "hex").replaceAll(/[^a-zA-Z0-9]/gu, "-"),
    `${SESSION}.jsonl`,
  );

  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, '{"type":"user","message":{"content":"run for a while"}}\n');

  return () => readFileSync(path, "utf-8");
}

function working() {
  const process = Bun.spawn(["sleep", "60"]);
  sleepers.push(process);

  return [{ sessionId: SESSION, pid: process.pid, status: "busy" }];
}

test("the owner's interrupt presses Esc in a busy session, which keeps running, and ends the turn, in hex's record of it too", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: working(),
  });
  const transcript = conversation();
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: true });
  await until(() => states.length);
  file(dir).turns.turned(SESSION, true);
  await hub.interrupt("chat:7");
  expect(transcript()).toContain("[Request interrupted by user");
  expect(states.at(-1)).toEqual(["chat:7", false]);
  expect(file(dir).turns.get(SESSION).ended).toBeDefined();
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
});

test("an interrupted turn Claude still reports working counts as one with background work left, so a renew waits for it to be done", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ ...working()[0], state: "working" }],
  });
  conversation();
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: true });
  await until(() => states.length);
  hub.renew("chat:7");
  await hub.interrupt("chat:7");
  await settled();
  expect(calls().some((each) => each[0] === "stop" || each[0] === "respawn")).toBe(false);
});

test("a Stop whose Esc lands in no turn leaves the session and its background work running", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ ...working()[0], state: "working" }],
  });
  conversation();
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: true });
  await until(() => states.length);
  writeFileSync(join(dir, "idle"), "");
  const stopping = hub.interrupt("chat:7");
  await time.lapse(5000);
  expect(await settles(stopping)).toEqual({ status: "fulfilled", value: undefined });
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
});

test("a Stop leaves a turn alone that the hooks report over while its Esc goes in, even past a request that repeats an earlier interrupt", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: working(),
  });
  const transcript = conversation();
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: true });
  await until(() => states.length);
  writeFileSync(join(dir, "idle"), "");
  const interrupting = hub.interrupt("chat:7");
  await until(() => transcript().includes("api-request-blob"));
  await send({ type: "state", thread: "chat:7", busy: false });
  await until(() => states.length === 2);
  await time.lapse(5000);
  expect(await settles(interrupting)).toEqual({ status: "fulfilled", value: undefined });
  expect(states).toEqual([
    ["chat:7", true],
    ["chat:7", false],
  ]);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
});

test("an interrupt leaves a session alone once its turn is over, background agents and all", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: working(),
  });
  const transcript = conversation();
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: false, background: true });
  await until(() => states.length);
  await hub.interrupt("chat:7");
  expect(transcript()).not.toContain("[Request interrupted by user");
  expect(states).toEqual([["chat:7", false]]);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
});

test("a Stop after a hub restart presses Esc in a turn Claude's daemon says is working, though hex never heard it begin", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ ...working()[0], state: "working" }],
  });
  const transcript = conversation();
  await session("chat:7");
  await hub.interrupt("chat:7");
  expect(transcript()).toContain("[Request interrupted by user");
  expect(states).toEqual([["chat:7", false]]);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
});

test("a Stop leaves alone a session whose turn hex never heard and Claude's daemon says is done", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ ...working()[0], state: "done" }],
  });
  const transcript = conversation();
  await session("chat:7");
  await hub.interrupt("chat:7");
  expect(transcript()).not.toContain("[Request interrupted by user");
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
});

test("a message that comes while a stopped session is still exiting waits, even through a second stop, and resumes the thread once it has", async () => {
  const exiting = Bun.spawn(["sleep", "60"]);
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: exiting.pid, status: "busy" }],
  });
  const old = await session("chat:7");
  void hub.stop("chat:7");
  await until(() => calls().find((each) => each[0] === "stop"));
  writeFileSync(join(dir, "unanswering"), "");
  void hub.stop("chat:7");
  await settled();
  rmSync(join(dir, "unanswering"));
  await hub.deliver("chat:7", "Desk anchors", message);
  await time.advance(300);
  expect(old.received).toEqual([]);
  expect(calls().some((each) => each[0] === "--bg")).toBe(false);
  exiting.kill();
  const args = await launched();
  expect(args[args.indexOf("--resume") + 1]).toBe(SESSION);
  const resumed = await session("chat:7");
  await until(() => resumed.received.length);
  expect(resumed.received[0]).toMatchObject({ type: "inbound", content: "hi" });
  expect(old.received).toEqual([]);
});

test("a stop goes out while Claude's daemon isn't answering, without waiting for it to answer", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, status: "idle" }],
  });
  await session("chat:7");
  writeFileSync(join(dir, "unanswering"), "");
  void hub.stop("chat:7");
  await until(() => calls().find((each) => each[0] === "stop"));
});
