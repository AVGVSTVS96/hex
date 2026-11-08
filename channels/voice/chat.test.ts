import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clients, open } from "@hex/hub";
import type { Client, Hub } from "@hex/hub";

import { Chats } from "./chat.ts";

const DESK = "-1001234:5";
const OLD = "abcdef12-0000-0000-0000-000000000000";
const NOW = "12345678-0000-0000-0000-000000000000";
const where = { app: "telegram", thread: DESK, session: NOW };
let hexDir: string;
let state: string;
let chats: Chats;
let calls: unknown[][];
let delivered: Parameters<Hub["deliver"]>[2][];
let telegram: Client;

function withOnly(hub: Pick<Hub, "name" | "deliver" | "stop">): Client {
  // SAFETY: Chats reaches a client's hub only through name, deliver and stop.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fake of the three methods Chats uses
  const partial = hub as Hub;

  return { hub: partial, place: () => Promise.resolve({ thread: "", link: "" }) };
}

const aFreshHexDbRunsEveryMigrationForSecondsOnALoadedMachine = 30_000;

beforeEach(() => {
  hexDir = mkdtempSync(join(tmpdir(), "chat-"));
  state = join(hexDir, "state");
  mkdirSync(state, { recursive: true });
  calls = [];
  delivered = [];
  telegram = withOnly({
    name: () => "Desk",
    deliver: (thread, name, message) => {
      calls.push(["deliver", thread, name, message]);
      delivered.push(message);

      return true;
    },
    stop: (thread) => {
      calls.push(["hub stop", thread]);

      return Promise.resolve();
    },
  });
  clients.set("telegram", telegram);
  chats = new Chats(state);
}, aFreshHexDbRunsEveryMigrationForSecondsOnALoadedMachine);

afterEach(() => {
  chats.close();
  clients.clear();
  rmSync(hexDir, { recursive: true, force: true });
});

test("a thread's chat is what the owner said and hex replied across its sessions, then what's waiting", () => {
  const store = open(state);
  store.deliver({
    key: "telegram:1",
    to: DESK,
    from: "telegram",
    author: "owner",
    body: "ship it",
    meta: { user_id: "1" },
  });
  store.take("telegram:1", OLD);
  store.deliver(
    { key: "terminal:1", to: DESK, from: "terminal", author: "hex", body: "thinking out loud" },
    OLD,
  );
  store.deliver(
    { key: "telegram:10", to: DESK, from: "telegram", author: "hex", body: "Shipped." },
    OLD,
  );
  store.deliver({
    key: "telegram:2",
    to: DESK,
    from: "telegram",
    author: "owner",
    body: "and the tests",
    meta: { user: "hex app" },
  });
  store.take("telegram:2", NOW);
  store.deliver(
    { key: "telegram:11", to: DESK, from: "telegram", author: "hex", body: "On it." },
    NOW,
  );
  store.deliver({
    key: "telegram:3",
    to: DESK,
    from: "telegram",
    author: "owner",
    body: "then ship",
    meta: { user_id: "1" },
  });
  store.deliver({
    key: "schedule:4",
    to: DESK,
    from: "schedule",
    author: "prompt",
    body: "heartbeat",
    meta: { user: "schedule" },
  });
  expect(chats.of(where)).toMatchObject({
    sends: true,
    total: 4,
    turns: [
      { from: "me", text: "ship it" },
      { from: "hex", text: "Shipped." },
      { from: "me", text: "and the tests" },
      { from: "hex", text: "On it." },
    ],
    waiting: [{ key: "telegram:3", text: "then ship" }],
  });
});

test("words typed in the app reach the thread as the owner, under the key the app named them", () => {
  chats.send(where, "and the docs", "app-00000001");
  expect(calls).toMatchObject([
    [
      "deliver",
      DESK,
      "Desk",
      { content: "and the docs", key: "app-00000001", author: "owner", meta: { user: "hex app" } },
    ],
  ]);
});

