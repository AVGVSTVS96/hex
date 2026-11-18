import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { clock } from "./clock.ts";
import {
  CHANNEL,
  settled,
  SESSION,
  message,
  EXITED,
  dir,
  hub,
  states,
  time,
  listener,
  inbound,
  fold,
  start,
  calls,
  launched,
  session,
  bound,
  saved,
  said,
  settingsOf,
  registry,
  NEXT,
  toolCall,
} from "./hub.testing.ts";
import { until } from "./until.ts";

test("an idle thread is stopped, and a busy one is not", async () => {
  await start({ idleStop: 50 });
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: false });
  await send({ type: "state", thread: "chat:7", busy: true });
  await time.advance(120);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
  await send({ type: "state", thread: "chat:7", busy: false });
  await time.lapse(50);
  const stop = await until(() => calls().find((each) => each[0] === "stop"));
  expect(stop).toEqual(["stop", SESSION.slice(0, 8)]);
});

test("a session that starts without a prompt is stopped once idle", async () => {
  await start({ idleStop: 50 });
  hub.open("chat:8", "OpenAI");
  await launched();
  await session("chat:8");
  await time.lapse(50);
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
});

test("an idle thread whose session Claude still reports busy is not stopped until it goes idle again", async () => {
  await start({
    idleStop: 50,
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, status: "busy" }],
  });
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: false });
  await time.lapse(50);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ sessionId: SESSION, pid: 42, status: "idle" }]),
  );
  await send({ type: "state", thread: "chat:7", busy: false });
  await time.lapse(50);
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
});

test("an idle thread with a big conversation compacts while its cache is warm, without showing as working, then stops", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await start({
    idleStop: 50,
    compactAbove: 150_000,
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "idle", startedAt: clock.now() + 60_000 }],
  });
  said(40_000);
  said(200_000);
  const first = await session("chat:7");
  await first.send({ type: "state", thread: "chat:7", busy: false });
  await time.lapse(50);
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  writeFileSync(join(dir, "agents"), "[]");
  first.close();
  old.kill();
  const args = await launched();
  expect(args[args.indexOf("--resume") + 1]).toBe(SESSION);
  expect(args.at(-1)).toBe("/compact");
  said(9000, true);
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([
      { sessionId: SESSION, pid: 42, status: "idle", startedAt: clock.now() + 60_000 },
    ]),
  );
  await session("chat:7");
  await time.lapse(50);
  await until(() => calls().filter((each) => each[0] === "stop").length === 2);
  expect(calls().filter((each) => each[0] === "--bg")).toHaveLength(1);
  expect(states.filter(([, busy]) => busy)).toEqual([]);
});

test("an idle thread with a small conversation, or one leaving, stops without compacting", async () => {
  await start({
    idleStop: 50,
    compactAbove: 150_000,
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, status: "idle", startedAt: clock.now() + 60_000 }],
  });
  said(120_000);
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: false });
  await time.lapse(50);
  await until(() => calls().find((each) => each[0] === "stop"));
  said(400_000);
  void hub.retire("chat:7");
  await until(() => calls().filter((each) => each[0] === "stop").length === 2);
  await settled();
  expect(calls().some((each) => each[0] === "--bg")).toBe(false);
});

test("the main thread compacts a big conversation before its cache goes cold, and otherwise keeps running", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await start({
    main: "chat",
    cacheWarm: 50,
    compactAbove: 150_000,
    reconnect: 60_000,
    registry: { chat: { name: "hex", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "idle", startedAt: clock.now() + 60_000 }],
  });
  said(100_000);
  const { send, close } = await session("chat");
  await send({ type: "state", thread: "chat", busy: false });
  await time.advance(200);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
  said(300_000);
  await send({ type: "state", thread: "chat", busy: false });
  await time.lapse(50);
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  writeFileSync(join(dir, "agents"), "[]");
  close();
  old.kill();
  const args = await launched();
  expect(args[args.indexOf("--resume") + 1]).toBe(SESSION);
  expect(args.at(-1)).toBe("/compact");
  expect(states.filter(([, busy]) => busy)).toEqual([]);
});

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The line Claude Code writes when /compact fails, like with every account of the pool out of usage.
function failedCompaction(at = clock.now()) {
  const project = join(dir, "projects", join(dir, "hex").replaceAll(/[^a-zA-Z0-9]/gu, "-"));

  const content =
    "<local-command-stderr>Error during compaction: API Error: rate_limit_error</local-command-stderr>";

  appendFileSync(
    join(project, `${SESSION}.jsonl`),
    `${JSON.stringify({
      type: "system",
      subtype: "local_command",
      content,
      timestamp: new Date(at).toISOString(),
    })}\n`,
  );
}

