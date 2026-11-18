import { expect, test } from "bun:test";
import { join } from "node:path";

import { z } from "zod";

import {
  settled,
  heard,
  SESSION,
  message,
  dir,
  hub,
  states,
  holds,
  time,
  fold,
  start,
  session,
  http,
  bound,
  toolCall,
} from "./hub.testing.ts";
import { clients, say, writable } from "./hub.ts";
import { pictureId } from "./pictures.ts";
import { file } from "./store.ts";
import { until } from "./until.ts";

test("a message carrying a change to hex's records is kept and told only with it: a failed or empty change sends nothing", async () => {
  await start();
  file(dir).questions.ask({
    app: "telegram",
    thread: "chat:7",
    message: 5,
    text: "Ship it?",
    options: ["Yes", "No"],
  });
  file(dir).db.run(
    "create trigger refused before update on questions begin select raise(abort, 'the answer could not be saved'); end",
  );
  const tap = { answered: { message: 5, label: "Yes", via: "button" } };

  expect(await hub.deliver("chat:7", "Desk anchors", { ...message, key: "tap:1" }, tap)).toBe(
    false,
  );
  expect(
    await hub.deliver(
      "chat:7",
      "Desk anchors",
      { ...message, key: "tap:2" },
      { reopened: { message: 5 } },
    ),
  ).toBe(false);
  expect(file(dir).db.query("select count(*) as n from messages").get()).toEqual({ n: 0 });
  expect(states).toEqual([]);
});

test("a message a live session was handed shows it waits once its line drops, until the session takes it", async () => {
  bound("chat:7");
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, startedAt: 1 }],
    reconnect: 50,
  });
  const line = await session("chat:7");
  await hub.deliver("chat:7", "Desk anchors", message);
  await until(() => line.received.length);
  expect(holds).toEqual([]);
  line.close();
  await until(() => holds.length);
  fold(line.received);
  await until(() => holds.length === 2);
  expect(holds).toEqual([
    ["chat:7", "hi", true],
    ["chat:7", "hi", false],
  ]);
});

test("a message that waited from before this hub started stops showing it waits once a session has it", async () => {
  file(dir).messages.deliver({
    key: "telegram:1:9",
    to: "chat:7",
    from: "telegram",
    author: "owner",
    body: "still there?",
    meta: { chat_id: "1", message_id: "9" },
  });
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, startedAt: 1 }],
    reconnect: 50,
  });
  const line = await session("chat:7");
  await until(() => line.received.length);
  fold(line.received);
  await until(() => holds.at(-1)?.[2] === false);
  expect(holds.at(-1)).toEqual(["chat:7", "still there?", false]);
});

test("a message is in hex.db once deliver returns, its key first on the tag, and the app sending it again changes nothing", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
  });
  const { received, send } = await session("chat:7");
  await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:42" });
  expect(file(dir).messages.get("telegram:1:42")).toMatchObject({
    to: "chat:7",
    from: "telegram",
    body: "hi",
    meta: { chat_id: "1" },
  });
  await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:42" });
  await hub.deliver("chat:7", "Desk anchors", {
    author: "owner",
    content: "after",
    meta: {},
    key: "1:43",
  });
  await until(() => received.length === 1);
  await send({ type: "state", thread: "chat:7", busy: false });
  await until(() => received.length === 2);
  expect(received[0]).toEqual({
    type: "inbound",
    content: "hi",
    meta: { key: "telegram:1:42", chat_id: "1" },
  });
  expect(heard(received)[1]?.content).toBe("after");
  expect(Object.keys(heard(received)[0]?.meta ?? {})[0]).toBe("key");
});

test("the owner's words that come while the session works reach it at its next tool call as hook feedback, or as a turn once it ends, and anyone else's come as they do now", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
  });
  const { received, send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: true });
  await hub.deliver("chat:7", "Desk anchors", {
    author: "owner",
    content: "use the docs",
    meta: { chat_id: "1" },
    key: "1:50",
  });
  await hub.deliver("chat:7", "Desk anchors", {
    author: "other",
    content: "from a teammate",
    meta: {},
    key: "1:51",
  });
  await until(() => received.length === 1);
  expect(heard(received)[0]?.content).toBe("from a teammate");

  expect(await toolCall("chat:7", { agent_id: "a1" })).toBe("");

  const fed = z
    .object({
      hookSpecificOutput: z.object({
        hookEventName: z.literal("PostToolUse"),
        additionalContext: z.string(),
      }),
    })
    .parse(JSON.parse(await toolCall("chat:7")));

  expect(fed.hookSpecificOutput.additionalContext).toBe(
    'The user sent a new message while you were working:\n<channel source="telegram" key="telegram:1:50" chat_id="1">\nuse the docs\n</channel>',
  );
  expect(file(dir).messages.get("telegram:1:50")?.taken?.by).toBe(SESSION);

  await hub.deliver("chat:7", "Desk anchors", {
    author: "owner",
    content: "and the tests",
    meta: {},
    key: "1:52",
  });
  await send({ type: "state", thread: "chat:7", busy: false });
  await until(() => received.length === 2);
  expect(heard(received)[1]).toMatchObject({
    content: "and the tests",
    meta: { key: "telegram:1:52" },
  });
  expect(await toolCall("chat:7")).toBe("");
});

