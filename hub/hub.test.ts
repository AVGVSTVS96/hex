import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
  existsSync,
  symlinkSync,
  watch,
} from "node:fs";
import { connect, createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { settled } from "./claude.ts";
import type { Job as JobRecord } from "./claude.ts";
import { clock, manual } from "./clock.ts";
import {
  begin,
  clients,
  free,
  history,
  mirror,
  move,
  say,
  stamp,
  startHub,
  tappable,
  tool,
  transcribe,
  writable,
} from "./hub.ts";
import type { Call, ChannelServer, Hub, HubLine, Message, Permission } from "./hub.ts";
import { open } from "./store.ts";
import type { Author } from "./store.ts";
import { ATTACH, hangUpAll, http as channelLine, port } from "./testing.ts";
import { until } from "./until.ts";

const CHANNEL = "plugin:telegram@hex";

type Registered = {
  name: string;
  session?: string;
  from?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  launched?: string;
  link?: string;
};

const Keyed = z.object({ meta: z.object({ key: z.string() }) });

const Args = z.array(z.string());

const Heard = z.looseObject({
  type: z.string().optional(),
  content: z.string().optional(),
  meta: z.record(z.string(), z.string()).optional(),
});

function heard(received: unknown[]) {
  return Heard.array().parse(received);
}

const Initialized = z.object({
  result: z.object({
    protocolVersion: z.string(),
    capabilities: z.object({ tools: z.unknown(), experimental: z.unknown() }),
    instructions: z.string(),
  }),
});

const Declined = z.object({ error: z.object({ code: z.number() }) });

function anyString(): string {
  // oxlint-disable-next-line typescript/no-unsafe-return -- bun types its asymmetric matchers as any
  return expect.any(String);
}

function matching(pattern: RegExp): string {
  // oxlint-disable-next-line typescript/no-unsafe-return -- bun types its asymmetric matchers as any
  return expect.stringMatching(pattern);
}

function partialHub(methods: Partial<Hub>): Hub {
  // SAFETY: each test that hands a client this hub calls only the methods it gave.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a stub client's hub needs only what the test calls
  return methods as Hub;
}

const SettingsFile = z.looseObject({
  enabledPlugins: z.record(z.string(), z.boolean()),
  env: z.record(z.string(), z.string()),
});

const SESSION = "0a1b2c3d-0000-4000-8000-000000000000";
const message: Message = { content: "hi", author: "owner", meta: { chat_id: "1" } };

const SERVER: ChannelServer = {
  title: "Telegram",
  instructions: 'Messages arrive as <channel source="telegram">.',
  tools: [tool({ name: "reply", description: "Reply.", input: z.object({}) })],
  permission: true,
};

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Above Linux's highest pid, so a session's process is always already gone.
const EXITED = 4_194_305;

let dir: string;
let hub: ReturnType<typeof startHub>;
let states: [string, boolean][];
let failures: [string, string][];
let prompts: [string, Permission][];
let holds: [string, string, boolean][];
let time: ReturnType<typeof manual>;
const sockets: Socket[] = [];
const sleepers: ReturnType<typeof Bun.spawn>[] = [];
const listener = { port: port() };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-"));
  mkdirSync(join(dir, "hex"), { recursive: true });
  mkdirSync(join(dir, "jobs", "job12345"), { recursive: true });
  const fake = join(dir, "claude");
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Each call is logged once it has done what it does.
  writeFileSync(
    fake,
    `#!/bin/sh
trap 'jq -cn "\\$ARGS.positional" --args -- "$@" >> "${dir}/calls"' EXIT
[ "$1" = "rm" ] && [ -f "${dir}/slow" ] && sleep 0.3
[ "$1 $2" = "agents --json" ] && [ -f "${dir}/unanswering" ] && exit 1
[ "$1 $2" = "agents --json" ] && [ -f "${dir}/unreadable" ] && rm "${dir}/unreadable" && echo 'Error: connect ECONNREFUSED' && exit 1
[ "$1 $2" = "agents --json" ] && { [ -f "${dir}/down" ] && echo '[]' || cat "${dir}/agents" 2>/dev/null || echo '[]'; }
[ "$1 $2" = "daemon status" ] && [ -f "${dir}/down" ] && exit 1
[ "$1 $2" = "daemon status" ] && echo "version: $(cat "${dir}/daemon" 2>/dev/null || echo 2.1.0)"
[ "$1 $2" = "daemon stop" ] && rm -f "${dir}/daemon"
[ "$1" = "--version" ] && echo "2.1.0 (Claude Code)"
[ "$1 $2" = "daemon run" ] && rm -f "${dir}/down"
[ "$1" = "--bg" ] && echo "backgrounded · job12345 · test"
${ATTACH}
[ "$1" = "stop" ] && [ -f "${dir}/agents" ] && jq -c --arg id "$2" 'map(select(.sessionId | startswith($id) | not))' "${dir}/agents" > "${dir}/agents.next" && mv "${dir}/agents.next" "${dir}/agents"
exit 0
`,
  );
  chmodSync(fake, 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.CLAUDE_CONFIG_DIR = dir;
  time = manual(settled);
});

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }

  for (const sleeper of sleepers.splice(0)) {
    sleeper.kill();
  }

  hangUpAll();
  hub?.close();
  time.restore();
  process.env.PATH = (process.env.PATH ?? "").split(":").slice(1).join(":");
  delete process.env.CLAUDE_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function inbound(sent: Message) {
  return {
    type: "inbound",
    content: sent.content,
    meta: { key: matching(/^telegram:/u), ...sent.meta },
  };
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The session's hook taking each message it was given, as Claude Code adds it to the conversation.
function fold(received: unknown[]) {
  for (const payload of Keyed.array().parse(received)) {
    open(dir).messages.take(payload.meta.key, SESSION);
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// stale: the registry's sessions started with what the hub no longer gives a session, as after an update.
function start(
  options: {
    call?: Call;
    main?: string;
    general?: boolean;
    idleStop?: number;
    cacheWarm?: number;
    compactAbove?: number;
    reconnect?: number;
    connect?: number;
    launcher?: string;
    registry?: Record<string, Registered>;
    stale?: boolean;
    agents?: object[];
    fresh?: (thread: string) => boolean;
    capacity?: number;
    startup?: string[];
  } = {},
) {
  const {
    idleStop,
    cacheWarm,
    compactAbove,
    reconnect,
    connect: connectWait = 0,
    capacity,
  } = options;

  if (options.registry) {
    open(dir).threads.keep(
      "telegram",
      Object.fromEntries(
        Object.entries(options.stale === true ? before(options.registry) : options.registry).map(
          ([thread, { from, ...known }]) => [
            thread,
            { ...known, ...(from !== undefined && { fork: from }) },
          ],
        ),
      ),
    );
  }

  if (options.agents) {
    writeFileSync(join(dir, "agents"), JSON.stringify(options.agents));
  }

  const seen: [string, boolean][] = [];
  const failedSeen: [string, string][] = [];
  const asked: [string, Permission][] = [];
  const marked: [string, string, boolean][] = [];
  states = seen;
  failures = failedSeen;
  prompts = asked;
  holds = marked;
  hub = startHub({
    stateDir: dir,
    channel: CHANNEL,
    server: SERVER,
    port: listener.port,
    main: options.main,
    general: options.general,
    call: options.call ?? ((thread, name) => Promise.resolve(`${name} in ${thread}`)),
    state: (thread, busy) => {
      seen.push([thread, busy]);
    },
    failed: (thread, reason) => {
      failedSeen.push([thread, reason]);
    },
    waits: (thread, { content }, still) => {
      marked.push([thread, content, still]);
    },
    permission: (thread, request) => {
      asked.push([thread, request]);
    },
    hexDir: join(dir, "hex"),
    limits: Object.fromEntries(
      Object.entries({
        idleStop,
        cacheWarm,
        compactAbove,
        reconnect,
        connect: connectWait,
        capacity,
      }).filter(([, value]) => value !== undefined),
    ),
    launcher: options.launcher,
    fresh: options.fresh,
    startup: options.startup,
    mainName: "hex",
  });
}

function before(registered: Record<string, Registered>) {
  return Object.fromEntries(
    Object.entries(registered).map(([thread, known]) => [
      thread,
      { ...known, launched: stamp([], { ...SERVER, instructions: "older" }) },
    ]),
  );
}

const failsToSave = () => {
  throw new Error("the answer could not be saved");
};

const bgStarts = () => calls().filter((each) => each[0] === "--bg");

const deskStarts = () =>
  calls().filter((each) => each[0] === "--bg" && each.join(" ").includes("chat%3A7"));

const startedAgainFor = (thread: string) =>
  bgStarts()
    .slice(3)
    .find((each) => settingsOf(each).env.HEX_THREAD === thread) ?? [];

const respawns = () => calls().filter((each) => each[0] === "respawn");

const restsOf = (thread: string) =>
  states.filter(([each, busy]) => each === thread && !busy).length;

const minutesIntoNovember = (minutes: number) =>
  new Date(Date.parse("2026-11-01T00:00:00.000Z") + minutes * 60_000).toISOString();

const SeenLine = z.looseObject({});

function hookSays(busy: boolean) {
  const socket = connect(join(dir, "hub.sock"));
  socket.on("connect", () => {
    socket.end(`${JSON.stringify({ type: "state", thread: "chat:9", busy })}\n`);
  });
}

async function settles(promise: Promise<unknown>) {
  const [settledAs] = await Promise.allSettled([promise]);

  return settledAs;
}

function calls(): string[][] {
  if (!existsSync(join(dir, "calls"))) {
    return [];
  }

  return readFileSync(join(dir, "calls"), "utf-8")
    .split("\n")
    .slice(0, -1)
    .map((each) => Args.parse(JSON.parse(each)));
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Once the hub knows the job its session runs as.
async function launched() {
  const started = await until(() => calls().find((each) => each[0] === "--bg"));
  await settled();

  return started;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A session connecting the way Claude Code does over HTTP: it initializes, opens the stream its messages arrive on, lists the tools, and lists them again when told they changed. Claude's job record has its id from the start.
async function session(thread: string, id = SESSION) {
  writeFileSync(
    join(dir, "jobs", "job12345", "state.json"),
    JSON.stringify({ state: "working", sessionId: id }),
  );
  const line = http(thread);
  await line.initialize();
  await line.open();
  await line.rpc("tools/list");
  await until(() => line.listed() === 2);
  await settled();

  return line;
}

function http(thread?: string, extra: Record<string, string> = {}, deaf = 0) {
  return {
    ...channelLine({ stateDir: dir, path: "/telegram", channel: CHANNEL, thread, extra, deaf }),
    send: (payload: HubLine) => sendToHub(payload),
  };
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A line to hub.sock, the way a session's hooks and hex's own tools reach the hub. Resolves once the hub has read it and closed its end.
function sendToHub(payload: HubLine) {
  const socket = connect(join(dir, "hub.sock"));
  sockets.push(socket);
  socket.on("connect", () => {
    socket.end(`${JSON.stringify(payload)}\n`);
  });

  return new Promise<void>((resolve) => {
    socket.on("close", () => {
      resolve();
    });
  });
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Claude's record of a background job, with the flags it restarts with: they read the thread's settings file, which binds the session to it. The job defaults to the session's short id, as Claude lists a job without one.
function bound(thread: string, id = SESSION, jobId = id.slice(0, 8), channel = CHANNEL) {
  mkdirSync(join(dir, "jobs", jobId), { recursive: true });
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const settings = join(dir, "sessions", `${encodeURIComponent(thread)}.json`);
  writeFileSync(
    settings,
    JSON.stringify({ enabledPlugins: {}, env: { HEX_CHANNEL: channel, HEX_THREAD: thread } }),
  );
  writeFileSync(
    join(dir, "jobs", jobId, "state.json"),
    JSON.stringify({
      state: "working",
      sessionId: id,
      respawnFlags: ["--channels", channel, "--settings", settings],
    }),
  );
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Rewrites a job's record, resolving once a watch of the test's own has seen it, as the hub's watch would.
function job(id: string, record: JobRecord) {
  const folder = join(dir, "jobs", id);

  const seen = new Promise<void>((resolve) => {
    const watcher = watch(folder, () => {
      watcher.close();
      resolve();
    });
  });

  writeFileSync(join(folder, "state.json"), JSON.stringify(record));

  return seen.then(settled);
}

function saved(id = SESSION, folder = join(dir, "hex")) {
  const project = join(dir, "projects", folder.replaceAll(/[^a-zA-Z0-9]/gu, "-"));
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${id}.jsonl`), "{}\n");
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A line of the session's transcript: a request that sent this much context, or a compaction down to it.
function said(tokens: number, compacted = false, id = SESSION, at = clock.now()) {
  const project = join(dir, "projects", join(dir, "hex").replaceAll(/[^a-zA-Z0-9]/gu, "-"));
  mkdirSync(project, { recursive: true });

  const line = compacted
    ? {
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: { trigger: "manual", preTokens: 0, postTokens: tokens },
      }
    : {
        type: "assistant",
        message: {
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: tokens - 102,
          },
        },
      };

  appendFileSync(
    join(project, `${id}.jsonl`),
    `${JSON.stringify({ ...line, timestamp: new Date(at).toISOString() })}\n`,
  );
}

function settingsOf(args: string[]) {
  const file = args[args.indexOf("--settings") + 1] ?? "";

  return SettingsFile.parse(JSON.parse(readFileSync(file, "utf-8")));
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Without the digest of what each session started with, which only the renew tests look at.
function registry(): Record<string, Registered> {
  return Object.fromEntries(
    open(dir)
      .threads.list({ open: true })
      .map(({ app: _app, thread, open: _open, launched: _launched, fork, ...known }) => [
        thread,
        { ...known, ...(fork !== undefined && fork !== "" && { from: fork }) },
      ]),
  );
}

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

test("a message for a new thread starts a session bound to that thread", async () => {
  start();
  hub.deliver("chat:7", "Desk anchors", message);
  const args = await launched();
  expect(args.slice(0, 5)).toEqual(["--bg", "--channels", CHANNEL, "--name", "Desk anchors"]);
  expect(args).not.toContain("--resume");
  expect(settingsOf(args)).toEqual({
    enabledPlugins: { "telegram@hex": true },
    env: {
      HEX_CHANNEL: CHANNEL,
      HEX_THREAD: "chat:7",
      HEX_HUB: join(dir, "hub.sock"),
      HEX_PORT: String(listener.port),
      HEX_TOKEN: readFileSync(join(dir, "token"), "utf-8"),
      HEX_STORE: dir,
      HEX_HELD: join(dir, "sessions", "chat%3A7"),
    },
  });
  expect(states).toEqual([["chat:7", true]]);
});

test("a message carrying a change to hex's records is kept and told only with it: a failed or empty change sends nothing", () => {
  start();

  expect(hub.deliver("chat:7", "Desk anchors", { ...message, key: "tap:1" }, failsToSave)).toBe(
    false,
  );
  expect(hub.deliver("chat:7", "Desk anchors", { ...message, key: "tap:2" }, () => false)).toBe(
    false,
  );
  expect(open(dir).db.query("select count(*) as n from messages").get()).toEqual({ n: 0 });
  expect(states).toEqual([]);
});

test("a new thread prompt comes last, where --channels cannot swallow it", async () => {
  start();
  hub.open("chat:8", "OpenAI", "find the latest model");
  const args = await launched();
  expect(args.at(-1)).toBe("find the latest model");
  expect(args.at(-3)).toBe("--settings");
});

test("queued messages reach the session when it connects, and its id is kept", async () => {
  start();
  hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  saved();
  const { received } = await session("chat:7");
  await until(() => received.length);
  expect(received).toEqual([inbound(message)]);
  expect(registry()["chat:7"]).toEqual({ name: "Desk anchors", session: SESSION });
});

test("a stopped thread has its job record cleared, then resumes under the same id", async () => {
  start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } }, agents: [] });
  hub.deliver("chat:7", "Desk anchors", message);
  const args = await launched();
  expect(
    calls().find((each) => !["agents", "daemon", "--version"].includes(each[0] ?? "")),
  ).toEqual(["rm", SESSION.slice(0, 8)]);
  expect(args).toContain("--resume");
  expect(args[args.indexOf("--resume") + 1]).toBe(SESSION);
});

test("a thread whose session is still running is never relaunched", async () => {
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
  });
  hub.deliver("chat:7", "Desk anchors", message);
  await settled();
  expect(calls().every((each) => each[0] === "agents")).toBe(true);
  const { received } = await session("chat:7");
  await until(() => received.length);
  expect(heard(received)[0]?.content).toBe("hi");
});

test("an answer Claude couldn't give is asked again, never read as nothing running", async () => {
  start({ agents: [{ sessionId: SESSION, pid: 42 }] });
  writeFileSync(join(dir, "unreadable"), "");
  hub.adopt("chat:7", "Desk anchors", SESSION);
  hub.deliver("chat:7", "Desk anchors", message);
  await time.lapse(1000);
  expect(calls()).toEqual([
    ["agents", "--json"],
    ["agents", "--json"],
  ]);
  const { received } = await session("chat:7");
  await until(() => received.length);
  expect(heard(received)[0]?.content).toBe("hi");
});

test("a daemon that went down while General ran is started, so the hub finds General instead of starting a copy", async () => {
  writeFileSync(join(dir, "down"), "");
  start({
    main: "chat",
    general: true,
    registry: { chat: { name: "hex", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
  });
  await until(() => calls().some((each) => each[0] === "daemon" && each[1] === "run"));
  await time.lapse(1000);
  const run = calls().findIndex((each) => each[0] === "daemon" && each[1] === "run");
  expect(calls().slice(run + 1)).toContainEqual(["agents", "--json"]);
  expect(calls().filter((each) => each[0] !== "agents" && each[0] !== "daemon")).toEqual([]);
});

test("a daemon left on an older claude is stopped with its sessions kept, so the session starts on a current one", async () => {
  writeFileSync(join(dir, "daemon"), "2.0.9");
  start({ main: "chat", general: true });
  await launched();

  const daemon = calls()
    .filter((each) => each[0] === "daemon" || each[0] === "--bg")
    .map((each) => each.slice(0, 4).join(" "));

  expect(daemon.slice(-2)).toEqual([
    "daemon stop --any --keep-workers",
    `--bg --channels ${CHANNEL} --name`,
  ]);
});

test("a session's start checks the daemon while its old record is removed, so the wait for one doesn't add to the other", async () => {
  writeFileSync(join(dir, "slow"), "");
  start({ main: "chat", general: true, registry: { chat: { name: "hex", session: SESSION } } });
  await launched();

  const order = calls().map((each) => each[0]);

  expect(order.indexOf("--version")).toBeLessThan(order.indexOf("rm"));
});

test("a daemon on the claude that's installed is left running", async () => {
  start({ main: "chat", general: true });
  await launched();
  expect(calls().some((each) => each[0] === "daemon" && each[1] === "stop")).toBe(false);
});

test("the main thread starts with the hub, under its name, with no prompt and no typing", async () => {
  start({ main: "chat", general: true });
  const args = await launched();
  expect(args.slice(0, 5)).toEqual(["--bg", "--channels", CHANNEL, "--name", "hex"]);
  expect(args.at(-2)).toBe("--settings");
  expect(settingsOf(args).env.HEX_MAIN).toBe("1");
  expect(states).toEqual([]);
});

test("a running main thread is left to reconnect, and gets its messages when it does", async () => {
  start({
    main: "chat",
    registry: { chat: { name: "chat", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
  });
  hub.deliver("chat", "hex", message);
  await settled();
  expect(calls().every((each) => each[0] === "agents")).toBe(true);
  expect(registry().chat?.name).toBe("hex");
  const { received } = await session("chat");
  await until(() => received.length);
  expect(heard(received)[0]?.content).toBe("hi");
});

test("a main thread whose session is gone is resumed again, and is never stopped for being idle", async () => {
  start({
    main: "chat",
    registry: { chat: { name: "hex", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
    reconnect: 50,
    idleStop: 20,
  });
  const { close, send } = await session("chat");
  await send({ type: "state", thread: "chat", busy: false });
  await time.advance(100);
  expect(calls().filter((each) => each[0] === "stop")).toEqual([]);
  writeFileSync(join(dir, "agents"), "[]");
  close();
  await time.lapse(50);
  const args = await launched();
  expect(args[args.indexOf("--resume") + 1]).toBe(SESSION);
});

test("a session that dies mid-turn has its turn ended in hex's record once its channel stays gone, and a turn that ended keeps its end", async () => {
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
    reconnect: 50,
  });
  const { close } = await session("chat:7");
  open(dir).turns.turned(SESSION, true, "2026-01-01T00:00:00.000Z");
  writeFileSync(join(dir, "agents"), "[]");
  close();
  await time.armed(50);
  expect(open(dir).turns.get(SESSION).ended).toBeUndefined();
  await time.lapse(50);
  const ended = await until(() => open(dir).turns.get(SESSION).ended);
  expect(ended > "2026-01-01T00:00:00.000Z").toBe(true);

  writeFileSync(join(dir, "agents"), JSON.stringify([{ sessionId: SESSION, pid: 42 }]));
  hub.deliver("chat:7", "Desk anchors", message);
  const again = await session("chat:7");
  open(dir).turns.turned(SESSION, false, "2027-01-01T00:00:00.000Z");
  writeFileSync(join(dir, "agents"), "[]");
  again.close();
  await time.lapse(50);
  await settled();
  expect(open(dir).turns.get(SESSION).ended).toBe("2027-01-01T00:00:00.000Z");
});

test("what a session took and never answered goes to the thread's next session once it dies; what it answered stays answered", async () => {
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
    reconnect: 50,
  });
  hub.deliver("chat:7", "Desk anchors", { ...message, content: "answered" });
  const first = await session("chat:7");
  await until(() => first.received.length);
  open(dir).turns.turned(SESSION, true, "2026-01-01T00:00:00.000Z");
  fold(first.received);
  open(dir).turns.turned(SESSION, false);
  open(dir).turns.handled(SESSION);
  hub.deliver("chat:7", "Desk anchors", { ...message, content: "hanging" });
  await until(() => first.received.length === 2);
  open(dir).turns.turned(SESSION, true);
  fold(first.received.slice(1));
  writeFileSync(join(dir, "agents"), "[]");
  first.close();
  await time.lapse(50);
  await launched();
  const next = await session("chat:7");
  await until(() => next.received.length);
  expect(heard(next.received).map((each) => each.content)).toEqual(["hanging"]);
  expect(holds).toContainEqual(["chat:7", "hanging", true]);
});

test("a hub that starts after its sessions died (a reboot) gives what they never answered to their threads' next sessions", async () => {
  const store = open(dir);
  store.threads.keep("telegram", { "chat:7": { name: "Desk anchors", session: SESSION } });
  store.messages.deliver({
    key: "telegram:1:9",
    to: "chat:7",
    from: "telegram",
    author: "owner",
    body: "mid-turn",
    meta: {},
  });
  store.turns.turned(SESSION, true, "2026-01-01T00:00:00.000Z");
  store.messages.take("telegram:1:9", SESSION);
  start({ agents: [], reconnect: 50 });
  await time.lapse(50);
  await launched();
  const next = await session("chat:7");
  await until(() => next.received.length);
  expect(heard(next.received)[0]?.content).toBe("mid-turn");
  expect(store.turns.get(SESSION).ended).toBeDefined();
});

test("a session that died while its background agents still worked (a reboot) gives what it took to its thread's next session", async () => {
  const store = open(dir);
  store.threads.keep("telegram", { "chat:7": { name: "Desk anchors", session: SESSION } });
  store.messages.deliver({
    key: "telegram:1:10",
    to: "chat:7",
    from: "telegram",
    author: "owner",
    body: "research it in the background",
    meta: {},
  });
  store.turns.turned(SESSION, true, "2026-01-01T00:00:00.000Z");
  store.messages.take("telegram:1:10", SESSION);

  const hook = Bun.spawn(["bun", join(import.meta.dir, "state.ts"), "idle"], {
    env: { ...process.env, HEX_STORE: dir, MEMORY_DIR: "" },
    stdin: new Blob([
      JSON.stringify({
        hook_event_name: "Stop",
        session_id: SESSION,
        background_tasks: [{ type: "subagent", status: "running" }],
      }),
    ]),
  });

  await hook.exited;
  expect(store.turns.midTurn("chat:7")).toBe(true);
  start({ agents: [], reconnect: 50 });
  await time.lapse(50);
  await launched();
  const next = await session("chat:7");
  await until(() => next.received.length);
  expect(heard(next.received)[0]?.content).toBe("research it in the background");
  expect(store.turns.midTurn("chat:7")).toBe(false);
});

test("a session the hub stops while idle has handled what it took, even with its turn left open (Esc in an attached terminal runs no Stop hook)", async () => {
  start({ idleStop: 50, reconnect: 50 });
  hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  const line = await session("chat:7");
  await until(() => line.received.length);
  open(dir).turns.turned(SESSION, true, "2026-01-01T00:00:00.000Z");
  fold(line.received);
  await line.send({ type: "state", thread: "chat:7", busy: false });
  await time.lapse(50);
  await until(() => calls().some((each) => each[0] === "stop"));
  const starts = calls().filter((each) => each[0] === "--bg").length;
  line.close();
  await time.lapse(50);
  await settled();
  expect(open(dir).messages.untaken("chat:7")).toEqual([]);
  expect(open(dir).turns.get(SESSION).handled).toBeDefined();
  expect(calls().filter((each) => each[0] === "--bg").length).toBe(starts);
});

test("a session whose turn failed (StopFailure) keeps what it took when it stops, since its conversation holds it", async () => {
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
    reconnect: 50,
  });
  hub.deliver("chat:7", "Desk anchors", message);
  const line = await session("chat:7");
  await until(() => line.received.length);
  open(dir).turns.turned(SESSION, true, "2026-01-01T00:00:00.000Z");
  fold(line.received);
  open(dir).turns.turned(SESSION, false);
  writeFileSync(join(dir, "agents"), "[]");
  line.close();
  await time.lapse(50);
  await settled();
  expect(open(dir).messages.untaken("chat:7")).toEqual([]);
  expect(calls().some((each) => each[0] === "--bg")).toBe(false);
});

test("a session that dies before its conversation is saved leaves the thread on its last saved one", async () => {
  const OLD = SESSION;
  const NEW = "4460ed71-0000-4000-8000-000000000000";
  saved(OLD);
  start({
    main: "chat",
    registry: { chat: { name: "hex", session: OLD } },
    agents: [],
    reconnect: 50,
  });
  await launched();
  const { close } = await session("chat", NEW);
  expect(registry().chat?.session).toBe(OLD);
  close();
  await time.lapse(50);
  await until(() => calls().filter((each) => each[0] === "--bg").length === 2);
  const args = calls().filter((each) => each[0] === "--bg")[1] ?? [];
  expect(args[args.indexOf("--resume") + 1]).toBe(OLD);
  const back = await session("chat", OLD);
  back.close();
  await time.lapse(50);
  await until(() => calls().filter((each) => each[0] === "--bg").length === 3);
  const next = await session("chat", NEW);
  saved(NEW);
  await next.send({ type: "state", thread: "chat", busy: false });
  await until(() => registry().chat?.session === NEW);
  void hub.stop("chat");
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    NEW.slice(0, 8),
  ]);
});

test("tool calls act on the calling session's own thread", async () => {
  start();
  const { call } = await session("chat:9");
  expect(await call("reply", { text: "yo" })).toEqual({
    content: [{ type: "text", text: "reply in chat:9" }],
  });
});

test("a permission prompt reaches the client with its thread, and the answer goes back to that session alone", async () => {
  start();
  const desk = await session("chat:9");
  const other = await session("chat:10");

  const request = {
    request_id: "abcde",
    tool_name: "Bash",
    description: "List files",
    input_preview: '{"command":"ls"}',
  };

  await desk.ask(request);
  const [thread, asked] = await until(() => prompts[0]);
  expect(thread).toBe("chat:9");
  expect(asked).toMatchObject(request);
  hub.answer("chat:9", "abcde", "allow");
  await until(() => desk.received.length);
  expect(desk.received).toEqual([{ type: "permission", request_id: "abcde", behavior: "allow" }]);
  expect(other.received).toEqual([]);
});

test("a dropped channel that comes back while Claude Code reconnects it leaves its session running", async () => {
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, startedAt: 1 }],
    reconnect: 100,
  });
  const first = await session("chat:7");
  first.close();
  await time.armed(100);
  const back = await session("chat:7");
  await time.advance(200);
  expect(calls().filter((each) => each[0] !== "agents")).toEqual([]);
  hub.deliver("chat:7", "Desk anchors", message);
  await until(() => back.received.length);
});

test("a session still running once its channel stays gone restarts in place, and gets what waited when it reconnects", async () => {
  bound("chat:7");
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, startedAt: 1 }],
    reconnect: 50,
  });
  const { close } = await session("chat:7");
  close();
  await time.lapse(50);
  expect(await until(() => calls().find((each) => each[0] === "respawn"))).toEqual([
    "respawn",
    SESSION.slice(0, 8),
  ]);
  expect(
    SettingsFile.parse(JSON.parse(readFileSync(join(dir, "sessions", "chat%3A7.json"), "utf-8")))
      .env.HEX_TOKEN,
  ).toBe(readFileSync(join(dir, "token"), "utf-8"));
  hub.deliver("chat:7", "Desk anchors", message);
  const back = await session("chat:7");
  await until(() => back.received.length);
  expect(heard(back.received)[0]?.content).toBe("hi");
  await time.advance(150);
  expect(calls().filter((each) => each[0] === "respawn").length).toBe(1);
  expect(failures).toEqual([]);
});

test("a starting session gets as long as Claude Code is told to wait for its channel, and its message shows it waits until the session takes it", async () => {
  start({ reconnect: 50, connect: 1000 });
  hub.deliver("chat:7", "Desk anchors", message);
  const args = await launched();
  expect(settingsOf(args).env.MCP_TIMEOUT).toBe("1000");
  expect(holds).toEqual([["chat:7", "hi", true]]);
  bound("chat:7", SESSION, "job12345");
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ id: "job12345", sessionId: SESSION, pid: 42, startedAt: 1 }]),
  );
  await time.advance(900);
  expect(calls().filter((each) => each[0] === "respawn")).toEqual([]);
  const line = await session("chat:7");
  await until(() => line.received.length);
  expect(holds).toEqual([["chat:7", "hi", true]]);
  fold(line.received);
  await until(() => holds.length === 2);
  expect(holds[1]).toEqual(["chat:7", "hi", false]);
  expect(failures).toEqual([]);
});

test("a starting session still running once the wait for a slow hub is over restarts in place", async () => {
  start({ reconnect: 50, connect: 200 });
  hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  bound("chat:7", SESSION, "job12345");
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ id: "job12345", sessionId: SESSION, pid: process.pid, startedAt: 1 }]),
  );
  await time.advance(150);
  expect(calls().filter((each) => each[0] === "respawn")).toEqual([]);
  await time.advance(100);
  expect(await until(() => calls().find((each) => each[0] === "respawn"))).toEqual([
    "respawn",
    "job12345",
  ]);
});

test("a starting session that has ended is reported the next time the hub looks, not after the wait for a slow hub", async () => {
  start({ reconnect: 50, connect: 60_000, agents: [] });
  hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  await time.lapse(50);
  await until(() => failures.length);
  expect(failures).toEqual([["chat:7", "its session ended before its channel connected"]]);
});

test("a session that restarts in place keeps what its launcher added to its settings, and gets the hub's current token", async () => {
  bound("chat:7");
  const file = join(dir, "sessions", "chat%3A7.json");
  writeFileSync(
    file,
    JSON.stringify({
      model: "claude-sonnet-5-5",
      claudeMdExcludes: ["/rules.md"],
      enabledPlugins: { "other@hex": true },
      env: { HEX_CHANNEL: CHANNEL, HEX_THREAD: "chat:7", HEX_TOKEN: "old", HEX_WAKE: "/wake.md" },
    }),
  );
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, startedAt: 1 }],
    reconnect: 50,
  });
  await time.lapse(50);
  await until(() => calls().find((each) => each[0] === "respawn"));
  const settings = SettingsFile.parse(JSON.parse(readFileSync(file, "utf-8")));
  expect(settings).toMatchObject({
    model: "claude-sonnet-5-5",
    claudeMdExcludes: ["/rules.md"],
    enabledPlugins: { "other@hex": true, "telegram@hex": true },
    env: { HEX_WAKE: "/wake.md", HEX_THREAD: "chat:7" },
  });
  expect(settings.env.HEX_TOKEN).toBe(readFileSync(join(dir, "token"), "utf-8"));
});

test("a session that restarts in place and still gets no channel is reported, not restarted again", async () => {
  bound("chat:7");
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, startedAt: 1 }],
    reconnect: 50,
  });
  const { close } = await session("chat:7");
  close();
  await time.lapse(50);
  await until(() => calls().find((each) => each[0] === "respawn"));
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ sessionId: SESSION, pid: 43, startedAt: clock.now() }]),
  );
  await time.lapse(50);
  expect(failures).toEqual([]);
  await time.lapse(50);
  expect(failures[0]).toEqual(["chat:7", "its session runs, but its channel never connects"]);
  expect(calls().filter((each) => each[0] === "respawn").length).toBe(1);
});

test("a session that outlived the hub and never reconnects restarts in place", async () => {
  bound("chat:7");
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, startedAt: 1 }],
    reconnect: 50,
  });
  await time.lapse(50);
  expect(await until(() => calls().find((each) => each[0] === "respawn"))).toEqual([
    "respawn",
    SESSION.slice(0, 8),
  ]);
});

test("a session found by the job it was started for restarts in place, though its conversation is not saved", async () => {
  bound("chat:7", "0a1b2c3d-0000-4000-8000-000000000009", "job99999");
  start({
    registry: { "chat:7": { name: "Desk anchors" } },
    agents: [
      { id: "job99999", sessionId: "0a1b2c3d-0000-4000-8000-000000000009", pid: 42, startedAt: 1 },
    ],
    reconnect: 50,
  });
  await time.lapse(50);
  expect(await until(() => calls().find((each) => each[0] === "respawn"))).toEqual([
    "respawn",
    "job99999",
  ]);
});

test("a message for a thread whose new session runs but has no conversation saved yet waits for that session instead of starting another", async () => {
  const NEW = "0a1b2c3d-0000-4000-8000-000000000009";
  bound("chat:7", NEW, "job99999");
  start({
    registry: { "chat:7": { name: "Desk anchors" } },
    agents: [{ id: "job99999", sessionId: NEW, pid: 42, startedAt: clock.now() + 60_000 }],
    reconnect: 60_000,
  });
  hub.deliver("chat:7", "Desk anchors", message);
  await settled();
  const { received } = await session("chat:7", NEW);
  await until(() => received.length);
  expect(calls().some((each) => each[0] === "--bg")).toBe(false);
});

test("a message for a running session with no channel waits for it, and starts it again once it has ended", async () => {
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, startedAt: clock.now() + 60_000 }],
    reconnect: 50,
  });
  hub.deliver("chat:7", "Desk anchors", message);
  await settled();
  expect(calls().some((each) => each[0] === "--bg")).toBe(false);
  writeFileSync(join(dir, "agents"), "[]");
  await time.lapse(50);
  const args = await launched();
  expect(args[args.indexOf("--resume") + 1]).toBe(SESSION);
  const { received } = await session("chat:7");
  await until(() => received.length);
  expect(heard(received)[0]?.content).toBe("hi");
});

test("a new session's channel opens once it lists the tools again after hearing they changed, since Claude Code listens for both at once", async () => {
  start();
  hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  writeFileSync(
    join(dir, "jobs", "job12345", "state.json"),
    JSON.stringify({ state: "working", sessionId: SESSION }),
  );
  const line = http("chat:7");

  const { result } = Initialized.parse(
    await line.rpc("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    }),
  );

  expect(result.capabilities.tools).toEqual({ listChanged: true });
  await line.initialize();
  await line.open();
  await settled();
  expect(line.received).toEqual([]);
  await line.rpc("tools/list");
  await until(() => line.listed() === 2);
  await until(() => line.received.length);
  expect(line.received).toEqual([inbound(message)]);
});

test("a session starting cold that drops the first tools/list_changed is told again until it lists the tools", async () => {
  start();
  hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  const line = http("chat:7", {}, 2);
  await line.initialize();
  await line.open();
  await line.rpc("tools/list");
  await time.lapse(250);
  expect(line.listed()).toBe(1);
  expect(line.received).toEqual([]);
  await time.lapse(250);
  await until(() => line.received.length);
  expect(line.listed()).toBe(2);
  expect(line.received).toEqual([inbound(message)]);
});

test("a session that lists the tools before opening its stream hears they changed once the stream opens", async () => {
  start();
  hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  const line = http("chat:7");
  await line.initialize();
  await line.rpc("tools/list");
  await line.open();
  await until(() => line.listed() === 2);
  await until(() => line.received.length);
  expect(line.received).toEqual([inbound(message)]);
});

test("a stream back from before the hub restarted carries on under its old id, without initializing again", async () => {
  start();
  const line = http("chat:7");
  const response = await line.open(crypto.randomUUID());
  expect(response.status).toBe(200);
  hub.deliver("chat:7", "Desk anchors", message);
  await until(() => line.received.length);
  expect(calls().some((each) => each[0] === "--bg")).toBe(false);
  expect(await line.call("reply", { text: "yo" })).toEqual({
    content: [{ type: "text", text: "reply in chat:7" }],
  });
});

test("the hub declines the newest protocol, whose sessions get no channel, and offers one that has it", async () => {
  start();
  const line = http("chat:7");
  expect(Declined.parse(await line.rpc("server/discover")).error.code).toBe(-32_601);

  const { result } = Initialized.parse(
    await line.rpc("initialize", {
      protocolVersion: "2026-07-28",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    }),
  );

  expect(result.protocolVersion).toBe("2025-11-25");
  expect(result.capabilities.experimental).toEqual({
    "claude/channel": {},
    "claude/channel/permission": {},
  });
  expect(result.instructions).toBe(SERVER.instructions);
});

test("a request from a web page, or by a name other than localhost, is refused", async () => {
  start();
  expect(
    (await http("chat:7", { origin: "https://example.com" }).post({ id: 1, method: "ping" }))
      .status,
  ).toBe(403);
  expect(
    (await http("chat:7", { host: "example.com" }).post({ id: 1, method: "ping" })).status,
  ).toBe(403);
  expect((await http("chat:7").post({ id: 1, method: "ping" })).status).toBe(200);
});

test("a request without the hub's token is refused, and the token is the owner's alone", async () => {
  start();
  expect(
    (await http("chat:7", { authorization: "Bearer guess" }).post({ id: 1, method: "ping" }))
      .status,
  ).toBe(403);
  const { authorization: _, ...anonymous } = { authorization: "" };
  expect(
    (
      await fetch(`http://127.0.0.1:${listener.port}/telegram`, {
        method: "POST",
        headers: { "content-type": "application/json", ...anonymous },
        body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
      })
    ).status,
  ).toBe(403);
  expect(statSync(join(dir, "token")).mode % 0o1000).toBe(0o600);
  hub.deliver("chat:7", "Desk anchors", message);
  const settings = (await launched()).at(-1) ?? "";
  expect(statSync(settings).mode % 0o1000).toBe(0o600);
});

test("a session with no thread, or another channel's, gets no messages and acts on no thread", async () => {
  start();
  const unbound = http();
  await unbound.initialize();
  expect(await unbound.call("reply", { text: "yo" })).toEqual({
    content: [
      {
        type: "text",
        text: "reply failed: this session is not bound to a Telegram thread (HEX_THREAD is unset)",
      },
    ],
    isError: true,
  });

  const other = http(undefined, {
    "x-hex-channel": "plugin:discord@hex",
    "x-hex-thread": "chat:7",
  });

  await other.initialize();
  await other.open();
  await other.rpc("tools/list");
  hub.deliver("chat:7", "Desk anchors", message);
  await settled();
  expect(other.received).toEqual([]);
});

test("busy and idle from session hooks reach the client, and a dropped session is idle", async () => {
  start();
  const { close } = await session("chat:9");

  hookSays(true);
  await until(() => states.length === 1);
  hookSays(false);
  await until(() => states.length === 2);
  close();
  await until(() => states.length === 3);
  expect(states).toEqual([
    ["chat:9", true],
    ["chat:9", false],
    ["chat:9", false],
  ]);
});

test("an idle thread is stopped, and a busy one is not", async () => {
  start({ idleStop: 50 });
  hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: false });
  await send({ type: "state", thread: "chat:7", busy: true });
  await time.advance(120);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
  await send({ type: "state", thread: "chat:7", busy: false });
  await time.lapse(50);
  const stop = await until(() => calls().find((each) => each[0] === "stop"));
  expect(stop).toEqual(["stop", SESSION.slice(0, 8)]);
});

test("a session that starts without a prompt is stopped once idle", async () => {
  start({ idleStop: 50 });
  hub.open("chat:8", "OpenAI");
  await launched();
  await session("chat:8");
  await time.lapse(50);
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
});

test("an idle thread whose session Claude still reports busy is not stopped until it goes idle again", async () => {
  start({
    idleStop: 50,
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, status: "busy" }],
  });
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: false });
  await time.lapse(50);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ sessionId: SESSION, pid: 42, status: "idle" }]),
  );
  await send({ type: "state", thread: "chat:7", busy: false });
  await time.lapse(50);
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
});

