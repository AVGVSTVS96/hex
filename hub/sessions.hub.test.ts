import { expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

import * as claude from "./claude.ts";
import { clock } from "./clock.ts";
import {
  CHANNEL,
  settled,
  heard,
  matching,
  SettingsFile,
  SESSION,
  message,
  EXITED,
  dir,
  hub,
  states,
  failures,
  holds,
  time,
  listener,
  inbound,
  fold,
  start,
  respawns,
  calls,
  launched,
  session,
  http,
  bound,
  job,
  saved,
  said,
  settingsOf,
  registry,
  fault,
  bgStarts,
} from "./hub.testing.ts";
import { file } from "./store.ts";
import type { File } from "./store.ts";
import { until } from "./until.ts";

test("a message for a new thread starts a session bound to that thread", async () => {
  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
  const args = await launched();
  expect(args.slice(0, 5)).toEqual(["--bg", "--channels", CHANNEL, "--name", "Desk anchors"]);
  expect(args).not.toContain("--resume");
  expect(settingsOf(args)).toEqual({
    enabledPlugins: { "telegram@hex": true },
    env: {
      HEX_CHANNEL: CHANNEL,
      HEX_THREAD: "chat:7",
      HEX_HUB: join(dir, "hub.sock"),
      HEX_PORT: String(listener.port),
      HEX_TOKEN: readFileSync(join(dir, "token"), "utf-8"),
      HEX_STORE: dir,
    },
  });
  expect(states).toEqual([["chat:7", true]]);
});

test("a new thread prompt comes last, where --channels cannot swallow it", async () => {
  await start();
  hub.open("chat:8", "OpenAI", "find the latest model");
  const args = await launched();
  expect(args.at(-1)).toBe("find the latest model");
  expect(args.at(-3)).toBe("--settings");
});

test("queued messages reach the session when it connects, and its id is kept", async () => {
  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  saved();
  const { received } = await session("chat:7");
  await until(() => received.length);
  expect(received).toEqual([inbound(message)]);
  expect(registry()["chat:7"]).toEqual({ name: "Desk anchors", session: SESSION });
});

test("a stopped thread has its job record cleared, then resumes under the same id", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } }, agents: [] });
  await hub.deliver("chat:7", "Desk anchors", message);
  const args = await launched();
  expect(
    calls().find((each) => !["agents", "daemon", "--version"].includes(each[0] ?? "")),
  ).toEqual(["rm", SESSION.slice(0, 8)]);
  expect(args).toContain("--resume");
  expect(args[args.indexOf("--resume") + 1]).toBe(SESSION);
});

test("a stopped thread whose big conversation's cache has expired starts a new session that takes over from it", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } }, agents: [] });
  said(120_000, false, SESSION, clock.now() - 61 * 60_000);
  await hub.deliver("chat:7", "Desk anchors", message);
  const args = await launched();
  expect(args).not.toContain("--resume");
  expect(settingsOf(args).env.HEX_HANDOFF).toEndWith(`/${SESSION}.jsonl`);
});

test("a stopped thread resumes while its cache is warm", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } }, agents: [] });
  said(120_000, false, SESSION, clock.now() - 50 * 60_000);
  await hub.deliver("chat:7", "Desk anchors", message);
  const args = await launched();
  expect(args[args.indexOf("--resume") + 1]).toBe(SESSION);
  expect(settingsOf(args).env.HEX_HANDOFF).toBeUndefined();
});

test("a stopped thread with a small conversation resumes even once its cache has expired", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } }, agents: [] });
  said(60_000, false, SESSION, clock.now() - 3 * 60 * 60_000);
  await hub.deliver("chat:7", "Desk anchors", message);
  const args = await launched();
  expect(args[args.indexOf("--resume") + 1]).toBe(SESSION);
});

test("a thread whose session is still running is never relaunched", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
  });
  await hub.deliver("chat:7", "Desk anchors", message);
  await settled();
  expect(calls().every((each) => each[0] === "agents")).toBe(true);
  const { received } = await session("chat:7");
  await until(() => received.length);
  expect(heard(received)[0]?.content).toBe("hi");
});