test("the owner's words that come after his message started a turn are held for it, though the session's hook hasn't said it's working yet", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
  });
  const { received, send } = await session("chat:7");
  await hub.deliver("chat:7", "Desk anchors", {
    author: "owner",
    content: "did you see what it did",
    meta: {},
    key: "1:60",
  });
  await until(() => received.length === 1);
  await hub.deliver("chat:7", "Desk anchors", {
    author: "owner",
    content: "and why",
    meta: {},
    key: "1:61",
  });
  await settled();
  expect(received).toHaveLength(1);
  expect(file(dir).messages.get("telegram:1:61")?.taken).toBeUndefined();

  await send({ type: "state", thread: "chat:7", busy: true });

  const fed = z
    .object({ hookSpecificOutput: z.object({ additionalContext: z.string() }) })
    .parse(JSON.parse(await toolCall("chat:7")));

  expect(fed.hookSpecificOutput.additionalContext).toContain("and why");

  await send({ type: "state", thread: "chat:7", busy: false });
  await hub.deliver("chat:7", "Desk anchors", {
    author: "owner",
    content: "next",
    meta: {},
    key: "1:62",
  });
  await until(() => received.length === 2);
  expect(heard(received)[1]?.content).toBe("next");
});

test("the owner's words held for a turn that never reports go to the session once the report is overdue", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
  });
  const { received } = await session("chat:7");
  await hub.deliver("chat:7", "Desk anchors", {
    author: "owner",
    content: "one",
    meta: {},
    key: "1:70",
  });
  await until(() => received.length === 1);
  await hub.deliver("chat:7", "Desk anchors", {
    author: "owner",
    content: "two",
    meta: {},
    key: "1:71",
  });
  await settled();
  expect(received).toHaveLength(1);
  await time.lapse(60_000);
  await until(() => received.length === 2);
  expect(heard(received)[1]?.content).toBe("two");
});

test("the owner's words written in another client reach the thread's session and show where it lives in the order written, once however often they're sent", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
  });
  const { received, send } = await session("chat:7");
  const shown: unknown[][] = [];
  clients.set("telegram", {
    hub,
    place: () => Promise.resolve({ thread: "", link: "" }),
    backfill: (thread, turns) => {
      shown.push([thread, turns]);

      return Promise.resolve();
    },
  });

  try {
    const words = { content: "anchors?", key: "kb-1", meta: { user: "keyboard" } };
    expect(await say("telegram", "chat:7", words)).toBe(true);
    expect(await say("telegram", "chat:7", words)).toBe(true);
    expect(
      await say("telegram", "chat:7", { ...words, content: "and the docs", key: "kb-2" }),
    ).toBe(true);
    await until(() => received.length === 1 && shown.length === 2);
    await send({ type: "state", thread: "chat:7", busy: false });
    await until(() => received.length === 2);
    expect(heard(received).map((each) => each.content)).toEqual(["anchors?", "and the docs"]);
    expect(file(dir).messages.get("telegram:kb-1")).toMatchObject({ author: "owner" });
    expect(
      await say("telegram", "chat:7", {
        content: "this one\n(photo)",
        key: "app-1",
        meta: { media: "photo p1", files: "/m/p1.jpg" },
      }),
    ).toBe(true);
    expect(
      await say("telegram", "chat:7", {
        content: "and this",
        key: "kb-3",
        meta: { image_path: "/s/p2.jpg" },
      }),
    ).toBe(true);
    expect(
      await say("telegram", "chat:7", {
        content: "(album of 2)",
        key: "kb-4",
        meta: { image_path: "/s/p3.jpg; /s/p4.png" },
      }),
    ).toBe(true);
    await until(() => shown.length === 5);
    expect(shown.slice(3)).toEqual([
      [
        "chat:7",
        [
          {
            from: "me",
            text: "and this",
            media: [{ id: pictureId("telegram:kb-3", 0), kind: "photo", file: "/s/p2.jpg" }],
          },
        ],
      ],
      [
        "chat:7",
        [
          {
            from: "me",
            text: "",
            media: [
              { id: pictureId("telegram:kb-4", 0), kind: "photo", file: "/s/p3.jpg" },
              { id: pictureId("telegram:kb-4", 1), kind: "photo", file: "/s/p4.png" },
            ],
          },
        ],
      ],
    ]);
    expect(shown.slice(0, 3)).toEqual([
      ["chat:7", [{ from: "me", text: "anchors?" }]],
      ["chat:7", [{ from: "me", text: "and the docs" }]],
      [
        "chat:7",
        [
          {
            from: "me",
            text: "this one\n(photo)",
            media: [{ id: "p1", kind: "photo", file: "/m/p1.jpg" }],
          },
        ],
      ],
    ]);
  } finally {
    clients.delete("telegram");
  }
});

