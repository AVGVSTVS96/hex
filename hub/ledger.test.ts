import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HeldBackError } from "./held-back.ts";
import { asking, Ledger } from "./ledger.ts";
import type { Post } from "./ledger.ts";
import { File, file, open, reading, stateDir, UnreachedError } from "./store.ts";
import { answering } from "./store/wire.ts";
import { until } from "./until.ts";

let dir: string;

const rejection = <T>(promise: Promise<T>) => promise.then(() => "resolved", String);

function found<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("the ledger has none");
  }

  return value;
}

let ledgerJson: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-"));
  mkdirSync(join(dir, "telegram"));
  ledgerJson = join(dir, "telegram", "ledger.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("an older hex's questions and pins move from ledger.json into hex.db once, answers and notes and all (a pin written by hand keeps its words above its own 🔴 🟡 🟢 lines as its note), and the file is renamed", async () => {
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
    ledgerJson,
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
  expect(await ledger.find("-100:7", 41)).toMatchObject({
    app: "telegram",
    text: "Deploy now?",
    options: ["Deploy", "Wait"],
    at: "2026-10-18T08:00:00.000Z",
  });
  expect(found(await ledger.byPoll("p-42")).answer).toMatchObject({ label: "B", via: "telegram" });
  expect(await ledger.find("-100:7", 43)).toBeUndefined();
  expect(await ledger.find("-100:7", 44)).toBeUndefined();
  expect(await ledger.pin("-100:7")).toEqual({
    app: "telegram",
    thread: "-100:7",
    ...pin,
    note: "📌 **desk**\nShipping today",
  });
  expect(await ledger.pin("-100:8")).toEqual({ app: "telegram", thread: "-100:8", ...post });
  expect(await ledger.pin("-100:9")).toBeUndefined();
  expect(existsSync(ledgerJson)).toBe(false);
  expect(readFileSync(`${ledgerJson}.moved-to-hex.db`, "utf-8")).toContain("Deploy now?");
  expect(file(dir).pins.list()).toHaveLength(2);
});

