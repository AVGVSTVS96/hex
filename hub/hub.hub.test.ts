import { expect, test } from "bun:test";
import { statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

import { clients } from "./apps.ts";
import {
  CHANNEL,
  partialHub,
  SESSION,
  message,
  SERVER,
  dir,
  hub,
  startTestHub,
  sockets,
  listener,
  inbound,
  start,
  calls,
  launched,
  session,
  sendToHub,
  saved,
  settingsOf,
  registry,
} from "./hub.testing.ts";
import { file } from "./store.ts";
import { until } from "./until.ts";

test("a line on hub.sock that isn't one of its requests is dropped, and the lines after it still work", async () => {
  await start();
  const { received } = await session("chat:9");
  const socket = connect(join(dir, "hub.sock"));
  sockets.push(socket);
  socket.on("connect", () => {
    socket.end(
      `not json\nnull\n${[
        { type: "launch", thread: "chat:9" },
        { type: "state", thread: "chat:9", busy: "yes" },
        { type: "inbound", thread: "chat:9", content: 7 },
      ]
        .map((bad) => JSON.stringify(bad))
        .join("\n")}\n${JSON.stringify({
        type: "inbound",
        thread: "chat:9",
        content: "still here",
        meta: {},
      })}\n`,
    );
  });
  await until(() => received.length);
  expect(received[0]).toEqual(inbound({ content: "still here", meta: {} }));
});

test("a local open request starts a session for an existing topic with its prompt", async () => {
  await start();
  const socket = connect(join(dir, "hub.sock"));
  socket.on("connect", () => {
    socket.end(
      `${JSON.stringify({
        type: "open",
        thread: "chat:5",
        name: "Video clips",
        prompt: "pick it up",
      })}\n`,
    );
  });
  const args = await launched();
  expect(args.slice(3, 5)).toEqual(["--name", "Video clips"]);
  expect(args.at(-1)).toBe("pick it up");
  expect(settingsOf(args).env.HEX_THREAD).toBe("chat:5");
});

test("a local inbound request reaches the thread like a message from the app, by its <app>:<key> id too", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
  });
  const { received } = await session("chat:7");
  const socket = connect(join(dir, "hub.sock"));
  socket.on("connect", () => {
    socket.end(`${JSON.stringify({ type: "inbound", thread: "telegram:chat:7", ...message })}\n`);
  });
  await until(() => received.length);
  expect(received).toEqual([inbound(message)]);
});

test("a local inbound request for a thread this hub doesn't have opens nothing", async () => {
  await start();
  const socket = connect(join(dir, "hub.sock"));
  socket.on("connect", () => {
    socket.end(
      [
        { type: "inbound", thread: "other-app-key", ...message },
        { type: "inbound", thread: "constructor", ...message },
        { type: "open", thread: "chat:5", name: "Video clips" },
      ]
        .map((line) => `${JSON.stringify(line)}\n`)
        .join(""),
    );
  });
  await launched();
  expect(calls().filter((each) => each[0] === "--bg")).toHaveLength(1);
  expect(hub.threads()).toEqual(["chat:5"]);
  expect(Object.keys(registry())).toEqual(["chat:5"]);
});

test("a hub whose state folder is gone makes it again, with a new token", async () => {
  const state = join(dir, "gone");
  await startTestHub({
    stateDir: state,
    channel: CHANNEL,
    server: SERVER,
    port: listener.port,
    call: () => Promise.resolve(""),
    state: () => {},
    failed: () => {},
    hexDir: join(dir, "hex"),
  });
  expect(statSync(join(state, "token")).mode % 0o1000).toBe(0o600);
});

test("a mirror asked on hub.sock opens there, by the thread's name", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  const placed: string[] = [];
  clients.set("elsewhere", {
    hub: partialHub({ follow: (): void => undefined }),
    place: (name) => {
      placed.push(name);

      return Promise.resolve({ thread: "far:1", link: "https://far/1" });
    },
  });

  try {
    void sendToHub({ type: "mirror", thread: "Desk anchors", to: "elsewhere" });
    expect(await until(() => placed[0])).toBe("Desk anchors");
  } finally {
    clients.delete("elsewhere");
  }
});

test("a thread that follows a session forks it with its first message, then keeps the fork as its own", async () => {
  const FORKED = "0a1b2c3d-2222-4000-8000-000000000000";
  await start({ agents: [] });
  hub.follow("chat:7", "Desk anchors", SESSION);
  await hub.synced();
  expect(registry()["chat:7"]).toEqual({ name: "Desk anchors", from: SESSION });
  await hub.deliver("chat:7", "Desk anchors", message);
  const args = await launched();
  const resume = args.indexOf("--resume");
  expect(args.slice(resume, resume + 3)).toEqual(["--resume", SESSION, "--fork-session"]);
  saved(FORKED);
  const { received } = await session("chat:7", FORKED);
  await until(() => received.length);
  expect(
    await until(() => registry()["chat:7"]?.session === FORKED && registry()["chat:7"]),
  ).toEqual({ name: "Desk anchors", session: FORKED });
});

test("only General's hub runs schedules.json", async () => {
  writeFileSync(join(dir, "hex", "schedules.json"), "{}");
  await start();
  expect(file(dir).scheduler.checked()).toBeUndefined();
  hub.close();
  await start({ main: "general", general: true });
  expect(await until(() => file(dir).scheduler.checked())).toBe(Math.floor(Date.now() / 60_000));
});
