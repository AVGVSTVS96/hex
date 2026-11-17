import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";

import { z } from "zod";

import { open, Store } from "./store.ts";
import type { NewRow } from "./store.ts";
import { appendOnlyMigrations } from "./store/migrations.ts";
import { until } from "./until.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const message = {
  key: "telegram:-100:42",
  to: "-100:7",
  from: "telegram",
  body: "remind me to water the plants",
  author: "owner",
  meta: { user: "victor" },
} satisfies NewRow;

function said(out: string) {
  return out.split("\n").filter((line) => /^(on|Telegram)/u.test(line));
}

function anyString(): string {
  // oxlint-disable-next-line typescript/no-unsafe-return -- bun types its asymmetric matchers as any
  return expect.any(String);
}

function containing(text: string): string {
  // oxlint-disable-next-line typescript/no-unsafe-return -- bun types its asymmetric matchers as any
  return expect.stringContaining(text);
}

function matching(pattern: RegExp): string {
  // oxlint-disable-next-line typescript/no-unsafe-return -- bun types its asymmetric matchers as any
  return expect.stringMatching(pattern);
}

test("a message is kept once, word for word, and a resend under its key changes nothing", async () => {
  const store = new Store(dir);
  expect(await store.messages.deliver(message)).toBe(true);
  expect(await store.messages.deliver({ ...message, body: "something else" })).toBe(false);
  const kept = store.messages.get(message.key);
  expect(kept).toMatchObject({ ...message });
  expect(kept?.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u);
  expect(kept?.taken).toBeUndefined();
});

test("a key has to start with its sender, so the keys hex makes stay its own", async () => {
  const store = new Store(dir);
  // oxlint-disable-next-line typescript/await-thenable typescript/no-confusing-void-expression -- bun's rejects matchers return a promise that its types call void
  await expect(
    store.messages.deliver({ ...message, key: "schedule:heartbeat@2026-10-18T21:45Z" }),
  ).rejects.toThrow();
  // oxlint-disable-next-line typescript/await-thenable typescript/no-confusing-void-expression -- bun's rejects matchers return a promise that its types call void
  await expect(store.messages.deliver({ ...message, key: "42" })).rejects.toThrow();
  expect(store.messages.untaken()).toEqual([]);
});

test("a message reads as its newest edit, made in any topic of its chat, even when only the edit was kept", async () => {
  const store = new Store(dir);

  const sent = {
    key: "telegram:-100:42",
    to: "-100:7",
    from: "telegram",
    author: "hex",
    body: "Deploy at 5",
  } satisfies NewRow;

  await store.messages.deliver(sent);
  expect(store.messages.latest(sent.key)?.body).toBe("Deploy at 5");
  await store.messages.deliver({
    ...sent,
    key: "telegram:edit-1",
    body: "Deploy at 6",
    meta: { edited: "true", message_id: "42" },
  });
  await store.messages.deliver({
    ...sent,
    key: "telegram:edit-2",
    body: "Deploy at 7",
    meta: { edited: "true", message_id: "42" },
  });
  await store.messages.deliver({
    ...sent,
    key: "telegram:edit-3",
    to: "-200:3",
    body: "another chat",
    meta: { edited: "true", message_id: "42" },
  });
  await store.messages.deliver({
    ...sent,
    key: "discord:edit-4",
    from: "discord",
    body: "another app",
    meta: { edited: "true", message_id: "42" },
  });
  expect(store.messages.latest(sent.key)?.body).toBe("Deploy at 7");
  await store.messages.deliver({
    ...sent,
    key: "telegram:edit-5",
    to: "-100:9",
    body: "Deploy at 8, edited from another topic",
    meta: { edited: "true", message_id: "42" },
  });
  expect(store.messages.latest(sent.key)).toMatchObject({
    key: sent.key,
    to: "-100:7",
    body: "Deploy at 8, edited from another topic",
  });
  expect(store.messages.latest("telegram:-100:43")).toBeNull();
  await store.messages.deliver({
    key: "buzz:e2",
    to: "thread",
    from: "buzz",
    author: "owner",
    body: "tagged on edit",
    meta: { edited: "true", message_id: "e1" },
  });
  expect(store.messages.latest("buzz:e1")?.body).toBe("tagged on edit");
});

test("a message a topic's session sent into another chat reads as its newest edit, kept by its id with its chat", async () => {
  const store = new Store(dir);

  const sent = {
    key: "telegram:2000:55",
    to: "-100:7",
    from: "telegram",
    author: "hex",
    body: "Tiles",
  } satisfies NewRow;

  await store.messages.deliver(sent);
  await store.messages.deliver({
    ...sent,
    key: "telegram:edit-6",
    body: "Bigger tiles",
    meta: { edited: "true", message_id: "telegram:2000:55" },
  });
  await store.messages.deliver({
    ...sent,
    key: "telegram:edit-7",
    body: "the group's own message 55",
    meta: { edited: "true", message_id: "55" },
  });
  expect(store.messages.latest(sent.key)?.body).toBe("Bigger tiles");
});

test("the first session to take a message has it, and it leaves what waits", async () => {
  const store = new Store(dir);
  await store.messages.deliver(message);
  await store.messages.deliver({ ...message, key: "telegram:-100:43", body: "and some chips" });
  await store.messages.deliver({ ...message, key: "telegram:-100:44", to: "-100:9" });
  expect(await store.messages.take(message.key, "session-a")).toBe(true);
  expect(await store.messages.take(message.key, "session-b")).toBe(false);
  expect(await store.messages.take("telegram:-100:99", "session-a")).toBe(false);
  expect(store.messages.get(message.key)?.taken?.by).toBe("session-a");
  expect(store.messages.untaken("-100:7").map((row) => row.body)).toEqual(["and some chips"]);
  expect(store.messages.untaken().map((row) => row.key)).toEqual([
    "telegram:-100:43",
    "telegram:-100:44",
  ]);
});

test("some threads' untaken messages, and a mark that moves only when a thread's messages do", async () => {
  const store = new Store(dir);
  await store.messages.deliver(message);
  await store.messages.deliver({ ...message, key: "telegram:-100:43", to: "-100:8" });
  await store.messages.deliver({ ...message, key: "telegram:-100:44", to: "-100:9" });
  expect(store.messages.untaken(["-100:9", "-100:7"]).map((row) => row.key)).toEqual([
    message.key,
    "telegram:-100:44",
  ]);
  const mark = store.messages.mark("-100:7");
  await store.messages.take("telegram:-100:43", "session-a");
  expect(store.messages.mark("-100:7")).toBe(mark);
  await store.messages.take(message.key, "session-a");
  const taken = store.messages.mark("-100:7");
  expect(taken).not.toBe(mark);
  await store.messages.deliver({ ...message, key: "telegram:-100:45" });
  const kept = store.messages.mark("-100:7");
  expect(kept).not.toBe(taken);
  expect(
    await store.messages.past(
      [[{ ...message, key: "telegram:-100:46" }, "2020-01-01T00:00:00.000Z"]],
      "session-a",
    ),
  ).toEqual(["telegram:-100:46"]);
  expect(store.messages.mark("-100:7")).not.toBe(kept);
});

test("a schedule's slot fires once, and its next slot fires whether or not the last was taken", async () => {
  const store = new Store(dir);
  const minute = Date.UTC(2026, 9, 18, 21, 45) / 60_000;
  expect(
    await store.scheduler.fire("heartbeat", minute, "general", "[heartbeat] Hourly check"),
  ).toBe(true);
  expect(
    await store.scheduler.fire("heartbeat", minute, "general", "[heartbeat] Hourly check"),
  ).toBe(false);
  expect(
    await store.scheduler.fire("heartbeat", minute + 60, "general", "[heartbeat] Hourly check"),
  ).toBe(true);
  expect(await store.scheduler.fire("call", minute, "general", "[call] Ring if needed", true)).toBe(
    true,
  );
  expect(store.messages.get("schedule:heartbeat@2026-10-18T21:45Z")).toMatchObject({
    to: "general",
    from: "schedule",
    meta: { user: "schedule", schedule: "heartbeat" },
  });
  expect(store.messages.get("schedule:call@2026-10-18T21:45Z")?.meta?.late).toBe("true");
});

test("the scheduler keeps the last minute it checked", async () => {
  const store = new Store(dir);
  expect(store.scheduler.checked()).toBeUndefined();
  await store.scheduler.check(100);
  await store.scheduler.check(101);
  expect(new Store(dir).scheduler.checked()).toBe(101);
});

test("a change committed in another process rings the bell, and a write that changed nothing stays quiet", async () => {
  const store = open(dir);
  expect(open(dir)).toBe(store);
  let rang = 0;
  await store.threads.keep("telegram", { general: { name: "General" } });

  const stop = store.watch(() => {
    rang++;
  });

  const cli = Bun.spawn([
    "bun",
    join(import.meta.dir, "cli.ts"),
    dir,
    "deliver",
    "job:build:abc",
    "--to",
    "general",
    "[job]",
    "build",
    "ended",
  ]);

  expect(await cli.exited).toBe(0);
  await until(() => rang > 0);
  expect(store.messages.get("job:build:abc")).toMatchObject({
    to: "general",
    from: "job",
    body: "[job] build ended",
    meta: { user: "job" },
  });
  const bell = readFileSync(join(dir, "hex.bell"), "utf-8");
  expect(await store.messages.take("job:nothing:here", "session-a")).toBe(false);
  expect(readFileSync(join(dir, "hex.bell"), "utf-8")).toBe(bell);
  stop();
});

test("a listener runs at the first ring, then once for each change, however many times the bell rings for it", async () => {
  const store = open(dir);
  let rang = 0;

  const stop = store.watch(() => {
    rang++;
  });

  for (let ring = 0; ring < 5; ring++) {
    appendFileSync(join(dir, "hex.bell"), ".");
  }

  await until(() => rang > 0);
  await Bun.sleep(100);
  expect(rang).toBe(1);
  await store.messages.deliver(message);
  await until(() => rang > 1);
  await Bun.sleep(100);
  expect(rang).toBe(2);
  stop();
});