test("an idle thread with a big conversation compacts while its cache is warm, without showing as working, then stops", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  start({
    idleStop: 50,
    compactAbove: 150_000,
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "idle", startedAt: clock.now() + 60_000 }],
  });
  said(40_000);
  said(200_000);
  const first = await session("chat:7");
  await first.send({ type: "state", thread: "chat:7", busy: false });
  await time.lapse(50);
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  writeFileSync(join(dir, "agents"), "[]");
  first.close();
  old.kill();
  const args = await launched();
  expect(args[args.indexOf("--resume") + 1]).toBe(SESSION);
  expect(args.at(-1)).toBe("/compact");
  said(9000, true);
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([
      { sessionId: SESSION, pid: 42, status: "idle", startedAt: clock.now() + 60_000 },
    ]),
  );
  await session("chat:7");
  await time.lapse(50);
  await until(() => calls().filter((each) => each[0] === "stop").length === 2);
  expect(calls().filter((each) => each[0] === "--bg")).toHaveLength(1);
  expect(states.filter(([, busy]) => busy)).toEqual([]);
});

test("an idle thread with a small conversation, or one leaving, stops without compacting", async () => {
  start({
    idleStop: 50,
    compactAbove: 150_000,
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, status: "idle", startedAt: clock.now() + 60_000 }],
  });
  said(120_000);
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: false });
  await time.lapse(50);
  await until(() => calls().find((each) => each[0] === "stop"));
  said(400_000);
  void hub.retire("chat:7");
  await until(() => calls().filter((each) => each[0] === "stop").length === 2);
  await settled();
  expect(calls().some((each) => each[0] === "--bg")).toBe(false);
});

