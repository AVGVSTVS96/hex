import { expect, test } from "bun:test";
import { statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

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
  settles,
  calls,
  launched,
  session,
  sendToHub,
  saved,
  settingsOf,
  registry,
} from "./hub.testing.ts";
import { begin, clients, history, mirror, move, tappable, transcribe } from "./hub.ts";
import { file } from "./store.ts";
import type { Author } from "./store.ts";
import { until } from "./until.ts";

test("without a transcriber set up, a recording is never fetched or sent anywhere", async () => {
  delete process.env.TRANSCRIBE_URL;
  delete process.env.TRANSCRIBE_MODEL;
  let fetched = false;
  expect(
    await transcribe(() => {
      fetched = true;

      return Promise.resolve("voice.oga");
    }),
  ).toBeUndefined();
  expect(fetched).toBe(false);
});

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

test("a buzz:// link becomes a web link that opens it, in plain text and in Markdown", () => {
  const link = "buzz://message?channel=c-1&id=abc";
  const web = `https://hex-sand.vercel.app/open.html#${encodeURIComponent(link)}`;
  expect(tappable(`see ${link}.`)).toBe(`see ${web}.`);
  expect(tappable(`open ${link}?`)).toBe(`open ${web}?`);
  expect(tappable(`[the thread](${link})`)).toBe(`[the thread](${web})`);
  expect(tappable("no links here")).toBe("no links here");
});

test("begin opens a thread on another client and starts its session on a prompt, or on a message it delivers under the thread's name", async () => {
  await start({ agents: [] });
  const placed: (string | undefined)[][] = [];
  clients.set("elsewhere", {
    hub,
    place: (name, where, about) => {
      placed.push([name, where, about]);

      return Promise.resolve({
        thread: `chat:${placed.length + 8}`,
        link: `https://chat/${placed.length + 8}`,
      });
    },
  });

  try {
    expect(
      await begin("elsewhere", "Anchors", "look at the anchors", {
        about: "From Discord",
        where: "desk",
      }),
    ).toEqual({ thread: "chat:9", link: "https://chat/9" });
    expect((await launched()).at(-1)).toBe("look at the anchors");
    await begin("elsewhere", "Relay", {
      content: "fix the relay",
      author: "prompt",
      meta: { user: "hex voice" },
    });
    expect(placed).toEqual([
      ["Anchors", "desk", "From Discord"],
      ["Relay", undefined, undefined],
    ]);
    expect((await until(() => registry()["chat:10"])).name).toBe("Relay");
    const { received } = await session("chat:10");
    await until(() => received.length);
    expect(received[0]).toMatchObject({ content: "fix the relay", meta: { user: "hex voice" } });
    expect(await settles(begin("nowhere", "Anchors", "x"))).toMatchObject({
      status: "rejected",
      reason: new Error("nowhere isn't connected; threads open in elsewhere"),
    });
  } finally {
    clients.delete("elsewhere");
  }
});

test("a move that copies forks the session there and leaves the thread here", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  const forked: unknown[][] = [];
  clients.set("elsewhere", {
    hub: partialHub({
      fork: (...args: unknown[]) => {
        forked.push(args);
      },
    }),
    place: () => Promise.resolve({ thread: "far:1", link: "https://far/1" }),
  });

  try {
    expect(await move(hub, "chat:7", "elsewhere", "Anchors", undefined, true)).toBe(
      "https://far/1",
    );
    await until(() => forked.length);
    expect(forked).toEqual([
      [
        "far:1",
        "Anchors",
        SESSION,
        'This conversation just moved to elsewhere, into the thread "Anchors". Your elsewhere tools now post there. Carry on where you left off.',
        undefined,
      ],
    ]);
    expect(registry()["chat:7"]).toEqual({ name: "Desk anchors", session: SESSION });
  } finally {
    clients.delete("elsewhere");
  }
});

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A thread's messages as hex.db keeps them, each taken by the session it reached or wrote it.
function stored(
  rows: { author: Author; body: string; from?: string; meta?: Record<string, string> }[],
  thread = "chat:7",
  takenBy: string | undefined = SESSION,
) {
  const store = file(dir);

  for (const [i, { from = "buzz", ...row }] of rows.entries()) {
    store.messages.deliver({ key: `${from}:${thread}-${i}`, to: thread, from, ...row }, takenBy);
  }
}

test("a thread's history is what the owner said and hex replied, headings and all, without the terminal, others, failed sends or what waits, and a session's is what it took", async () => {
  stored([
    { author: "owner", body: "how full is your context?" },
    { author: "hex", body: "Roomy.\n\n## What loads\n\nthe rules" },
    { author: "owner", from: "terminal", body: "typed in the terminal" },
    { author: "hex", body: "never sent", meta: { failed: "network" } },
    { author: "owner", from: "telegram", body: "thanks" },
    {
      author: "prompt",
      from: "telegram",
      body: "From General: the build passed.",
      meta: { user: "hex General" },
    },
    { author: "call", from: "voice", body: "[1.0s] you: hi\n[2.0s] voice: hello" },
  ]);
  stored([{ author: "owner", body: "not taken yet" }], "chat:7", undefined);
  stored([{ author: "owner", body: "another thread" }], "chat:8");
  expect(await history(file(dir).store, "chat:7")).toEqual([
    { from: "me", text: "how full is your context?" },
    { from: "hex", text: "Roomy.\n\n## What loads\n\nthe rules" },
    { from: "me", text: "thanks" },
  ]);
  expect(await history(file(dir).store, "chat:9")).toEqual([]);
  file(dir)
    .db.query("update messages set at = '2026-10-01T00:00:00.000Z' where key = 'buzz:chat:7-0'")
    .run();
  file(dir)
    .db.query("update messages set taken_by = 'older-session' where key = 'buzz:chat:7-0'")
    .run();
  expect((await history(file(dir).store, "chat:7", SESSION)).map((turn) => turn.text)).toEqual([
    "Roomy.\n\n## What loads\n\nthe rules",
    "thanks",
  ]);
  expect(await history(file(dir).store, "chat:7", "new-session")).toEqual([]);
});