test("a hex.db that took a ledger in at each start brings in only what an older hex changed in it since, then renames it", () => {
  const store = new File(dir);
  store.pins.pinned({
    app: "telegram",
    thread: "-100:8",
    message: 30,
    text: "pinned again here",
    note: "pinned again here",
  });
  store.pins.pinned({
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
    ledgerJson,
    JSON.stringify({
      pins: {
        "-100:6": { message: 5, text: "pinned there", at: "2026-10-20T09:00:00.000Z" },
        "-100:8": { message: 12, text: "edited there", at: "2026-10-20T09:00:00.000Z" },
      },
    }),
  );
  const after = new File(dir);
  expect(after.pins.list().map(({ thread, message, text }) => ({ thread, message, text }))).toEqual(
    [
      { thread: "-100:6", message: 5, text: "pinned there" },
      { thread: "-100:8", message: 30, text: "pinned again here" },
      { thread: "-100:9", message: 20, text: "pinned after the move" },
    ],
  );
  expect(existsSync(ledgerJson)).toBe(false);
  expect(
    after.db.query("select name from sqlite_master where name in ('files', 'shown')").all(),
  ).toEqual([]);
});

test("a ledger.json that can't be read stays where it is", async () => {
  writeFileSync(ledgerJson, '{"broken');
  expect(await new Ledger(dir, "telegram").pin("-100:7")).toBeUndefined();
  expect(existsSync(ledgerJson)).toBe(true);
});

test("a question stays open through an edit and leaves the waiting list only when answered or settled", async () => {
  const ledger = new Ledger(dir, "telegram");
  const store = file(dir);
  await ledger.ask("-100:7", 41, "Deploy now?", ["Deploy", "Wait"]);
  await ledger.edited("-100:7", 41, "Deploy now? CI is green.");
  expect(store.questions.list({ waiting: true })).toMatchObject([
    { text: "Deploy now? CI is green." },
  ]);
  await ledger.settled("-100:7", 41, "✓ Settled");
  expect(store.questions.list({ waiting: true })).toEqual([]);
  await ledger.reopened("-100:7", 41);
  await ledger.answered("-100:7", 41, "Deploy", "app");
  expect(await ledger.find("-100:7", 41)).toMatchObject({
    answer: { label: "Deploy", via: "app" },
  });
  expect(found(await ledger.find("-100:7", 41)).settled).toBeUndefined();
  file(dir).pins.pinned({
    app: "telegram",
    thread: "-100:7",
    message: 9,
    text: "Status: starting",
    note: "Status: starting",
  });
  await ledger.forget("-100:7");
  expect(await ledger.questions).toEqual([]);
  expect(await ledger.pin("-100:7")).toBeUndefined();
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

  await ledger.ask("-100:8", 10, "Ship it?", ["Yes", "No"]);
  expect(await ledger.post("-100:8", "Site: example.com", post)).toBe(21);
  const text = String(done[0]?.[2]);
  expect(text).toStartWith("Site: example.com\n\n**Waiting on you**\n- Ship it?");
  expect(done[1]).toEqual(["pin", 21]);
  expect(await ledger.pin("-100:8")).toMatchObject({
    message: 21,
    text,
    note: "Site: example.com",
  });
  await ledger.rewrite("-100:8", post);
  expect(done).toHaveLength(2);

  await ledger.rewrite("-100:8", post, "Site: example.org\n\n**🔴 Blocked on you**\n- copied", 21);
  expect(await new Ledger(dir, "telegram").pin("-100:8")).toMatchObject({
    note: "Site: example.org",
  });
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
  expect(await ledger.pin("-100:8")).toMatchObject({ message: 21 });
  next = 21;
  expect(await ledger.post("-100:8", "Site: moved", post)).toBe(22);
  expect(done.slice(-2)).toEqual([
    ["pin", 22],
    ["unpin", 21],
  ]);
  expect(await ledger.pin("-100:8")).toMatchObject({ message: 22, note: "Site: moved" });

  const closed: Post = { ...post, edit: () => Promise.resolve(false) };
  const before = await ledger.pin("-100:8");
  await ledger.ask("-100:8", 15, "Rename it?", ["Yes", "No"]);
  await ledger.rewrite("-100:8", closed);
  expect(await ledger.pin("-100:8")).toEqual(before);
  expect(await rejection(ledger.rewrite("-100:8", closed, "Site: closed", 22))).toContain("closed");

  const slow: Post = {
    ...post,
    edit: async (...args) => {
      file(dir).pins.pinned({
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
  const { at, ...standing } = found(await ledger.pin("-100:8"));
  expect(standing).toEqual({
    app: "telegram",
    thread: "-100:8",
    message: 11,
    text: "Status: another post",
    note: "Status: another post",
  });
  expect(at).toBeString();

  await ledger.rewrite("-100:8", { ...post, edit: () => Promise.resolve(null) });
  expect(await ledger.pin("-100:8")).toBeUndefined();
  expect(done.at(-1)).not.toEqual(["unpin", 11]);
  await ledger.post("-100:8", "Site: again", post);
  expect(await ledger.unpin("-100:8", post)).toBe(23);
  expect(done.at(-1)).toEqual(["unpin", 23]);
  expect(await ledger.unpin("-100:8", post)).toBeUndefined();
  expect(await ledger.unpin("-100:8", post, 7)).toBe(7);
  expect(done.at(-1)).toEqual(["unpin", 7]);
  expect(await ledger.pin("-100:8")).toBeUndefined();
});

test("Telegram's bot.json, which nothing reads now, is renamed", () => {
  writeFileSync(join(dir, "telegram", "bot.json"), '{"username":"hex_bot"}');
  file(dir);
  expect([
    existsSync(join(dir, "telegram", "bot.json")),
    existsSync(join(dir, "telegram", "bot.json.moved-to-hex.db")),
  ]).toEqual([false, true]);
});

test("a reply that ends asking something waits on the owner until they reply to it", async () => {
  const ledger = new Ledger(dir, "telegram");
  await ledger.said(
    "-100:7",
    70,
    "Plans first, then free credits, then paid extra usage last.\n\n**Is that order right?**",
  );
  await ledger.said("-100:7", 71, "Is it done? Yes, it shipped.");
  expect(await ledger.find("-100:7", 70)).toMatchObject({
    text: "Is that order right?",
    options: [],
  });
  expect(await ledger.find("-100:7", 71)).toBeUndefined();
  await ledger.heard("-100:7", 80, "yes, plans first", 70);
  expect(found(await ledger.find("-100:7", 70)).answer).toMatchObject({
    label: "yes, plans first",
    via: "reply",
  });
  await ledger.ask("-100:7", 72, "Deploy now?", ["Deploy", "Wait"]);
  await ledger.heard("-100:7", 81, "not yet", 72);
  expect(found(await ledger.find("-100:7", 72)).answer).toBeUndefined();
  expect(asking("> - Want me to merge it?")).toBe("Want me to merge it?");
});

test("the owner's question waits on them once hex answers, until they quote-reply to it or a session settles it", async () => {
  const ledger = new Ledger(dir, "telegram");
  const store = file(dir);
  await ledger.heard(
    "-100:7",
    90,
    "ok so the deploy went out. did the migration run? i never saw it",
  );
  await ledger.heard("-100:7", 91, "ship it");
  expect(await ledger.find("-100:7", 90)).toMatchObject({
    asker: "owner",
    text: "did the migration run?",
  });
  expect(await ledger.find("-100:7", 91)).toBeUndefined();
  expect(store.questions.list({ thread: "-100:7", waiting: true })).toEqual([]);
  await ledger.said("-100:7", 92, "On it, checking the logs.");
  await ledger.said("-100:7", 93, "Shipped.");
  expect(store.questions.list({ thread: "-100:7", waiting: true })).toMatchObject([
    { message: 90, answer: { via: "hex", message: 93 } },
  ]);
  expect(store.questions.list({ thread: "-100:7", waiting: true, asker: "hex" })).toEqual([]);
  await ledger.heard("-100:7", 94, "now the docs");
  await ledger.said("-100:7", 95, "Docs are up.");
  expect(await ledger.find("-100:7", 90)).toMatchObject({ answer: { message: 93, kept: true } });
  expect(found(await ledger.find("-100:7", 90)).settled).toBeUndefined();
  await ledger.said("-100:7", 96, "Yes, the migration ran at 4:02pm.", {
    question: found(await ledger.find("-100:7", 90)),
    message: 90,
  });
  expect(await ledger.find("-100:7", 90)).toMatchObject({ answer: { message: 96, kept: true } });
  await ledger.heard("-100:7", 97, "nice, thanks", 96);
  expect(found(await ledger.find("-100:7", 90)).settled).toMatchObject({ note: "you replied" });
  await ledger.heard("-100:7", 98, "and is the cache warm?");
  await ledger.said("-100:7", 99, "Yes.");
  await ledger.heard("-100:7", 100, "what about the queue?", 98);
  expect(found(await ledger.find("-100:7", 98)).settled).toMatchObject({ note: "you replied" });
  expect(store.questions.list({ waiting: true })).toEqual([]);
});

test("a status post is rebuilt when its own thread's questions change, not on every write to hex.db", async () => {
  const ledger = new Ledger(dir, "telegram");
  const rendered: string[] = [];
  const edited: string[] = [];

  const post: Post = {
    room: 4096,
    // oxlint-disable-next-line unicorn/no-useless-undefined -- a Link returns string | undefined, which () => {} doesn't
    link: () => undefined,
    send: () => Promise.resolve(1),
    edit: (thread) => {
      edited.push(thread);

      return Promise.resolve(true);
    },
    ready: (thread) => {
      rendered.push(thread);

      return Promise.resolve();
    },
    pin: () => Promise.resolve(),
    unpin: () => Promise.resolve(),
  };

  await ledger.post("-100:8", "Desk", post);
  await ledger.post("-100:9", "Site", post);

  const stop = await ledger.keep(post, (_, error) => {
    throw error;
  });

  await until(() => rendered.length >= 4);
  await Bun.sleep(100);
  rendered.length = 0;

  file(dir).messages.deliver({
    key: "telegram:-100:8:1",
    to: "-100:8",
    from: "telegram",
    author: "owner",
    body: "hi",
  });
  await Bun.sleep(200);
  expect(rendered).toEqual([]);

  await ledger.ask("-100:9", 10, "Ship it?", ["Yes", "No"]);
  await until(() => edited.includes("-100:9"));
  expect(rendered).toEqual(["-100:9"]);
  stop();
});

test("rewrites asked for while one is slow join into one that runs after it with the newest note, so they never pile up behind it", async () => {
  const ledger = new Ledger(dir, "telegram");
  const edited: string[] = [];
  let release: (() => void) | undefined;

  const post: Post = {
    room: 4096,
    // oxlint-disable-next-line unicorn/no-useless-undefined -- a Link returns string | undefined, which () => {} doesn't
    link: () => undefined,
    send: () => Promise.resolve(1),
    edit: async (_, __, text) => {
      edited.push(text);

      if (edited.length === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }

      return true;
    },
    pin: () => Promise.resolve(),
    unpin: () => Promise.resolve(),
  };

  await ledger.post("-100:8", "Desk", post);

  const slow = ledger.rewrite("-100:8", post, "First", 1);
  await until(() => release !== undefined);

  const after = ["Second", "Third", "Fourth"].map(async (note) => {
    await ledger.rewrite("-100:8", post, note, 1);
  });

  const kept = ledger.rewrite("-100:8", post);

  release?.();
  await Promise.all([slow, ...after, kept]);

  expect(edited).toEqual(["First", "Fourth"]);
  expect(await ledger.pin("-100:8")).toMatchObject({ note: "Fourth" });
});

test("a background rewrite Telegram holds back is tried again once the wait it names is over", async () => {
  const ledger = new Ledger(dir, "telegram");
  const tried: string[] = [];
  const failures: string[] = [];

  file(dir).pins.pinned({
    app: "telegram",
    thread: "-100:8",
    message: 1,
    text: "old",
    note: "Desk",
  });

  const post: Post = {
    room: 4096,
    // oxlint-disable-next-line unicorn/no-useless-undefined -- a Link returns string | undefined, which () => {} doesn't
    link: () => undefined,
    send: () => Promise.resolve(1),
    edit: (_, __, text) => {
      tried.push(text);

      return tried.length === 1
        ? Promise.reject(new HeldBackError("Telegram asks this chat to wait 0s", 0))
        : Promise.resolve(true);
    },
    pin: () => Promise.resolve(),
    unpin: () => Promise.resolve(),
  };

  const stop = await ledger.keep(post, (_, error) => {
    failures.push(String(error));
  });

  try {
    await until(() => failures.length > 0);
    let looks = 0;
    await until(() => tried.length > 1 || (looks += 1) > 50);

    expect(tried).toEqual(["Desk", "Desk"]);
    expect(await ledger.pin("-100:8")).toMatchObject({ text: "Desk" });
    expect(failures).toEqual(["HeldBackError: Telegram asks this chat to wait 0s"]);
  } finally {
    stop();
  }
});

test("a status post's reads don't wait in line behind a board's", async () => {
  const records = file(join(dir, "object"));
  const answer = answering(records);
  records.pins.pinned({
    app: "telegram",
    thread: "-100:7",
    message: 1,
    text: "old",
    note: "Working",
  });
  const { promise: boardMayAnswer, resolve: answerTheBoard } = Promise.withResolvers<undefined>();

  const object = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const call = await request.text();

      if (call.includes('"threads"')) {
        await boardMayAnswer;
      }

      return Response.json(answer(call));
    },
  });

  writeFileSync(
    join(stateDir(dir), "store.json"),
    JSON.stringify({ url: object.url.origin, name: "hex", key: "k".repeat(32) }),
  );

  const post: Post = {
    room: 4096,
    // oxlint-disable-next-line unicorn/no-useless-undefined -- a Link returns string | undefined, which () => {} doesn't
    link: () => undefined,
    send: () => Promise.resolve(2),
    edit: (_, __, text) => {
      edited.push(text);

      return Promise.resolve(true);
    },
    pin: () => Promise.resolve(),
    unpin: () => Promise.resolve(),
  };

  const edited: string[] = [];
  let boardAnswered = false;

  const board = (async () => {
    await reading(stateDir(dir)).threads.list();
    boardAnswered = true;
  })();

  try {
    await new Ledger(dir, "telegram").rewrite("-100:7", post);

    expect(edited).toEqual(["Working"]);
    expect(boardAnswered).toBe(false);
  } finally {
    answerTheBoard(undefined);
    await Promise.allSettled([board]);
    await object.stop(true);
  }
});

test("reads sent at once to a store that stopped answering share one probe of it", async () => {
  const probes = new Set<string>();

  const object = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if ((await request.text()).includes('"clock"')) {
        probes.add(request.headers.get("hex-call") ?? "");
      }

      return new Response("", { status: 500 });
    },
  });

  writeFileSync(
    join(stateDir(dir), "store.json"),
    JSON.stringify({ url: object.url.origin, name: "hex", key: "k".repeat(32) }),
  );

  try {
    const failed = await Promise.allSettled(
      Array.from({ length: 50 }, async () => await reading(stateDir(dir), false).threads.list()),
    );

    expect(
      failed.every((each) => each.status === "rejected" && each.reason instanceof UnreachedError),
    ).toBe(true);
    expect(probes.size).toBe(1);
  } finally {
    await object.stop(true);
  }
});