test("a compaction that fails isn't tried again on a timer, only once another session's turn ends with an answer", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await start({
    main: "chat",
    cacheWarm: 50,
    compactAbove: 150_000,
    reconnect: 60_000,
    registry: { chat: { name: "hex", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "idle", startedAt: clock.now() + 60_000 }],
  });
  said(300_000);
  const first = await session("chat");
  await first.send({ type: "state", thread: "chat", busy: false });
  await time.lapse(50);
  await until(() => calls().find((each) => each[0] === "stop"));
  writeFileSync(join(dir, "agents"), "[]");
  first.close();
  old.kill();
  expect((await launched()).at(-1)).toBe("/compact");
  failedCompaction();
  const resumed = Bun.spawn(["sleep", "30"]);
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([
      { sessionId: SESSION, pid: resumed.pid, status: "idle", startedAt: clock.now() + 60_000 },
    ]),
  );
  const { send, close } = await session("chat");
  await time.lapse(50);
  await time.advance(500);
  await send({ type: "state", thread: "chat:8", busy: false, failed: true });
  await settled();
  expect(calls().filter((each) => each[0] === "stop")).toHaveLength(1);
  await send({ type: "state", thread: "chat:8", busy: false });
  await until(() => calls().filter((each) => each[0] === "stop").length === 2);
  writeFileSync(join(dir, "agents"), "[]");
  close();
  resumed.kill();
  await until(() => calls().filter((each) => each[0] === "--bg").length === 2);
  expect(
    calls()
      .findLast((each) => each[0] === "--bg")
      ?.at(-1),
  ).toBe("/compact");
});

test("a thread whose compaction failed stops at its rest, and resumes to compact once a turn goes through", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await start({
    idleStop: 50,
    compactAbove: 150_000,
    reconnect: 1000,
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "idle", startedAt: clock.now() + 60_000 }],
  });
  said(200_000);
  const first = await session("chat:7");
  await first.send({ type: "state", thread: "chat:7", busy: false });
  await time.lapse(50);
  await until(() => calls().find((each) => each[0] === "stop"));
  writeFileSync(join(dir, "agents"), "[]");
  first.close();
  old.kill();
  await launched();
  failedCompaction();
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([
      { sessionId: SESSION, pid: EXITED, status: "idle", startedAt: clock.now() + 60_000 },
    ]),
  );
  const second = await session("chat:7");
  await time.lapse(50);
  await until(() => calls().filter((each) => each[0] === "stop").length === 2);
  second.close();
  await time.lapse(1000);
  expect(calls().filter((each) => each[0] === "--bg")).toHaveLength(1);
  await second.send({ type: "state", thread: "chat:9", busy: false });
  await until(() => calls().filter((each) => each[0] === "--bg").length === 2);

  const args = calls().findLast((each) => each[0] === "--bg") ?? [];

  expect(args[args.indexOf("--resume") + 1]).toBe(SESSION);
  expect(args.at(-1)).toBe("/compact");
  expect(states.filter(([, busy]) => busy)).toEqual([]);
});

test("a fresh thread with no capacity starts a new session instead of resuming its last, and says so in its env", async () => {
  await start({
    registry: { dm: { name: "DM", session: SESSION } },
    agents: [],
    fresh: (thread) => thread === "dm",
    capacity: 0,
  });
  await hub.deliver("dm", "DM", message);
  const args = await launched();
  expect(args).not.toContain("--resume");
  expect(calls().some((each) => each[0] === "rm")).toBe(false);
  expect(settingsOf(args).env).toEqual({
    HEX_CHANNEL: CHANNEL,
    HEX_THREAD: "dm",
    HEX_HUB: join(dir, "hub.sock"),
    HEX_PORT: String(listener.port),
    HEX_TOKEN: readFileSync(join(dir, "token"), "utf-8"),
    HEX_STORE: dir,
    HEX_FRESH: "1",
  });
  saved(NEXT);
  const { received } = await session("dm", NEXT);
  await until(() => received.length);
  expect(registry().dm).toEqual({ name: "DM", session: NEXT });
});

