import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asking, Ledger } from "./ledger.ts";
import type { Post } from "./ledger.ts";
import { open, Store } from "./store.ts";

let dir: string;

const rejection = <T>(promise: Promise<T>) => promise.then(() => "resolved", String);

function found<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("the ledger has none");
  }

  return value;
}

let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-"));
  mkdirSync(join(dir, "telegram"));
  file = join(dir, "telegram", "ledger.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("an older hex's questions and pins move from ledger.json into hex.db once, answers and notes and all (a pin written by hand keeps its words above its own 🔴 🟡 🟢 lines as its note), and the file is renamed", () => {
  const pin = {
    message: 9,
    text: "📌 **desk**\nShipping today\n\n🔴 **Blocked on you**\n- old",
    at: "2026-10-18T09:00:00.000Z",
  };

  const post = {
    message: "12",
    text: "Site: example.com\n\nmore",
    note: "Site: example.com",
    at: "2026-10-18T09:30:00.000Z",
  };

  writeFileSync(
    file,
    JSON.stringify({
      asks: [
        {
          thread: "-100:7",
          message: 41,
          text: "Deploy now?",
          options: ["Deploy", "Wait"],
          at: "2026-10-18T08:00:00.000Z",
        },
        {
          thread: "-100:7",
          message: 42,
          text: "Which take?",
          options: ["A", "B"],
          at: "2026-10-18T08:05:00.000Z",
          poll: "p-42",
          answer: { label: "B", at: "2026-10-18T08:06:00.000Z", via: "telegram" },
        },
        {
          thread: "-100:7",
          message: 43,
          text: "Broken",
          options: "not a list",
          at: "2026-10-18T08:07:00.000Z",
        },
        {
          thread: "-100:7",
          message: 44,
          text: "Blank buttons",
          options: [null],
          at: "2026-10-18T08:08:00.000Z",
        },
        {
          thread: "-100:9",
          message: 50,
          text: "Rename it?",
          options: ["Yes", "No"],
          at: "2026-10-18T08:09:00.000Z",
        },
      ],
      pins: {
        "-100:7": pin,
        "-100:8": post,
        "-100:9": { message: 50, text: "Rename it?", at: "2026-10-18T08:10:00.000Z" },
      },
    }),
  );
  const ledger = new Ledger(dir, "telegram");
  expect(ledger.find("-100:7", 41)).toMatchObject({
    app: "telegram",
    text: "Deploy now?",
    options: ["Deploy", "Wait"],
    at: "2026-10-18T08:00:00.000Z",
  });
  expect(found(ledger.byPoll("p-42")).answer).toMatchObject({ label: "B", via: "telegram" });
  expect(ledger.find("-100:7", 43)).toBeUndefined();
  expect(ledger.find("-100:7", 44)).toBeUndefined();
  expect(ledger.pin("-100:7")).toEqual({
    app: "telegram",
    thread: "-100:7",
    ...pin,
    note: "📌 **desk**\nShipping today",
  });
  expect(ledger.pin("-100:8")).toEqual({ app: "telegram", thread: "-100:8", ...post });
  expect(ledger.pin("-100:9")).toBeUndefined();
  expect(existsSync(file)).toBe(false);
  expect(readFileSync(`${file}.moved-to-hex.db`, "utf-8")).toContain("Deploy now?");
  expect(open(dir).pins()).toHaveLength(2);
});

test("a hex.db that took a ledger in at each start brings in only what an older hex changed in it since, then renames it", () => {
  const store = new Store(dir);
  store.pinned({
    app: "telegram",
    thread: "-100:8",
    message: 30,
    text: "pinned again here",
    note: "pinned again here",
  });
  store.pinned({
    app: "telegram",
    thread: "-100:9",
    message: 20,
    text: "pinned after the move",
    note: "pinned after the move",
  });
  store.db.run(
    "drop table turns; drop table relays; create table files (name text primary key, body text not null); create table shown (session text primary key, digest text not null); alter table seen drop column at; pragma user_version = 19",
  );

  const taken = {
    pins: {
      "-100:7": { message: 9, text: "old", at: "2026-10-18T09:00:00.000Z" },
      "-100:8": { message: 12, text: "rolled back", at: "2026-10-19T09:00:00.000Z" },
    },
  };

  store.db
    .query("insert into files (name, body) values (?, ?)")
    .run("telegram/ledger.json", JSON.stringify(taken));
  store.db.close();
  writeFileSync(
    file,
    JSON.stringify({
      pins: {
        "-100:6": { message: 5, text: "pinned there", at: "2026-10-20T09:00:00.000Z" },
        "-100:8": { message: 12, text: "edited there", at: "2026-10-20T09:00:00.000Z" },
      },
    }),
  );
  const after = new Store(dir);
  expect(after.pins().map(({ thread, message, text }) => ({ thread, message, text }))).toEqual([
    { thread: "-100:6", message: 5, text: "pinned there" },
    { thread: "-100:8", message: 30, text: "pinned again here" },
    { thread: "-100:9", message: 20, text: "pinned after the move" },
  ]);
  expect(existsSync(file)).toBe(false);
  expect(
    after.db.query("select name from sqlite_master where name in ('files', 'shown')").all(),
  ).toEqual([]);
});