test("photos and clips go with the owner's words as images the session reads, and the chat shows them beside those words", () => {
  const photo = { id: "p1", kind: "photo" as const, images: ["/m/p1.jpg"] };

  const video = {
    id: "v1",
    kind: "video" as const,
    images: ["/m/v1-1.jpg"],
    seconds: 4,
    mute: true as const,
  };

  chats.send(where, "", "app-00000002", [photo, video]);
  expect(calls).toMatchObject([
    [
      "deliver",
      DESK,
      "Desk",
      {
        content: "(photo)\n(video 0:04, 1 still, no sound)",
        meta: { image_path: "/m/p1.jpg; /m/v1-1.jpg", media: "photo p1; video v1" },
      },
    ],
  ]);
  const store = open(state);

  const [message] = delivered;

  if (!message) {
    throw new Error("nothing was delivered");
  }

  store.deliver({
    key: "telegram:app-00000002",
    to: DESK,
    from: "telegram",
    author: "owner",
    body: message.content,
    meta: message.meta,
  });
  store.deliver({
    key: "telegram:app-00000003",
    to: DESK,
    from: "telegram",
    author: "owner",
    body: "this one\n(photo)",
    meta: { media: "photo p2" },
  });
  store.take("telegram:app-00000002", NOW);
  expect(chats.of(where)).toMatchObject({
    turns: [
      {
        from: "me",
        text: "",
        media: [
          { id: "p1", kind: "photo" },
          { id: "v1", kind: "video" },
        ],
      },
    ],
    waiting: [
      { key: "telegram:app-00000003", text: "this one", media: [{ id: "p2", kind: "photo" }] },
    ],
  });
});

test("a stop goes through the app's own stop when it has one, and only where an app holds the thread", () => {
  chats.stop(where);
  telegram.stop = (thread) => {
    calls.push(["own stop", thread]);
  };

  chats.stop(where);
  telegram.hub.name = () => {};

  expect(() => {
    chats.stop(where);
  }).toThrow();
  expect(calls).toEqual([
    ["hub stop", DESK],
    ["own stop", DESK],
  ]);
});

test("an app that shows only turns it starts, doesn't hold the thread, or isn't here can't take words from here", () => {
  telegram.hub.name = () => {};

  expect(chats.of(where).sends).toBe(false);
  telegram.hub.name = () => "Desk";
  telegram.waits = true;
  expect(chats.of(where).sends).toBe(false);
  expect(() => {
    chats.send(where, "hi", "app-0002");
  }).toThrow();
  expect(() => {
    chats.send({ ...where, app: "claude" }, "hi", "app-0003");
  }).toThrow();
});

test("a wait for the chat ends when it changes, and not on a change elsewhere", async () => {
  const { version } = chats.of(where);
  const waited = chats.next(() => where, version, 5000);
  open(state).deliver({
    key: "telegram:5",
    to: "-1009:1",
    from: "telegram",
    author: "owner",
    body: "elsewhere",
    meta: { user_id: "1" },
  });
  await Bun.sleep(50);
  open(state).deliver({
    key: "telegram:6",
    to: DESK,
    from: "telegram",
    author: "owner",
    body: "hi",
    meta: { user_id: "1" },
  });
  const chat = await waited;
  expect(chat.version).not.toBe(version);
  expect(chat.waiting.map((sent) => sent.text)).toEqual(["hi"]);
  expect((await chats.next(() => where, chat.version, 100)).version).toBe(chat.version);
});

test("a chat is read again only once its thread's messages change", () => {
  const store = open(state);
  store.deliver({
    key: "telegram:1",
    to: DESK,
    from: "telegram",
    author: "owner",
    body: "ship it",
    meta: { user_id: "1" },
  });
  const first = chats.of(where);
  store.deliver({
    key: "telegram:5",
    to: "-1001234:6",
    from: "telegram",
    author: "owner",
    body: "elsewhere",
    meta: { user_id: "1" },
  });
  expect(chats.of(where)).toBe(first);
  store.take("telegram:1", NOW);
  const taken = chats.of(where);
  expect(taken).not.toBe(first);
  expect(taken).toMatchObject({ total: 1, waiting: [] });
  expect(taken.version).toBeGreaterThan(first.version);
});
