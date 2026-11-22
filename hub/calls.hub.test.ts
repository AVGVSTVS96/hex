import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { free } from "./calls.ts";
import {
  settled,
  heard,
  SESSION,
  message,
  dir,
  hub,
  time,
  fold,
  start,
  calls,
  launched,
  session,
  said,
} from "./hub.testing.ts";
import { until } from "./until.ts";

test("a session with no capacity takes every message of a call, idle or not, and the call after it gets a new session", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "idle" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  const { received, send } = await session("voice");
  said(20_000);
  await hub.keep("voice");

  for (const turn of ["one", "two", "three"]) {
    said(20_000);
    await send({ type: "state", thread: "voice", busy: false });
    await hub.deliver("voice", "voice", { author: "owner", content: turn, meta: {} });
    await until(() => heard(received).find((payload) => payload.content === turn));
  }

  expect(calls().some((each) => each[0] === "stop" || each[0] === "--bg")).toBe(false);
  await hub.deliver("voice", "voice", { author: "owner", content: "the call ended", meta: {} });
  hub.renew("voice");
  await send({ type: "state", thread: "voice", busy: true });
  await send({ type: "state", thread: "voice", busy: false });
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  old.kill();
  expect(await launched()).not.toContain("--resume");
});

test("a call's end that reaches the session as its last turn ends gets its turn before the session renews", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "idle" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  const { received, send } = await session("voice");
  said(20_000);
  await hub.keep("voice");
  await send({ type: "state", thread: "voice", busy: true });
  await hub.deliver("voice", "voice", { author: "call", content: "the call ended", meta: {} });
  await until(() => heard(received).find((payload) => payload.content === "the call ended"));
  hub.renew("voice");
  await send({ type: "state", thread: "voice", busy: false });
  await time.advance(100);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
  await send({ type: "state", thread: "voice", busy: true });
  await send({ type: "state", thread: "voice", busy: false });
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  old.kill();
});

test("a call that finds its session still waiting for its first message starts it over, and keeps the call until the new one connects", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "idle" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  await session("voice");
  let kept = false;
  void hub.keep("voice").then(() => (kept = true));
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  writeFileSync(join(dir, "agents"), "[]");
  old.kill();
  expect(await launched()).not.toContain("--resume");
  await time.advance(50);
  expect(kept).toBe(false);
  await session("voice", "0a1b2c3d-0000-4000-8000-000000000009");
  await until(() => kept);
  expect(hub.session("voice")).toBe("0a1b2c3d-0000-4000-8000-000000000009");
});

test("a call whose session's restart never gets through doesn't hold up the hub's own restart, and the session being stopped takes nothing if it reconnects", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "idle" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  await session("voice");
  let kept = false;
  void hub.keep("voice").then(() => (kept = true));
  await until(() => calls().find((each) => each[0] === "stop"));
  await free();
  await hub.deliver("voice", "voice", message);
  const again = await session("voice");
  await time.advance(100);
  expect(again.received).toEqual([]);
  expect(kept).toBe(false);
  old.kill();
});

test("a call whose restarted session fails to start goes on", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "idle" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  await session("voice");
  let kept = false;
  void hub.keep("voice").then(() => (kept = true));
  await until(() => calls().find((each) => each[0] === "stop"));
  writeFileSync(join(dir, "agents"), "[]");
  old.kill();
  await launched();
  writeFileSync(
    join(dir, "jobs", "job12345", "state.json"),
    JSON.stringify({ state: "failed", detail: "exit 1 before init" }),
  );
  await until(() => kept);
});

test("a call that comes while the last call's session is still on its turn keeps that session, warm, instead of waiting for a new one", async () => {
  await start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, status: "busy" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  const { send } = await session("voice");
  said(500);
  await send({ type: "state", thread: "voice", busy: true });
  hub.renew("voice");
  await settled();
  let kept = false;
  void hub.keep("voice").then(() => (kept = true));
  await until(() => kept);
  await send({ type: "state", thread: "voice", busy: false });
  await time.advance(150);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
  expect(hub.session("voice")).toBe(SESSION);
});

test("a call that comes once a renew is starting the session over takes the new session as it starts, without starting it over again", async () => {
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
  said(500);
  await send({ type: "state", thread: "voice", busy: true });
  hub.renew("voice");
  await settled();
  await send({ type: "state", thread: "voice", busy: false });
  await until(() => calls().find((each) => each[0] === "stop"));
  let kept = false;
  void hub.keep("voice").then(() => (kept = true));
  writeFileSync(join(dir, "agents"), "[]");
  old.kill();
  await launched();
  await time.advance(50);
  expect(kept).toBe(false);
  await session("voice", "0a1b2c3d-0000-4000-8000-000000000009");
  await until(() => kept);
  await time.advance(150);
  expect(calls().filter((each) => each[0] === "stop")).toHaveLength(1);
  expect(hub.session("voice")).toBe("0a1b2c3d-0000-4000-8000-000000000009");
});

