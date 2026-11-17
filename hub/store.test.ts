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
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { file, File, open } from "./store.ts";
import type { NewRow } from "./store.ts";
import { objectStorage } from "./store/fake.ts";
import { recordsIn } from "./store/storage.ts";
import { client } from "./store/wire.ts";
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

async function failure(pending: Promise<unknown>): Promise<string> {
  return await pending.then(() => "it didn't fail", String);
}

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

test("a change committed in another process rings the bell, and a write that changed nothing stays quiet", async () => {
  const store = open(dir);
  expect(open(dir)).toBe(store);
  let rang = 0;
  file(dir).threads.keep("telegram", { general: { name: "General" } });

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
  expect(await store.messages.get("job:build:abc")).toMatchObject({
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

test("the store a caller holds answers each call as its file does, one that returns nothing included", async () => {
  const store = open(dir);
  expect(await store.messages.deliver(message)).toBe(true);
  expect(await store.messages.get(message.key)).toMatchObject({ body: message.body });
  expect(await store.messages.untaken()).toMatchObject([{ key: message.key }]);
  expect(await failure(store.messages.deliver({ ...message, key: "42" }))).toContain("Error");
  await store.threads.keep("telegram", { "-100:7": { name: "General" } });
  expect(file(dir).threads.list()).toMatchObject([{ thread: "-100:7", name: "General" }]);
});

test("hex sql prints what a query reads, and hex store copy writes the records to a file a hex runs on", async () => {
  file(dir).messages.deliver(message);

  const hex = async (...args: string[]) => {
    const cli = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), dir, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    return {
      code: await cli.exited,
      out: await new Response(cli.stdout).text(),
      err: await new Response(cli.stderr).text(),
    };
  };

  expect(await hex("sql", "select key from messages")).toEqual({
    code: 0,
    out: `{"key":"${message.key}"}\n`,
    err: "",
  });
  mkdirSync(join(dir, "copy"));
  expect(await hex("store", "copy", join(dir, "copy", "hex.db"))).toMatchObject({ code: 0 });
  expect(new File(join(dir, "copy")).messages.get(message.key)).toMatchObject(message);
});

test("thread names and ids reach every caller as lookups a name like toString finds nothing in, from a file or an object", async () => {
  const storage = objectStorage();
  recordsIn(storage);
  storage.sql.exec("insert into _home (one, version) values (1, 0)");
  const object = recordsIn(storage, dir);
  const inObject = client((call) => Promise.resolve(JSON.stringify(object.call(call).reply)));

  for (const store of [open(dir), inObject]) {
    await store.threads.keep("telegram", { "-100:7": { name: "General" } });
    const [names, ids] = await Promise.all([store.threads.names(), store.threads.ids()]);
    expect([names["-100:7"], ids["-100:7"]]).toEqual(["General", "telegram:-100:7"]);
    expect(["toString" in names, "constructor" in ids]).toEqual([false, false]);
  }
});

test("a read of the file can change nothing, and a copy is a file a hex runs on", async () => {
  const store = open(dir);
  file(dir).messages.deliver(message);
  expect(await store.read("select key from messages where key = ?", message.key)).toEqual([
    { key: message.key },
  ]);
  expect(await failure(store.read("delete from messages"))).toContain("hex sql can change nothing");
  mkdirSync(join(dir, "copy"));
  await store.copy(join(dir, "copy", "hex.db"));
  expect(new File(join(dir, "copy")).messages.get(message.key)).toMatchObject(message);
  expect(file(dir).messages.get(message.key)).toMatchObject(message);
});

test("a listener runs at the first ring, then once for each change, however many times the bell rings for it", async () => {
  const store = file(dir);
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
  store.messages.deliver(message);
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
    const store = file(dir);
    let n = 0;

    const change = () =>
      store.messages.deliver({
        key: `job:watched:${n++}`,
        to: "general",
        from: "job",
        author: "prompt",
        body: "one",
      });

    change();
    expect(await line()).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z\n/u);
    await lines.cancel();
    await until(() => watch.exitCode !== null || void change());
    expect(watch.exitCode).toBe(0);
  } finally {
    watch.kill();
  }
});

test("a change right after the one the bell just rang for is still heard", async () => {
  const store = file(dir);
  const seen: (string | undefined)[] = [];

  const stop = store.watch(() => {
    seen.push(store.messages.get("job:quick:2")?.body);

    if (seen.length === 1) {
      store.messages.deliver({
        key: "job:quick:2",
        to: "general",
        from: "job",
        author: "prompt",
        body: "two",
      });
    }
  });

  store.messages.deliver({
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
  file(dir).threads.keep("discord", { "1561": { name: "Repair" } });

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
  expect(file(dir).messages.said("1561", 1)).toMatchObject([
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
  file(dir).threads.keep("telegram", {
    "-100:4801": { name: "Watchdog" },
    "-100:4802": { name: "website", session: "a1f3c6d2-0000-4000-8000-000000000000" },
  });
  file(dir).turns.turned("d4365c34-312f-4a52-9704-36fcf657e5b9", true);
  file(dir).threads.keep("telegram", {
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
    file(dir)
      .messages.since()
      .map((row) => row.to),
  ).toEqual(["-100:7", "-100:7", "-100:7", "-100:4803", "-100:103", "-100:4801", "-100:4802"]);
});

test("hex deliver finds a thread by its name too, keeps one for a closed thread till it opens, and refuses an address no thread has", async () => {
  file(dir).threads.keep("t3", {
    "0f3a9c1e-0000-4000-8000-000000000000": { name: "Old T3 thread" },
  });
  file(dir).threads.keep("t3", { "5b0e7d2a-0000-4000-8000-000000000000": { name: "t3: notes" } });
  file(dir).threads.keep("telegram", { "-100:1": { name: "hex" } });
  file(dir).threads.keep("telegram", {
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
    file(dir)
      .messages.since()
      .map((row) => row.to),
  ).toEqual([
    "-100:4801",
    "-100:2",
    "5b0e7d2a-0000-4000-8000-000000000000",
    "0f3a9c1e-0000-4000-8000-000000000000",
  ]);
});

test("hex log reads every thread a name means, a delivery to that name asks for one by its id, and hex recall takes rg's -i", async () => {
  const store = file(dir);
  store.threads.keep("telegram", { "629": { name: "DM" } });
  store.threads.keep("discord", { "1560": { name: "DM" } });

  for (const [from, key, to, body] of [
    ["telegram", "telegram:629:1", "629", "on Telegram"],
    ["discord", "discord:1560:1", "1560", "on Discord"],
    ["telegram", "telegram:629:2", "629", "Telegram again"],
  ] as const) {
    store.messages.deliver({ key, to, from, author: "owner", body });
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

test("hex threads --json gives each thread its id, <app>:<key>", async () => {
  const store = file(dir);
  store.threads.keep("discord", { "1561": { name: "Repair" }, "1562": { name: "Stage" } });
  store.threads.keep("telegram", { "-100:7": { name: "Shop" } });
  store.threads.keep("buzz", { abc: { name: "Buzz shop" } });

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
  const store = file(dir);
  const telegram = { "-100:7": { name: "Chats" }, "-100:8": { name: "Android" } };
  store.threads.keep("telegram", telegram);

  const hex = async (...args: string[]) =>
    await Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), dir, ...args], { stderr: "pipe" })
      .exited;

  const projects = () => store.threads.list().map(({ name, project }) => [name, project]);
  expect(await hex("thread", "Chats", "--project", "keyboard")).toBe(0);
  store.threads.keep("telegram", { ...telegram, "-100:7": { name: "Chats", session: "s1" } });
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

  const handed = new Set(
    [
      ...readFileSync(join(import.meta.dir, "../bin/hex"), "utf-8").matchAll(
        /^ {2}([a-z|]+)\)\n(.*?)^ {4};;$/gmsu,
      ),
    ].flatMap(([, labels = "", body = ""]) =>
      body.includes('exec bun "$hex/hub/cli.ts"') ? labels.split("|") : [],
    ),
  );

  expect(commands).toContain("thread");
  expect(commands.filter((command) => !handed.has(command))).toEqual([]);
});

const ask = {
  ...message,
  key: "telegram:-100:50",
  body: "Fix the login page. Also the logo looks blurry on retina.",
};

test("hex task makes a task from a message by its key, and the owner is the thread asking", async () => {
  file(dir).messages.deliver(ask);

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
  expect(file(dir).tasks.get("t-1")).toMatchObject({
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
  const store = file(dir);
  store.pins.pinned({
    app: "telegram",
    thread: "chat:3",
    message: 9,
    text: "Site: example.com\n\n🔴 **Blocked on you**",
    note: "Site: example.com",
  });
  store.pins.pinned({
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
  file(dir).threads.keep("discord", { "1561": { name: "Repair" } });
  expect(await hex("--thread", "discord:1561", "--json")).toBe(
    await hex("--thread", "1561", "--json"),
  );
});

test("hex profile prints the profile's newest version", async () => {
  const store = file(dir);
  store.profiles.profiled("", "# Who he is\n- Ships on fridays");
  store.profiles.profiled("# Who he is\n- Ships on fridays", "# Who he is\n- Ships any day");

  const cli = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), dir, "profile"], {
    stdout: "pipe",
  });

  expect(await new Response(cli.stdout).text()).toBe("# Who he is\n- Ships any day\n");
});

test("hex message gives the owner's words as he last edited them, naming the edit's key", async () => {
  const store = file(dir);
  store.threads.keep("telegram", { "-100:7": { name: "Website" } });
  store.messages.deliver({
    key: "telegram:-100:52",
    to: "-100:7",
    from: "telegram",
    author: "owner",
    body: "Tell watchdog, so it can be fixed next run",
  });
  store.messages.deliver({
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

  store.messages.deliver({
    key: "telegram:-100:52@2",
    to: "-100:7",
    from: "telegram",
    author: "owner",
    body: "Tell watchdog, so it can be fixed properly at the root tonight",
    meta: { edited: "true", message_id: "52" },
  });
  store.messages.deliver({
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
  store.messages.deliver({
    key: "buzz:e2",
    to: "thread",
    from: "buzz",
    author: "owner",
    body: "first edit",
    meta: { edited: "true", message_id: "e1" },
  });
  store.messages.deliver({
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
  const store = new File(dir);
  store.syncInBackground();
  expect(store.db.query("pragma synchronous").get()).toEqual({ synchronous: 1 });

  const other = new Database(join(dir, "hex.db"), { readonly: true });

  for (let n = 0; n < 1500; n += 1) {
    store.messages.deliver({
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
    const store = new File(dir);
    store.syncInBackground();
    store.messages.deliver(message);
    await store.synced();
    store.messages.deliver({ ...message, key: "telegram:-100:5:2" });
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
  const store = new File(dir);
  store.syncInBackground();
  store.messages.deliver(message);
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
  store.messages.deliver({ ...message, key: "telegram:-100:5:2" });
  await store.synced();
});

test("while a store flushes a write to disk, another process can write", () => {
  const store = new File(dir);
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

  store.messages.deliver(message);
  expect(writesElsewhere).toEqual([0]);
});

test("a process that writes and exits leaves the WAL to the processes still using it", () => {
  const store = new File(dir);
  store.messages.deliver(message);

  const child = Bun.spawnSync([
    process.execPath,
    "-e",
    `const { File } = await import(${JSON.stringify(join(import.meta.dir, "store.ts"))});
    new File(${JSON.stringify(dir)}).messages.deliver(${JSON.stringify({ ...message, key: "telegram:-100:5:2" })});`,
  ]);

  expect(child.exitCode).toBe(0);
  expect(
    new DataView(readFileSync(join(dir, "hex.db-shm")).buffer).getUint32(16, true),
  ).toBeGreaterThan(0);
  expect(store.messages.get("telegram:-100:5:2")).not.toBeNull();
});