test("hex watch prints a line once it listens and one for each change to hex.db, never opens it, and ends once nothing reads it", async () => {
  const watch = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), dir, "watch"], {
    stdout: "pipe",
  });

  try {
    const lines = watch.stdout.getReader();
    const line = async () => new TextDecoder().decode((await lines.read()).value);
    expect(await line()).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z\n$/u);
    expect(existsSync(join(dir, "hex.db"))).toBe(false);
    const store = open(dir);
    let n = 0;

    const change = () =>
      store.messages.deliver({
        key: `job:watched:${n++}`,
        to: "general",
        from: "job",
        author: "prompt",
        body: "one",
      });

    await change();
    expect(await line()).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z\n/u);
    await lines.cancel();
    await until(() => watch.exitCode !== null || void change());
    expect(watch.exitCode).toBe(0);
  } finally {
    watch.kill();
  }
});

test("a change right after the one the bell just rang for is still heard", async () => {
  const store = open(dir);
  const seen: (string | undefined)[] = [];

  const stop = store.watch(() => {
    seen.push(store.messages.get("job:quick:2")?.body);

    if (seen.length === 1) {
      void store.messages.deliver({
        key: "job:quick:2",
        to: "general",
        from: "job",
        author: "prompt",
        body: "two",
      });
    }
  });

  await store.messages.deliver({
    key: "job:quick:1",
    to: "general",
    from: "job",
    author: "prompt",
    body: "one",
  });
  await until(() => seen.at(-1) === "two");
  stop();
});

test("hex deliver says how to call it when something is missing", async () => {
  for (const args of [
    ["job:build:abc", "no thread"],
    ["build", "--to", "general"],
  ]) {
    const cli = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), dir, "deliver", ...args], {
      stderr: "pipe",
    });

    expect(await cli.exited).toBe(2);
    expect(await new Response(cli.stderr).text()).toContain(
      "hex deliver <from>[:<id>] --to <thread>",
    );
  }
});

test("hex deliver reaches a thread by its id, and a sender alone gets a key of its own", async () => {
  await open(dir).threads.keep("discord", { "1561": { name: "Repair" } });

  const cli = Bun.spawn([
    "bun",
    join(import.meta.dir, "cli.ts"),
    dir,
    "deliver",
    "hex",
    "--to",
    "discord:1561",
    "--user",
    "hex General",
    "look at the build",
  ]);

  expect(await cli.exited).toBe(0);
  expect(open(dir).messages.said("1561", 1)).toMatchObject([
    {
      key: matching(/^hex:[0-9a-f-]{36}$/u),
      from: "hex",
      author: "prompt",
      body: "look at the build",
      meta: { user: "hex General" },
    },
  ]);
});