test("the main thread compacts a big conversation before its cache goes cold, and otherwise keeps running", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  start({
    main: "chat",
    cacheWarm: 50,
    compactAbove: 150_000,
    reconnect: 60_000,
    registry: { chat: { name: "hex", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "idle", startedAt: clock.now() + 60_000 }],
  });
  said(100_000);
  const { send, close } = await session("chat");
  await send({ type: "state", thread: "chat", busy: false });
  await time.advance(200);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
  said(300_000);
  await send({ type: "state", thread: "chat", busy: false });
  await time.lapse(50);
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  writeFileSync(join(dir, "agents"), "[]");
  close();
  old.kill();
  const args = await launched();
  expect(args[args.indexOf("--resume") + 1]).toBe(SESSION);
  expect(args.at(-1)).toBe("/compact");
  expect(states.filter(([, busy]) => busy)).toEqual([]);
});

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The line Claude Code writes when /compact fails, like with every account of the pool out of usage.
function failedCompaction(at = clock.now()) {
  const project = join(dir, "projects", join(dir, "hex").replaceAll(/[^a-zA-Z0-9]/gu, "-"));

  const content =
    "<local-command-stderr>Error during compaction: API Error: rate_limit_error</local-command-stderr>";

  appendFileSync(
    join(project, `${SESSION}.jsonl`),
    `${JSON.stringify({
      type: "system",
      subtype: "local_command",
      content,
      timestamp: new Date(at).toISOString(),
    })}\n`,
  );
}

test("a compaction that fails isn't tried again on a timer, only once another session's turn ends with an answer", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  start({
    main: "chat",
    cacheWarm: 50,
    compactAbove: 150_000,
    reconnect: 60_000,
    registry: { chat: { name: "hex", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "idle", startedAt: clock.now() + 60_000 }],
  });
  said(300_000);
  const first = await session("chat");
  await first.send({ type: "state", thread: "chat", busy: false });
  await time.lapse(50);
  await until(() => calls().find((each) => each[0] === "stop"));
  writeFileSync(join(dir, "agents"), "[]");
  first.close();
  old.kill();
  expect((await launched()).at(-1)).toBe("/compact");
  failedCompaction();
  const resumed = Bun.spawn(["sleep", "30"]);
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([
      { sessionId: SESSION, pid: resumed.pid, status: "idle", startedAt: clock.now() + 60_000 },
    ]),
  );
  const { send, close } = await session("chat");
  await time.lapse(50);
  await time.advance(500);
  await send({ type: "state", thread: "chat:8", busy: false, failed: true });
  await settled();
  expect(calls().filter((each) => each[0] === "stop")).toHaveLength(1);
  await send({ type: "state", thread: "chat:8", busy: false });
  await until(() => calls().filter((each) => each[0] === "stop").length === 2);
  writeFileSync(join(dir, "agents"), "[]");
  close();
  resumed.kill();
  await until(() => calls().filter((each) => each[0] === "--bg").length === 2);
  expect(
    calls()
      .findLast((each) => each[0] === "--bg")
      ?.at(-1),
  ).toBe("/compact");
});