test("a T3 message in a history is the owner's request, without the context T3 Code sends around it", async () => {
  const runtime = "<runtime_info>In case you're asked: you are running in T3 Code.</runtime_info>";
  stored([
    {
      author: "owner",
      from: "t3",
      body: `<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer assumptions.\n</t3_code_instructions>\n\n<user_request>\nship it\n</user_request>\n\n${runtime}`,
    },
    {
      author: "owner",
      from: "t3",
      body: `and the docs\n\n${runtime}\n\n<pull_request_linking>\nLink every PR.\n</pull_request_linking>`,
    },
    { author: "hex", from: "t3", body: "Shipped." },
  ]);
  expect(await history(file(dir).store, "chat:7")).toEqual([
    { from: "me", text: "ship it" },
    { from: "me", text: "and the docs" },
    { from: "hex", text: "Shipped." },
  ]);
});

test("a move backfills the thread there with its chat before its session resumes there", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  stored([{ author: "owner", body: "anchors?" }]);
  const steps: unknown[][] = [];
  clients.set("elsewhere", {
    hub: partialHub({
      fork: (...args: unknown[]) => {
        steps.push(["fork", args[0]]);
      },
    }),
    place: () => Promise.resolve({ thread: "far:1", link: "https://far/1" }),
    backfill: (thread, turns) => {
      steps.push(["backfill", thread, turns]);

      return Promise.resolve();
    },
  });

  try {
    await move(hub, "chat:7", "elsewhere", "Anchors", undefined, true);
    await until(() => steps.length === 2);
    expect(steps).toEqual([
      ["backfill", "far:1", [{ from: "me", text: "anchors?" }]],
      ["fork", "far:1"],
    ]);
  } finally {
    clients.delete("elsewhere");
  }
});

test("a move to a client that shows only its own turns hands it the session to resume with the next message there", async () => {
  await start({
    registry: {
      "chat:7": { name: "Desk anchors", session: SESSION },
      "chat:8": { name: "Desk bolts", session: "22222222-0000-4000-8000-000000000000" },
    },
  });
  const steps: unknown[][] = [];
  clients.set("elsewhere", {
    hub: partialHub({
      adopt: (...args: unknown[]) => {
        steps.push(["adopt", ...args]);
      },
      follow: (...args: unknown[]) => {
        steps.push(["follow", ...args]);
      },
    }),
    place: () => Promise.resolve({ thread: "far:1", link: "https://far/1" }),
    waits: true,
  });

  try {
    await move(hub, "chat:8", "elsewhere", "Bolts");
    await move(hub, "chat:7", "elsewhere", "Anchors", undefined, true);
    await until(() => steps.length === 2);
    expect(steps).toContainEqual([
      "adopt",
      "far:1",
      "Bolts",
      "22222222-0000-4000-8000-000000000000",
      undefined,
      undefined,
    ]);
    expect(steps).toContainEqual(["follow", "far:1", "Anchors", SESSION, undefined]);
  } finally {
    clients.delete("elsewhere");
  }
});

test("a mirror opens a backfilled copy that follows the session, and leaves the thread here", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION, cwd: "/work/anchors" } },
  });
  stored([{ author: "hex", body: "Anchors are in." }]);
  const steps: unknown[][] = [];
  clients.set("elsewhere", {
    hub: partialHub({
      follow: (...args: unknown[]) => {
        steps.push(["follow", ...args]);
      },
    }),
    place: (name, where, about, cwd) => {
      steps.push(["place", name, where, about, cwd]);

      return Promise.resolve({ thread: "far:1", link: "https://far/1" });
    },
    backfill: (thread, turns) => {
      steps.push(["backfill", thread, turns]);

      return Promise.resolve();
    },
  });

  try {
    expect(await mirror(hub, "chat:7", "elsewhere", "open-source")).toBe("https://far/1");
    expect(steps).toEqual([
      ["place", "Desk anchors", "open-source", undefined, "/work/anchors"],
      ["backfill", "far:1", [{ from: "hex", text: "Anchors are in." }]],
      ["follow", "far:1", "Desk anchors", SESSION, "/work/anchors"],
    ]);
    expect(registry()["chat:7"]).toEqual({
      name: "Desk anchors",
      session: SESSION,
      cwd: "/work/anchors",
    });
  } finally {
    clients.delete("elsewhere");
  }
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

test("a channel that shows another's threads waits for that client to join, and goes on at once when it's already here", async () => {
  let joined = false;

  const waiting = (async () => {
    await clients.joined("elsewhere");
    joined = true;
  })();

  await Bun.sleep(10);
  expect(joined).toBe(false);

  try {
    clients.set("elsewhere", { hub, place: () => Promise.resolve({ thread: "", link: "" }) });
    await waiting;
    await clients.joined("elsewhere");
  } finally {
    clients.delete("elsewhere");
  }
});