test("hex deliver reaches a thread by its session's id or the 8 characters hex running prints, and refuses a session that works for no thread", async () => {
  const claude = join(dir, "claude");
  mkdirSync(join(claude, "sessions"), { recursive: true });

  const session = (
    sessionId: string,
    name: string,
    thread?: string,
    store = dir,
    jobId = `job${sessionId.slice(0, 5)}`,
  ) => {
    const job = thread === undefined ? "" : thread && (jobId || sessionId.slice(0, 8));
    writeFileSync(
      join(claude, "sessions", `${sessionId}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId,
        name,
        status: "busy",
        ...(job && { kind: "bg" }),
        ...(job && jobId && { jobId }),
      }),
    );

    if (!job) {
      return;
    }

    const settings = join(claude, `${thread}.json`);
    writeFileSync(
      settings,
      JSON.stringify({
        env: { HEX_CHANNEL: "plugin:telegram@hex", HEX_THREAD: thread, HEX_STORE: store },
      }),
    );
    mkdirSync(join(claude, "jobs", job), { recursive: true });
    writeFileSync(
      join(claude, "jobs", job, "state.json"),
      JSON.stringify({
        sessionId,
        respawnFlags: ["--channels", "plugin:telegram@hex", "--settings", settings],
      }),
    );
  };

  session("4c1d9f07-82da-46a4-8a80-802ddb4fbec5", "hex/garden-plugins2");
  session("4c1d9f07-ffff-4000-8000-000000000000", "hex/garden-import2");
  session("d4e6f9c5-0000-4000-8000-000000000000", "hex notes", "-100:4803");
  session("b2e4d7a3-0000-4000-8000-000000000000", "Watchdog", "-100:4801");
  session("c3d5e8b4-0000-4000-8000-000000000000", "Video clips", "-100:103", dir, "");
  session(
    "e5f7a0d6-0000-4000-8000-000000000000",
    "another hex",
    "-100:4716",
    join(dir, "elsewhere"),
  );
  await open(dir).threads.keep("telegram", {
    "-100:4801": { name: "Watchdog" },
    "-100:4802": { name: "website", session: "a1f3c6d2-0000-4000-8000-000000000000" },
  });
  await open(dir).turns.turned("d4365c34-312f-4a52-9704-36fcf657e5b9", true);
  await open(dir).threads.keep("telegram", {
    "-100:7": { name: "General", session: "b7e2c5a9-11f6-4698-9b9e-c80b1d5aebdf" },
    "-100:4803": { name: "hex notes" },
    "-100:103": { name: "Video clips" },
  });

  const deliver = async (to: string) => {
    const cli = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "cli.ts"),
        dir,
        "deliver",
        "hex",
        "--to",
        to,
        "the theme class names",
      ],
      { stderr: "pipe", env: { ...Bun.env, CLAUDE_CONFIG_DIR: claude } },
    );

    return { code: await cli.exited, said: await new Response(cli.stderr).text() };
  };

  for (const to of [
    "b7e2c5a9",
    "B7E2C5A9",
    "b7e2c5a9-11f6-4698-9b9e-c80b1d5aebdf",
    "d4e6f9c5",
    "c3d5e8b4",
  ]) {
    expect(await deliver(to)).toEqual({ code: 0, said: "" });
  }

  for (const to of ["b2e4d7a3", "a1f3c6d2"]) {
    expect(await deliver(to)).toEqual({
      code: 0,
      said: containing("is closed, so this waits until it opens"),
    });
  }

  expect(await deliver("e5f7a0d6")).toEqual({
    code: 1,
    said: containing(
      "e5f7a0d6-0000-4000-8000-000000000000 (another hex) is a session no thread holds",
    ),
  });
  expect(await deliver("d4365c34-312f-4a52-9704-36fcf657e5b9")).toEqual({
    code: 1,
    said: containing("no thread or running session is d4365c34-312f-4a52-9704-36fcf657e5b9"),
  });
  expect(await deliver("4c1d9f07-82")).toEqual({
    code: 1,
    said: containing(
      '4c1d9f07-82da-46a4-8a80-802ddb4fbec5 (hex/garden-plugins2) is a session no thread holds, so it would never take this message: message it with Claude Code\'s SendMessage to "hex/garden-plugins2"',
    ),
  });
  expect(await deliver("4c1d9f07")).toEqual({
    code: 1,
    said: containing(
      "4c1d9f07 starts more than one session's id: 4c1d9f07-82da-46a4-8a80-802ddb4fbec5 (hex/garden-plugins2), 4c1d9f07-ffff-4000-8000-000000000000 (hex/garden-import2)",
    ),
  });
  expect(await deliver("d4365c34")).toEqual({
    code: 1,
    said: containing("no thread or running session is d4365c34"),
  });
  expect(
    open(dir)
      .messages.since()
      .map((row) => row.to),
  ).toEqual(["-100:7", "-100:7", "-100:7", "-100:4803", "-100:103", "-100:4801", "-100:4802"]);
});

test("hex deliver finds a thread by its name too, keeps one for a closed thread till it opens, and refuses an address no thread has", async () => {
  await open(dir).threads.keep("t3", {
    "0f3a9c1e-0000-4000-8000-000000000000": { name: "Old T3 thread" },
  });
  await open(dir).threads.keep("t3", {
    "5b0e7d2a-0000-4000-8000-000000000000": { name: "t3: notes" },
  });
  await open(dir).threads.keep("telegram", { "-100:1": { name: "hex" } });
  await open(dir).threads.keep("telegram", {
    "-100:4801": { name: "Watchdog" },
    "-100:2": { name: "hex" },
    watchdog: { name: "Old notes" },
  });

  const deliver = async (to: string) => {
    const cli = Bun.spawn(
      ["bun", join(import.meta.dir, "cli.ts"), dir, "deliver", "hex", "--to", to, "hello"],
      { stderr: "pipe", env: { ...Bun.env, CLAUDE_CONFIG_DIR: join(dir, "claude") } },
    );

    return { code: await cli.exited, said: await new Response(cli.stderr).text() };
  };

  for (const to of ["Watchdog", "HEX", "T3: notes"]) {
    expect(await deliver(to)).toEqual({ code: 0, said: "" });
  }

  expect(await deliver("0F3A9C1E-0000-4000-8000-000000000000")).toEqual({
    code: 0,
    said: containing(
      "the thread 0f3a9c1e-0000-4000-8000-000000000000 is closed, so this waits until it opens again",
    ),
  });
  expect(await deliver("Self heal")).toEqual({
    code: 1,
    said: containing('no thread is "Self heal" (hex threads lists them)'),
  });
  expect(await deliver("1d056dde-a8e8-479f-842c-e9d7eb6e6e5d")).toEqual({
    code: 1,
    said: containing("no thread or running session is 1d056dde-a8e8-479f-842c-e9d7eb6e6e5d"),
  });
  expect(
    open(dir)
      .messages.since()
      .map((row) => row.to),
  ).toEqual([
    "-100:4801",
    "-100:2",
    "5b0e7d2a-0000-4000-8000-000000000000",
    "0f3a9c1e-0000-4000-8000-000000000000",
  ]);
});

const ask = {
  ...message,
  key: "telegram:-100:50",
  body: "Fix the login page. Also the logo looks blurry on retina.",
};

test("a task from before titles gets its first words as its title", async () => {
  const store = new Store(dir);
  await store.messages.deliver({ ...ask, body: "Fix the login page.\nIt 500s on submit." });
  await store.tasks.create({ title: "x", message: ask.key, owner: "-100:7" });
  store.db.run("update tasks set title = null");
  store.db.run("drop index said; drop table profiles");
  store.db.run("alter table messages drop column author");
  store.db.run("drop table seen");
  store.db.run(
    "drop table pins; create table shown (session text primary key, digest text not null); drop table threads; create table threads (app text not null, thread text not null, name text not null, primary key (app, thread))",
  );
  store.db.run("drop table turns; drop table relays");
  store.db.run("pragma user_version = 10");
  store.db.close();
  expect(new Store(dir).tasks.get("t-1")?.title).toBe("Fix the login page. It 500s on submit.");
});

test("a task has a clean title of its own, and its words still come from the message", async () => {
  const store = new Store(dir);
  await store.messages.deliver(ask);

  const task = await store.tasks.create({
    title: "  Sharpen the logo on retina ",
    message: ask.key,
    owner: "-100:7",
  });

  expect(task).toMatchObject({
    title: "Sharpen the logo on retina",
    words: [{ text: ask.body }],
  });
  expect(() => store.tasks.create({ title: " ", message: ask.key, owner: "-100:7" })).toThrow(
    "needs a title",
  );
  expect((await store.tasks.edit(task.id, { title: "Make the logo crisp" })).title).toBe(
    "Make the logo crisp",
  );
  expect(() => store.tasks.edit(task.id, { title: " \n" })).toThrow("can't be empty");
  expect((await store.tasks.edit(task.id, { title: "Make the logo\n  crisp " })).title).toBe(
    "Make the logo crisp",
  );
  expect((await store.tasks.edit(task.id, { status: "done", proof: "abc123" })).title).toBe(
    "Make the logo crisp",
  );
  expect((await store.tasks.edit(task.id, { status: "open" })).proof).toBeUndefined();
});

test("a task holds the owner's words as they sent them, quoted whole or in part, and never retyped", async () => {
  const store = new Store(dir);
  await store.messages.deliver(ask);
  const whole = store.tasks.create({ title: "Fix it", message: ask.key, owner: "-100:7" });
  expect(await whole).toMatchObject({
    id: "t-1",
    owner: "-100:7",
    status: "open",
    words: [{ message: ask.key, text: ask.body, who: "owner" }],
  });
  expect(
    (
      await store.tasks.create({
        title: "Fix it",
        message: ask.key,
        quote: "the logo looks blurry on retina",
        owner: "-100:7",
      })
    ).words[0]?.text,
  ).toBe("the logo looks blurry on retina");
  // oxlint-disable-next-line typescript/await-thenable typescript/no-confusing-void-expression -- bun's rejects matchers return a promise that its types call void
  await expect(
    store.tasks.create({
      title: "Fix it",
      message: ask.key,
      quote: "the logo is blurry",
      owner: "-100:7",
    }),
  ).rejects.toThrow("isn't in telegram:-100:50 as written");
  // oxlint-disable-next-line typescript/await-thenable typescript/no-confusing-void-expression -- bun's rejects matchers return a promise that its types call void
  await expect(
    store.tasks.create({ title: "Fix it", message: "telegram:-100:404", owner: "-100:7" }),
  ).rejects.toThrow("no message");
  expect(() =>
    store.db.run(
      "insert into words (task, message, text) values (1, 'telegram:-100:50', 'fix it all')",
    ),
  ).toThrow("character for character");
  expect(() => store.db.run("update words set text = 'Fix it' where task = 1")).toThrow(
    "only ever cut down",
  );
  expect(() => store.db.run("update messages set body = 'Fix it'")).toThrow("keeps its words");
  // oxlint-disable-next-line typescript/await-thenable typescript/no-confusing-void-expression -- bun's rejects matchers return a promise that its types call void
  await expect(
    store.tasks.create({ title: "Fix it", message: ask.key, quote: "", owner: "-100:7" }),
  ).rejects.toThrow("needs words");
  store.db.run(
    "insert or replace into messages (key, \"to\", \"from\", author, body, at) values ('telegram:-100:50', '-100:7', 'telegram', 'owner', 'Fix it', '2026-10-19T00:00:00.000Z')",
  );
  expect(store.messages.get(ask.key)?.body).toBe(ask.body);
  expect(() =>
    store.db.run(
      "insert or replace into words (rowid, task, message, text) values (1, 1, 'telegram:-100:50', 'Fix the login page.')",
    ),
  ).toThrow("never rewritten");
  expect(store.tasks.list().map((task) => task.id)).toEqual(["t-2", "t-1"]);
  expect(store.tasks.list({ owner: "-100:7", status: ["open"], words: false })).toEqual(
    store.tasks
      .list({ owner: "-100:7", status: ["open"] })
      .map(({ words: _words, ...task }) => task),
  );
  expect(store.tasks.get("t-1")?.words[0]?.text).toBe(ask.body);
});

test("a task can be cut down to the words that ask, still quoted as written", async () => {
  const store = new Store(dir);
  await store.messages.deliver(ask);
  await store.tasks.create({ title: "Fix it", message: ask.key, owner: "-100:7" });
  expect(
    (await store.tasks.requote("t-1", ask.key, "Fix the login page.")).words.map(
      (words) => words.text,
    ),
  ).toEqual(["Fix the login page."]);
  // oxlint-disable-next-line typescript/await-thenable typescript/no-confusing-void-expression -- bun's rejects matchers return a promise that its types call void
  await expect(store.tasks.requote("t-1", ask.key, "fix it all")).rejects.toThrow(
    "holds no whole message",
  );
  expect(
    (await store.tasks.requote("t-1", ask.key, "Fix the login page.")).words.map(
      (words) => words.text,
    ),
  ).toEqual(["Fix the login page."]);
  expect(store.tasks.get("t-1")?.words.map((words) => words.text)).toEqual(["Fix the login page."]);
  expect(() => store.db.run("update words set text = 'Fix it all' where task = 1")).toThrow(
    "only ever cut down",
  );
  expect(() => store.db.run("delete from words")).toThrow("never taken away");
});

test("cutting a whole message down keeps the other asks quoted from it", async () => {
  const store = new Store(dir);
  await store.messages.deliver(ask);
  await store.tasks.create({ title: "Fix it", message: ask.key, owner: "-100:7" });
  await store.tasks.addWords("t-1", ask.key, "the logo looks blurry on retina");
  await store.tasks.requote("t-1", ask.key, "Fix the login page.");
  expect(store.tasks.get("t-1")?.words.map((words) => words.text)).toEqual([
    "Fix the login page.",
    "the logo looks blurry on retina",
  ]);
});

test("a task already holding the ask folds its whole copy of the message into it", async () => {
  const store = new Store(dir);
  await store.messages.deliver(ask);
  await store.tasks.create({ title: "Fix it", message: ask.key, owner: "-100:7" });
  await store.tasks.addWords("t-1", ask.key, "Fix the login page.");
  expect(
    (await store.tasks.requote("t-1", ask.key, "Fix the login page.")).words.map(
      (words) => words.text,
    ),
  ).toEqual(["Fix the login page."]);
  expect(
    (await store.tasks.requote("t-1", ask.key, "Fix the login page.")).words.map(
      (words) => words.text,
    ),
  ).toEqual(["Fix the login page."]);
  expect(() => store.db.run("update words set rowid = 99 where task = 1")).toThrow(
    "only ever cut down",
  );
});

test("cutting takes the whole message and leaves quotes picked on purpose alone", async () => {
  const store = new Store(dir);
  await store.messages.deliver(ask);
  await store.tasks.create({ title: "Fix it", message: ask.key, owner: "-100:7" });
  await store.messages.deliver({ ...ask, key: "telegram:-100:51", body: "Also the docs." });
  await store.tasks.addWords("t-1", "telegram:-100:51");
  await store.tasks.addWords("t-1", ask.key, "Fix the login page.");
  await store.tasks.requote("t-1", ask.key, "Fix the login page.");
  expect(store.tasks.get("t-1")?.words.map((words) => words.text)).toEqual([
    "Fix the login page.",
    "Also the docs.",
  ]);
  await store.tasks.addWords("t-1", ask.key, "the logo looks blurry on retina");
  // oxlint-disable-next-line typescript/await-thenable typescript/no-confusing-void-expression -- bun's rejects matchers return a promise that its types call void
  await expect(store.tasks.requote("t-1", ask.key, "blurry")).rejects.toThrow(
    "holds no whole message",
  );
  expect(store.tasks.get("t-1")?.words.map((words) => words.text)).toEqual([
    "Fix the login page.",
    "Also the docs.",
    "the logo looks blurry on retina",
  ]);
  expect(() => store.db.run("delete from words where text = 'Also the docs.'")).toThrow(
    "never taken away",
  );
});

test("a task from a T3 Code prompt holds what was asked, not T3's instructions around it", async () => {
  const store = new Store(dir);

  const body =
    "<t3_code_instructions>\n## T3 Code interaction mode: Default\n</t3_code_instructions>\n\n<user_request>\nship it\n</user_request>\n\n<runtime_info>opus</runtime_info>";

  await store.messages.deliver({
    key: "t3:1",
    to: "thread-1",
    from: "t3",
    author: "owner",
    body,
    meta: { ts: "2026-10-20T00:00:00.000Z" },
  });
  expect(
    (await store.tasks.create({ title: "Fix it", message: "t3:1", owner: "thread-1" })).words[0]
      ?.text,
  ).toBe("ship it");
  // oxlint-disable-next-line typescript/await-thenable typescript/no-confusing-void-expression -- bun's rejects matchers return a promise that its types call void
  await expect(store.tasks.addWords("t-1", "t3:1", body)).rejects.toThrow("isn't in");
  expect((await store.tasks.addWords("t-1", "t3:1")).words.map((words) => words.text)).toEqual([
    "ship it",
  ]);
  expect(
    (await store.tasks.requote("t-1", "t3:1", "ship")).words.map((words) => words.text),
  ).toEqual(["ship"]);
  expect(
    (await store.tasks.requote("t-1", "t3:1", "ship")).words.map((words) => words.text),
  ).toEqual(["ship"]);
  const shot = `${body}\n\n[image: /inbox/1.png]`;
  await store.messages.deliver({
    key: "t3:2",
    to: "thread-1",
    from: "t3",
    author: "owner",
    body: shot,
    meta: { ts: "2026-10-20T00:00:00.000Z" },
  });
  expect(
    (await store.tasks.create({ title: "Fix it", message: "t3:2", owner: "thread-1" })).words.map(
      (words) => words.text,
    ),
  ).toEqual(["ship it", "[image: /inbox/1.png]"]);
  expect(
    (await store.tasks.requote("t-2", "t3:2", "ship")).words.map((words) => words.text),
  ).toEqual(["ship", "[image: /inbox/1.png]"]);
  await store.tasks.addWords("t-2", "t3:2");
  expect(store.tasks.get("t-2")?.words.map((words) => words.text)).toEqual([
    "ship",
    "[image: /inbox/1.png]",
  ]);

  const attached =
    "<t3_code_instructions>\nx\n</t3_code_instructions>\n\n<user_request>\nship it\n</user_request>\n\n[image: /inbox/2.png]";

  await store.messages.deliver({
    key: "t3:5",
    to: "thread-1",
    from: "t3",
    author: "owner",
    body: attached,
    meta: { ts: "2026-10-20T00:00:00.000Z" },
  });
  expect(
    (await store.tasks.create({ title: "Fix it", message: "t3:5", owner: "thread-1" })).words.map(
      (words) => words.text,
    ),
  ).toEqual(["ship it", "[image: /inbox/2.png]"]);

  const tagged =
    "<user_request>\nmake the header say\n<title>Hello</title>\n</user_request>\n\n<runtime_info>opus</runtime_info>";

  await store.messages.deliver({
    key: "t3:4",
    to: "thread-1",
    from: "t3",
    author: "owner",
    body: tagged,
    meta: { ts: "2026-10-20T00:00:00.000Z" },
  });
  expect(
    (await store.tasks.create({ title: "Fix it", message: "t3:4", owner: "thread-1" })).words[0]
      ?.text,
  ).toBe("make the header say\n<title>Hello</title>");
  await store.messages.deliver({
    key: "t3:3",
    to: "thread-1",
    from: "t3",
    author: "owner",
    body: "and the docs\n\n<runtime_info>opus</runtime_info>",
    meta: { ts: "2026-10-20T00:00:00.000Z" },
  });
  expect(
    (await store.tasks.create({ title: "Fix it", message: "t3:3", owner: "thread-1" })).words[0]
      ?.text,
  ).toBe("and the docs");
  await store.messages.deliver({
    ...ask,
    key: "telegram:-100:51",
    body: "paste: <user_request>x</user_request>",
  });
  expect(
    (await store.tasks.create({ title: "Fix it", message: "telegram:-100:51", owner: "-100:7" }))
      .words[0]?.text,
  ).toBe("paste: <user_request>x</user_request>");
});

test("follow-ups are added after what was said first, and a repeat changes nothing", async () => {
  const store = new Store(dir);
  await store.messages.deliver(ask);
  await store.messages.deliver({
    ...message,
    key: "telegram:-100:51",
    body: "and make it work on mobile",
  });

  const task = await store.tasks.create({
    title: "Fix it",
    message: ask.key,
    quote: "Fix the login page.",
    owner: "-100:7",
  });

  await store.tasks.addWords(task.id, "telegram:-100:51");
  await store.tasks.addWords(task.id, "telegram:-100:51");
  expect(store.tasks.get(task.id)?.words.map((words) => words.text)).toEqual([
    "Fix the login page.",
    "and make it work on mobile",
  ]);
});

test("done needs a proof, and the states are the four a task has", async () => {
  const store = new Store(dir);
  await store.messages.deliver(ask);

  const { id } = await store.tasks.create({
    title: "Fix it",
    message: ask.key,
    owner: "-100:7",
    status: "idea",
  });

  // oxlint-disable-next-line typescript/await-thenable typescript/no-confusing-void-expression -- bun's rejects matchers return a promise that its types call void
  await expect(store.tasks.edit(id, { status: "done" })).rejects.toThrow();
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion anti-slop/require-safety-comment-for-type-assertion typescript/await-thenable typescript/no-confusing-void-expression -- a status outside the four, to show the store refuses it; bun's rejects matchers return a promise that its types call void
  await expect(store.tasks.edit(id, { status: "finished" as never })).rejects.toThrow();
  await store.tasks.edit(id, { project: "site", doneWhen: "it signs in" });
  expect(await store.tasks.edit(id, { owner: "-100:9", project: undefined })).toMatchObject({
    owner: "-100:9",
    project: "site",
    doneWhen: "it signs in",
  });
  expect(
    await store.tasks.edit(id, { status: "done", proof: "https://example.com/pr/1" }),
  ).toMatchObject({
    status: "done",
    proof: "https://example.com/pr/1",
  });
  expect(store.tasks.list({ status: ["open", "idea"] })).toEqual([]);
  expect(store.tasks.list({ status: ["done"] }).map((task) => task.id)).toEqual([id]);
});

test("a task keeps when it was closed: set when it ends, kept through later edits, cleared if it opens again", async () => {
  const store = new Store(dir);
  await store.messages.deliver(ask);
  const { id } = await store.tasks.create({ title: "Fix it", message: ask.key, owner: "-100:7" });

  expect(store.tasks.get(id)).toMatchObject({ id, status: "open" });
  expect(store.tasks.get(id)?.closed).toBeUndefined();

  const { closed } = await store.tasks.edit(id, {
    status: "done",
    proof: "https://example.com/pr/1",
  });

  expect(closed).toBeString();
  expect((await store.tasks.edit(id, { proof: "https://example.com/pr/2" })).closed).toBe(closed);
  expect((await store.tasks.edit(id, { status: "open" })).closed).toBeUndefined();

  const duplicate = await store.tasks.create({
    title: "Fix it",
    message: ask.key,
    quote: "Fix the login page.",
    owner: "-100:7",
  });

  expect(await store.tasks.merge(id, duplicate.id)).toMatchObject({ status: "open" });
  expect(store.tasks.get(duplicate.id)?.closed).toBeString();
});

test("a merge puts the duplicate's words after the task's own, drops it, and its follow-ups go where it went", async () => {
  const store = new Store(dir);
  await store.messages.deliver(ask);
  await store.messages.deliver({
    ...message,
    key: "telegram:-100:60",
    to: "-100:9",
    body: "the login page is broken",
  });
  await store.messages.deliver({
    ...message,
    key: "telegram:-100:61",
    to: "-100:9",
    body: "still broken btw",
  });

  const kept = await store.tasks.create({
    title: "Fix it",
    message: ask.key,
    quote: "Fix the login page.",
    owner: "-100:7",
  });

  const duplicate = await store.tasks.create({
    title: "Fix it",
    message: "telegram:-100:60",
    owner: "-100:9",
  });

  const merged = await store.tasks.merge(kept.id, duplicate.id);
  expect(merged.words.map((words) => words.text)).toEqual([
    "Fix the login page.",
    "the login page is broken",
  ]);
  expect(store.tasks.get(duplicate.id)).toMatchObject({ status: "dropped", mergedInto: kept.id });
  expect((await store.tasks.addWords(duplicate.id, "telegram:-100:61")).id).toBe(kept.id);
  expect(store.tasks.get(kept.id)?.words).toHaveLength(3);
  // oxlint-disable-next-line typescript/await-thenable typescript/no-confusing-void-expression -- bun's rejects matchers return a promise that its types call void
  await expect(store.tasks.edit(duplicate.id, { status: "open" })).rejects.toThrow();
  // oxlint-disable-next-line typescript/await-thenable typescript/no-confusing-void-expression -- bun's rejects matchers return a promise that its types call void
  await expect(store.tasks.merge(kept.id, duplicate.id)).rejects.toThrow("dropped");
  // oxlint-disable-next-line typescript/await-thenable typescript/no-confusing-void-expression -- bun's rejects matchers return a promise that its types call void
  await expect(store.tasks.merge(kept.id, kept.id)).rejects.toThrow("itself");
});

test("hex log reads every thread a name means, a delivery to that name asks for one by its id, and hex recall takes rg's -i", async () => {
  const store = open(dir);
  await store.threads.keep("telegram", { "629": { name: "DM" } });
  await store.threads.keep("discord", { "1560": { name: "DM" } });

  for (const [from, key, to, body] of [
    ["telegram", "telegram:629:1", "629", "on Telegram"],
    ["discord", "discord:1560:1", "1560", "on Discord"],
    ["telegram", "telegram:629:2", "629", "Telegram again"],
  ] as const) {
    await store.messages.deliver({ key, to, from, author: "owner", body });
    await Bun.sleep(5);
  }

  const hex = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), dir, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...Bun.env, MEMORY_DIR: join(dir, "memory"), CLAUDE_CONFIG_DIR: join(dir, "claude") },
    });

    return {
      code: await cli.exited,
      out: await new Response(cli.stdout).text(),
      err: await new Response(cli.stderr).text(),
    };
  };

  expect(said((await hex("log", "--", "dm")).out)).toEqual([
    "on Telegram",
    "on Discord",
    "Telegram again",
  ]);
  expect(said((await hex("log", "--last", "2", "--", "DM")).out)).toEqual([
    "on Discord",
    "Telegram again",
  ]);
  expect(said((await hex("log", "--", "telegram:629")).out)).toEqual([
    "on Telegram",
    "Telegram again",
  ]);
  expect(await hex("deliver", "hex", "--to", "DM", "hello")).toMatchObject({
    code: 1,
    err: containing(
      'more than one thread is named "DM", so send to one by its id: discord:1560, telegram:629',
    ),
  });
  expect(await hex("recall", "-i", "salty")).toEqual(await hex("recall", "salty"));
  expect(await hex("deliver", "hex", "--to", "telegram:629", "use", "rg", "-i")).toMatchObject({
    code: 2,
    err: "hex: -i is only for recall\n",
  });
});

test("each app's threads.json comes into hex.db once, as that app's open threads", () => {
  new Store(dir).db.close();
  const old = new Database(join(dir, "hex.db"));
  old.run(
    "drop table pins; create table shown (session text primary key, digest text not null); alter table seen drop column at; drop table threads; create table threads (app text not null, thread text not null, name text not null, primary key (app, thread))",
  );
  old.run("insert into threads values ('telegram', '-100:9', 'Errands')");
  old.run("drop table turns; drop table relays");
  old.run("pragma user_version = 16");
  old.close();
  mkdirSync(join(dir, "telegram"));
  writeFileSync(
    join(dir, "telegram", "threads.json"),
    JSON.stringify({
      "-100:7": { name: "Desk", session: "s-1", cwd: "/w", from: "s-0", launched: "abc" },
    }),
  );
  mkdirSync(join(dir, "discord"));
  writeFileSync(join(dir, "discord", "threads.json"), '{"broken');
  writeFileSync(join(dir, "threads.json"), JSON.stringify({ "7": { name: "Outside a hex" } }));
  expect(new Store(dir).threads.list()).toEqual(
    [
      {
        app: "telegram",
        thread: "-100:7",
        name: "Desk",
        session: "s-1",
        cwd: "/w",
        launched: "abc",
        fork: "s-0",
        open: true,
      },
      { app: "telegram", thread: "-100:9", name: "Errands", open: false },
      { app: basename(dir), thread: "7", name: "Outside a hex", open: true },
    ].toSorted((a, b) => a.app.localeCompare(b.app) || a.thread.localeCompare(b.thread)),
  );
  expect(
    ["telegram/threads.json", "threads.json"].map((file) => existsSync(join(dir, file))),
  ).toEqual([false, false]);
  expect(readFileSync(join(dir, "telegram", "threads.json.moved-to-hex.db"), "utf-8")).toContain(
    "Desk",
  );
});

test("a session that ended loses what it was shown, and log/'s turns headed t become T3's", () => {
  const store = new Store(dir);
  store.db.run(
    "create table files (name text primary key, body text not null); create table shown (session text primary key, digest text not null); alter table seen drop column at",
  );
  const shown = store.db.query("insert into seen (session, kind, record) values (?, ?, ?)");
  shown.run("ended", "tasks", "old");
  shown.run("live", "tasks", "now");
  shown.run("live", "rules", "{}");
  store.db
    .query('insert into messages (key, "to", "from", author, body, at) values (?, ?, ?, ?, ?, ?)')
    .run("t:past:abc:0", "abc", "t", "owner", "Quick test from T3", "2026-10-08T10:16:00.000Z");
  store.db.run("drop table turns; drop table relays");
  store.db.run("pragma user_version = 20");
  store.db.close();
  const after = new Store(dir);
  expect([
    after.seen.get("ended", "tasks"),
    after.seen.get("live", "tasks"),
    after.seen.get("live", "rules"),
  ]).toEqual(["", "now", "{}"]);
  expect(after.messages.get("t3:past:abc:0")).toMatchObject({ from: "t3", author: "owner" });
  expect(after.messages.get("t:past:abc:0")).toBeNull();
});

const SENT_WITH_A_QUESTION = [
  [10, "hex", "The new m?", "", "02:40:20"],
  [11, "hex", "(file: logo.png)", "A", "02:40:22"],
  [12, "hex", "(file: logo.png)", "B", "02:40:23"],
  [13, "owner", "yes", "", "02:41:00"],
  [14, "hex", "(file: logo.png)", "C", "02:41:05"],
  [20, "hex", "Ship it?", "D", "03:00:00"],
  [30, "hex", "Rename it?", "", "04:00:00"],
  [31, "hex", "(file: late.png)", "E", "04:05:00"],
] as const;

test("an older question gets the file messages hex sent right with it, and nothing it didn't", async () => {
  const store = new Store(dir);
  const thread = "-100:9";

  const sent = store.db.query(
    'insert into messages (key, "to", "from", author, body, meta, at) values (?, ?, ?, ?, ?, ?, ?)',
  );

  for (const [id, author, body, file, time] of SENT_WITH_A_QUESTION) {
    const meta = file === "" ? {} : { file: "logo.png", attachment_file_id: file };
    sent.run(
      `telegram:-100:${id}`,
      thread,
      "telegram",
      author,
      body,
      JSON.stringify(meta),
      `2026-11-12T${time}.000Z`,
    );
  }

  for (const [id, , text] of SENT_WITH_A_QUESTION.filter(([n]) => n % 10 === 0)) {
    await store.questions.ask({
      app: "telegram",
      thread,
      message: id,
      text,
      options: ["Yes", "No"],
    });
  }

  const attaching = appendOnlyMigrations.findIndex(
    ({ name }) => name === "attachOldQuestionsTheirFiles",
  );

  store.db.run(`pragma user_version = ${String(attaching)}`);
  store.db.close();

  const after = new Store(dir);

  expect([10, 20, 30].map((id) => after.questions.get("telegram", thread, id)?.attached)).toEqual([
    ["11", "12"],
    ["20"],
    undefined,
  ]);
});

test("each app's relays.jsonl comes into hex.db once, the newest run per pair of threads", () => {
  mkdirSync(join(dir, "discord"));

  const lines = [
    { at: "2026-10-21T10:00:00.000Z", from: "fix", thread: "thread-prims", run: "run-1" },
    { at: "2026-10-21T10:05:00.000Z", from: "fix", thread: "thread-codex", run: "run-2" },
    { at: "2026-10-21T10:10:00.000Z", from: "fix", thread: "thread-prims", run: "run-3" },
  ];

  writeFileSync(
    join(dir, "discord", "relays.jsonl"),
    [...lines.map((line) => JSON.stringify(line)), "not json", ""].join("\n"),
  );
  expect(new Store(dir).relays.list()).toEqual([
    { from: "discord:fix", thread: "thread-codex", run: "run-2", at: "2026-10-21T10:05:00.000Z" },
    { from: "discord:fix", thread: "thread-prims", run: "run-3", at: "2026-10-21T10:10:00.000Z" },
  ]);
  expect(existsSync(join(dir, "discord", "relays.jsonl"))).toBe(false);
  expect(existsSync(join(dir, "discord", "relays.jsonl.moved-to-hex.db"))).toBe(true);
});

test("a session's turns: one begins, ends, and the next begins again, an end from before its begin is old news, and one not heard from in 30 days goes", async () => {
  const store = new Store(dir);
  await store.turns.turned("s-1", true);
  expect(store.turns.get("s-1")).toEqual({ began: anyString(), handled: anyString() });
  await store.turns.turned("s-1", false);
  const { began = "", ended = "" } = store.turns.get("s-1");
  expect(began).not.toBe("");
  expect(ended >= began).toBe(true);
  await store.turns.turned("s-1", true, "2026-10-21T10:00:00.000Z");
  await store.turns.turned("s-1", false, "2026-10-21T09:59:59.000Z");
  expect(store.turns.get("s-1")).toEqual({
    began: "2026-10-21T10:00:00.000Z",
    handled: anyString(),
  });
  store.db.run(
    "update turns set began = '2026-01-01T00:00:00.000Z', ended = '2026-01-01T00:00:01.000Z'",
  );
  await store.turns.turned("s-2", true);
  expect(store.turns.get("s-1")).toEqual({});
  expect(store.turns.get("s-2")).toEqual({ began: anyString(), handled: anyString() });
});

test("a thread's sessions cut short mid-turn give back what they took since last handled, never hex's own words or what was typed in them; a turn that ended, answered, failed or handled by the hub, gives nothing back", async () => {
  const store = new Store(dir);

  const give = (key: string, from = "telegram", author: "owner" | "hex" = "owner") =>
    store.messages.deliver({ key: `${from}:${key}`, to: "7", from, author, body: key, meta: {} });

  await give("answered");
  await store.turns.turned("s-1", true, "2026-10-21T10:00:00.000Z");
  await store.messages.take("telegram:answered", "s-1");
  await store.turns.handled("s-1");
  await Bun.sleep(2);
  await give("open");
  await store.turns.turned("s-1", true);
  await store.messages.take("telegram:open", "s-1");
  await give("reply", "telegram", "hex");
  await store.messages.take("telegram:reply", "s-1");
  await store.messages.deliver(
    { key: "terminal:typed", to: "7", from: "terminal", author: "owner", body: "typed", meta: {} },
    "s-1",
  );
  await give("unsaved");
  await store.turns.turned("s-2", true, "2026-10-21T10:00:00.000Z");
  await store.messages.take("telegram:unsaved", "s-2");
  expect(store.turns.midTurn("7")).toBe(true);
  expect((await store.turns.cut("7")).given.toSorted()).toEqual([
    "telegram:open",
    "telegram:unsaved",
  ]);
  expect(store.messages.untaken("7").map((row) => row.key)).toEqual([
    "telegram:open",
    "telegram:unsaved",
  ]);
  expect(store.turns.get("s-1").ended).toBeDefined();
  expect(store.turns.midTurn("7")).toBe(false);
  expect((await store.turns.cut("7")).given).toEqual([]);
  await give("failed");
  await store.turns.turned("s-3", true, "2026-10-21T10:00:00.000Z");
  await store.messages.take("telegram:failed", "s-3");
  await store.turns.turned("s-3", false);
  await give("stopped");
  await store.turns.turned("s-4", true, "2026-10-21T10:00:00.000Z");
  await store.messages.take("telegram:stopped", "s-4");
  await store.turns.handled("s-4");
  await give("old");
  await store.messages.take("telegram:old", "s-0");
  expect((await store.turns.cut("7")).given).toEqual([]);
});

test("a session cut short after turns that ended with its background agents working gives back only what it took since the last of them, however often it is cut: nothing while it waits or in a turn an agent's report began, and a turn's own messages", async () => {
  const store = new Store(dir);

  const turn = async (key: string) => {
    await store.messages.deliver({
      key: `telegram:${key}`,
      to: "7",
      from: "telegram",
      author: "owner",
      body: key,
      meta: {},
    });
    await store.turns.turned("s-1", true);
    await store.messages.take(`telegram:${key}`, "s-1");
    await Bun.sleep(2);
  };

  const waitOnAgents = async () => {
    await store.turns.turned("s-1", false);
    await store.turns.waitsOnAgents("s-1");
    await Bun.sleep(2);
  };

  await turn("start the agents");
  await waitOnAgents();
  await turn("a question meanwhile");
  await waitOnAgents();
  expect(store.turns.midTurn("7")).toBe(true);
  expect(await store.turns.cut("7", "s-1")).toEqual({ given: [], waited: true });
  expect(store.turns.midTurn("7")).toBe(false);
  expect(await store.turns.cut("7", "s-1")).toEqual({ given: [], waited: false });

  await turn("the hub's line");

  expect(await store.turns.cut("7", "s-1")).toEqual({
    given: ["telegram:the hub's line"],
    waited: false,
  });

  await turn("the hub's line");
  await store.turns.handled("s-1");
  await turn("start more agents");
  await waitOnAgents();
  await store.turns.turned("s-1", true);
  expect(await store.turns.cut("7", "s-1")).toEqual({ given: [], waited: true });

  await turn("and more");
  await waitOnAgents();
  await turn("cut off in this turn");

  expect(await store.turns.cut("7", "s-1")).toEqual({
    given: ["telegram:cut off in this turn"],
    waited: true,
  });

  await turn("cut off in this turn");

  expect(await store.turns.cut("7", "s-1")).toEqual({
    given: ["telegram:cut off in this turn"],
    waited: false,
  });

  expect(store.messages.untaken("7").map((row) => row.key)).toEqual([
    "telegram:cut off in this turn",
  ]);
});

test("a session that only posted in a thread, as General does opening a topic, isn't one of its sessions: cutting the thread leaves that session's turn and what it took alone", async () => {
  const store = new Store(dir);
  await store.messages.deliver({
    key: "telegram:ask",
    to: "general",
    from: "telegram",
    author: "owner",
    body: "make a topic",
    meta: {},
  });
  await store.turns.turned("general-1", true, "2026-10-21T10:00:00.000Z");
  await store.messages.take("telegram:ask", "general-1");
  await store.messages.deliver(
    {
      key: "telegram:opened",
      to: "topic",
      from: "telegram",
      author: "hex",
      body: "this topic is its home",
      meta: {},
    },
    "general-1",
  );
  expect(store.turns.midTurn("topic")).toBe(false);
  expect((await store.turns.cut("topic")).given).toEqual([]);
  expect(store.messages.untaken("general")).toEqual([]);
  expect(store.turns.midTurn("general")).toBe(true);
});

test("a thread keeps its row after it closes, and takes a new name when renamed", async () => {
  const store = new Store(dir);
  await store.threads.keep("telegram", {
    "-100:7": { name: "pricehub", session: "s-1", cwd: "/w" },
    "-100:8": { name: "website" },
  });
  await store.threads.keep("telegram", {
    "-100:7": {
      name: "pricehub and stage",
      session: "s-2",
      model: "opus",
      link: "https://t.me/c/100/7",
    },
  });
  await store.threads.keep("discord", { "1561": { name: "Repair" } });
  expect(store.threads.list()).toEqual([
    { app: "discord", thread: "1561", name: "Repair", open: true },
    {
      app: "telegram",
      thread: "-100:7",
      name: "pricehub and stage",
      session: "s-2",
      model: "opus",
      link: "https://t.me/c/100/7",
      open: true,
    },
    { app: "telegram", thread: "-100:8", name: "website", open: false },
  ]);
  expect(
    store.threads.list({ app: "telegram", open: true }).map((thread) => thread.thread),
  ).toEqual(["-100:7"]);
});

test("a thread's key names it in every app, and its id is <app>:<key>", async () => {
  const store = new Store(dir);
  await store.threads.keep("discord", { "1561": { name: "Repair" }, "1562": { name: "Stage" } });
  await store.threads.keep("telegram", { "-100:7": { name: "Shop" } });
  await store.threads.keep("buzz", { "1561": { name: "Shop" }, abc: { name: "Buzz shop" } });
  expect(store.threads.list({ app: "buzz" }).map(({ thread }) => thread)).toEqual(["1561", "abc"]);
  await store.threads.keep("discord", { "1561": { name: "Repair" }, "1562": { name: "Stage" } });
  expect(store.threads.names()).toEqual({
    "1561": "Repair",
    "1562": "Stage",
    "-100:7": "Shop",
    abc: "Buzz shop",
  });
  expect(store.threads.ids()).toEqual({
    "1561": "discord:1561",
    "1562": "discord:1562",
    "-100:7": "telegram:-100:7",
    abc: "buzz:abc",
  });
  expect(
    ["discord:1561", "1561", "telegram:-100:7", "-100:7", "slack:1", "abc", "constructor"].map(
      (id) => store.threads.key(id),
    ),
  ).toEqual(["1561", "1561", "-100:7", "-100:7", "slack:1", "abc", "constructor"]);
  expect(["constructor" in store.threads.names(), "constructor" in store.threads.ids()]).toEqual([
    false,
    false,
  ]);

  const cli = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), dir, "threads", "--json"], {
    stdout: "pipe",
  });

  expect(
    z
      .array(z.object({ id: z.string() }))
      .parse(JSON.parse(await new Response(cli.stdout).text()))
      .map(({ id }) => id),
  ).toEqual(["buzz:abc", "discord:1561", "discord:1562", "telegram:-100:7"]);
});

test("hex thread files a thread under the project it's part of, kept as its app updates it, until it's filed under its own again", async () => {
  const store = open(dir);
  const telegram = { "-100:7": { name: "Chats" }, "-100:8": { name: "Android" } };
  await store.threads.keep("telegram", telegram);

  const hex = async (...args: string[]) =>
    await Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), dir, ...args], { stderr: "pipe" })
      .exited;

  const projects = () => store.threads.list().map(({ name, project }) => [name, project]);
  expect(await hex("thread", "Chats", "--project", "keyboard")).toBe(0);
  await store.threads.keep("telegram", { ...telegram, "-100:7": { name: "Chats", session: "s1" } });
  expect(projects()).toEqual([
    ["Chats", "keyboard"],
    ["Android", undefined],
  ]);
  expect(await hex("thread", "Chats", "--project", "")).toBe(0);
  expect(projects()).toEqual([
    ["Chats", undefined],
    ["Android", undefined],
  ]);
  expect(await hex("thread", "Nowhere", "--project", "keyboard")).not.toBe(0);
});

test("bin/hex hands hex's cli every command its usage lists", async () => {
  const usage = await new Response(
    Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), dir], { stderr: "pipe" }).stderr,
  ).text();

  const commands = [
    ...new Set([...usage.matchAll(/^ {2}hex (\w+)/gmu)].flatMap(([, command]) => command ?? [])),
  ];

  const handed = /^ {2}([a-z|]+)\)\n {4}export MEMORY_DIR/mu
    .exec(readFileSync(join(import.meta.dir, "../bin/hex"), "utf-8"))?.[1]
    ?.split("|");

  expect(commands).toContain("thread");
  expect(commands.filter((command) => handed?.includes(command) !== true)).toEqual([]);
});

test("a key two apps had before keys were global keeps its open, then newest, row", () => {
  const store = new Store(dir);
  store.db.run("drop index threads_key; pragma user_version = 23");
  store.db.run(
    "insert into threads (app, thread, name, open) values ('buzz', 'k', 'old', 0), ('discord', 'k', 'live', 1), ('t3', 'k', 'closed too', 0), ('buzz', 'j', 'first', 0), ('t3', 'j', 'later', 0)",
  );
  store.db.close();
  expect(new Store(dir).threads.list().map(({ app, thread }) => `${app}:${thread}`)).toEqual([
    "discord:k",
    "t3:j",
  ]);
});

test("what a session was shown is kept per kind until its context loses it, and a tasks record unchanged for 2 days goes, a rules one after a week, since a session's end leaves it behind and one still there just gets its whole list again", async () => {
  const store = new Store(dir);
  expect(store.seen.get("session-a", "tasks")).toBe("");
  await store.seen.show("session-a", "tasks", "one");
  await store.seen.show("session-a", "rules", "{}");
  await store.seen.show("session-b", "tasks", "two");
  expect(store.seen.get("session-a", "tasks")).toBe("one");
  await store.seen.unshow("session-a", "tasks");
  expect([
    store.seen.get("session-a", "tasks"),
    store.seen.get("session-a", "rules"),
    store.seen.get("session-b", "tasks"),
  ]).toEqual(["", "{}", "two"]);
  await store.seen.show(
    "session-c",
    "tasks",
    "three",
    new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
  );
  expect([
    store.seen.get("session-a", "rules"),
    store.seen.get("session-b", "tasks"),
    store.seen.get("session-c", "tasks"),
  ]).toEqual(["{}", "", "three"]);
  await store.seen.show("session-a", "rules 2", "{}");
  await store.seen.show(
    "session-d",
    "rules",
    "{}",
    new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString(),
  );
  expect([
    store.seen.get("session-a", "rules"),
    store.seen.get("session-a", "rules 2"),
    store.seen.get("session-d", "rules"),
  ]).toEqual(["", "", "{}"]);
});

test("hex task makes a task from a message by its key, and the owner is the thread asking", async () => {
  await open(dir).messages.deliver(ask);

  const hex = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), dir, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HEX_THREAD: "chat:3" },
    });

    return {
      code: await cli.exited,
      out: await new Response(cli.stdout).text(),
      err: await new Response(cli.stderr).text(),
    };
  };

  expect(await hex("task", "new", ask.key, "--done-when", "it signs in")).toMatchObject({
    code: 1,
    err: containing("needs a title"),
  });
  expect(
    await hex(
      "task",
      "new",
      ask.key,
      "--title",
      "Fix the login page",
      "--quote",
      "Fix the login page.",
      "--done-when",
      "it signs in",
    ),
  ).toMatchObject({ code: 0 });
  expect(open(dir).tasks.get("t-1")).toMatchObject({
    title: "Fix the login page",
    owner: "chat:3",
    doneWhen: "it signs in",
    words: [{ text: "Fix the login page." }],
  });
  expect((await hex("tasks")).out).toContain("t-1 (open, chat:3): Fix the login page\n");
  expect(await hex("task", "edit", "t-1", "--title", "Make sign-in work")).toMatchObject({
    code: 0,
    out: containing(": Make sign-in work\n"),
  });
  expect(await hex("task", "done", "t-1")).toMatchObject({
    code: 1,
    err: containing("--proof"),
  });
  expect(await hex("task", "done", "t-1", "--proof", "shipped", "in", "abc123")).toMatchObject({
    code: 1,
    err: containing("\"in\" isn't a flag's value"),
  });
  expect((await hex("tasks", "--status", "open")).out).toBe((await hex("tasks")).out);
  expect(await hex("task", "new", ask.key, "--title", "Fix", "the", "login")).toMatchObject({
    code: 1,
    err: containing("\"the\" isn't a flag's value"),
  });
  expect(await hex("task", "edit", "t-1", "--title", "Make", "it", "work")).toMatchObject({
    code: 1,
    err: containing('"it" isn\'t'),
  });
  expect(
    await hex("task", "new", ask.key, "--title", "Fix login", "--quote", "fix login"),
  ).toMatchObject({ code: 1, err: containing("as written") });
  expect((await hex("message", ask.key)).out).toBe(`${ask.body}\n`);
});

test("hex pins lists the asking thread's pinned post, or every thread's with --all, as text or JSON", async () => {
  const store = open(dir);
  await store.pins.pinned({
    app: "telegram",
    thread: "chat:3",
    message: 9,
    text: "Site: example.com\n\n🔴 **Blocked on you**",
    note: "Site: example.com",
  });
  await store.pins.pinned({
    app: "discord",
    thread: "1561",
    message: "1562",
    text: "Status: by hand",
    note: "Status: by hand",
  });

  const hex = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), dir, "pins", ...args], {
      stdout: "pipe",
      env: { ...process.env, HEX_THREAD: "chat:3", HEX_MAIN: "" },
    });

    return (await new Response(cli.stdout).text()).trim();
  };

  expect(await hex()).toBe("telegram · chat:3 · message 9 · Site: example.com");
  expect((await hex("--all")).split("\n")).toEqual([
    "discord · 1561 · message 1562 · Status: by hand",
    "telegram · chat:3 · message 9 · Site: example.com",
  ]);
  expect(JSON.parse(await hex("--thread", "1561", "--json"))).toEqual([
    {
      app: "discord",
      thread: "1561",
      message: "1562",
      text: "Status: by hand",
      note: "Status: by hand",
      at: anyString(),
      threadId: "discord:1561",
    },
  ]);
  await open(dir).threads.keep("discord", { "1561": { name: "Repair" } });
  expect(await hex("--thread", "discord:1561", "--json")).toBe(
    await hex("--thread", "1561", "--json"),
  );
});

test("a question keeps its first answer, a poll's vote replaces the one before, and taking one back says whether there was one", async () => {
  const store = new Store(dir);

  const question = {
    app: "telegram",
    thread: "-100:7",
    message: 41,
    text: "Deploy now?",
    options: ["Deploy", "Wait"],
  };

  await store.questions.ask(question);
  expect(await store.questions.answered("telegram", "-100:7", 41, "Wait", "telegram")).toBe(true);
  expect(await store.questions.answered("telegram", "-100:7", 41, "Deploy", "app")).toBe(false);
  expect(store.questions.get("telegram", "-100:7", 41)?.answer).toMatchObject({
    label: "Wait",
    via: "telegram",
  });
  expect(await store.questions.answered("telegram", "-100:7", 41, "Deploy", "telegram", true)).toBe(
    true,
  );
  expect(store.questions.get("telegram", "-100:7", 41)?.answer).toMatchObject({ label: "Deploy" });
  expect(await store.questions.reopened("telegram", "-100:7", 41)).toBe(true);
  expect(await store.questions.reopened("telegram", "-100:7", 41)).toBe(false);
  expect(await store.questions.answered("telegram", "-100:7", 99, "Wait", "telegram")).toBe(false);
});

test("an answer and the message that wakes its thread with it land together or not at all", async () => {
  const store = new Store(dir);
  await store.questions.ask({
    app: "telegram",
    thread: "-100:7",
    message: 41,
    text: "Deploy now?",
    options: ["Deploy", "Wait"],
  });

  const wake = {
    key: "telegram:tap:1",
    to: "-100:7",
    from: "telegram",
    author: "owner",
    body: "Wait",
  } satisfies NewRow;

  // oxlint-disable-next-line typescript/await-thenable typescript/no-confusing-void-expression -- bun's rejects matchers return a promise that its types call void
  await expect(
    store.write((tx) => {
      tx.questions.answered("telegram", "-100:7", 41, "Wait", "telegram");
      throw new Error("killed before the wake was kept");
    }),
  ).rejects.toThrow("killed");
  expect(store.questions.get("telegram", "-100:7", 41)).toMatchObject({ message: 41 });
  expect(store.questions.get("telegram", "-100:7", 41)?.answer).toBeUndefined();
  expect(
    await store.write(
      (tx) =>
        tx.questions.answered("telegram", "-100:7", 41, "Wait", "telegram") &&
        tx.messages.deliver(wake),
    ),
  ).toBe(true);
  expect(
    await store.write(
      (tx) =>
        tx.questions.answered("telegram", "-100:7", 41, "Deploy", "telegram") &&
        tx.messages.deliver({ ...wake, key: "telegram:tap:2", body: "Deploy" }),
    ),
  ).toBe(false);
  expect(store.messages.get("telegram:tap:2")).toBeNull();
});

test("messages kept under a sender's name get one of hex's five authors, and keep the name in meta.user", () => {
  const store = new Store(dir);
  store.db.run(
    "drop table pins; create table shown (session text primary key, digest text not null); alter table seen drop column at; drop table threads; create table threads (app text not null, thread text not null, name text not null, primary key (app, thread))",
  );
  store.db.run("drop table turns; drop table relays");
  store.db.run(
    "create index unauthored on messages (n) where author = ''; pragma user_version = 15",
  );

  const kept = (key: string, from: string, author: string, meta?: Record<string, string>) =>
    store.db
      .query(
        'insert into messages (key, "to", "from", author, body, meta, at) values (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        key,
        "-100:7",
        from,
        author,
        "hi",
        meta === undefined ? null : JSON.stringify(meta),
        "2026-10-21T10:00:00.000Z",
      );

  kept("telegram:1", "telegram", "hex General", { user: "hex General" });
  kept("job:a:1", "job", "job");
  kept("schedule:b@1", "schedule", "schedule", { user: "schedule" });
  kept("buzz:2", "buzz", "buzz:abc", { user: "Ana", user_id: "abc" });
  kept("t3:3", "t3", "t3");
  kept("discord:4", "discord", "discord");
  kept("telegram:5", "telegram", "owner", { user_id: "1" });
  kept("telegram:6", "telegram", "", { user_id: "1" });
  store.db.close();
  const reopened = new Store(dir);
  expect(
    reopened.messages.since().map(({ key, author, meta }) => [key, author, meta?.user]),
  ).toEqual([
    ["telegram:1", "prompt", "hex General"],
    ["job:a:1", "prompt", "job"],
    ["schedule:b@1", "prompt", "schedule"],
    ["buzz:2", "other", "Ana"],
    ["t3:3", "other", "t3"],
    ["discord:4", "other", "discord"],
    ["telegram:5", "owner", undefined],
    ["telegram:6", "owner", undefined],
  ]);
});

test("a message's author is the owner, hex, a prompt (what hex itself tells a session: a job's end, a schedule, another thread, the hub), a call or someone other", async () => {
  const store = new Store(dir);
  // oxlint-disable-next-line typescript/await-thenable typescript/no-confusing-void-expression -- bun's rejects matchers return a promise that its types call void
  await expect(
    store.messages.deliver({
      key: "telegram:-100:90",
      to: "-100:7",
      from: "telegram",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion anti-slop/require-safety-comment-for-type-assertion -- no author, to show the store refuses it
      author: "" as never,
      body: "hi",
    }),
  ).rejects.toThrow("owner, hex, prompt, call or other");
  // oxlint-disable-next-line typescript/await-thenable typescript/no-confusing-void-expression -- bun's rejects matchers return a promise that its types call void
  await expect(
    store.messages.deliver({
      key: "job:x:1",
      to: "-100:7",
      from: "job",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion anti-slop/require-safety-comment-for-type-assertion -- an author outside the five, to show the store refuses it
      author: "job" as never,
      body: "hi",
    }),
  ).rejects.toThrow("owner, hex, prompt, call or other");
  expect(
    await store.messages.deliver({
      key: "telegram:-100:91",
      to: "-100:7",
      from: "telegram",
      author: "other",
      body: "hi",
    }),
  ).toBe(true);
});

test("the profile is its newest version, put in place only over the one a writer read, and every version stays", async () => {
  const store = open(dir);
  expect(store.profiles.current()).toBe("");
  expect(await store.profiles.profiled("", "# Who he is\n- Ships on fridays\n")).toBe(true);
  expect(await store.profiles.profiled("", "# Who he is\n- Ships any day")).toBe(false);
  expect(
    await store.profiles.profiled(
      "# Who he is\n- Ships on fridays",
      "# Who he is\n- Ships on fridays",
    ),
  ).toBe(true);
  expect(
    await store.profiles.profiled(
      "# Who he is\n- Ships on fridays",
      "# Who he is\n- Ships any day",
    ),
  ).toBe(true);
  expect(store.profiles.current()).toBe("# Who he is\n- Ships any day");
  expect(store.profiles.list().map(({ body }) => body)).toEqual([
    "# Who he is\n- Ships any day",
    "# Who he is\n- Ships on fridays",
  ]);

  const cli = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), dir, "profile"], {
    stdout: "pipe",
  });

  expect(await new Response(cli.stdout).text()).toBe("# Who he is\n- Ships any day\n");
});

test("a profile kept in state/profile.md comes into hex.db with its history, in order and once each, and the files move aside", () => {
  writeFileSync(join(dir, "profile.md"), "# Who he is\n- Third\n");

  const history = [
    { at: "2026-10-21T13:00:00.000Z", profile: "# Always\n- First" },
    { at: "2026-10-21T13:32:54.590Z", profile: "# Always\n- First" },
    { at: "2026-10-21T15:09:00.000Z", profile: "# Who he is\n- Second" },
  ];

  writeFileSync(
    join(dir, "profile.md.history"),
    `${history.map((each) => JSON.stringify(each)).join("\n")}\n{"at": "broken\n`,
  );
  const store = new Store(dir);
  expect(store.profiles.list().map(({ body }) => body)).toEqual([
    "# Who he is\n- Third",
    "# Who he is\n- Second",
    "# Always\n- First",
  ]);
  expect(store.profiles.list()[1]?.at).toBe("2026-10-21T13:32:54.590Z");
  expect(store.profiles.list()[2]?.at).toBe("2026-10-21T13:00:00.000Z");
  expect(readFileSync(join(dir, "profile.md.moved-to-hex.db"), "utf-8")).toBe(
    "# Who he is\n- Third\n",
  );
  expect(() => store.db.run("delete from profiles")).toThrow("never taken away");
});

test("a carry that renamed the profile files and then failed to commit carries them from their new names", () => {
  writeFileSync(join(dir, "profile.md.moved-to-hex.db"), "# Who he is\n- Third\n");
  expect(new Store(dir).profiles.current()).toBe("# Who he is\n- Third");
});

test("hex message gives the owner's words as he last edited them, and a task quote of an edit names it", async () => {
  const store = open(dir);
  await store.threads.keep("telegram", { "-100:7": { name: "Website" } });
  await store.messages.deliver({
    key: "telegram:-100:52",
    to: "-100:7",
    from: "telegram",
    author: "owner",
    body: "Tell watchdog, so it can be fixed next run",
  });
  await store.messages.deliver({
    key: "telegram:-100:52@1",
    to: "-100:7",
    from: "telegram",
    author: "owner",
    body: "Tell watchdog, so it can be fixed properly at the root next run",
    meta: { edited: "true", message_id: "52" },
  });

  const hexMessage = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), dir, "message", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    await cli.exited;

    return (
      (await new Response(cli.stdout).text()).trim() +
      (await new Response(cli.stderr).text()).trim().replace(/^./u, " $&")
    );
  };

  expect(await hexMessage("telegram:-100:52")).toBe(
    "Tell watchdog, so it can be fixed properly at the root next run (edited: these are the words of telegram:-100:52@1, the key to quote them under)",
  );
  expect(JSON.parse(await hexMessage("telegram:-100:52", "--json"))).toMatchObject({
    key: "telegram:-100:52",
    meta: { edit: "telegram:-100:52@1" },
  });

  const task = await store.tasks.create({
    title: "Fix it at the root",
    message: "telegram:-100:52",
    quote: "Tell watchdog",
    owner: "-100:7",
  });

  // oxlint-disable-next-line typescript/await-thenable typescript/no-confusing-void-expression -- bun's rejects matchers return a promise that its types call void
  await expect(
    store.tasks.addWords(task.id, "telegram:-100:52", "fixed properly at the root"),
  ).rejects.toThrow(
    "is in telegram:-100:52@1, the owner's edit of telegram:-100:52: quote it under that key",
  );
  expect(
    (await store.tasks.addWords(task.id, "telegram:-100:52@1", "fixed properly at the root")).words,
  ).toMatchObject([
    { text: "Tell watchdog" },
    { message: "telegram:-100:52@1", text: "fixed properly at the root" },
  ]);
  // oxlint-disable-next-line typescript/await-thenable typescript/no-confusing-void-expression -- bun's rejects matchers return a promise that its types call void
  await expect(store.tasks.addWords(task.id, "telegram:-100:52", "tonight")).rejects.toThrow(
    "isn't in telegram:-100:52 as written",
  );
  await store.messages.deliver({
    key: "telegram:-100:52@2",
    to: "-100:7",
    from: "telegram",
    author: "owner",
    body: "Tell watchdog, so it can be fixed properly at the root tonight",
    meta: { edited: "true", message_id: "52" },
  });
  await store.messages.deliver({
    key: "telegram:-200:52@3",
    to: "-200",
    from: "telegram",
    author: "owner",
    body: "another chat",
    meta: { edited: "true", message_id: "52" },
  });
  expect(await hexMessage("telegram:-100:52@1")).toBe(
    "Tell watchdog, so it can be fixed properly at the root tonight (edited: these are the words of telegram:-100:52@2, the key to quote them under)",
  );
  expect(await hexMessage("telegram:-100:52@2")).toBe(
    "Tell watchdog, so it can be fixed properly at the root tonight (edited: these are the words of telegram:-100:52@2, the key to quote them under)",
  );
  await store.messages.deliver({
    key: "buzz:e2",
    to: "thread",
    from: "buzz",
    author: "owner",
    body: "first edit",
    meta: { edited: "true", message_id: "e1" },
  });
  await store.messages.deliver({
    key: "buzz:e3",
    to: "thread",
    from: "buzz",
    author: "owner",
    body: "second edit",
    meta: { edited: "true", message_id: "e1" },
  });
  expect(await hexMessage("buzz:e2")).toBe(
    "second edit (edited: these are the words of buzz:e3, the key to quote them under)",
  );
  expect(await hexMessage("buzz:e3")).toBe("second edit");
});

test("a store that syncs in the background shows a write at once, says when it's on disk, and checkpoints off the hub's thread", async () => {
  const store = new Store(dir);
  store.syncInBackground();
  expect(store.db.query("pragma synchronous").get()).toEqual({ synchronous: 1 });

  const other = new Database(join(dir, "hex.db"), { readonly: true });

  for (let n = 0; n < 1500; n += 1) {
    await store.messages.deliver({
      ...message,
      key: `telegram:-100:5:${String(n)}`,
      body: "x".repeat(3000),
    });
  }

  expect(other.query("select count(*) as n from messages").get()).toEqual({ n: 1500 });
  await store.synced();
  await until(() => Bun.file(join(dir, "hex.db")).size > 4_000_000);

  const framesInWal = () =>
    new DataView(readFileSync(join(dir, "hex.db-shm")).buffer).getUint32(16, true);

  await until(() => framesInWal() < 1000);
  other.close();
});

test.skipIf(!existsSync("/proc/locks"))(
  "a store that syncs in the background keeps its locks on the WAL's index, so no other process cuts it short",
  async () => {
    const store = new Store(dir);
    store.syncInBackground();
    await store.messages.deliver(message);
    await store.synced();
    await store.messages.deliver({ ...message, key: "telegram:-100:5:2" });
    await store.synced();

    const { ino } = statSync(join(dir, "hex.db-shm"));

    const held = new RegExp(
      `POSIX\\s+ADVISORY\\s+READ\\s+${String(process.pid)}\\s+\\S+:${String(ino)}\\s`,
      "u",
    );

    expect(readFileSync("/proc/locks", "utf-8")).toMatch(held);
  },
);

test("if its sync thread ends, a store waits for the disk on every write again and still answers who waits", async () => {
  const store = new Store(dir);
  store.syncInBackground();
  await store.messages.deliver(message);
  const waiting = store.synced();
  // oxlint-disable-next-line dot-notation -- ending the thread is what this test is about
  await store["syncer"]?.terminate();
  await waiting;
  await until(
    () =>
      z
        .object({ wal_autocheckpoint: z.literal(1000) })
        .safeParse(store.db.query("pragma wal_autocheckpoint").get()).success,
  );
  await store.messages.deliver({ ...message, key: "telegram:-100:5:2" });
  await store.synced();
});

test("while a store flushes a write to disk, another process can write", async () => {
  const store = new Store(dir);
  expect(store.db.query("pragma synchronous").get()).toEqual({ synchronous: 1 });

  const writesElsewhere: number[] = [];
  // oxlint-disable-next-line dot-notation -- the flush after the commit is what this test is about
  const flush = store["flush"].bind(store);
  // oxlint-disable-next-line dot-notation -- the flush after the commit is what this test is about
  store["flush"] = () => {
    const { exitCode } = Bun.spawnSync([
      process.execPath,
      "-e",
      `const { Database } = await import("bun:sqlite");
      const db = new Database(${JSON.stringify(join(dir, "hex.db"))});
      db.run("begin immediate");
      db.run("commit");
      db.close();`,
    ]);

    writesElsewhere.push(exitCode);
    flush();
  };

  await store.messages.deliver(message);
  expect(writesElsewhere).toEqual([0]);
});

test("a process that writes and exits leaves the WAL to the processes still using it", async () => {
  const store = new Store(dir);
  await store.messages.deliver(message);

  const child = Bun.spawnSync([
    process.execPath,
    "-e",
    `const { Store } = await import(${JSON.stringify(join(import.meta.dir, "store.ts"))});
    new Store(${JSON.stringify(dir)}).messages.deliver(${JSON.stringify({ ...message, key: "telegram:-100:5:2" })});`,
  ]);

  expect(child.exitCode).toBe(0);
  expect(
    new DataView(readFileSync(join(dir, "hex.db-shm")).buffer).getUint32(16, true),
  ).toBeGreaterThan(0);
  expect(store.messages.get("telegram:-100:5:2")).not.toBeNull();
});

test("each job's record from before hex.db kept them carries in once, with how it stopped, and an ended or unreadable one stays out", async () => {
  const tableThenCarry =
    appendOnlyMigrations.findIndex(({ name }) => name === "carryJobRecords") - 1;

  const store = new Store(dir);
  store.db.run("drop table jobs");
  store.db.run(`pragma user_version = ${String(tableThenCarry)}`);
  await store.seen.show("job:moved", "stopped", "moved");
  await store.seen.show("job:finished", "stopped", "ended");
  store.db.close();

  const jobs = join(dir, "jobs");
  const spec = { owner: "t3:stray-key", cwd: "/work", properties: [], command: ["make", "all"] };
  mkdirSync(jobs);

  for (const unit of ["moved", "finished", "plain", "closed"]) {
    writeFileSync(
      join(jobs, `${unit}.json`),
      JSON.stringify({
        ...spec,
        machine: unit === "plain" ? undefined : "twin-x",
        started: `2026-11-15T10:0${String(unit.length)}:00.000Z`,
      }),
    );
  }

  writeFileSync(join(jobs, "closed.ended"), "2026-11-15T11:00:00.000Z");
  writeFileSync(join(jobs, "broken.json"), "{");
  writeFileSync(join(jobs, "plain.sync-conflict-20261113-010055-ABC.json"), "{}");

  const after = new Store(dir);

  const [moved, plain, ...more] = after.jobs.list();

  expect(moved).toMatchObject({
    unit: "moved",
    machine: "twin-x",
    run: "2026-11-15T10:05:00.000Z",
    spec,
  });
  expect(moved?.stopped?.why).toBe("moved");
  expect(plain).toEqual({
    unit: "plain",
    machine: hostname(),
    run: "2026-11-15T10:05:00.000Z",
    spec,
    stopped: undefined,
  });
  expect(more).toEqual([]);
  expect(after.seen.get("job:moved", "stopped")).toBe("");
  expect(after.seen.get("job:finished", "stopped")).toBe("");
  expect(existsSync(join(jobs, "plain.json"))).toBe(true);
});

test("while another process holds the write lock, the hub goes on answering and its writes land in order once it's free", async () => {
  const store = new Store(dir);
  store.syncInBackground();
  await store.messages.deliver(message);

  const held = join(dir, "held");

  const holder = Bun.spawn([
    process.execPath,
    "-e",
    `import { Database } from "bun:sqlite";
    const db = new Database(${JSON.stringify(join(dir, "hex.db"))});
    db.run("begin immediate");
    await Bun.write(${JSON.stringify(held)}, "");
    await Bun.sleep(1500);
    db.run("commit");`,
  ]);

  await until(() => existsSync(held));

  let longestStall = 0;
  let last = performance.now();

  const ticking = setInterval(() => {
    longestStall = Math.max(longestStall, performance.now() - last);
    last = performance.now();
  }, 5);

  const asked = performance.now();
  const first = store.messages.deliver({ ...message, key: "telegram:-100:42:2" });
  const second = store.messages.deliver({ ...message, key: "telegram:-100:42:3" });
  const tookToAsk = performance.now() - asked;

  expect(store.messages.get("telegram:-100:42:2")).toBeNull();
  expect(await Promise.all([first, second])).toEqual([true, true]);
  await holder.exited;
  clearInterval(ticking);

  expect(tookToAsk).toBeLessThan(500);
  expect(longestStall).toBeLessThan(500);
  expect(store.messages.untaken("-100:7").map((row) => row.key)).toEqual([
    "telegram:-100:42",
    "telegram:-100:42:2",
    "telegram:-100:42:3",
  ]);
});