test("a thread whose compaction failed stops at its rest, and resumes to compact once a turn goes through", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  start({
    idleStop: 50,
    compactAbove: 150_000,
    reconnect: 1000,
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "idle", startedAt: clock.now() + 60_000 }],
  });
  said(200_000);
  const first = await session("chat:7");
  await first.send({ type: "state", thread: "chat:7", busy: false });
  await time.lapse(50);
  await until(() => calls().find((each) => each[0] === "stop"));
  writeFileSync(join(dir, "agents"), "[]");
  first.close();
  old.kill();
  await launched();
  failedCompaction();
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([
      { sessionId: SESSION, pid: EXITED, status: "idle", startedAt: clock.now() + 60_000 },
    ]),
  );
  const second = await session("chat:7");
  await time.lapse(50);
  await until(() => calls().filter((each) => each[0] === "stop").length === 2);
  second.close();
  await time.lapse(1000);
  expect(calls().filter((each) => each[0] === "--bg")).toHaveLength(1);
  await second.send({ type: "state", thread: "chat:9", busy: false });
  await until(() => calls().filter((each) => each[0] === "--bg").length === 2);

  const args = calls().findLast((each) => each[0] === "--bg") ?? [];

  expect(args[args.indexOf("--resume") + 1]).toBe(SESSION);
  expect(args.at(-1)).toBe("/compact");
  expect(states.filter(([, busy]) => busy)).toEqual([]);
});

test("a line on hub.sock that isn't one of its requests is dropped, and the lines after it still work", async () => {
  start();
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

test("a launcher that can't run fails the start instead of leaving it hanging", async () => {
  start({ launcher: join(dir, "missing") });
  hub.deliver("chat:7", "Desk anchors", message);
  await until(() => failures.length);
  expect(failures[0]?.[0]).toBe("chat:7");
  expect(states).toEqual([
    ["chat:7", true],
    ["chat:7", false],
  ]);
});

test("a local open request starts a session for an existing topic with its prompt", async () => {
  start();
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
  start({
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
  start();
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

test("a message a live session was handed shows it waits once its line drops, until the session takes it", async () => {
  bound("chat:7");
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, startedAt: 1 }],
    reconnect: 50,
  });
  const line = await session("chat:7");
  hub.deliver("chat:7", "Desk anchors", message);
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
  open(dir).messages.deliver({
    key: "telegram:1:9",
    to: "chat:7",
    from: "telegram",
    author: "owner",
    body: "still there?",
    meta: { chat_id: "1", message_id: "9" },
  });
  start({
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

test("a session that fails to start is reported with its reason, and the next message retries", async () => {
  start();
  hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  writeFileSync(
    join(dir, "jobs", "job12345", "state.json"),
    JSON.stringify({ state: "failed", detail: "exit 1 before init" }),
  );
  await until(() => failures.length);
  expect(failures).toEqual([["chat:7", "exit 1 before init"]]);
  expect(states).toEqual([
    ["chat:7", true],
    ["chat:7", false],
  ]);
  hub.deliver("chat:7", "Desk anchors", message);
  await until(() => calls().filter((each) => each[0] === "--bg").length === 2);
});

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A launcher whose resumes fail as Claude Code fails one of a session no project folder has.
function forgetting() {
  const launcher = join(dir, "launch");
  writeFileSync(
    launcher,
    `#!/bin/sh
case "$*" in *--resume*) echo "backgrounded · jobgone1 · test"; exit 0;; esac
exec claude "$@"
`,
  );
  chmodSync(launcher, 0o755);
  mkdirSync(join(dir, "jobs", "jobgone1"));
  writeFileSync(
    join(dir, "jobs", "jobgone1", "state.json"),
    JSON.stringify({ state: "failed", detail: `source session ${SESSION} not found` }),
  );

  return launcher;
}

test("a thread whose session Claude Code no longer has starts a new one, which hears why when it connects", async () => {
  start({
    launcher: forgetting(),
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [],
  });
  hub.deliver("chat:7", "Desk anchors", message);
  expect(await launched()).not.toContain("--resume");
  expect(registry()["chat:7"]).toEqual({ name: "Desk anchors" });
  const { received } = await session("chat:7", "2c3d4e5f-0000-4000-8000-000000000000");
  await until(() => received.length === 2);
  const note = `[hub] Claude Code no longer has the conversation of session ${SESSION}, which this thread was to continue, so you're a new session without it; say so when you reply.`;
  expect(received).toEqual([
    inbound(message),
    { type: "inbound", content: note, meta: { key: `hub:chat:7:lost:${SESSION}`, user: "hub" } },
  ]);
  expect(failures).toEqual([]);
});

test("a resume Claude Code can't find, of a session another project folder has, fails and keeps the session", async () => {
  start({
    launcher: forgetting(),
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [],
  });
  saved(SESSION, join(dir, "elsewhere"));
  hub.deliver("chat:7", "Desk anchors", message);
  await until(() => failures.length);
  expect(failures).toEqual([["chat:7", `source session ${SESSION} not found`]]);
  expect(registry()["chat:7"]).toEqual({ name: "Desk anchors", session: SESSION });
});

test("a thread that would fork a session Claude Code no longer has starts a new one instead", async () => {
  start({
    launcher: forgetting(),
    registry: { "chat:7": { name: "Desk anchors", from: SESSION } },
    agents: [],
  });
  hub.deliver("chat:7", "Desk anchors", message);
  expect(await launched()).not.toContain("--resume");
  expect(registry()["chat:7"]).toEqual({ name: "Desk anchors" });
  expect(failures).toEqual([]);
});

test("a thread whose session failed to start starts again once another session connects, and gets the message that waited", async () => {
  start();
  hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  writeFileSync(
    join(dir, "jobs", "job12345", "state.json"),
    JSON.stringify({ state: "failed", detail: "daemon binary was deleted (upgrade in progress)" }),
  );
  await until(() => failures.length);
  writeFileSync(join(dir, "jobs", "job12345", "state.json"), JSON.stringify({ state: "working" }));
  hub.open("chat:8", "OpenAI");
  await until(() => bgStarts().length === 2);
  await session("chat:8", "1b2c3d4e-0000-4000-8000-000000000000");
  expect(settingsOf(await until(() => bgStarts()[2])).env.HEX_THREAD).toBe("chat:7");
  const { received } = await session("chat:7");
  await until(() => received.length);
  expect(received).toEqual([inbound(message)]);
});

test("a thread opened with a prompt, or as a fork, whose start failed starts again with it once another session connects", async () => {
  start();
  mkdirSync(join(dir, "work"));
  hub.open("chat:8", "OpenAI", "find the latest model", join(dir, "work"));
  hub.fork("chat:10", "Copy", SESSION, "carry on");
  await until(() => bgStarts().length === 2);
  await settled();
  writeFileSync(
    join(dir, "jobs", "job12345", "state.json"),
    JSON.stringify({ state: "failed", detail: "exit 1 before init" }),
  );
  await until(() => failures.length === 2);
  writeFileSync(join(dir, "jobs", "job12345", "state.json"), JSON.stringify({ state: "working" }));
  hub.open("chat:9", "Video clips");
  await until(() => bgStarts().length === 3);
  await session("chat:9", "1b2c3d4e-0000-4000-8000-000000000000");
  await until(() => bgStarts().length === 5);

  expect(startedAgainFor("chat:8").at(-1)).toBe("find the latest model");
  expect(hub.cwd("chat:8")).toBe(join(dir, "work"));
  expect(startedAgainFor("chat:10").slice(5, 8)).toEqual(["--resume", SESSION, "--fork-session"]);
  expect(startedAgainFor("chat:10").at(-1)).toBe("carry on");
});

test("a thread whose starts keep failing says so in its chat with each message, and General hears of it once, at the third", async () => {
  start({ main: "general", general: true });
  await launched();
  const general = await session("general");
  writeFileSync(
    join(dir, "jobs", "job12345", "state.json"),
    JSON.stringify({ state: "failed", detail: "exit 1 before init" }),
  );

  for (const n of [1, 2, 3, 4]) {
    hub.deliver("chat:7", "Desk anchors", { ...message, content: `try ${n}` });
    await until(() => restsOf("chat:7") === n);
  }

  expect(failures).toEqual(Array.from({ length: 4 }, () => ["chat:7", "exit 1 before init"]));
  await until(() => general.received.length);
  await Bun.sleep(50);
  expect(heard(general.received).map((turn) => turn.content)).toEqual([
    '[hub] hex couldn\'t start the session of telegram thread "Desk anchors" 3 times in a row: exit 1 before init. Its next message starts it again.',
  ]);
});

test("General hears of a thread that keeps failing once its hub is there, even when that's after the third", async () => {
  start();
  writeFileSync(
    join(dir, "jobs", "job12345", "state.json"),
    JSON.stringify({ state: "failed", detail: "exit 1 before init" }),
  );

  for (const n of [1, 2, 3]) {
    hub.deliver("chat:7", "Desk anchors", { ...message, content: `try ${n}` });
    await until(() => restsOf("chat:7") === n);
  }

  mkdirSync(join(dir, "general"));

  const general = startHub({
    stateDir: join(dir, "general"),
    storeDir: dir,
    channel: "plugin:discord@hex",
    server: SERVER,
    port: listener.port,
    main: "general",
    general: true,
    call: () => Promise.resolve(""),
    state: () => {},
    failed: () => {},
    hexDir: join(dir, "hex"),
  });

  try {
    hub.deliver("chat:7", "Desk anchors", { ...message, content: "try 4" });
    await until(() => restsOf("chat:7") === 4);
    await until(() => open(dir).messages.untaken("general").length);
    expect(
      open(dir)
        .messages.untaken("general")
        .map((row) => row.body),
    ).toEqual([
      '[hub] hex couldn\'t start the session of telegram thread "Desk anchors" 4 times in a row: exit 1 before init. Its next message starts it again.',
    ]);
  } finally {
    general.close();
  }
});

test("General whose start failed starts again with each next message, as its heartbeat, says so in its chat each time, and leaves itself no message", async () => {
  start({ main: "general", general: true });
  await launched();
  writeFileSync(
    join(dir, "jobs", "job12345", "state.json"),
    JSON.stringify({ state: "failed", detail: "exit 1 before init" }),
  );

  for (const n of [1, 2, 3]) {
    if (n > 1) {
      hub.deliver("general", "hex", { ...message, content: `try ${n}` });
    }

    await until(() => restsOf("general") === n);
    expect(calls().filter((each) => each[0] === "--bg")).toHaveLength(n);
  }

  expect(failures).toEqual(Array.from({ length: 3 }, () => ["general", "exit 1 before init"]));
  expect(
    open(dir)
      .messages.untaken("general")
      .map((row) => row.body),
  ).toEqual(["try 2", "try 3"]);
});

test("a thread whose start fails even once another session started is left to its own next message, and its chat hears only of that", async () => {
  const launcher = join(dir, "launch");
  writeFileSync(
    launcher,
    `#!/bin/sh
case "$*" in *chat%3A7*) echo try >> "${dir}/tries"; echo 'its folder is gone'; exit 1;; esac
exec claude "$@"
`,
  );
  chmodSync(launcher, 0o755);
  start({ launcher });

  const tries = () =>
    existsSync(join(dir, "tries"))
      ? readFileSync(join(dir, "tries"), "utf-8").split("\n").length - 1
      : 0;

  hub.deliver("chat:7", "Desk anchors", message);
  await until(() => failures.length);
  hub.open("chat:8", "OpenAI");
  await launched();
  const openai = await session("chat:8", "1b2c3d4e-0000-4000-8000-000000000000");
  await until(() => tries() === 2);
  openai.close();
  await session("chat:8", "1b2c3d4e-0000-4000-8000-000000000000");
  hub.open("chat:9", "Video clips");
  await until(() => calls().filter((each) => each[0] === "--bg").length === 2);
  await session("chat:9", "2c3d4e5f-0000-4000-8000-000000000000");
  await Bun.sleep(100);
  expect(tries()).toBe(2);
  expect(failures).toEqual([["chat:7", "its folder is gone"]]);
  hub.deliver("chat:7", "Desk anchors", { ...message, content: "again" });
  await until(() => tries() === 3);
  await until(() => failures.length === 2);
});

test("a thread whose messages keep failing to start gets a retry for each, so it starts once starts go through", async () => {
  const launcher = join(dir, "launch");
  writeFileSync(join(dir, "broken"), "");
  writeFileSync(
    launcher,
    `#!/bin/sh
case "$*" in *chat%3A7*) if [ -e "${dir}/broken" ]; then echo try >> "${dir}/tries"; echo 'its folder is gone'; exit 1; fi;; esac
exec claude "$@"
`,
  );
  chmodSync(launcher, 0o755);
  start({ launcher });

  const tries = () =>
    existsSync(join(dir, "tries"))
      ? readFileSync(join(dir, "tries"), "utf-8").split("\n").length - 1
      : 0;

  hub.deliver("chat:7", "Desk anchors", message);
  await until(() => failures.length);
  hub.open("chat:8", "OpenAI");
  await launched();
  await session("chat:8", "1b2c3d4e-0000-4000-8000-000000000000");
  await until(() => tries() === 2);
  hub.deliver("chat:7", "Desk anchors", { ...message, content: "again" });
  await until(() => failures.length === 2);
  rmSync(join(dir, "broken"));
  hub.open("chat:9", "Video clips");
  await until(() => calls().filter((each) => each[0] === "--bg").length === 2);
  await session("chat:9", "2c3d4e5f-0000-4000-8000-000000000000");
  await until(() => deskStarts().length === 1);
  expect(tries()).toBe(3);
});

test("a message that arrives while a retry starts makes the retry its own, so its chat hears if that start fails", async () => {
  const launcher = join(dir, "launch");
  writeFileSync(
    launcher,
    `#!/bin/sh
case "$*" in *chat%3A7*) echo try >> "${dir}/tries"; if [ "$(wc -l < "${dir}/tries")" -ge 2 ]; then while [ ! -e "${dir}/go" ]; do sleep 0.02; done; fi; echo 'its folder is gone'; exit 1;; esac
exec claude "$@"
`,
  );
  chmodSync(launcher, 0o755);
  start({ launcher });

  const tries = () =>
    existsSync(join(dir, "tries"))
      ? readFileSync(join(dir, "tries"), "utf-8").split("\n").length - 1
      : 0;

  hub.deliver("chat:7", "Desk anchors", message);
  await until(() => failures.length);
  hub.open("chat:8", "OpenAI");
  await launched();
  const connected = session("chat:8", "1b2c3d4e-0000-4000-8000-000000000000");
  await until(() => tries() === 2);
  hub.deliver("chat:7", "Desk anchors", { ...message, content: "again" });
  writeFileSync(join(dir, "go"), "");
  await connected;
  await until(() => failures.length === 2);
  expect(failures).toEqual([
    ["chat:7", "its folder is gone"],
    ["chat:7", "its folder is gone"],
  ]);
  expect(tries()).toBe(2);
});

test("a fork whose session runs without its channel starts again into that session, not a second copy", async () => {
  const FORKED = "2c3d4e5f-0000-4000-8000-000000000000";
  bound("chat:10", FORKED);
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ sessionId: FORKED, pid: 42, startedAt: 1 }]),
  );
  start({ reconnect: 50 });
  hub.fork("chat:10", "Copy", SESSION, "carry on");
  await time.lapse(50);
  await time.lapse(50);
  expect(failures[0]).toEqual(["chat:10", "its session runs, but its channel never connects"]);
  hub.open("chat:9", "Video clips");
  await until(() => bgStarts().length === 2);
  await session("chat:9", "1b2c3d4e-0000-4000-8000-000000000000");
  await time.lapse(50);
  await time.lapse(50);
  expect(states.filter(([thread, busy]) => thread === "chat:10" && !busy)).toHaveLength(2);
  expect(bgStarts()).toHaveLength(2);
  expect(calls().filter((each) => each[0] === "respawn")).toHaveLength(2);
});

test("a thread whose session runs without its channel is retried once, not each time another session starts", async () => {
  const STUCK = "2c3d4e5f-0000-4000-8000-000000000000";
  bound("chat:10", STUCK);
  writeFileSync(join(dir, "agents"), JSON.stringify([{ sessionId: STUCK, pid: 42, startedAt: 1 }]));
  start({ reconnect: 50 });
  hub.deliver("chat:10", "Stuck", message);
  await time.lapse(50);
  await time.lapse(50);
  expect(failures[0]).toEqual(["chat:10", "its session runs, but its channel never connects"]);
  hub.open("chat:8", "OpenAI");
  await until(() => calls().filter((each) => each[0] === "--bg").length === 1);
  await session("chat:8", "1b2c3d4e-0000-4000-8000-000000000000");
  await time.lapse(50);
  await time.lapse(50);
  expect(states.filter(([thread, busy]) => thread === "chat:10" && !busy)).toHaveLength(2);

  const resumed: [string, string][] = [
    ["chat:9", "3d4e5f60-0000-4000-8000-000000000000"],
    ["chat:11", "4e5f6071-0000-4000-8000-000000000000"],
  ];

  for (const [thread, id] of resumed) {
    hub.open(thread, thread);
    await until(() =>
      calls().some(
        (each) => each[0] === "--bg" && each.join(" ").includes(encodeURIComponent(thread)),
      ),
    );
    await session(thread, id);
  }

  await time.advance(300);
  expect(respawns()).toHaveLength(2);
  expect(failures).toHaveLength(1);
});

test("the owner's stop ends a thread's run of failed starts, so another session connecting doesn't start it again", async () => {
  start();
  hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  writeFileSync(
    join(dir, "jobs", "job12345", "state.json"),
    JSON.stringify({ state: "failed", detail: "exit 1 before init" }),
  );
  await until(() => failures.length);
  writeFileSync(join(dir, "jobs", "job12345", "state.json"), JSON.stringify({ state: "working" }));
  await hub.stop("chat:7");
  hub.open("chat:8", "OpenAI");
  await until(() => bgStarts().length === 2);
  await session("chat:8", "1b2c3d4e-0000-4000-8000-000000000000");
  await Bun.sleep(100);
  expect(bgStarts()).toHaveLength(2);
});

test("a session that connects ends the watch, so a later failed state is ignored", async () => {
  start();
  hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  await session("chat:7");
  await job("job12345", { state: "failed", detail: "later" });
  expect(failures).toEqual([]);
});

test("stopping a thread ends its session now, and its next message resumes it", async () => {
  start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  const { close, send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: true });
  await until(() => states.length);
  void hub.stop("chat:7");
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  close();
  await until(() => states.length === 2);
  writeFileSync(join(dir, "agents"), "[]");
  hub.deliver("chat:7", "Desk anchors", message);
  const args = await launched();
  expect(args[args.indexOf("--resume") + 1]).toBe(SESSION);
  expect(registry()["chat:7"]).toEqual({ name: "Desk anchors", session: SESSION });
});

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The session's conversation as Claude Code keeps it, for a thread working in hex's folder.
function conversation() {
  const file = join(
    dir,
    "projects",
    join(dir, "hex").replaceAll(/[^a-zA-Z0-9]/gu, "-"),
    `${SESSION}.jsonl`,
  );

  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, '{"type":"user","message":{"content":"run for a while"}}\n');

  return () => readFileSync(file, "utf-8");
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A session Claude's daemon lists as working, as it does through a turn and while background agents run.
function working() {
  const process = Bun.spawn(["sleep", "60"]);
  sleepers.push(process);

  return [{ sessionId: SESSION, pid: process.pid, status: "busy" }];
}

test("the owner's interrupt presses Esc in a busy session, which keeps running, and ends the turn, in hex's record of it too", async () => {
  start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } }, agents: working() });
  const transcript = conversation();
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: true });
  await until(() => states.length);
  open(dir).turns.turned(SESSION, true);
  await hub.interrupt("chat:7");
  expect(transcript()).toContain("[Request interrupted by user");
  expect(states.at(-1)).toEqual(["chat:7", false]);
  expect(open(dir).turns.get(SESSION).ended).toBeDefined();
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
});