test("an answer Claude couldn't give is asked again, never read as nothing running", async () => {
  await start({ agents: [{ sessionId: SESSION, pid: 42 }] });
  writeFileSync(join(dir, "unreadable"), "");
  hub.adopt("chat:7", "Desk anchors", SESSION);
  await hub.deliver("chat:7", "Desk anchors", message);
  await time.lapse(1000);
  expect(calls()).toEqual([
    ["agents", "--json"],
    ["agents", "--json"],
  ]);
  const { received } = await session("chat:7");
  await until(() => received.length);
  expect(heard(received)[0]?.content).toBe("hi");
});

test("the main thread starts with the hub, under its name, with no prompt and no typing", async () => {
  await start({ main: "chat", general: true });
  const args = await launched();
  expect(args.slice(0, 5)).toEqual(["--bg", "--channels", CHANNEL, "--name", "hex"]);
  expect(args.at(-2)).toBe("--settings");
  expect(settingsOf(args).env.HEX_MAIN).toBe("1");
  expect(states).toEqual([]);
});

test("a running main thread is left to reconnect, and gets its messages when it does", async () => {
  await start({
    main: "chat",
    registry: { chat: { name: "chat", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
  });
  await hub.deliver("chat", "hex", message);
  await settled();
  expect(calls().every((each) => each[0] === "agents")).toBe(true);
  expect(registry().chat?.name).toBe("hex");
  const { received } = await session("chat");
  await until(() => received.length);
  expect(heard(received)[0]?.content).toBe("hi");
});

test("a main thread whose session is gone is resumed again, and is never stopped for being idle", async () => {
  await start({
    main: "chat",
    registry: { chat: { name: "hex", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
    reconnect: 50,
    idleStop: 20,
  });
  const { close, send } = await session("chat");
  await send({ type: "state", thread: "chat", busy: false });
  await time.advance(100);
  expect(calls().filter((each) => each[0] === "stop")).toEqual([]);
  writeFileSync(join(dir, "agents"), "[]");
  close();
  await time.lapse(50);
  const args = await launched();
  expect(args[args.indexOf("--resume") + 1]).toBe(SESSION);
});

test("a session that dies mid-turn has its turn ended in hex's record once its channel stays gone, and a turn that ended keeps its end", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
    reconnect: 50,
  });
  const { close } = await session("chat:7");
  file(dir).turns.turned(SESSION, true, "2026-01-01T00:00:00.000Z");
  writeFileSync(join(dir, "agents"), "[]");
  close();
  await time.armed(50);
  expect(file(dir).turns.get(SESSION).ended).toBeUndefined();
  await time.lapse(50);
  const ended = await until(() => file(dir).turns.get(SESSION).ended);
  expect(ended > "2026-01-01T00:00:00.000Z").toBe(true);

  writeFileSync(join(dir, "agents"), JSON.stringify([{ sessionId: SESSION, pid: 42 }]));
  await hub.deliver("chat:7", "Desk anchors", message);
  const again = await session("chat:7");
  file(dir).turns.turned(SESSION, false, "2027-01-01T00:00:00.000Z");
  writeFileSync(join(dir, "agents"), "[]");
  again.close();
  await time.lapse(50);
  await settled();
  expect(file(dir).turns.get(SESSION).ended).toBe("2027-01-01T00:00:00.000Z");
});

test("what a session took and never answered goes to the thread's next session once it dies; what it answered stays answered", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
    reconnect: 50,
  });
  await hub.deliver("chat:7", "Desk anchors", { ...message, content: "answered" });
  const first = await session("chat:7");
  await until(() => first.received.length);
  file(dir).turns.turned(SESSION, true, "2026-01-01T00:00:00.000Z");
  fold(first.received);
  file(dir).turns.turned(SESSION, false);
  file(dir).turns.handled(SESSION);
  await first.send({ type: "state", thread: "chat:7", busy: false });
  await hub.deliver("chat:7", "Desk anchors", { ...message, content: "hanging" });
  await until(() => first.received.length === 2);
  file(dir).turns.turned(SESSION, true);
  fold(first.received.slice(1));
  writeFileSync(join(dir, "agents"), "[]");
  first.close();
  await time.lapse(50);
  await launched();
  const next = await session("chat:7");
  await until(() => next.received.length);
  expect(heard(next.received).map((each) => each.content)).toEqual(["hanging"]);
  expect(holds).toContainEqual(["chat:7", "hanging", true]);
});