test("a message to a fresh thread with no capacity steers its session while Claude reports it working, and starts a new one once it is done", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await start({
    registry: { dm: { name: "DM", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "busy" }],
    fresh: (thread) => thread === "dm",
    capacity: 0,
  });
  const { received, send } = await session("dm");
  await hub.deliver("dm", "DM", message);
  await until(() => received.length);
  expect(received).toEqual([inbound(message)]);
  fold(received);
  said(50_000);
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ sessionId: SESSION, pid: old.pid, status: "idle" }]),
  );
  await send({ type: "state", thread: "dm", busy: false });
  await hub.deliver("dm", "DM", { author: "owner", content: "next", meta: {} });
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  old.kill();
  const args = await launched();
  expect(args).not.toContain("--resume");
  expect(received).toHaveLength(1);
  const next = await session("dm", "0a1b2c3d-0000-4000-8000-000000000001");
  await until(() => next.received.length);
  expect(next.received[0]).toMatchObject({ type: "inbound", content: "next" });
});

test("a fresh thread keeps its session while it waits on a permission prompt or its turn is still running", async () => {
  await start({
    registry: { dm: { name: "DM", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 999_999, state: "blocked" }],
    fresh: (thread) => thread === "dm",
  });
  const { received, send } = await session("dm");
  await hub.deliver("dm", "DM", message);
  await until(() => received.length);
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ sessionId: SESSION, pid: 999_999, status: "idle" }]),
  );
  await send({ type: "state", thread: "dm", busy: true });
  await until(() => states.length);
  await hub.deliver("dm", "DM", { author: "owner", content: "more", meta: {} });
  await settled();
  expect(await toolCall("dm")).toContain("more");
  expect(calls().some((each) => each[0] === "stop" || each[0] === "--bg")).toBe(false);
});

const dm = async (
  agents: object[],
  options: {
    capacity?: number;
    cacheWarm?: number;
    idleStop?: number;
    compactAbove?: number;
    reconnect?: number;
    stale?: boolean;
  } = {},
) => {
  await start({
    registry: { dm: { name: "DM", session: SESSION } },
    agents,
    fresh: (thread) => thread === "dm",
    capacity: 1000,
    ...options,
  });
};

test("a fresh thread's warm session takes every message as it comes, and stays up while it rests", async () => {
  await dm(
    [{ sessionId: SESSION, pid: 999_999, status: "idle", startedAt: clock.now() + 60_000 }],
    {
      idleStop: 10,
    },
  );
  said(500);
  const { received, send } = await session("dm");
  await hub.deliver("dm", "DM", message);
  await send({ type: "state", thread: "dm", busy: false });
  await until(() => states.length);
  await hub.deliver("dm", "DM", { author: "owner", content: "next", meta: {} });
  await until(() => received.length === 2);
  await time.advance(100);
  expect(calls().some((each) => each[0] === "stop" || each[0] === "--bg")).toBe(false);
});

test("a fresh thread whose session stopped starts a new one, warm or not, since a start rewrites its view past the cache", async () => {
  await dm([]);
  said(500);
  await hub.deliver("dm", "DM", message);
  expect(await launched()).not.toContain("--resume");
  expect(calls().some((each) => each[0] === "rm")).toBe(false);
});

test("a fresh thread's session on a five-minute cache hands over five minutes after its last request, not an hour", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await dm(
    [{ sessionId: SESSION, pid: old.pid, status: "idle", startedAt: clock.now() + 60_000 }],
    {
      cacheWarm: 60_000,
    },
  );
  const project = join(dir, "projects", join(dir, "hex").replaceAll(/[^a-zA-Z0-9]/gu, "-"));
  mkdirSync(project, { recursive: true });

  const usage = {
    input_tokens: 2,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 398,
    cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 },
  };

  appendFileSync(
    join(project, `${SESSION}.jsonl`),
    `${JSON.stringify({
      type: "assistant",
      message: { usage },
      timestamp: new Date(clock.now() - 4800).toISOString(),
    })}\n`,
  );
  const first = await session("dm");
  await first.send({ type: "state", thread: "dm", busy: false });
  await time.lapse(200);
  await until(() => calls().find((each) => each[0] === "stop"));
  first.close();
  old.kill();
  expect(await launched()).not.toContain("--resume");
});