test("an interrupted turn Claude still reports working counts as one with background work left, so a renew waits for it to be done", async () => {
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ ...working()[0], state: "working" }],
  });
  conversation();
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: true });
  await until(() => states.length);
  hub.renew("chat:7");
  await hub.interrupt("chat:7");
  await settled();
  expect(calls().some((each) => each[0] === "stop" || each[0] === "respawn")).toBe(false);
});

test("a Stop whose Esc lands in no turn leaves the session and its background work running", async () => {
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ ...working()[0], state: "working" }],
  });
  conversation();
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: true });
  await until(() => states.length);
  writeFileSync(join(dir, "idle"), "");
  const stopping = hub.interrupt("chat:7");
  await time.lapse(5000);
  expect(await settles(stopping)).toEqual({ status: "fulfilled", value: undefined });
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
});

test("a Stop leaves a turn alone that the hooks report over while its Esc goes in, even past a request that repeats an earlier interrupt", async () => {
  start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } }, agents: working() });
  const transcript = conversation();
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: true });
  await until(() => states.length);
  writeFileSync(join(dir, "idle"), "");
  const interrupting = hub.interrupt("chat:7");
  await until(() => transcript().includes("api-request-blob"));
  await send({ type: "state", thread: "chat:7", busy: false });
  await until(() => states.length === 2);
  await time.lapse(5000);
  expect(await settles(interrupting)).toEqual({ status: "fulfilled", value: undefined });
  expect(states).toEqual([
    ["chat:7", true],
    ["chat:7", false],
  ]);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
});

test("an interrupt leaves a session alone once its turn is over, background agents and all", async () => {
  start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } }, agents: working() });
  const transcript = conversation();
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: false, background: true });
  await until(() => states.length);
  await hub.interrupt("chat:7");
  expect(transcript()).not.toContain("[Request interrupted by user");
  expect(states).toEqual([["chat:7", false]]);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
});

test("a Stop after a hub restart presses Esc in a turn Claude's daemon says is working, though hex never heard it begin", async () => {
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ ...working()[0], state: "working" }],
  });
  const transcript = conversation();
  await session("chat:7");
  await hub.interrupt("chat:7");
  expect(transcript()).toContain("[Request interrupted by user");
  expect(states).toEqual([["chat:7", false]]);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
});

test("a Stop leaves alone a session whose turn hex never heard and Claude's daemon says is done", async () => {
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ ...working()[0], state: "done" }],
  });
  const transcript = conversation();
  await session("chat:7");
  await hub.interrupt("chat:7");
  expect(transcript()).not.toContain("[Request interrupted by user");
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
});

test("a message that comes while a stopped session is still exiting waits, even through a second stop, and resumes the thread once it has", async () => {
  const exiting = Bun.spawn(["sleep", "60"]);
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: exiting.pid, status: "busy" }],
  });
  const old = await session("chat:7");
  void hub.stop("chat:7");
  await until(() => calls().find((each) => each[0] === "stop"));
  writeFileSync(join(dir, "unanswering"), "");
  void hub.stop("chat:7");
  await settled();
  rmSync(join(dir, "unanswering"));
  hub.deliver("chat:7", "Desk anchors", message);
  await time.advance(300);
  expect(old.received).toEqual([]);
  expect(calls().some((each) => each[0] === "--bg")).toBe(false);
  exiting.kill();
  const args = await launched();
  expect(args[args.indexOf("--resume") + 1]).toBe(SESSION);
  const resumed = await session("chat:7");
  await until(() => resumed.received.length);
  expect(resumed.received[0]).toMatchObject({ type: "inbound", content: "hi" });
  expect(old.received).toEqual([]);
});

test("a stop goes out while Claude's daemon isn't answering, without waiting for it to answer", async () => {
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, status: "idle" }],
  });
  await session("chat:7");
  writeFileSync(join(dir, "unanswering"), "");
  void hub.stop("chat:7");
  await until(() => calls().find((each) => each[0] === "stop"));
});

test("a thread's model and effort are kept, and a running session takes them by starting again with its next message", async () => {
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, status: "idle" }],
  });
  const { received } = await session("chat:7");
  hub.deliver("chat:7", "Desk anchors", message);
  await until(() => received.length);
  fold(received);
  hub.configure("chat:7", { model: "fable", effort: "xhigh" });
  expect(registry()["chat:7"]).toEqual({
    name: "Desk anchors",
    session: SESSION,
    model: "fable",
    effort: "xhigh",
  });
  hub.deliver("chat:7", "Desk anchors", { author: "owner", content: "again", meta: {} });
  const args = await launched();
  expect([
    args[args.indexOf("--model") + 1],
    args[args.indexOf("--effort") + 1],
    args[args.indexOf("--resume") + 1],
  ]).toEqual(["fable", "xhigh", SESSION]);
  expect(heard(received).map((payload) => payload.content)).toEqual(["hi"]);
  const fresh = await session("chat:7");
  await until(() => fresh.received.length);
  expect(fresh.received[0]).toMatchObject({ type: "inbound", content: "again" });
});

test("a thread saved with a full model id runs its family's alias, so it gets the newest model", async () => {
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION, model: "claude-opus-5-5" } },
    agents: [],
  });
  hub.deliver("chat:7", "Desk anchors", message);
  const args = await launched();
  expect(args[args.indexOf("--model") + 1]).toBe("opus");
});

test("a fresh thread with no capacity starts a new session instead of resuming its last, and says so in its env", async () => {
  start({
    registry: { dm: { name: "DM", session: SESSION } },
    agents: [],
    fresh: (thread) => thread === "dm",
    capacity: 0,
  });
  hub.deliver("dm", "DM", message);
  const args = await launched();
  expect(args).not.toContain("--resume");
  expect(calls().some((each) => each[0] === "rm")).toBe(false);
  expect(settingsOf(args).env).toEqual({
    HEX_CHANNEL: CHANNEL,
    HEX_THREAD: "dm",
    HEX_HUB: join(dir, "hub.sock"),
    HEX_PORT: String(listener.port),
    HEX_TOKEN: readFileSync(join(dir, "token"), "utf-8"),
    HEX_STORE: dir,
    HEX_FRESH: "1",
  });
  saved(NEXT);
  const { received } = await session("dm", NEXT);
  await until(() => received.length);
  expect(registry().dm).toEqual({ name: "DM", session: NEXT });
});

test("a message to a fresh thread with no capacity steers its session while Claude reports it working, and starts a new one once it is done", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  start({
    registry: { dm: { name: "DM", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "busy" }],
    fresh: (thread) => thread === "dm",
    capacity: 0,
  });
  const { received, send } = await session("dm");
  hub.deliver("dm", "DM", message);
  await until(() => received.length);
  expect(received).toEqual([inbound(message)]);
  fold(received);
  said(50_000);
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ sessionId: SESSION, pid: old.pid, status: "idle" }]),
  );
  await send({ type: "state", thread: "dm", busy: false });
  hub.deliver("dm", "DM", { author: "owner", content: "next", meta: {} });
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  old.kill();
  const args = await launched();
  expect(args).not.toContain("--resume");
  expect(received).toHaveLength(1);
  const next = await session("dm", "0a1b2c3d-0000-4000-8000-000000000001");
  await until(() => next.received.length);
  expect(next.received[0]).toMatchObject({ type: "inbound", content: "next" });
});

test("a fresh thread keeps its session while it waits on a permission prompt or its turn is still running", async () => {
  start({
    registry: { dm: { name: "DM", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 999_999, state: "blocked" }],
    fresh: (thread) => thread === "dm",
  });
  const { received, send } = await session("dm");
  hub.deliver("dm", "DM", message);
  await until(() => received.length);
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ sessionId: SESSION, pid: 999_999, status: "idle" }]),
  );
  await send({ type: "state", thread: "dm", busy: true });
  await until(() => states.length);
  hub.deliver("dm", "DM", { author: "owner", content: "more", meta: {} });
  await until(() => received.length === 2);
  expect(calls().some((each) => each[0] === "stop" || each[0] === "--bg")).toBe(false);
});

const NEXT = "0a1b2c3d-0000-4000-8000-000000000001";

const dm = (
  agents: object[],
  options: {
    capacity?: number;
    cacheWarm?: number;
    idleStop?: number;
    compactAbove?: number;
    reconnect?: number;
    stale?: boolean;
  } = {},
) => {
  start({
    registry: { dm: { name: "DM", session: SESSION } },
    agents,
    fresh: (thread) => thread === "dm",
    capacity: 1000,
    ...options,
  });
};

test("a fresh thread's warm session takes every message as it comes, and stays up while it rests", async () => {
  dm([{ sessionId: SESSION, pid: 999_999, status: "idle", startedAt: clock.now() + 60_000 }], {
    idleStop: 10,
  });
  said(500);
  const { received, send } = await session("dm");
  hub.deliver("dm", "DM", message);
  await send({ type: "state", thread: "dm", busy: false });
  await until(() => states.length);
  hub.deliver("dm", "DM", { author: "owner", content: "next", meta: {} });
  await until(() => received.length === 2);
  await time.advance(100);
  expect(calls().some((each) => each[0] === "stop" || each[0] === "--bg")).toBe(false);
});

test("a fresh thread whose session stopped starts a new one, warm or not, since a start rewrites its view past the cache", async () => {
  dm([]);
  said(500);
  hub.deliver("dm", "DM", message);
  expect(await launched()).not.toContain("--resume");
  expect(calls().some((each) => each[0] === "rm")).toBe(false);
});

test("a fresh thread's session on a five-minute cache hands over five minutes after its last request, not an hour", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  dm([{ sessionId: SESSION, pid: old.pid, status: "idle", startedAt: clock.now() + 60_000 }], {
    cacheWarm: 60_000,
  });
  const project = join(dir, "projects", join(dir, "hex").replaceAll(/[^a-zA-Z0-9]/gu, "-"));
  mkdirSync(project, { recursive: true });

  const usage = {
    input_tokens: 2,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 398,
    cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 },
  };

  appendFileSync(
    join(project, `${SESSION}.jsonl`),
    `${JSON.stringify({
      type: "assistant",
      message: { usage },
      timestamp: new Date(clock.now() - 4800).toISOString(),
    })}\n`,
  );
  const first = await session("dm");
  await first.send({ type: "state", thread: "dm", busy: false });
  await time.lapse(200);
  await until(() => calls().find((each) => each[0] === "stop"));
  first.close();
  old.kill();
  expect(await launched()).not.toContain("--resume");
});

test("once a fresh thread's session is full, a new one takes over at the rest the Stop hook reports, though Claude still calls it busy, before the next message", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  dm([{ sessionId: SESSION, pid: old.pid, status: "busy", startedAt: clock.now() + 60_000 }]);
  const first = await session("dm");
  hub.deliver("dm", "DM", message);
  await until(() => first.received.length);
  fold(first.received);
  said(1500);
  await first.send({ type: "state", thread: "dm", busy: false });
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  first.close();
  old.kill();
  const args = await launched();
  expect(args).not.toContain("--resume");
  expect(args.at(-2)).toBe("--settings");
  const next = await session("dm", NEXT);
  hub.deliver("dm", "DM", { author: "owner", content: "next", meta: {} });
  await until(() => next.received.length);
  expect(next.received[0]).toMatchObject({ type: "inbound", content: "next" });
  expect(first.received).toHaveLength(1);
});

test("a fresh thread's session hands over when its cache expires, timed from its last request", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  dm([{ sessionId: SESSION, pid: old.pid, status: "idle", startedAt: clock.now() + 60_000 }], {
    cacheWarm: 400,
  });
  said(500, false, SESSION, clock.now() - 200);
  const first = await session("dm");
  await first.send({ type: "state", thread: "dm", busy: false });
  await time.advance(199);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
  await time.advance(1);
  await until(() => calls().find((each) => each[0] === "stop"));
  first.close();
  old.kill();
  expect(await launched()).not.toContain("--resume");
});