test("status posts read hex's store through a client of their own, so a message lands and the store syncs without waiting out their reads", async () => {
  const records = file(join(dir, "object"));
  const answer = answering(records);
  const threads = Array.from({ length: 200 }, (_, n) => `-100:${n}`);

  for (const thread of threads) {
    records.pins.pinned({ app: "telegram", thread, message: 1, text: "old", note: "Working" });
  }

  const object = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const call = await request.text();
      await Bun.sleep(5);

      return Response.json(answer(call));
    },
  });

  writeFileSync(
    join(stateDir(dir), "store.json"),
    JSON.stringify({ url: object.url.origin, name: "hex", key: "k".repeat(32) }),
  );

  const post: Post = {
    room: 4096,
    // oxlint-disable-next-line unicorn/no-useless-undefined -- a Link returns string | undefined, which () => {} doesn't
    link: () => undefined,
    send: () => Promise.resolve(2),
    edit: () => Promise.resolve(true),
    pin: () => Promise.resolve(),
    unpin: () => Promise.resolve(),
  };

  const ledger = new Ledger(dir, "telegram");

  const rewrites = threads.map(async (thread) => {
    await ledger.rewrite(thread, post);
  });

  try {
    const began = Date.now();

    await open(stateDir(dir)).messages.deliver({
      key: "telegram:-100:1:9",
      to: "-100:1",
      from: "telegram",
      author: "owner",
      body: "hi",
    });
    await open(stateDir(dir)).synced();

    expect(Date.now() - began).toBeLessThan(300);
    expect(records.messages.get("telegram:-100:1:9")?.body).toBe("hi");
  } finally {
    await Promise.allSettled(rewrites);
    await object.stop(true);
  }
});