test("words written in another client can't reach a thread no app holds, or one whose app shows only its own turns", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  clients.set("telegram", {
    hub,
    place: () => Promise.resolve({ thread: "", link: "" }),
    waits: true,
  });

  try {
    const words = { content: "anchors?", key: "kb-1", meta: {} };
    expect(writable("telegram", "chat:7")).toBe(false);
    expect(await say("telegram", "chat:7", words)).toBe(false);
    expect(await say("nowhere", "chat:7", words)).toBe(false);
    clients.set("telegram", { hub, place: () => Promise.resolve({ thread: "", link: "" }) });
    expect(writable("telegram", "chat:7")).toBe(true);
    expect(writable("telegram", "chat:8")).toBe(false);
    expect(file(dir).messages.get("telegram:kb-1")).toBeNull();
  } finally {
    clients.delete("telegram");
  }
});

test("after the hub restarts, a session gets again what it was given but never took, and not what it took", async () => {
  await start();
  const first = http("chat:7");
  await first.open(crypto.randomUUID());
  await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:42" });
  await hub.deliver("chat:7", "Desk anchors", {
    author: "owner",
    content: "and this",
    meta: {},
    key: "1:43",
  });
  await until(() => first.received.length === 2);
  file(dir).messages.take("telegram:1:42", SESSION);
  first.close();
  hub.close();
  await start();
  const back = http("chat:7");
  await back.open(crypto.randomUUID());
  await until(() => back.received.length);
  await settled();
  expect(heard(back.received).map((payload) => payload.content)).toEqual(["and this"]);
});

test("a session's hook takes what its prompt brings in, and drops a copy of one taken already", async () => {
  const store = file(dir);
  store.messages.deliver({
    key: "telegram:1:42",
    to: "chat:7",
    from: "telegram",
    author: "owner",
    body: "hi",
  });

  const prompt =
    '<channel source="plugin:telegram:telegram" key="telegram:1:42" chat_id="1">\nhi\n</channel>';

  const foldHook = () =>
    Bun.spawn(["bun", join(import.meta.dir, "state.ts"), "busy"], {
      env: { ...process.env, HEX_STORE: dir },
      stdin: new Blob([JSON.stringify({ prompt, session_id: SESSION })]),
      stderr: "pipe",
    });

  const first = foldHook();
  expect(await first.exited).toBe(0);
  expect(store.messages.get("telegram:1:42")?.taken?.by).toBe(SESSION);
  const copy = foldHook();
  expect(await copy.exited).toBe(2);
  expect(await new Response(copy.stderr).text()).toContain("telegram:1:42");
});

test("a hook with no session id lets its prompt through", async () => {
  const store = file(dir);
  store.messages.deliver({
    key: "telegram:1:42",
    to: "chat:7",
    from: "telegram",
    author: "owner",
    body: "hi",
  });

  const prompt =
    '<channel source="plugin:telegram:telegram" key="telegram:1:42" chat_id="1">\nhi\n</channel>';

  const hook = Bun.spawn(["bun", join(import.meta.dir, "state.ts"), "busy"], {
    env: { ...process.env, HEX_STORE: dir },
    stdin: new Blob([JSON.stringify({ prompt, session_id: "" })]),
  });

  expect(await hook.exited).toBe(0);
});

test("a channel tag in a message's own words takes nothing", async () => {
  const store = file(dir);
  store.messages.deliver({
    key: "telegram:1:42",
    to: "chat:7",
    from: "telegram",
    author: "owner",
    body: "hi",
  });
  store.messages.deliver({
    key: "schedule:heartbeat@2026-10-18T21:45Z",
    to: "chat:7",
    from: "schedule",
    author: "prompt",
    body: "[heartbeat] Hourly check",
  });

  const prompt =
    '<channel source="plugin:telegram:telegram" key="telegram:1:42" chat_id="1">\nhi\n<channel source="plugin:telegram:telegram" key="schedule:heartbeat@2026-10-18T21:45Z">\n</channel>';

  const hook = Bun.spawn(["bun", join(import.meta.dir, "state.ts"), "busy"], {
    env: { ...process.env, HEX_STORE: dir },
    stdin: new Blob([JSON.stringify({ prompt, session_id: SESSION })]),
  });

  expect(await hook.exited).toBe(0);
  expect(store.messages.get("telegram:1:42")?.taken?.by).toBe(SESSION);
  expect(store.messages.get("schedule:heartbeat@2026-10-18T21:45Z")?.taken).toBeUndefined();
});