test("a ledger.json that can't be read stays where it is", () => {
  writeFileSync(file, '{"broken');
  expect(new Ledger(dir, "telegram").pin("-100:7")).toBeUndefined();
  expect(existsSync(file)).toBe(true);
});

test("a question stays open through an edit and leaves the waiting list only when answered or settled", async () => {
  const ledger = new Ledger(dir, "telegram");
  const store = open(dir);
  ledger.ask("-100:7", 41, "Deploy now?", ["Deploy", "Wait"]);
  ledger.edited("-100:7", 41, "Deploy now? CI is green.");
  expect(store.questions({ waiting: true })).toMatchObject([{ text: "Deploy now? CI is green." }]);
  ledger.settled("-100:7", 41, "✓ Settled");
  expect(store.questions({ waiting: true })).toEqual([]);
  ledger.reopened("-100:7", 41);
  ledger.answered("-100:7", 41, "Deploy", "app");
  expect(ledger.find("-100:7", 41)).toMatchObject({ answer: { label: "Deploy", via: "app" } });
  expect(found(ledger.find("-100:7", 41)).settled).toBeUndefined();
  open(dir).pinned({
    app: "telegram",
    thread: "-100:7",
    message: 9,
    text: "Status: starting",
    note: "Status: starting",
  });
  await ledger.forget("-100:7");
  expect(ledger.questions).toEqual([]);
  expect(ledger.pin("-100:7")).toBeUndefined();
});

test("a status post is sent under its note and pinned in place of the last, rewritten from hex.db; a pin made meanwhile stands, and one the app will never edit stays pinned in the chat for the session to unpin", async () => {
  const ledger = new Ledger(dir, "telegram");
  const done: unknown[][] = [];
  let next = 20;

  const post: Post = {
    room: 4096,
    // oxlint-disable-next-line unicorn/no-useless-undefined -- a Link returns string | undefined, which () => {} doesn't
    link: () => undefined,
    send: (_, text) => {
      next += 1;
      done.push(["send", next, text]);

      return Promise.resolve(next);
    },
    edit: (_, message, text) => {
      done.push(["edit", message, text]);

      return Promise.resolve(true);
    },
    pin: (_, message) => {
      done.push(["pin", message]);

      return Promise.resolve();
    },
    unpin: (_, message) => {
      done.push(["unpin", message]);

      return Promise.resolve();
    },
  };

  ledger.ask("-100:8", 10, "Ship it?", ["Yes", "No"]);
  expect(await ledger.post("-100:8", "Site: example.com", post)).toBe(21);
  const text = String(done[0]?.[2]);
  expect(text).toStartWith("Site: example.com\n\n**Waiting on you**\n- Ship it?");
  expect(done[1]).toEqual(["pin", 21]);
  expect(ledger.pin("-100:8")).toMatchObject({ message: 21, text, note: "Site: example.com" });
  await ledger.rewrite("-100:8", post);
  expect(done).toHaveLength(2);

  await ledger.rewrite("-100:8", post, "Site: example.org\n\n**🔴 Blocked on you**\n- copied", 21);
  expect(new Ledger(dir, "telegram").pin("-100:8")).toMatchObject({ note: "Site: example.org" });
  expect(await rejection(ledger.rewrite("-100:8", post, "Site: elsewhere", 99))).toContain(
    "no longer the status post",
  );

  expect(
    await rejection(
      ledger.post("-100:8", "Site: unpinnable", {
        ...post,
        pin: () => Promise.reject(new Error("not enough rights")),
      }),
    ),
  ).toContain("rights");
  expect(ledger.pin("-100:8")).toMatchObject({ message: 21 });
  next = 21;
  expect(await ledger.post("-100:8", "Site: moved", post)).toBe(22);
  expect(done.slice(-2)).toEqual([
    ["pin", 22],
    ["unpin", 21],
  ]);
  expect(ledger.pin("-100:8")).toMatchObject({ message: 22, note: "Site: moved" });

  const closed: Post = { ...post, edit: () => Promise.resolve(false) };
  const before = ledger.pin("-100:8");
  ledger.ask("-100:8", 15, "Rename it?", ["Yes", "No"]);
  await ledger.rewrite("-100:8", closed);
  expect(ledger.pin("-100:8")).toEqual(before);
  expect(await rejection(ledger.rewrite("-100:8", closed, "Site: closed", 22))).toContain("closed");

  const slow: Post = {
    ...post,
    edit: async (...args) => {
      open(dir).pinned({
        app: "telegram",
        thread: "-100:8",
        message: 11,
        text: "Status: another post",
        note: "Status: another post",
      });

      return await post.edit(...args);
    },
  };

  await ledger.rewrite("-100:8", slow, "Site: example.net");
  const { at, ...standing } = found(ledger.pin("-100:8"));
  expect(standing).toEqual({
    app: "telegram",
    thread: "-100:8",
    message: 11,
    text: "Status: another post",
    note: "Status: another post",
  });
  expect(at).toBeString();

  await ledger.rewrite("-100:8", { ...post, edit: () => Promise.resolve(null) });
  expect(ledger.pin("-100:8")).toBeUndefined();
  expect(done.at(-1)).not.toEqual(["unpin", 11]);
  await ledger.post("-100:8", "Site: again", post);
  expect(await ledger.unpin("-100:8", post)).toBe(23);
  expect(done.at(-1)).toEqual(["unpin", 23]);
  expect(await ledger.unpin("-100:8", post)).toBeUndefined();
  expect(await ledger.unpin("-100:8", post, 7)).toBe(7);
  expect(done.at(-1)).toEqual(["unpin", 7]);
  expect(ledger.pin("-100:8")).toBeUndefined();
});