test("a call keeps the session it finds once a message has gone to it, before the session takes it", async () => {
  await start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, status: "idle" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  const { received } = await session("voice");
  await hub.deliver("voice", "voice", message);
  await until(() => received.length);
  await hub.keep("voice");
  await time.advance(150);
  expect(calls().some((each) => each[0] === "stop" || each[0] === "--bg")).toBe(false);
});

test("a call keeps the session it finds once that session has taken a message, like the one that placed the call, before its first request is through", async () => {
  await start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, status: "idle" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  const { received } = await session("voice");
  await hub.deliver("voice", "voice", message);
  await until(() => received.length);
  fold(received);
  await hub.keep("voice");
  await time.advance(150);
  expect(calls().some((each) => each[0] === "stop" || each[0] === "--bg")).toBe(false);
});

test("a session whose channel comes back before its rest still starts over for the call that ended", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "idle" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  const first = await session("voice");
  await first.send({ type: "state", thread: "voice", busy: true });
  hub.renew("voice");
  first.close();
  const again = await session("voice");
  await again.send({ type: "state", thread: "voice", busy: false });
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  old.kill();
});

test("a call that comes while a renew is on its way waits for the new session to connect", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "busy" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  let through = false;
  await hub.renewal("voice");
  const { send } = await session("voice");
  await send({ type: "state", thread: "voice", busy: true });
  hub.renew("voice");
  await settled();
  void hub.renewal("voice").then(() => (through = true));
  await send({ type: "state", thread: "voice", busy: false });
  await until(() => calls().find((each) => each[0] === "stop"));
  old.kill();
  await launched();
  await time.advance(50);
  expect(through).toBe(false);
  await session("voice", "0a1b2c3d-0000-4000-8000-000000000009");
  await until(() => through);
});

test("a call waits for no renew held up by background agents, or called off by a call already in the session", async () => {
  await start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, status: "busy" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  let through = 0;
  const { send } = await session("voice");
  await send({ type: "state", thread: "voice", busy: true });
  hub.renew("voice");
  await settled();
  void hub.renewal("voice").then(() => through++);
  await send({ type: "state", thread: "voice", busy: false, background: true });
  await until(() => through === 1);
  await send({ type: "state", thread: "voice", busy: true });
  hub.renew("voice");
  await settled();
  void hub.renewal("voice").then(() => through++);
  void hub.keep("voice");
  await until(() => through === 2);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
});

test("a restart waits for every call to hang up, even while its session's channel is gone", async () => {
  await start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  let freed = false;
  await free();
  await session("voice");
  said(500);
  void hub.keep("voice");
  void free().then(() => (freed = true));
  await time.advance(50);
  expect(freed).toBe(false);
  hub.renew("voice");
  await until(() => freed);
  freed = false;
  const second = await session("voice");
  void hub.keep("voice");
  void free().then(() => (freed = true));
  second.close();
  await time.advance(100);
  expect(freed).toBe(false);
  hub.renew("voice");
  await until(() => freed);
});

test("a restart doesn't wait on a call its engine can't reach, and waits again once the engine is back on it", async () => {
  await start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    fresh: () => true,
    capacity: 0,
  });
  let freed = false;
  await session("voice");
  said(500);
  void hub.keep("voice");
  hub.adrift("voice", true);
  hub.adrift("voice", false);
  void free().then(() => (freed = true));
  await time.advance(50);
  expect(freed).toBe(false);
  hub.adrift("voice", true);
  await until(() => freed);
  freed = false;
  hub.adrift("voice", false);
  void free().then(() => (freed = true));
  await time.advance(50);
  expect(freed).toBe(false);
  hub.renew("voice");
  await until(() => freed);
});

test("a hub with no main thread starts no session until a call, and a call after a stop gets a new one", async () => {
  await start({ fresh: () => true, capacity: 0 });
  await settled();
  expect(calls().some((each) => each[0] === "--bg")).toBe(false);

  await hub.keep("voice");
  await hub.deliver("voice", "voice", { author: "prompt", content: "A call started.", meta: {} });
  await launched();
  const first = await session("voice");
  await until(() => heard(first.received).find((payload) => payload.content === "A call started."));
  said(20_000);
  await first.send({ type: "state", thread: "voice", busy: false });
  const old = Bun.spawn(["sleep", "30"]);
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ sessionId: SESSION, pid: old.pid, status: "idle", startedAt: 1 }]),
  );
  void hub.stop("voice");
  await until(() => calls().find((each) => each[0] === "stop"));
  writeFileSync(join(dir, "agents"), "[]");
  first.close();
  old.kill();

  await hub.keep("voice");
  await hub.deliver("voice", "voice", { author: "prompt", content: "Next call.", meta: {} });
  const next = await until(() => calls().filter((each) => each[0] === "--bg")[1]);
  expect(next).not.toContain("--resume");
  const second = await session("voice", "0a1b2c3d-0000-4000-8000-000000000009");
  await until(() => heard(second.received).find((payload) => payload.content === "Next call."));
});