test("a hub that starts after its sessions died (a reboot, or a move to another machine) gives what they never answered to their threads' next sessions at once", async () => {
  const store = file(dir);
  store.threads.keep("telegram", { "chat:7": { name: "Desk anchors", session: SESSION } });
  store.messages.deliver({
    key: "telegram:1:9",
    to: "chat:7",
    from: "telegram",
    author: "owner",
    body: "mid-turn",
    meta: {},
  });
  store.turns.turned(SESSION, true, "2026-01-01T00:00:00.000Z");
  store.messages.take("telegram:1:9", SESSION);
  await start({ agents: [] });
  await launched();
  const next = await session("chat:7");
  await until(() => next.received.length);
  expect(heard(next.received)[0]?.content).toBe("mid-turn");
  expect(store.turns.get(SESSION).ended).toBeDefined();
});

const agentsStillWork = async (store: File) => {
  store.threads.keep("telegram", { "chat:7": { name: "Desk anchors", session: SESSION } });
  store.messages.deliver({
    key: "telegram:1:10",
    to: "chat:7",
    from: "telegram",
    author: "owner",
    body: "research it in the background",
    meta: {},
  });
  store.turns.turned(SESSION, true, "2026-01-01T00:00:00.000Z");
  store.messages.take("telegram:1:10", SESSION);

  store.messages.deliver(
    {
      key: "telegram:1:11",
      to: "chat:7",
      from: "telegram",
      author: "hex",
      body: "on it",
      meta: {},
    },
    SESSION,
  );

  const hook = Bun.spawn(["bun", join(import.meta.dir, "state.ts"), "idle"], {
    env: { ...process.env, HEX_STORE: dir, MEMORY_DIR: "" },
    stdin: new Blob([
      JSON.stringify({
        hook_event_name: "Stop",
        session_id: SESSION,
        background_tasks: [{ type: "subagent", status: "running" }],
      }),
    ]),
  });

  await hook.exited;
  expect(store.turns.get(SESSION).ended).toBeDefined();
  expect(store.turns.midTurn("chat:7")).toBe(true);
};

const startsAgainToldItsAgentsEnded = async (store: File, unanswered: string[] = []) => {
  await start({ agents: [], reconnect: 50 });
  await time.lapse(50);
  await launched();
  const next = await session("chat:7");
  await until(() => next.received.length > unanswered.length);
  await settled();
  const contents = heard(next.received).map(({ content }) => content);
  expect(contents.slice(0, -1)).toEqual(unanswered);
  expect(contents.at(-1)).toContain("background agents");
  expect(store.messages.get("telegram:1:10")?.taken?.by).toBe(SESSION);
  expect(store.turns.midTurn("chat:7")).toBe(false);
};

test("a session that died while its background agents still worked (a reboot) starts again, told by the hub that they ended, without the message it already answered", async () => {
  const store = file(dir);
  await agentsStillWork(store);
  await startsAgainToldItsAgentsEnded(store);
});

test("a session that died in a turn one of its agents' reports began starts again the same way", async () => {
  const store = file(dir);
  await agentsStillWork(store);
  store.turns.turned(SESSION, true);
  await startsAgainToldItsAgentsEnded(store);
});

test("a session that died mid-turn after starting background agents gives back that turn's message and is told the agents ended too", async () => {
  const store = file(dir);
  await agentsStillWork(store);
  store.messages.deliver({
    key: "telegram:1:12",
    to: "chat:7",
    from: "telegram",
    author: "owner",
    body: "and one more thing",
    meta: {},
  });
  store.turns.turned(SESSION, true);
  store.messages.take("telegram:1:12", SESSION);
  await startsAgainToldItsAgentsEnded(store, ["and one more thing"]);
});

test("a session the hub stops while idle has handled what it took, even with its turn left open (Esc in an attached terminal runs no Stop hook)", async () => {
  await start({ idleStop: 50, reconnect: 50 });
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  const line = await session("chat:7");
  await until(() => line.received.length);
  file(dir).turns.turned(SESSION, true, "2026-01-01T00:00:00.000Z");
  fold(line.received);
  await line.send({ type: "state", thread: "chat:7", busy: false });
  await time.lapse(50);
  await until(() => calls().some((each) => each[0] === "stop"));
  const starts = calls().filter((each) => each[0] === "--bg").length;
  line.close();
  await time.lapse(50);
  await settled();
  expect(file(dir).messages.untaken("chat:7")).toEqual([]);
  expect(file(dir).turns.get(SESSION).handled).toBeDefined();
  expect(calls().filter((each) => each[0] === "--bg").length).toBe(starts);
});