test("once a fresh thread's session is full, a new one takes over at the rest the Stop hook reports, though Claude still calls it busy, before the next message", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await dm([{ sessionId: SESSION, pid: old.pid, status: "busy", startedAt: clock.now() + 60_000 }]);
  const first = await session("dm");
  await hub.deliver("dm", "DM", message);
  await until(() => first.received.length);
  fold(first.received);
  said(1500);
  await first.send({ type: "state", thread: "dm", busy: false });
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  first.close();
  old.kill();
  const args = await launched();
  expect(args).not.toContain("--resume");
  expect(args.at(-2)).toBe("--settings");
  const next = await session("dm", NEXT);
  await hub.deliver("dm", "DM", { author: "owner", content: "next", meta: {} });
  await until(() => next.received.length);
  expect(next.received[0]).toMatchObject({ type: "inbound", content: "next" });
  expect(first.received).toHaveLength(1);
});

test("a fresh thread's session hands over when its cache expires, timed from its last request", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await dm(
    [{ sessionId: SESSION, pid: old.pid, status: "idle", startedAt: clock.now() + 60_000 }],
    {
      cacheWarm: 400,
    },
  );
  said(500, false, SESSION, clock.now() - 200);
  const first = await session("dm");
  await first.send({ type: "state", thread: "dm", busy: false });
  await time.advance(199);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
  await time.advance(1);
  await until(() => calls().find((each) => each[0] === "stop"));
  first.close();
  old.kill();
  expect(await launched()).not.toContain("--resume");
});

test("a message that finds a fresh thread's session gone cold goes to a new one", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await dm(
    [{ sessionId: SESSION, pid: old.pid, status: "idle", startedAt: clock.now() + 60_000 }],
    {
      cacheWarm: 60_000,
    },
  );
  said(500, false, SESSION, clock.now() - 61_000);
  const first = await session("dm");
  await time.lapse(0);
  await until(() => calls().find((each) => each[0] === "stop"));
  await hub.deliver("dm", "DM", message);
  first.close();
  old.kill();
  expect(await launched()).not.toContain("--resume");
  const next = await session("dm", NEXT);
  await until(() => next.received.length);
  expect(next.received[0]).toMatchObject({
    type: "inbound",
    content: message.content,
    meta: message.meta,
  });
  expect(first.received).toHaveLength(0);
});

test("a fresh thread never compacts or idles out, however big its session", async () => {
  await dm(
    [{ sessionId: SESSION, pid: 999_999, status: "idle", startedAt: clock.now() + 60_000 }],
    {
      capacity: 400_000,
      compactAbove: 150_000,
      idleStop: 20,
    },
  );
  said(200_000);
  const { send } = await session("dm");
  await send({ type: "state", thread: "dm", busy: false });
  await until(() => states.length);
  await time.advance(150);
  expect(calls().filter((each) => each[0] !== "agents")).toEqual([]);
});

test("a fresh thread's warm session that started with what the hub no longer gives starts over as a new one at its rest", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await dm([{ sessionId: SESSION, pid: old.pid, status: "idle", startedAt: 1 }], { stale: true });
  said(500);
  const first = await session("dm");
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  writeFileSync(join(dir, "agents"), "[]");
  first.close();
  old.kill();
  expect(await launched()).not.toContain("--resume");
});

test("a warm DM session the last hub started but never saved takes the next message, and hands over in its turn, instead of a second session", async () => {
  bound("dm", NEXT, "job99999");
  await dm(
    [
      {
        id: "job99999",
        sessionId: NEXT,
        pid: EXITED,
        status: "idle",
        startedAt: clock.now() + 60_000,
      },
    ],
    { reconnect: 60_000 },
  );
  await hub.deliver("dm", "DM", message);
  await settled();
  const { received, send } = await session("dm", NEXT);
  await until(() => received.length);
  expect(hub.session("dm")).toBe(NEXT);
  said(1500, false, NEXT);
  await send({ type: "state", thread: "dm", busy: false });
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    NEXT.slice(0, 8),
  ]);

  const made = calls().map((each) => each[0]);

  expect(made.slice(0, made.indexOf("stop"))).not.toContain("--bg");
});