test("a message that finds a fresh thread's session gone cold goes to a new one", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  dm([{ sessionId: SESSION, pid: old.pid, status: "idle", startedAt: clock.now() + 60_000 }], {
    cacheWarm: 60_000,
  });
  said(500, false, SESSION, clock.now() - 61_000);
  const first = await session("dm");
  await time.lapse(0);
  await until(() => calls().find((each) => each[0] === "stop"));
  hub.deliver("dm", "DM", message);
  first.close();
  old.kill();
  expect(await launched()).not.toContain("--resume");
  const next = await session("dm", NEXT);
  await until(() => next.received.length);
  expect(next.received[0]).toMatchObject({
    type: "inbound",
    content: message.content,
    meta: message.meta,
  });
  expect(first.received).toHaveLength(0);
});

test("a fresh thread never compacts or idles out, however big its session", async () => {
  dm([{ sessionId: SESSION, pid: 999_999, status: "idle", startedAt: clock.now() + 60_000 }], {
    capacity: 400_000,
    compactAbove: 150_000,
    idleStop: 20,
  });
  said(200_000);
  const { send } = await session("dm");
  await send({ type: "state", thread: "dm", busy: false });
  await until(() => states.length);
  await time.advance(150);
  expect(calls().filter((each) => each[0] !== "agents")).toEqual([]);
});

test("a fresh thread's warm session that started with what the hub no longer gives starts over as a new one at its rest", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  dm([{ sessionId: SESSION, pid: old.pid, status: "idle", startedAt: 1 }], { stale: true });
  said(500);
  const first = await session("dm");
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  writeFileSync(join(dir, "agents"), "[]");
  first.close();
  old.kill();
  expect(await launched()).not.toContain("--resume");
});

test("a warm DM session the last hub started but never saved takes the next message, and hands over in its turn, instead of a second session", async () => {
  bound("dm", NEXT, "job99999");
  dm(
    [{ id: "job99999", sessionId: NEXT, pid: 42, status: "idle", startedAt: clock.now() + 60_000 }],
    { reconnect: 60_000 },
  );
  hub.deliver("dm", "DM", message);
  await settled();
  const { received, send } = await session("dm", NEXT);
  await until(() => received.length);
  expect(hub.session("dm")).toBe(NEXT);
  said(1500, false, NEXT);
  await send({ type: "state", thread: "dm", busy: false });
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    NEXT.slice(0, 8),
  ]);
  expect(calls().some((each) => each[0] === "--bg")).toBe(false);
});

test("a session with no capacity takes every message of a call, idle or not, and the call after it gets a new session", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "idle" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  const { received, send } = await session("voice");
  said(20_000);
  await hub.keep("voice");

  for (const turn of ["one", "two", "three"]) {
    said(20_000);
    await send({ type: "state", thread: "voice", busy: false });
    hub.deliver("voice", "voice", { author: "owner", content: turn, meta: {} });
    await until(() => heard(received).find((payload) => payload.content === turn));
  }

  expect(calls().some((each) => each[0] === "stop" || each[0] === "--bg")).toBe(false);
  hub.deliver("voice", "voice", { author: "owner", content: "the call ended", meta: {} });
  hub.renew("voice");
  await send({ type: "state", thread: "voice", busy: true });
  await send({ type: "state", thread: "voice", busy: false });
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  old.kill();
  expect(await launched()).not.toContain("--resume");
});

test("a call's end that reaches the session as its last turn ends gets its turn before the session renews", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "idle" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  const { received, send } = await session("voice");
  said(20_000);
  await hub.keep("voice");
  await send({ type: "state", thread: "voice", busy: true });
  hub.deliver("voice", "voice", { author: "call", content: "the call ended", meta: {} });
  await until(() => heard(received).find((payload) => payload.content === "the call ended"));
  hub.renew("voice");
  await send({ type: "state", thread: "voice", busy: false });
  await time.advance(100);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
  await send({ type: "state", thread: "voice", busy: true });
  await send({ type: "state", thread: "voice", busy: false });
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  old.kill();
});

test("a call that finds its session still waiting for its first message starts it over, and keeps the call until the new one connects", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "idle" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  await session("voice");
  let kept = false;
  void hub.keep("voice").then(() => (kept = true));
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  writeFileSync(join(dir, "agents"), "[]");
  old.kill();
  expect(await launched()).not.toContain("--resume");
  await time.advance(50);
  expect(kept).toBe(false);
  await session("voice", "0a1b2c3d-0000-4000-8000-000000000009");
  await until(() => kept);
  expect(hub.session("voice")).toBe("0a1b2c3d-0000-4000-8000-000000000009");
});

test("a call whose session's restart never gets through doesn't hold up the hub's own restart, and the session being stopped takes nothing if it reconnects", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "idle" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  await session("voice");
  let kept = false;
  void hub.keep("voice").then(() => (kept = true));
  await until(() => calls().find((each) => each[0] === "stop"));
  await free();
  hub.deliver("voice", "voice", message);
  const again = await session("voice");
  await time.advance(100);
  expect(again.received).toEqual([]);
  expect(kept).toBe(false);
  old.kill();
});

test("a call whose restarted session fails to start goes on", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "idle" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  await session("voice");
  let kept = false;
  void hub.keep("voice").then(() => (kept = true));
  await until(() => calls().find((each) => each[0] === "stop"));
  writeFileSync(join(dir, "agents"), "[]");
  old.kill();
  await launched();
  writeFileSync(
    join(dir, "jobs", "job12345", "state.json"),
    JSON.stringify({ state: "failed", detail: "exit 1 before init" }),
  );
  await until(() => kept);
});

test("a call that comes while a renew is on its way takes the new session as it starts, without starting it over again", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "busy" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  const { send } = await session("voice");
  said(500);
  await send({ type: "state", thread: "voice", busy: true });
  hub.renew("voice");
  await settled();
  let kept = false;
  void hub
    .renewal("voice")
    .then(() => hub.keep("voice"))
    .then(() => (kept = true));
  await send({ type: "state", thread: "voice", busy: false });
  await until(() => calls().find((each) => each[0] === "stop"));
  writeFileSync(join(dir, "agents"), "[]");
  old.kill();
  await launched();
  await time.advance(50);
  expect(kept).toBe(false);
  await session("voice", "0a1b2c3d-0000-4000-8000-000000000009");
  await until(() => kept);
  await time.advance(150);
  expect(calls().filter((each) => each[0] === "stop")).toHaveLength(1);
  expect(hub.session("voice")).toBe("0a1b2c3d-0000-4000-8000-000000000009");
});

test("a call keeps the session it finds once a message has gone to it, before the session takes it", async () => {
  start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, status: "idle" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  const { received } = await session("voice");
  hub.deliver("voice", "voice", message);
  await until(() => received.length);
  await hub.keep("voice");
  await time.advance(150);
  expect(calls().some((each) => each[0] === "stop" || each[0] === "--bg")).toBe(false);
});

test("a call keeps the session it finds once that session has taken a message, like the one that placed the call, before its first request is through", async () => {
  start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, status: "idle" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  const { received } = await session("voice");
  hub.deliver("voice", "voice", message);
  await until(() => received.length);
  fold(received);
  await hub.keep("voice");
  await time.advance(150);
  expect(calls().some((each) => each[0] === "stop" || each[0] === "--bg")).toBe(false);
});

test("a session whose channel comes back before its rest still starts over for the call that ended", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "idle" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  const first = await session("voice");
  await first.send({ type: "state", thread: "voice", busy: true });
  hub.renew("voice");
  first.close();
  const again = await session("voice");
  await again.send({ type: "state", thread: "voice", busy: false });
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  old.kill();
});

test("a thread that asks to renew starts over as a new session once its turn ends", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "idle" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  const { send } = await session("voice");
  await send({ type: "state", thread: "voice", busy: true });
  hub.renew("voice");
  await time.advance(100);
  expect(calls().some((each) => each[0] === "stop" || each[0] === "--bg")).toBe(false);
  await send({ type: "state", thread: "voice", busy: false });
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  old.kill();
  expect(await launched()).not.toContain("--resume");
});

test("a renew waits out background agents the turn ended with, then starts over at the next idle", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "busy" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  const { send } = await session("voice");
  hub.renew("voice");
  await send({ type: "state", thread: "voice", busy: false, background: true });
  await time.advance(150);
  expect(calls().some((each) => each[0] === "stop" || each[0] === "--bg")).toBe(false);
  await send({ type: "state", thread: "voice", busy: false });
  await until(() => calls().find((each) => each[0] === "stop"));
  old.kill();
  expect(await launched()).not.toContain("--resume");
});

test("a renew goes through at a rest the Stop hook reports, though Claude still calls the session busy (its status lags, and a running shell counts)", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "busy" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  const { send } = await session("voice");
  await send({ type: "state", thread: "voice", busy: true });
  hub.renew("voice");
  await send({ type: "state", thread: "voice", busy: false });
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  old.kill();
  expect(await launched()).not.toContain("--resume");
});

test("a session that started with what the hub no longer gives and runs a shell renews only once Claude reports it idle, since it never asked", async () => {
  start({
    stale: true,
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, status: "busy", startedAt: 1 }],
  });
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: false });
  await time.advance(150);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
});

test("a call that comes while a renew is on its way waits for the new session to connect", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "busy" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  let through = false;
  await hub.renewal("voice");
  const { send } = await session("voice");
  await send({ type: "state", thread: "voice", busy: true });
  hub.renew("voice");
  await settled();
  void hub.renewal("voice").then(() => (through = true));
  await send({ type: "state", thread: "voice", busy: false });
  await until(() => calls().find((each) => each[0] === "stop"));
  old.kill();
  await launched();
  await time.advance(50);
  expect(through).toBe(false);
  await session("voice", "0a1b2c3d-0000-4000-8000-000000000009");
  await until(() => through);
});

test("a call waits for no renew held up by background agents, or called off by a call already in the session", async () => {
  start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, status: "busy" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  let through = 0;
  const { send } = await session("voice");
  await send({ type: "state", thread: "voice", busy: true });
  hub.renew("voice");
  await settled();
  void hub.renewal("voice").then(() => through++);
  await send({ type: "state", thread: "voice", busy: false, background: true });
  await until(() => through === 1);
  await send({ type: "state", thread: "voice", busy: true });
  hub.renew("voice");
  await settled();
  void hub.renewal("voice").then(() => through++);
  void hub.keep("voice");
  await until(() => through === 2);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
});

test("a fresh main thread still running when the hub starts is left to reconnect instead of getting a second session", async () => {
  start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, status: "idle" }],
    reconnect: 150,
    fresh: () => true,
    capacity: 0,
  });
  await time.armed(150);
  await session("voice");
  await time.advance(250);
  expect(calls().some((each) => each[0] === "--bg")).toBe(false);
});

test("a fresh main thread whose newest session is still running but not yet saved is left to reconnect too", async () => {
  bound("voice", "0a1b2c3d-0000-4000-8000-000000000009", "job99999");
  start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ id: "job99999", sessionId: "0a1b2c3d-0000-4000-8000-000000000009", pid: 43 }],
    reconnect: 150,
    fresh: () => true,
    capacity: 0,
  });
  await time.armed(150);
  await session("voice", "0a1b2c3d-0000-4000-8000-000000000009");
  await time.advance(250);
  expect(calls().some((each) => each[0] === "--bg")).toBe(false);
});

test("a fresh main thread whose session is gone when the hub starts gets a new one at once", async () => {
  start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  expect(await launched()).not.toContain("--resume");
});

test("a thread that asked to renew keeps running when it asks to keep before its turn ends (a new call started)", async () => {
  start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, status: "idle" }],
    reconnect: 50,
    fresh: () => true,
    capacity: 0,
  });
  const { send } = await session("voice");
  await send({ type: "state", thread: "voice", busy: true });
  hub.renew("voice");
  void hub.keep("voice");
  await send({ type: "state", thread: "voice", busy: false });
  await time.advance(150);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
});

test("a session that started with what the hub no longer gives stops at its next rest, so its next message resumes it on the current code", async () => {
  start({
    stale: true,
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, status: "busy", startedAt: 1 }],
  });
  const { send } = await session("chat:7");
  await time.advance(150);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ sessionId: SESSION, pid: 42, status: "idle", startedAt: 1 }]),
  );
  await send({ type: "state", thread: "chat:7", busy: false });
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  expect(calls().some((each) => each[0] === "--bg")).toBe(false);
});

test("a change to only the hooks a session loads renews it at its next rest", async () => {
  const hooks = join(dir, "hooks.json");
  writeFileSync(hooks, '{"hooks":{}}');
  const stamped = stamp([], SERVER, [hooks]);
  expect(stamp([], SERVER, [hooks])).toBe(stamped);
  writeFileSync(hooks, '{"hooks":{"Stop":[]}}');
  expect(stamp([], SERVER, [hooks])).not.toBe(stamped);
  start({
    startup: [hooks],
    registry: { "chat:7": { name: "Desk anchors", session: SESSION, launched: stamped } },
    agents: [{ sessionId: SESSION, pid: 42, status: "idle", startedAt: 1 }],
  });
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: false });
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
});

test("a new skill in a folder the session loads at start renews it at its next rest", async () => {
  const skills = join(dir, "skills");
  mkdirSync(join(skills, "echo"), { recursive: true });
  writeFileSync(join(skills, "echo/SKILL.md"), "Restate the ask.");
  const stamped = stamp([], SERVER, [skills]);
  mkdirSync(join(skills, "vault"));
  writeFileSync(join(skills, "vault/SKILL.md"), "Secrets go through the vault.");
  expect(stamp([], SERVER, [skills])).not.toBe(stamped);
  start({
    startup: [skills],
    registry: { "chat:7": { name: "Desk anchors", session: SESSION, launched: stamped } },
    agents: [{ sessionId: SESSION, pid: 42, status: "idle", startedAt: 1 }],
  });
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: false });
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
});

test("a file an update removes midway, or a dangling link, reads as missing rather than stopping the hub", () => {
  const skills = join(dir, "skills");
  mkdirSync(skills);
  symlinkSync(join(dir, "gone"), join(skills, "SKILL.md"));
  expect(stamp([], SERVER, [skills, join(dir, "nothing")])).toHaveLength(16);
});

test("a session whose hooks are unchanged keeps running across a hub restart", async () => {
  const hooks = join(dir, "hooks.json");
  writeFileSync(hooks, '{"hooks":{}}');
  start({
    startup: [hooks],
    registry: {
      "chat:7": { name: "Desk anchors", session: SESSION, launched: stamp([], SERVER, [hooks]) },
    },
    agents: [{ sessionId: SESSION, pid: 42, status: "idle", startedAt: 1 }],
  });
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: false });
  await time.advance(150);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
});

test("a main thread whose session started with what the hub no longer gives starts over as soon as it rests", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  start({
    stale: true,
    main: "chat",
    registry: { chat: { name: "hex", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "idle", startedAt: 1 }],
    reconnect: 60_000,
  });
  await session("chat");
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  writeFileSync(join(dir, "agents"), "[]");
  old.kill();
  expect(await launched()).toContain("--resume");
});

