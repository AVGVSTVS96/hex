import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { open } from "@hex/hub";
import type { Session, Store } from "@hex/hub";
import { until } from "@hex/hub/testing";
import { z } from "zod";

import { HTML, Keeper, lines, state } from "./board.ts";
import type { Lines, State } from "./board.ts";

const FORUM = "-1001234";
let dir: string;
let store: Store;

const session = (id: string, status: string, more: Partial<Session> = {}): [string, Session] => [
  id,
  { id, pid: 1, status, started: Date.parse("2026-11-10T10:00:00Z"), ...more },
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "board-"));
  store = open(dir);
  store.threads.keep("telegram", {
    [`${FORUM}:5`]: { name: "desk", session: "s-desk" },
    [`${FORUM}:6`]: { name: "notes", session: "s-notes" },
    [`${FORUM}:7`]: { name: "ships", session: "s-ships" },
    "2000": { name: "DM" },
  });
  store.messages.deliver({
    key: `telegram:${FORUM}:40`,
    to: `${FORUM}:5`,
    from: "telegram",
    body: "fix the login page",
    author: "owner",
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("a busy thread is working, with what its session says it's doing, linked to its newest message", () => {
  const found = lines(
    store,
    new Map([
      session("s-desk", "busy", {
        state: "working",
        detail: "running the **login** tests",
        updated: Date.parse("2026-11-10T11:00:00Z"),
      }),
      session("s-notes", "idle", { state: "working", detail: "(idle)" }),
    ]),
  );

  expect(found.w).toEqual([
    {
      title: "desk",
      line: "running the login tests",
      at: Date.parse("2026-11-10T11:00:00Z"),
      link: "1234/5/40",
    },
  ]);
});

test("a thread waits on the owner for hex's questions there, newest first, or for its blocked session", () => {
  store.questions.ask({
    app: "telegram",
    thread: `${FORUM}:6`,
    message: 51,
    text: "Ship **it**?",
    options: [],
    at: "2026-11-10T12:00:00.000Z",
  });
  store.questions.ask({
    app: "telegram",
    thread: `${FORUM}:6`,
    message: 52,
    text: "Which [logo](https://x.y)?",
    options: [],
    at: "2026-11-10T12:30:00.000Z",
  });
  store.questions.ask({
    app: "telegram",
    thread: `${FORUM}:7`,
    message: 53,
    text: "Old one",
    options: [],
    at: "2026-11-10T09:00:00.000Z",
  });

  const found = lines(
    store,
    new Map([
      session("s-ships", "idle", {
        state: "blocked",
        needs: "tap Install on the Duo",
        updated: Date.parse("2026-11-10T13:00:00Z"),
      }),
    ]),
  );

  expect(found.n).toEqual([
    {
      title: "ships",
      line: "tap Install on the Duo",
      at: Date.parse("2026-11-10T13:00:00Z"),
      link: "1234/7/53",
      count: 1,
    },
    {
      title: "notes",
      line: "Which logo?",
      at: Date.parse("2026-11-10T12:30:00.000Z"),
      link: "1234/6/52",
      count: 2,
    },
  ]);
});

test("a task done in the last day is done, linked to its proof", () => {
  const task = store.tasks.create({
    title: "Fix the login page",
    message: `telegram:${FORUM}:40`,
    owner: `${FORUM}:5`,
  });

  store.tasks.edit(task.id, { status: "done", proof: "Live: https://t.me/c/1234/5/99." });

  const [done] = lines(store, new Map()).d;

  expect(done).toMatchObject({ title: "desk", line: "Fix the login page", link: "1234/5/99" });
});

const many = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    title: `thread ${i}`,
    line: "x".repeat(50),
    at: Date.parse("2026-11-10T12:00:00Z") - i * 60_000,
    link: `1234/${i}/${i + 100}`,
    count: 3,
  }));

const Chat = z.object({
  t: z.number(),
  b: z.number(),
  c: z.string(),
  k: z.array(z.number()),
  w: z.array(z.array(z.unknown())),
  n: z.array(z.array(z.unknown())),
});

test("the board fits each state in Telegram's 1024 bytes, keeping the full counts", () => {
  const found: Lines = { w: many(20), n: many(30), d: many(40) };
  const { chat_data, public_data }: State = state(found, Date.parse("2026-11-10T12:10:00Z"));

  expect(Buffer.byteLength(chat_data)).toBeLessThanOrEqual(1024);
  expect(Buffer.byteLength(public_data)).toBeLessThanOrEqual(1024);

  const chat = Chat.parse(JSON.parse(chat_data));

  expect(chat.c).toBe("1234");
  expect(chat.k).toEqual([20, 30, 40]);
  expect(chat.t).toBe(Date.parse("2026-11-10T12:10:00Z") / 60_000);
  expect(chat.w[0]).toEqual([
    "thread 0",
    "x".repeat(50),
    "/0/100",
    Date.parse("2026-11-10T12:00:00Z") / 60_000 - chat.b,
    3,
  ]);
  expect(chat.w.length + chat.n.length).toBeGreaterThan(6);
});

test("the board's code fits Telegram's 4096 compressed bytes", () => {
  expect(deflateSync(readFileSync(HTML), { level: 9 }).length).toBeLessThanOrEqual(4096);
});

test("the keeper sends the board once, redraws it as hex changes, and stops when the owner deleted it", async () => {
  const claude = join(dir, "claude");
  mkdirSync(join(claude, "sessions"), { recursive: true });
  mkdirSync(join(claude, "jobs"), { recursive: true });
  const file = join(dir, "board.json");
  const sent: State[] = [];
  const edits: State[] = [];
  let gone = false;

  const keeper = new Keeper(
    store,
    file,
    {
      send: async (now) => {
        sent.push(now);

        return await Promise.resolve(77);
      },
      edit: async (_, now) => {
        edits.push(now);

        return await Promise.resolve(gone ? "gone" : "shown");
      },
      remove: async () => {
        await Promise.resolve();
      },
    },
    claude,
  );

  await keeper.start();
  expect(sent).toHaveLength(1);
  expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ message: 77 });

  store.questions.ask({
    app: "telegram",
    thread: `${FORUM}:6`,
    message: 51,
    text: "Ship it?",
    options: [],
  });
  await until(() => edits.at(-1)?.chat_data.includes("Ship it?"));

  gone = true;
  store.questions.ask({
    app: "telegram",
    thread: `${FORUM}:7`,
    message: 52,
    text: "Logo?",
    options: [],
  });
  await until(() => readFileSync(file, "utf-8").includes("off"));

  await keeper.again();
  expect(sent).toHaveLength(2);
  keeper.stop();
});

test("a board already sent is redrawn when the hub starts again, not sent twice", async () => {
  const file = join(dir, "board.json");
  writeFileSync(file, JSON.stringify({ message: 9 }));
  const calls: string[] = [];

  const keeper = new Keeper(
    store,
    file,
    {
      send: async () => {
        calls.push("send");

        return await Promise.resolve(10);
      },
      edit: async (message) => {
        calls.push(`edit ${message}`);

        return await Promise.resolve("shown");
      },
      remove: async () => {
        await Promise.resolve();
      },
    },
    join(dir, "no-claude"),
  );

  await keeper.start();
  keeper.stop();
  expect(calls).toEqual(["edit 9"]);
});