test("a session whose turn failed (StopFailure) keeps what it took when it stops, since its conversation holds it", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
    reconnect: 50,
  });
  await hub.deliver("chat:7", "Desk anchors", message);
  const line = await session("chat:7");
  await until(() => line.received.length);
  file(dir).turns.turned(SESSION, true, "2026-01-01T00:00:00.000Z");
  fold(line.received);
  file(dir).turns.turned(SESSION, false);
  writeFileSync(join(dir, "agents"), "[]");
  line.close();
  await time.lapse(50);
  await settled();
  expect(file(dir).messages.untaken("chat:7")).toEqual([]);
  expect(calls().some((each) => each[0] === "--bg")).toBe(false);
});

test("a session that dies before its conversation is saved leaves the thread on its last saved one", async () => {
  const OLD = SESSION;
  const NEW = "4460ed71-0000-4000-8000-000000000000";
  saved(OLD);
  await start({
    main: "chat",
    registry: { chat: { name: "hex", session: OLD } },
    agents: [],
    reconnect: 50,
  });
  await launched();
  const { close } = await session("chat", NEW);
  expect(registry().chat?.session).toBe(OLD);
  close();
  await time.lapse(50);
  await until(() => calls().filter((each) => each[0] === "--bg").length === 2);
  const args = calls().filter((each) => each[0] === "--bg")[1] ?? [];
  expect(args[args.indexOf("--resume") + 1]).toBe(OLD);
  const back = await session("chat", OLD);
  back.close();
  await time.lapse(50);
  await until(() => calls().filter((each) => each[0] === "--bg").length === 3);
  const next = await session("chat", NEW);
  saved(NEW);
  await next.send({ type: "state", thread: "chat", busy: false });
  await until(() => registry().chat?.session === NEW);
  void hub.stop("chat");
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    NEW.slice(0, 8),
  ]);
});

test("a dropped channel that comes back while Claude Code reconnects it leaves its session running", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, startedAt: 1 }],
    reconnect: 100,
  });
  const first = await session("chat:7");
  first.close();
  await time.armed(100);
  const back = await session("chat:7");
  await time.advance(200);
  expect(calls().filter((each) => each[0] !== "agents")).toEqual([]);
  await hub.deliver("chat:7", "Desk anchors", message);
  await until(() => back.received.length);
});

test("a session still running once its channel stays gone restarts in place, and gets what waited when it reconnects", async () => {
  bound("chat:7");
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, startedAt: 1 }],
    reconnect: 50,
  });
  const { close } = await session("chat:7");
  close();
  await time.lapse(50);
  expect(await until(() => calls().find((each) => each[0] === "respawn"))).toEqual([
    "respawn",
    SESSION.slice(0, 8),
  ]);
  expect(
    SettingsFile.parse(JSON.parse(readFileSync(join(dir, "sessions", "chat%3A7.json"), "utf-8")))
      .env.HEX_TOKEN,
  ).toBe(readFileSync(join(dir, "token"), "utf-8"));
  await hub.deliver("chat:7", "Desk anchors", message);
  const back = await session("chat:7");
  await until(() => back.received.length);
  expect(heard(back.received)[0]?.content).toBe("hi");
  await time.advance(150);
  expect(calls().filter((each) => each[0] === "respawn").length).toBe(1);
  expect(failures).toEqual([]);
});

test("a starting session gets as long as Claude Code is told to wait for its channel, and its message shows it waits until the session takes it", async () => {
  await start({ reconnect: 50, connect: 1000 });
  await hub.deliver("chat:7", "Desk anchors", message);
  const args = await launched();
  expect(settingsOf(args).env.MCP_TIMEOUT).toBe("1000");
  expect(holds).toEqual([["chat:7", "hi", true]]);
  bound("chat:7", SESSION, "job12345");
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ id: "job12345", sessionId: SESSION, pid: 42, startedAt: 1 }]),
  );
  await time.advance(900);
  expect(calls().filter((each) => each[0] === "respawn")).toEqual([]);
  const line = await session("chat:7");
  await until(() => line.received.length);
  expect(holds).toEqual([["chat:7", "hi", true]]);
  fold(line.received);
  await until(() => holds.length === 2);
  expect(holds[1]).toEqual(["chat:7", "hi", false]);
  expect(failures).toEqual([]);
});

