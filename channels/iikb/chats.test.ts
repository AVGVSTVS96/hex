import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clients, open } from "@hex/hub";
import type { Client, Hub, Store } from "@hex/hub";

import { answer, list, read } from "./chats.ts";

const DM = "1";
const GENERAL = "-100";
const DESK = "-100:5";
const QUIET = "-100:6";

const NAMES = new Map([
  [DM, "DM"],
  [GENERAL, "hex"],
  [DESK, "Desk"],
  [QUIET, "Quiet"],
]);

let hexDir: string;
let store: Store;
let delivered: unknown[][];

function telegram(): Client {
  const hub: Pick<Hub, "name" | "deliver" | "threads" | "fresh" | "main"> = {
    name: (thread) => NAMES.get(thread),
    deliver: (...args) => {
      delivered.push(args);

      return true;
    },
    threads: () => [...NAMES.keys()],
    fresh: (thread) => thread === DM,
    main: GENERAL,
  };

  // SAFETY: the iikb channel reaches a client's hub only through these five.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fake of the five the channel uses
  return { hub: hub as Hub, place: () => Promise.resolve({ thread: "", link: "" }) };
}

const say = (thread: string, n: number, author: "owner" | "hex", body: string) => {
  store.messages.deliver({
    key: `telegram:${thread}:${n}`,
    to: thread,
    from: "telegram",
    author,
    body,
  });
  store.messages.take(`telegram:${thread}:${n}`, "s1");
};

const ask = (path: string, init?: RequestInit) =>
  answer(store, new Request(`http://iikb${path}`, init), "secret");

const post = (path: string, body: { text: string; id: string }, token = "secret") =>
  ask(path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

const aFreshHexDbRunsEveryMigrationForSecondsOnALoadedMachine = 30_000;

beforeEach(() => {
  hexDir = mkdtempSync(join(tmpdir(), "iikb-"));
  mkdirSync(join(hexDir, "state"));
  store = open(join(hexDir, "state"));
  delivered = [];
  clients.set("telegram", telegram());
}, aFreshHexDbRunsEveryMigrationForSecondsOnALoadedMachine);

afterEach(() => {
  clients.clear();
  rmSync(hexDir, { recursive: true, force: true });
});

test("the DM and General come first, then threads by their latest message, each with its last line", () => {
  say(QUIET, 1, "owner", "old news");
  say(DESK, 1, "owner", "ship it");
  say(DESK, 2, "hex", "Shipped.\nBuild 9 is on your phone.");

  expect(list(store)).toEqual([
    { id: "telegram:1", name: "DM", pinned: true },
    { id: "telegram:-100", name: "General", pinned: true },
    { id: "telegram:-100:5", name: "Desk", line: "Shipped." },
    { id: "telegram:-100:6", name: "Quiet", line: "old news" },
  ]);
});

test("a chat is what was said in it, then the owner's words its session hasn't taken yet", async () => {
  say(DESK, 1, "owner", "ship it");
  say(DESK, 2, "hex", "Shipped.");
  store.messages.deliver({
    key: "telegram:x",
    to: DESK,
    from: "telegram",
    author: "owner",
    body: "and docs",
  });

  expect((await read(store, "telegram:-100:5")).messages).toEqual([
    { from: "me", text: "ship it" },
    { from: "hex", text: "Shipped." },
    { from: "me", text: "and docs", pending: true },
  ]);
});

test("a read after a version waits for the next message, and returns the moment it's written", async () => {
  say(DESK, 1, "owner", "ship it");
  const { version } = await read(store, "telegram:-100:5");
  const next = read(store, "telegram:-100:5", version);

  say(DESK, 2, "hex", "Shipped.");

  expect((await next).messages.at(-1)).toEqual({ from: "hex", text: "Shipped." });
});

test("words sent from the keyboard reach the thread as the owner's, from iikb, under the keyboard's id", async () => {
  const response = await post("/telegram%3A-100%3A5", { text: "and the tests", id: "m1" });

  expect(response.status).toBe(204);
  expect(delivered).toMatchObject([
    [
      "-100:5",
      "Desk",
      { content: "and the tests", key: "iikb-m1", author: "owner", meta: { user: "iikb" } },
    ],
  ]);
});

test("a chat whose app isn't running says so, a bad body is refused, and a wrong token gets nothing", async () => {
  expect((await post("/discord%3A7", { text: "hi", id: "m2" })).status).toBe(502);
  expect((await post("/telegram%3A-100%3A5", { text: " ", id: "m3" })).status).toBe(400);
  expect((await post("/telegram%3A-100%3A5", { text: "hi", id: "m4" }, "nope")).status).toBe(401);
  expect(delivered).toEqual([]);
});