test("a hub whose state folder is gone makes it again, with a new token", () => {
  const state = join(dir, "gone");
  hub = startHub({
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

test("a voice session that started with what the hub no longer gives waits out its call before starting over", async () => {
  start({
    stale: true,
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, status: "busy", startedAt: 1 }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  const { send } = await session("voice");
  said(500);
  await hub.keep("voice");
  await time.advance(100);
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ sessionId: SESSION, pid: EXITED, status: "idle", startedAt: 1 }]),
  );
  await send({ type: "state", thread: "voice", busy: false });
  await time.advance(150);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
  hub.renew("voice");
  await send({ type: "state", thread: "voice", busy: false });
  await until(() => calls().find((each) => each[0] === "stop"));
});

test("a restart waits for every call to hang up, even while its session's channel is gone", async () => {
  start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  let freed = false;
  await free();
  await session("voice");
  said(500);
  void hub.keep("voice");
  void free().then(() => (freed = true));
  await time.advance(50);
  expect(freed).toBe(false);
  hub.renew("voice");
  await until(() => freed);
  freed = false;
  const second = await session("voice");
  void hub.keep("voice");
  void free().then(() => (freed = true));
  second.close();
  await time.advance(100);
  expect(freed).toBe(false);
  hub.renew("voice");
  await until(() => freed);
});

test("closing an idle thread stops its session right away, then forgets the thread", async () => {
  start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  const { close } = await session("chat:7");
  void hub.retire("chat:7");
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  expect(registry()["chat:7"]).toBeDefined();
  close();
  await until(() => !registry()["chat:7"]);
});

test("a forgotten thread's settings file goes with it", async () => {
  start();
  hub.deliver("chat:7", "Desk anchors", message);
  const settings = (await launched()).at(-1) ?? "";
  const { close, send } = await session("chat:7");
  expect(existsSync(settings)).toBe(true);
  await send({ type: "state", thread: "chat:7", busy: false });
  await until(() => states.length === 2);
  void hub.retire("chat:7");
  await until(() => calls().find((each) => each[0] === "stop"));
  close();
  await until(() => !existsSync(settings));
});

test("a session whose flags read no settings file of the hub stops and resumes once its channel stays gone, since a respawn would lose its binding", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, startedAt: 1 }],
    reconnect: 50,
  });
  await time.lapse(50);
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  writeFileSync(join(dir, "agents"), "[]");
  old.kill();
  const args = await launched();
  expect(args[args.indexOf("--resume") + 1]).toBe(SESSION);
  expect(calls().some((each) => each[0] === "respawn")).toBe(false);
});

test("closing a thread with no live session forgets it at once", async () => {
  start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  await settled();
  const callsBefore = calls().length;
  void hub.retire("chat:7");
  expect(registry()["chat:7"]).toBeUndefined();
  await settled();
  expect(calls().slice(callsBefore)).toEqual([]);
});

test("closing a thread whose session Claude reports busy waits for its next idle", async () => {
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, status: "busy" }],
  });
  const { send } = await session("chat:7");
  void hub.retire("chat:7");
  await time.advance(100);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
  await send({ type: "state", thread: "chat:7", busy: false });
  await until(() => calls().find((each) => each[0] === "stop"));
});

test("closing a busy thread stops its session at its next idle, not before", async () => {
  start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: true });
  await until(() => states.length);
  void hub.retire("chat:7");
  await time.advance(100);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
  await send({ type: "state", thread: "chat:7", busy: false });
  await until(() => calls().find((each) => each[0] === "stop"));
});

test("threads are found by name or id, and renames are kept, in hex.db too", () => {
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION }, "chat:8": { name: "Clips" } },
  });
  expect(hub.find("desk anchors")).toBe("chat:7");
  expect(hub.find("chat:8")).toBe("chat:8");
  expect(() => hub.find("Nope")).toThrow('no thread named "Nope"');
  hub.rename("chat:8", "Video clips");
  expect(hub.find("Video clips")).toBe("chat:8");
  expect(hub.name("chat:8")).toBe("Video clips");
  expect(hub.name("chat:9")).toBeUndefined();
  expect(registry()["chat:8"]?.name).toBe("Video clips");
  expect(open(dir).threads.list()).toEqual([
    { app: "telegram", thread: "chat:7", name: "Desk anchors", session: SESSION, open: true },
    { app: "telegram", thread: "chat:8", name: "Video clips", open: true },
  ]);
});

test("a thread hex.db keeps comes back with its folder and settings, and a closed one keeps its row", async () => {
  start({
    registry: {
      "chat:7": { name: "Desk anchors", session: SESSION, cwd: "/work", model: "claude-opus-5-5" },
    },
  });
  expect(hub.threads()).toEqual(["chat:7"]);
  expect(hub.cwd("chat:7")).toBe("/work");
  await hub.retire("chat:7");
  expect(open(dir).threads.list()).toEqual([
    {
      app: "telegram",
      thread: "chat:7",
      name: "Desk anchors",
      session: SESSION,
      cwd: "/work",
      model: "opus",
      open: false,
    },
  ]);
});

test("sessions start through the launcher, in the hex folder, with nothing of the hub's own in its env", async () => {
  const launcher = join(dir, "launch");
  writeFileSync(
    launcher,
    `#!/bin/sh
pwd > "${dir}/cwd"
env | grep -c -e _BOT_TOKEN= -e ^HEX_ -e ^BUZZ_ > "${dir}/leaked"
exec claude "$@"
`,
  );
  chmodSync(launcher, 0o755);
  process.env.TELEGRAM_BOT_TOKEN = "secret";
  process.env.BUZZ_PRIVATE_KEY = "secret";
  process.env.HEX_DIR = join(dir, "somewhere");

  try {
    start({ launcher });
    hub.open("chat:7", "Desk anchors", "go");
    await launched();
  } finally {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.BUZZ_PRIVATE_KEY;
    delete process.env.HEX_DIR;
  }

  expect(readFileSync(join(dir, "cwd"), "utf-8").trim()).toBe(join(dir, "hex"));
  expect(readFileSync(join(dir, "leaked"), "utf-8").trim()).toBe("0");
});

test("a thread opened in a project starts its session there, and keeps that folder when it resumes", async () => {
  const project = join(dir, "project");
  mkdirSync(project);
  const launcher = join(dir, "launch");
  writeFileSync(
    launcher,
    `#!/bin/sh
pwd >> "${dir}/cwd"
exec claude "$@"
`,
  );
  chmodSync(launcher, 0o755);
  start({ launcher, agents: [] });
  hub.open("t3:1", "project", undefined, project);
  await launched();
  saved(SESSION, project);
  const { close } = await session("t3:1");
  await until(() => registry()["t3:1"]);
  expect(registry()["t3:1"]).toEqual({ name: "project", cwd: project, session: SESSION });
  expect(hub.cwd("t3:1")).toBe(project);
  close();
  await until(() => states.some(([thread, busy]) => thread === "t3:1" && !busy));
  hub.deliver("t3:1", "project", message);
  await until(() => readFileSync(join(dir, "cwd"), "utf-8").split("\n").length > 2);
  expect(readFileSync(join(dir, "cwd"), "utf-8").trim().split("\n")).toEqual([project, project]);
});

test("a thread in the hex folder keeps no folder of its own", async () => {
  start();
  hub.open("chat:7", "Desk anchors", "go");
  await launched();
  saved();
  await session("chat:7");
  await until(() => registry()["chat:7"]);
  expect(registry()["chat:7"]).toEqual({ name: "Desk anchors", session: SESSION });
  expect(hub.cwd("chat:7")).toBeUndefined();
});

test("releasing an idle thread stops its session, then forgets it once the socket closes", async () => {
  start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  const { close } = await session("chat:7");
  let released: string | undefined;
  void hub.release("chat:7").then((id) => (released = id));
  expect(await until(() => calls().find((each) => each[0] === "stop"))).toEqual([
    "stop",
    SESSION.slice(0, 8),
  ]);
  await time.advance(50);
  expect(released).toBeUndefined();
  expect(registry()["chat:7"]).toBeDefined();
  close();
  expect(await until(() => released)).toBe(SESSION);
  expect(registry()["chat:7"]).toBeUndefined();
});

test("releasing a busy thread waits for its next idle", async () => {
  start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  const { close, send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: true });
  await until(() => states.length);
  let released: string | undefined;
  void hub.release("chat:7").then((id) => (released = id));
  await time.advance(100);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
  await send({ type: "state", thread: "chat:7", busy: false });
  await until(() => calls().find((each) => each[0] === "stop"));
  close();
  expect(await until(() => released)).toBe(SESSION);
  expect(registry()["chat:7"]).toBeUndefined();
});

test("releasing a thread with no live session resolves at once", async () => {
  start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  expect(await hub.release("chat:7")).toBe(SESSION);
  expect(registry()["chat:7"]).toBeUndefined();
  expect(calls()).toEqual([]);
});

test("the main thread cannot be closed or released, nor a thread without a session", () => {
  start({ main: "chat", registry: { "chat:8": { name: "Clips" } } });
  expect(() => hub.retire("chat")).toThrow("the main thread stays open");
  expect(() => hub.release("chat")).toThrow("the main thread stays here");
  expect(() => hub.release("chat:8")).toThrow("this thread has no session yet");
});

test("an adopted thread clears the old job record, then resumes its session in its folder with the prompt last", async () => {
  start({ agents: [] });
  hub.adopt("chat:7", "Desk anchors", SESSION, "carry on", dir);
  const args = await launched();
  expect(
    calls().find((each) => !["agents", "daemon", "--version"].includes(each[0] ?? "")),
  ).toEqual(["rm", SESSION.slice(0, 8)]);
  expect(args[args.indexOf("--resume") + 1]).toBe(SESSION);
  expect(args.at(-1)).toBe("carry on");
  expect(registry()["chat:7"]).toEqual({ name: "Desk anchors", session: SESSION, cwd: dir });
});

test("a fork resumes a copy of the session without checking agents or clearing its job record", async () => {
  start();
  hub.fork("chat:7", "Desk anchors", SESSION, "carry on");
  const args = await launched();
  const resume = args.indexOf("--resume");
  expect(args.slice(resume, resume + 3)).toEqual(["--resume", SESSION, "--fork-session"]);
  expect(args.at(-1)).toBe("carry on");
  await time.advance(50);
  expect(
    calls()
      .map((each) => each[0])
      .filter((command) => command !== "daemon" && command !== "--version"),
  ).toEqual(["--bg"]);
});

test("a buzz:// link becomes a web link that opens it, in plain text and in Markdown", () => {
  const link = "buzz://message?channel=c-1&id=abc";
  const web = `https://hex-sand.vercel.app/open.html#${encodeURIComponent(link)}`;
  expect(tappable(`see ${link}.`)).toBe(`see ${web}.`);
  expect(tappable(`open ${link}?`)).toBe(`open ${web}?`);
  expect(tappable(`[the thread](${link})`)).toBe(`[the thread](${web})`);
  expect(tappable("no links here")).toBe("no links here");
});

test("a session's stop hook reports whether background agents are still working, which shells don't count as", async () => {
  const socket = join(dir, "state.sock");
  const received: object[] = [];

  const server = createServer((client) => {
    client.on("data", (chunk) => {
      received.push(SeenLine.parse(JSON.parse(String(chunk))));
    });
  }).listen(socket);

  const stop = async (tasks: object[]) => {
    const hook = Bun.spawn(["bun", join(import.meta.dir, "state.ts"), "idle"], {
      env: { ...process.env, HEX_HUB: socket, HEX_THREAD: "t1" },
      stdin: new Blob([JSON.stringify({ hook_event_name: "Stop", background_tasks: tasks })]),
    });

    await hook.exited;
  };

  await stop([{ type: "subagent", status: "running" }]);
  await stop([{ type: "shell", status: "running" }]);
  await until(() => received.length === 2 || undefined);
  server.close();
  expect(received).toEqual([
    { type: "state", thread: "t1", busy: false, background: true },
    { type: "state", thread: "t1", busy: false },
  ]);
});

test("a session's stop hook names its session, and says when the turn failed", async () => {
  const socket = join(dir, "state.sock");
  const received: object[] = [];

  const server = createServer((client) => {
    client.on("data", (chunk) => {
      received.push(SeenLine.parse(JSON.parse(String(chunk))));
    });
  }).listen(socket);

  for (const hook_event_name of ["Stop", "StopFailure"]) {
    const hook = Bun.spawn(["bun", join(import.meta.dir, "state.ts"), "idle"], {
      env: { ...process.env, HEX_HUB: socket, HEX_THREAD: "t1", HEX_STORE: dir, MEMORY_DIR: "" },
      stdin: new Blob([JSON.stringify({ hook_event_name, session_id: SESSION })]),
    });

    await hook.exited;
    await until(() => received.length === (hook_event_name === "Stop" ? 1 : 2) || undefined);
  }

  server.close();
  expect(received).toEqual([
    { type: "state", thread: "t1", busy: false, session: SESSION },
    { type: "state", thread: "t1", busy: false, failed: true, session: SESSION },
  ]);
});

test("a turn's hook tells the hub and goes, without waiting for a stalled hub to hang up", async () => {
  const socket = join(dir, "state.sock");
  const received: object[] = [];

  const server = createServer({ allowHalfOpen: true }, (client) => {
    client.on("data", (chunk) => {
      received.push(SeenLine.parse(JSON.parse(String(chunk))));
    });
  }).listen(socket);

  const hook = Bun.spawn(["bun", join(import.meta.dir, "state.ts"), "idle"], {
    env: { ...process.env, HEX_HUB: socket, HEX_THREAD: "t1" },
    stdin: new Blob([JSON.stringify({ hook_event_name: "Stop" })]),
  });

  const ended = await Promise.race([
    hook.exited.then(() => true),
    Bun.sleep(3000).then(() => false),
  ]);

  hook.kill();
  await until(() => received.length || undefined);
  server.close();
  expect(ended).toBe(true);
  expect(received).toEqual([{ type: "state", thread: "t1", busy: false }]);
});

test("a main thread whose new session ends before its channel connects is reported and started again", async () => {
  start({ main: "chat", agents: [], reconnect: 50 });
  expect(settingsOf(await launched()).env.HEX_MAIN).toBeUndefined();
  await time.lapse(50);
  expect(failures[0]).toEqual(["chat", "its session ended before its channel connected"]);
  await until(() => calls().filter((each) => each[0] === "--bg").length === 2);
});

test("a thread whose new session ends before its channel connects is reported, and its next message starts it again", async () => {
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [],
    reconnect: 50,
  });
  hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  await time.lapse(50);
  expect(failures[0]).toEqual(["chat:7", "its session ended before its channel connected"]);
  hub.deliver("chat:7", "Desk anchors", { ...message, content: "again" });
  await until(() => calls().filter((each) => each[0] === "--bg").length === 2);
  const { received } = await session("chat:7");
  await until(() => received.length === 2);
  expect(heard(received).map((m) => m.content)).toEqual(["hi", "again"]);
});

test("a session that restarts in place and then ends is reported, and the thread starts again on its next message", async () => {
  bound("chat:7");
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, startedAt: 1 }],
    reconnect: 50,
  });
  const { close } = await session("chat:7");
  close();
  await time.lapse(50);
  await until(() => calls().find((each) => each[0] === "respawn"));
  writeFileSync(join(dir, "agents"), "[]");
  await time.lapse(50);
  expect(failures[0]).toEqual(["chat:7", "its session ended before its channel connected"]);
  hub.deliver("chat:7", "Desk anchors", message);
  await launched();
});