test("a starting session still running once the wait for a slow hub is over restarts in place", async () => {
  await start({ reconnect: 50, connect: 200 });
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  bound("chat:7", SESSION, "job12345");
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ id: "job12345", sessionId: SESSION, pid: process.pid, startedAt: 1 }]),
  );
  await time.advance(150);
  expect(calls().filter((each) => each[0] === "respawn")).toEqual([]);
  await time.advance(100);
  expect(await until(() => calls().find((each) => each[0] === "respawn"))).toEqual([
    "respawn",
    "job12345",
  ]);
});

test("a starting session that has ended is reported the next time the hub looks, not after the wait for a slow hub", async () => {
  await start({ reconnect: 50, connect: 60_000, agents: [] });
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  await time.lapse(50);
  await until(() => failures.length);
  expect(failures).toEqual([["chat:7", "its session ended before its channel connected"]]);
});

test("a session that restarts in place keeps what its launcher added to its settings, and gets the hub's current token", async () => {
  bound("chat:7");
  const path = join(dir, "sessions", "chat%3A7.json");
  writeFileSync(
    path,
    JSON.stringify({
      model: "claude-sonnet-5-5",
      claudeMdExcludes: ["/rules.md"],
      enabledPlugins: { "other@hex": true },
      env: { HEX_CHANNEL: CHANNEL, HEX_THREAD: "chat:7", HEX_TOKEN: "old", HEX_WAKE: "/wake.md" },
    }),
  );
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, startedAt: 1 }],
    reconnect: 50,
  });
  await time.lapse(50);
  await until(() => calls().find((each) => each[0] === "respawn"));
  const settings = SettingsFile.parse(JSON.parse(readFileSync(path, "utf-8")));
  expect(settings).toMatchObject({
    model: "claude-sonnet-5-5",
    claudeMdExcludes: ["/rules.md"],
    enabledPlugins: { "other@hex": true, "telegram@hex": true },
    env: { HEX_WAKE: "/wake.md", HEX_THREAD: "chat:7" },
  });
  expect(settings.env.HEX_TOKEN).toBe(readFileSync(join(dir, "token"), "utf-8"));
});

test("a session that restarts in place and still gets no channel is reported, not restarted again", async () => {
  bound("chat:7");
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, startedAt: 1 }],
    reconnect: 50,
  });
  const { close } = await session("chat:7");
  close();
  await time.lapse(50);
  await until(() => calls().find((each) => each[0] === "respawn"));
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ sessionId: SESSION, pid: 43, startedAt: clock.now() }]),
  );
  await time.lapse(50);
  expect(failures).toEqual([]);
  await time.lapse(50);
  expect(failures[0]).toEqual(["chat:7", "its session runs, but its channel never connects"]);
  expect(calls().filter((each) => each[0] === "respawn").length).toBe(1);
});

test("a restart in place that can't write the session's settings file is a failed start, and the thread's next message starts it", async () => {
  bound("chat:7");
  const settings = join(dir, "sessions", "chat%3A7.json");
  const startedWith = join(dir, "sessions", "started-with.json");
  renameSync(settings, startedWith);
  mkdirSync(settings);
  writeFileSync(
    join(dir, "jobs", SESSION.slice(0, 8), "state.json"),
    JSON.stringify({
      state: "working",
      sessionId: SESSION,
      respawnFlags: ["--settings", startedWith],
    }),
  );
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, startedAt: 1 }],
    reconnect: 50,
  });
  await time.lapse(50);
  await until(() => failures.length);
  expect(failures).toEqual([["chat:7", matching(/chat%3A7\.json/u)]]);
  expect(respawns()).toEqual([]);
  rmSync(settings, { recursive: true });
  writeFileSync(join(dir, "agents"), "[]");
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
});

test("a wait for a session's channel that breaks is over, and the thread's next message takes its session up again", async () => {
  bound("chat:7");
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, startedAt: 1 }],
    reconnect: 50,
  });
  const { close } = await session("chat:7");
  const listing = spyOn(claude, "agents").mockRejectedValueOnce(new Error("no list of sessions"));

  try {
    close();
    await time.lapse(50);
    await time.advance(150);
    expect(listing).toHaveBeenCalledTimes(1);
    expect(respawns()).toEqual([]);
    await hub.deliver("chat:7", "Desk anchors", message);
    await time.lapse(50);
    await until(() => respawns().length);
    expect(failures).toEqual([]);
  } finally {
    listing.mockRestore();
  }
});