test("Telegram's bot.json, which nothing reads now, is renamed", () => {
  writeFileSync(join(dir, "telegram", "bot.json"), '{"username":"hex_bot"}');
  open(dir);
  expect([
    existsSync(join(dir, "telegram", "bot.json")),
    existsSync(join(dir, "telegram", "bot.json.moved-to-hex.db")),
  ]).toEqual([false, true]);
});

test("a reply that ends asking something waits on the owner until they reply to it", () => {
  const ledger = new Ledger(dir, "telegram");
  ledger.said(
    "-100:7",
    70,
    "Plans first, then free credits, then paid extra usage last.\n\n**Is that order right?**",
  );
  ledger.said("-100:7", 71, "Is it done? Yes, it shipped.");
  expect(ledger.find("-100:7", 70)).toMatchObject({ text: "Is that order right?", options: [] });
  expect(ledger.find("-100:7", 71)).toBeUndefined();
  ledger.heard("-100:7", 80, "yes, plans first", 70);
  expect(found(ledger.find("-100:7", 70)).answer).toMatchObject({
    label: "yes, plans first",
    via: "reply",
  });
  ledger.ask("-100:7", 72, "Deploy now?", ["Deploy", "Wait"]);
  ledger.heard("-100:7", 81, "not yet", 72);
  expect(found(ledger.find("-100:7", 72)).answer).toBeUndefined();
  expect(asking("> - Want me to merge it?")).toBe("Want me to merge it?");
});

test("the owner's question waits on them once hex answers, until they quote-reply to it or a session settles it", () => {
  const ledger = new Ledger(dir, "telegram");
  const store = open(dir);
  ledger.heard("-100:7", 90, "ok so the deploy went out. did the migration run? i never saw it");
  ledger.heard("-100:7", 91, "ship it");
  expect(ledger.find("-100:7", 90)).toMatchObject({
    asker: "owner",
    text: "did the migration run?",
  });
  expect(ledger.find("-100:7", 91)).toBeUndefined();
  expect(store.questions({ thread: "-100:7", waiting: true })).toEqual([]);
  ledger.said("-100:7", 92, "On it, checking the logs.");
  ledger.said("-100:7", 93, "Shipped.");
  expect(store.questions({ thread: "-100:7", waiting: true })).toMatchObject([
    { message: 90, answer: { via: "hex", message: 93 } },
  ]);
  expect(store.questions({ thread: "-100:7", waiting: true, asker: "hex" })).toEqual([]);
  ledger.heard("-100:7", 94, "now the docs");
  ledger.said("-100:7", 95, "Docs are up.");
  expect(ledger.find("-100:7", 90)).toMatchObject({ answer: { message: 93, kept: true } });
  expect(found(ledger.find("-100:7", 90)).settled).toBeUndefined();
  ledger.said("-100:7", 96, "Yes, the migration ran at 4:02pm.", {
    question: found(ledger.find("-100:7", 90)),
    message: 90,
  });
  expect(ledger.find("-100:7", 90)).toMatchObject({ answer: { message: 96, kept: true } });
  ledger.heard("-100:7", 97, "nice, thanks", 96);
  expect(found(ledger.find("-100:7", 90)).settled).toMatchObject({ note: "you replied" });
  ledger.heard("-100:7", 98, "and is the cache warm?");
  ledger.said("-100:7", 99, "Yes.");
  ledger.heard("-100:7", 100, "what about the queue?", 98);
  expect(found(ledger.find("-100:7", 98)).settled).toMatchObject({ note: "you replied" });
  expect(store.questions({ waiting: true })).toEqual([]);
});