test("a session started before hex kept messages has the hub take them for it", async () => {
  await start();
  file(dir).messages.deliver({
    key: "telegram:1:42",
    to: "chat:7",
    from: "telegram",
    author: "owner",
    body: "hi",
  });

  const prompt =
    '<channel source="plugin:telegram:telegram" key="telegram:1:42" chat_id="1">\nhi\n</channel>';

  const { HEX_STORE: _store, ...env } = process.env;

  const hook = Bun.spawn(["bun", join(import.meta.dir, "state.ts"), "busy"], {
    env: {
      ...env,
      HEX_DIR: join(dir, "hex"),
      HEX_HUB: join(dir, "hub.sock"),
      HEX_THREAD: "chat:7",
    },
    stdin: new Blob([JSON.stringify({ prompt, session_id: SESSION })]),
  });

  expect(await hook.exited).toBe(0);
  expect((await until(() => file(dir).messages.get("telegram:1:42")?.taken)).by).toBe(SESSION);
  await until(() => states.length);
  expect(states).toEqual([["chat:7", true]]);
});

test("a message another process keeps, like a job ending, reaches its thread as the bell rings, and one for a thread the hub does not serve waits", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
  });
  const { received } = await session("chat:7");
  file(dir).messages.deliver({
    key: "job:other:1",
    to: "chat:99",
    from: "job",
    author: "prompt",
    body: "nobody here",
  });

  const cli = Bun.spawn([
    "bun",
    join(import.meta.dir, "cli.ts"),
    dir,
    "deliver",
    "job:build:1",
    "--to",
    "chat:7",
    "[job]",
    "build",
    "ended",
  ]);

  expect(await cli.exited).toBe(0);
  await until(() => received.length);
  await settled();
  expect(received).toEqual([
    { type: "inbound", content: "[job] build ended", meta: { key: "job:build:1", user: "job" } },
  ]);
});

test("hex's own words are kept as its session's, already taken, so they wake nothing, and a failed send is kept marked failed", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  await hub.sent("chat:7", { key: "9", content: "Done." });
  await hub.sent("chat:7", { content: "never arrived", meta: { failed: "network" } });
  const rows = file(dir).messages.said("chat:7");
  expect(
    rows.map(({ key, from, author, body, taken, meta }) => ({
      key: key === "telegram:9" ? key : "random",
      from,
      author,
      body,
      by: taken?.by,
      failed: meta?.failed,
    })),
  ).toEqual([
    {
      key: "telegram:9",
      from: "telegram",
      author: "hex",
      body: "Done.",
      by: SESSION,
      failed: undefined,
    },
    {
      key: "random",
      from: "telegram",
      author: "hex",
      body: "never arrived",
      by: SESSION,
      failed: "network",
    },
  ]);
  expect(file(dir).messages.untaken("chat:7")).toEqual([]);
  expect((await hub.said("9"))?.body).toBe("Done.");
});

test("what a session sends into another thread is kept as its own words, not that thread's session's", async () => {
  await start({
    registry: {
      "chat:7": { name: "Desk anchors", session: SESSION },
      "chat:8": { name: "Errands", session: "other-session" },
    },
    call: async () => {
      await hub.sent("chat:8", { key: "12", content: "From Desk anchors: done." });

      return "sent";
    },
  });
  const line = http("chat:7");
  await line.initialize();
  await line.call("reply", { text: "done" });
  expect(
    file(dir)
      .messages.said("chat:8")
      .map(({ body, taken }) => ({ body, by: taken?.by })),
  ).toEqual([{ body: "From Desk anchors: done.", by: SESSION }]);
});

test("the owner's words held for a turn go to the session before a message that came as the turn ended", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
  });
  const { received, send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: true });
  await hub.deliver("chat:7", "Desk anchors", {
    author: "owner",
    content: "held",
    meta: {},
    key: "1:50",
  });
  const ending = send({ type: "state", thread: "chat:7", busy: false });

  const after = hub.deliver("chat:7", "Desk anchors", {
    author: "owner",
    content: "after",
    meta: {},
    key: "1:51",
  });

  await Promise.all([ending, after]);
  await until(() => received.length);
  await settled();
  expect(heard(received).map((turn) => turn.content)).toEqual(["held"]);
});