test("a starting session the hub stopped, since it couldn't restart it in place, is still reported when its start fails", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [],
    reconnect: 50,
  });
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ sessionId: SESSION, pid: EXITED, startedAt: 1 }]),
  );
  await time.lapse(50);
  await until(() => calls().find((each) => each[0] === "stop"));
  await job("job12345", { state: "failed", detail: "exit 1 before init" });
  await until(() => failures.length);
  expect(failures).toEqual([["chat:7", "exit 1 before init"]]);
});

test("a session still running mid-turn when the hub starts gets its window to reconnect before anything else starts for its thread", async () => {
  bound("chat:7");
  const store = file(dir);
  store.messages.deliver({
    key: "telegram:1:9",
    to: "chat:7",
    from: "telegram",
    author: "owner",
    body: "mid-turn",
    meta: {},
  });
  store.turns.turned(SESSION, true, "2026-01-01T00:00:00.000Z");
  store.messages.take("telegram:1:9", SESSION);
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, startedAt: 1 }],
    reconnect: 50,
  });
  await time.armed(50);
  await settled();
  expect(calls().filter((each) => each[0] === "--bg" || each[0] === "respawn")).toEqual([]);
  expect(file(dir).turns.midTurn("chat:7")).toBe(true);
  await time.lapse(50);
  expect(await until(() => calls().find((each) => each[0] === "respawn"))).toEqual([
    "respawn",
    SESSION.slice(0, 8),
  ]);
});

test("a session that outlived the hub and never reconnects restarts in place", async () => {
  bound("chat:7");
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, startedAt: 1 }],
    reconnect: 50,
  });
  await time.lapse(50);
  expect(await until(() => calls().find((each) => each[0] === "respawn"))).toEqual([
    "respawn",
    SESSION.slice(0, 8),
  ]);
});

test("a session found by the job it was started for restarts in place, though its conversation is not saved", async () => {
  bound("chat:7", "0a1b2c3d-0000-4000-8000-000000000009", "job99999");
  await start({
    registry: { "chat:7": { name: "Desk anchors" } },
    agents: [
      { id: "job99999", sessionId: "0a1b2c3d-0000-4000-8000-000000000009", pid: 42, startedAt: 1 },
    ],
    reconnect: 50,
  });
  await time.lapse(50);
  expect(await until(() => calls().find((each) => each[0] === "respawn"))).toEqual([
    "respawn",
    "job99999",
  ]);
});

test("a message for a thread whose new session runs but has no conversation saved yet waits for that session instead of starting another", async () => {
  const NEW = "0a1b2c3d-0000-4000-8000-000000000009";
  bound("chat:7", NEW, "job99999");
  await start({
    registry: { "chat:7": { name: "Desk anchors" } },
    agents: [{ id: "job99999", sessionId: NEW, pid: 42, startedAt: clock.now() + 60_000 }],
    reconnect: 60_000,
  });
  await hub.deliver("chat:7", "Desk anchors", message);
  await settled();
  const { received } = await session("chat:7", NEW);
  await until(() => received.length);
  expect(calls().some((each) => each[0] === "--bg")).toBe(false);
});

test("a message for a running session with no channel waits for it, and starts it again once it has ended", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, startedAt: clock.now() + 60_000 }],
    reconnect: 50,
  });
  await hub.deliver("chat:7", "Desk anchors", message);
  await settled();
  expect(calls().some((each) => each[0] === "--bg")).toBe(false);
  writeFileSync(join(dir, "agents"), "[]");
  await time.lapse(50);
  const args = await launched();
  expect(args[args.indexOf("--resume") + 1]).toBe(SESSION);
  const { received } = await session("chat:7");
  await until(() => received.length);
  expect(heard(received)[0]?.content).toBe("hi");
});

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A launcher whose resumes fail as Claude Code fails one of a session no project folder has, its conversation in hex's folder gone as it resumes.
function forgetting() {
  const launcher = join(dir, "launch");
  const project = join(dir, "projects", join(dir, "hex").replaceAll(/[^a-zA-Z0-9]/gu, "-"));
  writeFileSync(
    launcher,
    `#!/bin/sh
case "$*" in *--resume*) rm -rf '${project}'; echo "backgrounded · jobgone1 · test"; exit 0;; esac
exec claude "$@"
`,
  );
  chmodSync(launcher, 0o755);
  mkdirSync(join(dir, "jobs", "jobgone1"));
  writeFileSync(
    join(dir, "jobs", "jobgone1", "state.json"),
    JSON.stringify({ state: "failed", detail: `source session ${SESSION} not found` }),
  );

  return launcher;
}