test("begin opens a thread on another client and starts its session on a prompt, or on a message it delivers under the thread's name", async () => {
  start({ agents: [] });
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
  start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
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
  const store = open(dir);

  for (const [i, { from = "buzz", ...row }] of rows.entries()) {
    store.messages.deliver({ key: `${from}:${thread}-${i}`, to: thread, from, ...row }, takenBy);
  }
}

test("a thread's history is what the owner said and hex replied, headings and all, without the terminal, others, failed sends or what waits, and a session's is what it took", () => {
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
  expect(history(open(dir), "chat:7")).toEqual([
    { from: "me", text: "how full is your context?" },
    { from: "hex", text: "Roomy.\n\n## What loads\n\nthe rules" },
    { from: "me", text: "thanks" },
  ]);
  expect(history(open(dir), "chat:9")).toEqual([]);
  open(dir)
    .db.query("update messages set at = '2026-10-01T00:00:00.000Z' where key = 'buzz:chat:7-0'")
    .run();
  open(dir)
    .db.query("update messages set taken_by = 'older-session' where key = 'buzz:chat:7-0'")
    .run();
  expect(history(open(dir), "chat:7", SESSION).map((turn) => turn.text)).toEqual([
    "Roomy.\n\n## What loads\n\nthe rules",
    "thanks",
  ]);
  expect(history(open(dir), "chat:7", "new-session")).toEqual([]);
});

test("a T3 message in a history is the owner's request, without the context T3 Code sends around it", () => {
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
  expect(history(open(dir), "chat:7")).toEqual([
    { from: "me", text: "ship it" },
    { from: "me", text: "and the docs" },
    { from: "hex", text: "Shipped." },
  ]);
});

test("a move backfills the thread there with its chat before its session resumes there", async () => {
  start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
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
  start({
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
  start({
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
  start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
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
  start({ agents: [] });
  hub.follow("chat:7", "Desk anchors", SESSION);
  expect(registry()["chat:7"]).toEqual({ name: "Desk anchors", from: SESSION });
  hub.deliver("chat:7", "Desk anchors", message);
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

test("a message is in hex.db once deliver returns, its key first on the tag, and the app sending it again changes nothing", async () => {
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
  });
  const { received } = await session("chat:7");
  hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:42" });
  expect(open(dir).messages.get("telegram:1:42")).toMatchObject({
    to: "chat:7",
    from: "telegram",
    body: "hi",
    meta: { chat_id: "1" },
  });
  hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:42" });
  hub.deliver("chat:7", "Desk anchors", {
    author: "owner",
    content: "after",
    meta: {},
    key: "1:43",
  });
  await until(() => received.length === 2);
  expect(received[0]).toEqual({
    type: "inbound",
    content: "hi",
    meta: { key: "telegram:1:42", chat_id: "1" },
  });
  expect(heard(received)[1]?.content).toBe("after");
  expect(Object.keys(heard(received)[0]?.meta ?? {})[0]).toBe("key");
});

test("the owner's words written in another client reach the thread's session and show where it lives in the order written, once however often they're sent", async () => {
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
  });
  const { received } = await session("chat:7");
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
    expect(say("telegram", "chat:7", words)).toBe(true);
    expect(say("telegram", "chat:7", words)).toBe(true);
    expect(say("telegram", "chat:7", { ...words, content: "and the docs", key: "kb-2" })).toBe(
      true,
    );
    await until(() => received.length === 2 && shown.length === 2);
    expect(heard(received).map((each) => each.content)).toEqual(["anchors?", "and the docs"]);
    expect(open(dir).messages.get("telegram:kb-1")).toMatchObject({ author: "owner" });
    expect(
      say("telegram", "chat:7", {
        content: "this one\n(photo)",
        key: "app-1",
        meta: { media: "photo p1", files: "/m/p1.jpg" },
      }),
    ).toBe(true);
    await until(() => shown.length === 3);
    expect(shown).toEqual([
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

test("words written in another client can't reach a thread no app holds, or one whose app shows only its own turns", () => {
  start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  clients.set("telegram", {
    hub,
    place: () => Promise.resolve({ thread: "", link: "" }),
    waits: true,
  });

  try {
    const words = { content: "anchors?", key: "kb-1", meta: {} };
    expect(writable("telegram", "chat:7")).toBe(false);
    expect(say("telegram", "chat:7", words)).toBe(false);
    expect(say("nowhere", "chat:7", words)).toBe(false);
    clients.set("telegram", { hub, place: () => Promise.resolve({ thread: "", link: "" }) });
    expect(writable("telegram", "chat:7")).toBe(true);
    expect(writable("telegram", "chat:8")).toBe(false);
    expect(open(dir).messages.get("telegram:kb-1")).toBeNull();
  } finally {
    clients.delete("telegram");
  }
});

test("after the hub restarts, a session gets again what it was given but never took, and not what it took", async () => {
  start();
  const first = http("chat:7");
  await first.open(crypto.randomUUID());
  hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:42" });
  hub.deliver("chat:7", "Desk anchors", {
    author: "owner",
    content: "and this",
    meta: {},
    key: "1:43",
  });
  await until(() => first.received.length === 2);
  open(dir).messages.take("telegram:1:42", SESSION);
  first.close();
  hub.close();
  start();
  const back = http("chat:7");
  await back.open(crypto.randomUUID());
  await until(() => back.received.length);
  await settled();
  expect(heard(back.received).map((payload) => payload.content)).toEqual(["and this"]);
});

test("a session's hook takes what its prompt brings in, and drops a copy of one taken already", async () => {
  const store = open(dir);
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
  const store = open(dir);
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
  const store = open(dir);
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

test("a heartbeat that opens its session's turn is kept until that turn ends or another prompt comes, and one inside a turn isn't", async () => {
  const store = open(dir);

  const prompt = async (key: string, from: string, body: string, meta?: Record<string, string>) => {
    store.messages.deliver({
      key,
      to: "chat:7",
      from,
      author: from === "telegram" ? "owner" : "prompt",
      body,
      ...(meta && { meta }),
    });

    const hook = Bun.spawn(["bun", join(import.meta.dir, "state.ts"), "busy"], {
      env: { ...process.env, HEX_STORE: dir },
      stdin: new Blob([
        JSON.stringify({
          prompt: `<channel source="plugin:telegram:telegram" key="${key}">\n${body}\n</channel>`,
          session_id: SESSION,
        }),
      ]),
    });

    expect(await hook.exited).toBe(0);
  };

  const beat = (slot: string) =>
    prompt(`schedule:heartbeat@${slot}`, "schedule", "[heartbeat] Hourly check", {
      user: "schedule",
      schedule: "heartbeat",
    });

  await beat("2026-11-03T12:45Z");
  const [first] = store.turns.beats(SESSION);

  if (first === undefined) {
    throw new Error("the heartbeat began no beat");
  }

  expect(first).toEqual({ began: anyString() });
  await beat("2026-11-03T12:46Z");
  expect(store.turns.beats(SESSION)).toEqual([first]);
  store.turns.turned(SESSION, false);
  expect(store.turns.beats(SESSION)).toEqual([{ began: first.began, until: anyString() }]);
  expect(store.turns.beats(SESSION)[0]?.until).toBe(store.turns.get(SESSION).ended);
  await beat("2026-11-03T13:45Z");
  const [, second] = store.turns.beats(SESSION);

  if (second === undefined) {
    throw new Error("the next heartbeat began no beat");
  }

  expect(second).toEqual({ began: anyString() });
  store.turns.turned(SESSION, false, first.began);
  expect(store.turns.beats(SESSION)[1]).toEqual(second);
  await Bun.sleep(5);
  await prompt("telegram:1:50", "telegram", "ship it");
  const after = store.turns.get(SESSION).began;

  if (after === undefined) {
    throw new Error("the prompt began no turn");
  }

  expect(store.turns.beats(SESSION)).toEqual([
    { began: first.began, until: anyString(), after },
    { began: second.began, until: after, after },
  ]);
  await beat("2026-11-03T14:45Z");
  expect(store.turns.beats(SESSION)).toHaveLength(2);
});

test("hex.db counts a heartbeat from the busy flip after its turn's end, keeps a run's first beat a week on, and drops one a real prompt began before", () => {
  const store = open(dir);

  store.turns.turned("beat-a", true, minutesIntoNovember(0));
  store.turns.turned("beat-a", false, minutesIntoNovember(1));
  store.turns.turned(
    "beat-a",
    true,
    minutesIntoNovember(60),
    true,
    Date.parse(minutesIntoNovember(59.9)),
  );
  expect(store.turns.beats("beat-a")).toEqual([{ began: minutesIntoNovember(59.9) }]);
  store.turns.turned("beat-a", false, minutesIntoNovember(61));
  store.turns.turned(
    "beat-a",
    true,
    minutesIntoNovember(8 * 24 * 60),
    true,
    Date.parse(minutesIntoNovember(8 * 24 * 60 - 0.1)),
  );
  expect(store.turns.beats("beat-a").map((beat) => beat.began)).toEqual([
    minutesIntoNovember(59.9),
    minutesIntoNovember(8 * 24 * 60 - 0.1),
  ]);
  store.turns.turned("beat-b", false, minutesIntoNovember(0));
  store.turns.turned("beat-b", true, minutesIntoNovember(2), true);
  store.turns.turned("beat-b", true, minutesIntoNovember(1.5));
  expect(store.turns.beats("beat-b")).toEqual([]);
});

test("a task the heartbeat started reports back inside the heartbeat, and one started before it ends the run", async () => {
  const store = open(dir);
  const claude = mkdtempSync(join(tmpdir(), "hex-claude-"));
  const jobs = join(claude, "jobs", "job99999");
  mkdirSync(jobs, { recursive: true });

  const hook = async (prompt: string) => {
    const run = Bun.spawn(["bun", join(import.meta.dir, "state.ts"), "busy"], {
      env: { ...process.env, HEX_STORE: dir, CLAUDE_CONFIG_DIR: claude },
      stdin: new Blob([JSON.stringify({ prompt, session_id: SESSION })]),
    });

    expect(await run.exited).toBe(0);
  };

  const told = (task: string) =>
    hook(
      `<task-notification>\n<task-id>${task}</task-id>\n<status>completed</status>\n</task-notification>`,
    );

  store.messages.deliver({
    key: "schedule:heartbeat@2026-11-03T12:45Z",
    to: "chat:7",
    from: "schedule",
    author: "prompt",
    body: "[heartbeat] Hourly check",
    meta: { user: "schedule", schedule: "heartbeat" },
  });
  await hook(
    '<channel source="plugin:telegram:telegram" key="schedule:heartbeat@2026-11-03T12:45Z">\n[heartbeat] Hourly check\n</channel>',
  );
  const [beat] = store.turns.beats(SESSION);

  if (beat === undefined) {
    throw new Error("the heartbeat began no beat");
  }

  writeFileSync(
    join(jobs, "state.json"),
    JSON.stringify({
      sessionId: SESSION,
      fan: [
        { id: "early", kind: "agent", startedAt: Date.parse(beat.began) - 60_000 },
        { id: "own", kind: "shell", startedAt: Date.parse(beat.began) + 1000 },
      ],
    }),
  );
  store.turns.turned(SESSION, false);
  await Bun.sleep(5);
  await told("own");
  expect(store.turns.beats(SESSION).map((one) => one.after)).toEqual([undefined, undefined]);
  store.turns.turned(SESSION, false);
  await Bun.sleep(5);
  store.messages.deliver({
    key: "schedule:heartbeat@2026-11-03T13:45Z",
    to: "chat:7",
    from: "schedule",
    author: "prompt",
    body: "[heartbeat] Hourly check",
    meta: { user: "schedule", schedule: "heartbeat" },
  });
  await hook(
    '<channel source="plugin:telegram:telegram" key="schedule:heartbeat@2026-11-03T13:45Z">\n[heartbeat] Hourly check\n</channel>',
  );
  store.turns.turned(SESSION, false);
  await Bun.sleep(5);
  await told("own");
  expect(store.turns.beats(SESSION).map((one) => one.after)).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
  store.turns.turned(SESSION, false);
  await Bun.sleep(5);
  await told("early");
  expect(
    store.turns.beats(SESSION).every((one) => one.after !== undefined && one.after !== ""),
  ).toBe(true);
  rmSync(claude, { recursive: true });
});

test("a session started before hex kept messages has the hub take them for it", async () => {
  start();
  open(dir).messages.deliver({
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
    env: { ...env, HEX_HUB: join(dir, "hub.sock"), HEX_THREAD: "chat:7" },
    stdin: new Blob([JSON.stringify({ prompt, session_id: SESSION })]),
  });

  expect(await hook.exited).toBe(0);
  expect((await until(() => open(dir).messages.get("telegram:1:42")?.taken)).by).toBe(SESSION);
  expect(states).toEqual([["chat:7", true]]);
});

test("a message another process keeps, like a job ending, reaches its thread as the bell rings, and one for a thread the hub does not serve waits", async () => {
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
  });
  const { received } = await session("chat:7");
  open(dir).messages.deliver({
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

test("only General's hub runs schedules.json", () => {
  writeFileSync(join(dir, "hex", "schedules.json"), "{}");
  start();
  expect(open(dir).scheduler.checked()).toBeUndefined();
  hub.close();
  start({ main: "general", general: true });
  expect(open(dir).scheduler.checked()).toBe(Math.floor(Date.now() / 60_000));
});

test("hex's own words are kept as its session's, already taken, so they wake nothing, and a failed send is kept marked failed", () => {
  start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  hub.sent("chat:7", { key: "9", content: "Done." });
  hub.sent("chat:7", { content: "never arrived", meta: { failed: "network" } });
  const rows = open(dir).messages.said("chat:7");
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
  expect(open(dir).messages.untaken("chat:7")).toEqual([]);
  expect(hub.said("9")?.body).toBe("Done.");
});

test("what a session sends into another thread is kept as its own words, not that thread's session's", async () => {
  start({
    registry: {
      "chat:7": { name: "Desk anchors", session: SESSION },
      "chat:8": { name: "Errands", session: "other-session" },
    },
    call: () => {
      hub.sent("chat:8", { key: "12", content: "From Desk anchors: done." });

      return Promise.resolve("sent");
    },
  });
  const line = http("chat:7");
  await line.initialize();
  await line.call("reply", { text: "done" });
  expect(
    open(dir)
      .messages.said("chat:8")
      .map(({ body, taken }) => ({ body, by: taken?.by })),
  ).toEqual([{ body: "From Desk anchors: done.", by: SESSION }]);
});

test("an operation keeps its result across Stop events regardless of elapsed time", async () => {
  const waiting: (() => void)[] = [];
  start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    call: (_, name, toolArgs) =>
      new Promise((resolve) => {
        waiting.push(() => {
          resolve(`${name} ${String(toolArgs.text)}`);
        });
      }),
  });
  const line = await session("chat:7");

  const kept = async (text: string, stop: Partial<Extract<HubLine, { type: "state" }>>) => {
    const slow = line.call("reply", { text }, text);
    await until(() => waiting.length);
    await time.advance(150_000);
    waiting.shift()?.();
    await slow;
    await line.send({ type: "state", thread: "chat:7", busy: false, ...stop });
    const repeat = line.call("reply", { text }, text);

    const ran = await Promise.race([
      until(() => waiting.length).then(() => true),
      repeat.then(() => false),
    ]);

    if (ran) {
      waiting.shift()?.();
    }

    expect((await repeat).content[0]?.text).toBe(`reply ${text}`);

    return !ran;
  };

  expect(await kept("another session", { session: "ffffffff-0000-4000-8000-000000000000" })).toBe(
    true,
  );
  expect(await kept("background", { session: SESSION, background: true })).toBe(true);
  expect(await kept("failed", { session: SESSION, failed: true })).toBe(true);
  expect(await kept("no session", {})).toBe(true);
  expect(await kept("busy", { session: SESSION, busy: true })).toBe(true);
  expect(await kept("done", { session: SESSION })).toBe(true);
});