test("status posts whose first read the store didn't answer are kept once it answers again, and no read it fails goes unhandled", async () => {
  const records = file(join(dir, "object"));
  const answer = answering(records);
  records.pins.pinned({
    app: "telegram",
    thread: "-100:7",
    message: 1,
    text: "old",
    note: "Working",
  });
  let failing = true;
  let unhandled = 0;

  const count = () => {
    unhandled += 1;
  };

  process.on("unhandledRejection", count);

  const object = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request, server) => {
      if (new URL(request.url).pathname.endsWith("/watch")) {
        return server.upgrade(request) ? undefined : new Response("no", { status: 400 });
      }

      const call = await request.text();

      return failing && call.includes('"pins"')
        ? new Response("", { status: 500 })
        : Response.json(answer(call));
    },
    websocket: {
      open: (socket) => {
        socket.subscribe("changes");
      },
      message: (socket) => {
        socket.send("pong");
      },
    },
  });

  writeFileSync(
    join(stateDir(dir), "store.json"),
    JSON.stringify({ url: object.url.origin, name: "hex", key: "k".repeat(32) }),
  );

  const edited: string[] = [];

  const post: Post = {
    room: 4096,
    // oxlint-disable-next-line unicorn/no-useless-undefined -- a Link returns string | undefined, which () => {} doesn't
    link: () => undefined,
    send: () => Promise.resolve(2),
    edit: (thread) => {
      edited.push(thread);

      return Promise.resolve(true);
    },
    pin: () => Promise.resolve(),
    unpin: () => Promise.resolve(),
  };

  const stop = await new Ledger(dir, "telegram").keep(post, (_, error) => {
    throw error;
  });

  try {
    expect(edited).toEqual([]);
    failing = false;
    object.publish("changes", ".");
    await until(() => edited.includes("-100:7"));
    expect(unhandled).toBe(0);
  } finally {
    stop();
    process.off("unhandledRejection", count);
    await object.stop(true);
  }
});