test("a thread whose session's conversation no project folder has, as after hex is restored on a new machine, starts a new session that takes over from hex.db", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } }, agents: [] });
  rmSync(join(dir, "projects"), { recursive: true });
  await hub.deliver("chat:7", "Desk anchors", message);
  const args = await launched();
  expect(args).not.toContain("--resume");
  expect(settingsOf(args).env.HEX_HANDOFF).toEndWith(`/${SESSION}.jsonl`);
  saved("2c3d4e5f-0000-4000-8000-000000000000");
  const { received } = await session("chat:7", "2c3d4e5f-0000-4000-8000-000000000000");
  await until(() => received.length);
  expect(received).toEqual([inbound(message)]);
  await until(() => registry()["chat:7"]?.session === "2c3d4e5f-0000-4000-8000-000000000000");
  expect(failures).toEqual([]);
});

test("a thread whose conversation isn't whole on this machine takes over from it in a new session, with the prompt its start carries, and a fork of it does too", async () => {
  fault.notWhole = true;
  saved();
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } }, agents: [] });
  await hub.command("chat:7", "/compact");
  const args = await launched();
  expect(args).not.toContain("--resume");
  expect(args.at(-1)).toBe("/compact");
  expect(settingsOf(args).env.HEX_HANDOFF).toEndWith(`/${SESSION}.jsonl`);

  hub.fork("chat:10", "Copy", SESSION, "carry on");
  const forked = await until(() => bgStarts()[1]);
  expect(forked).not.toContain("--resume");
  expect(forked.at(-1)).toBe("carry on");
  expect(settingsOf(forked).env.HEX_HANDOFF).toEndWith(`/${SESSION}.jsonl`);
});

test("a thread whose session's conversation vanishes as it resumes starts a new one, which hears why when it connects", async () => {
  await start({
    launcher: forgetting(),
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [],
  });
  await hub.deliver("chat:7", "Desk anchors", message);
  expect(await launched()).not.toContain("--resume");
  expect(registry()["chat:7"]).toEqual({ name: "Desk anchors" });
  const { received } = await session("chat:7", "2c3d4e5f-0000-4000-8000-000000000000");
  await until(() => received.length === 2);
  const note = `[hub] Claude Code no longer has the conversation of session ${SESSION}, which this thread was to continue, so you're a new session without it; say so when you reply.`;
  expect(received).toEqual([
    inbound(message),
    { type: "inbound", content: note, meta: { key: `hub:chat:7:lost:${SESSION}`, user: "hub" } },
  ]);
  expect(failures).toEqual([]);
});

test("a resume Claude Code can't find, of a session another project folder has, fails and keeps the session", async () => {
  await start({
    launcher: forgetting(),
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [],
  });
  saved(SESSION, join(dir, "elsewhere"));
  await hub.deliver("chat:7", "Desk anchors", message);
  await until(() => failures.length);
  expect(failures).toEqual([["chat:7", `source session ${SESSION} not found`]]);
  expect(registry()["chat:7"]).toEqual({ name: "Desk anchors", session: SESSION });
});

test("a thread that would fork a session Claude Code no longer has starts a new one instead", async () => {
  await start({
    launcher: forgetting(),
    registry: { "chat:7": { name: "Desk anchors", from: SESSION } },
    agents: [],
  });
  await hub.deliver("chat:7", "Desk anchors", message);
  expect(await launched()).not.toContain("--resume");
  expect(registry()["chat:7"]).toEqual({ name: "Desk anchors" });
  expect(failures).toEqual([]);
});

test("a fresh main thread still running when the hub starts is left to reconnect instead of getting a second session", async () => {
  await start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, status: "idle" }],
    reconnect: 150,
    fresh: () => true,
    capacity: 0,
  });
  await time.armed(150);
  await session("voice");
  await time.advance(250);
  expect(calls().some((each) => each[0] === "--bg")).toBe(false);
});

test("a fresh main thread whose newest session is still running but not yet saved is left to reconnect too", async () => {
  bound("voice", "0a1b2c3d-0000-4000-8000-000000000009", "job99999");
  await start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ id: "job99999", sessionId: "0a1b2c3d-0000-4000-8000-000000000009", pid: 43 }],
    reconnect: 150,
    fresh: () => true,
    capacity: 0,
  });
  await time.armed(150);
  await session("voice", "0a1b2c3d-0000-4000-8000-000000000009");
  await time.advance(250);
  expect(calls().some((each) => each[0] === "--bg")).toBe(false);
});

test("a fresh main thread whose session is gone when the hub starts gets a new one at once", async () => {
  await start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  expect(await launched()).not.toContain("--resume");
});

test("a session whose flags read no settings file of the hub stops and resumes once its channel stays gone, since a respawn would lose its binding", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, startedAt: 1 }],
    reconnect: 50,
  });
  await time.lapse(50);
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  writeFileSync(join(dir, "agents"), "[]");
  old.kill();
  const args = await launched();
  expect(args[args.indexOf("--resume") + 1]).toBe(SESSION);
  expect(calls().some((each) => each[0] === "respawn")).toBe(false);
});

test("sessions start through the launcher, in the hex folder, with nothing of the hub's own in its env", async () => {
  const launcher = join(dir, "launch");
  writeFileSync(
    launcher,
    `#!/bin/sh
pwd > "${dir}/cwd"
env | grep -c -e _BOT_TOKEN= -e ^HEX_ -e ^BUZZ_ > "${dir}/leaked"
exec claude "$@"
`,
  );
  chmodSync(launcher, 0o755);
  process.env.TELEGRAM_BOT_TOKEN = "secret";
  process.env.BUZZ_PRIVATE_KEY = "secret";
  process.env.HEX_DIR = join(dir, "somewhere");

  try {
    await start({ launcher });
    hub.open("chat:7", "Desk anchors", "go");
    await launched();
  } finally {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.BUZZ_PRIVATE_KEY;
    delete process.env.HEX_DIR;
  }

  expect(readFileSync(join(dir, "cwd"), "utf-8").trim()).toBe(join(dir, "hex"));
  expect(readFileSync(join(dir, "leaked"), "utf-8").trim()).toBe("0");
});

test("an adopted thread clears the old job record, then resumes its session in its folder with the prompt last", async () => {
  await start({ agents: [] });
  hub.adopt("chat:7", "Desk anchors", SESSION, "carry on", dir);
  const args = await launched();
  expect(
    calls().find((each) => !["agents", "daemon", "--version"].includes(each[0] ?? "")),
  ).toEqual(["rm", SESSION.slice(0, 8)]);
  expect(args[args.indexOf("--resume") + 1]).toBe(SESSION);
  expect(args.at(-1)).toBe("carry on");
  expect(registry()["chat:7"]).toEqual({ name: "Desk anchors", session: SESSION, cwd: dir });
});

test("a fork resumes a copy of the session without checking agents or clearing its job record", async () => {
  await start();
  hub.fork("chat:7", "Desk anchors", SESSION, "carry on");
  const args = await launched();
  const resume = args.indexOf("--resume");
  expect(args.slice(resume, resume + 3)).toEqual(["--resume", SESSION, "--fork-session"]);
  expect(args.at(-1)).toBe("carry on");
  await time.advance(50);
  expect(
    calls()
      .map((each) => each[0])
      .filter((command) => command !== "daemon" && command !== "--version"),
  ).toEqual(["--bg"]);
});

test("a session is live as its channel connects, so a thread closed while the hub reads what the session is given stops that session and stays closed", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  writeFileSync(
    join(dir, "jobs", "job12345", "state.json"),
    JSON.stringify({ state: "working", sessionId: SESSION }),
  );
  const line = http("chat:7");
  await line.initialize();
  await line.open();
  await line.rpc("tools/list");
  await until(() => line.listed() === 2);
  const closed = hub.retire("chat:7");
  await settled();
  expect(calls().filter(([command]) => command === "stop")).toHaveLength(1);
  line.close();
  expect(await closed).toBe(SESSION);
  await settled();
  expect(hub.threads()).toEqual([]);
});
