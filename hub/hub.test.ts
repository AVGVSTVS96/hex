import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
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

import * as claude from "./claude.ts";
import { settled as commandsSettled } from "./claude.ts";
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
  startHub,
  tappable,
  tool,
  transcribe,
  writable,
} from "./hub.ts";
import type { Call, ChannelServer, Hub, HubLine, Message, Permission } from "./hub.ts";
import { claimedAs, landed, takeOver, whenLost, whenMoved } from "./kept.ts";
import { pictureId } from "./pictures.ts";
import { stamp } from "./start.ts";
import * as stores from "./store.ts";
import { file, LostError, MovedError, RefusedError, UnreachedError } from "./store.ts";
import type { Author, File, Store } from "./store.ts";
import { ATTACH, hangUpAll, http as channelLine, port } from "./testing.ts";
import { until } from "./until.ts";

const CHANNEL = "plugin:telegram@hex";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The store open() hands a hub, which a test can make answer as a home across the network does when it can't take anything (unreached), or once it refuses the hub's tenure (lost), or refuse a message over a size (refusing), or answer as a hex.db whose records moved to the folder movedTo (moved).
let outage: "unreached" | "lost" | "moved" | undefined;
let refusingOver: number | undefined;
let refusingKey: string | undefined;
let movedTo: string | undefined;

const openedFirst = stores.open;
const outages = new Map<string, Store>();

const MessageArgs = z
  .tuple([z.looseObject({ body: z.string().optional(), key: z.string().optional() })])
  .rest(z.unknown());

function refusal(name: string | symbol, args: unknown[]) {
  if (outage === "unreached") {
    return new UnreachedError("hex's store didn't answer");
  }

  if (outage === "lost") {
    return new LostError("tenure 1 no longer holds hex: tenure 2 does");
  }

  if (outage === "moved") {
    return new MovedError("hex's records moved");
  }

  const row = name === "deliver" ? MessageArgs.safeParse(args).data?.[0] : undefined;

  if (refusingKey !== undefined && row?.key === refusingKey) {
    return new RefusedError("CHECK constraint failed: key");
  }

  return refusingOver !== undefined && row?.body !== undefined && row.body.length > refusingOver
    ? new RefusedError("the row is over the store's limit")
    : undefined;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Every call the store's client makes, on any domain, answered as the outage says: a test seam over a client whose methods are a table built from names (store/wire.ts), so it reads them by name too. A store moved from answers nothing as it did.
function answering<Domain extends object>(
  domain: Domain,
  movedFrom = false,
  claimed = true,
): Domain {
  return new Proxy(domain, {
    get(target, name) {
      // oxlint-disable-next-line anti-slop/no-reflect-get -- any method of any domain, by name
      const value: unknown = Reflect.get(target, name);

      if (name === "watch" || !(value instanceof Object)) {
        return value;
      }

      // oxlint-disable-next-line unicorn/no-instanceof-builtins -- as above
      if (!(value instanceof Function)) {
        return answering(value, movedFrom, claimed);
      }

      return async (...args: unknown[]) => {
        const refusing = claimed || outage !== "lost" ? refusal(name, args) : undefined;

        if (refusing !== undefined && (outage !== "moved" || movedFrom)) {
          throw refusing;
        }

        // oxlint-disable-next-line anti-slop/no-reflect-apply, typescript/no-unsafe-return -- whatever the store's own method answers
        return await Reflect.apply(value, target, args);
      };
    },
  });
}

function withOutages(dir: string): Store {
  const at = movedTo ?? dir;
  const known = outages.get(at) ?? answering(openedFirst(at), movedTo === undefined);
  outages.set(at, known);

  return known;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A client that never claimed hex, which no tenure refuses.
const unclaimedFirst = stores.unclaimed;
const unclaimedWithOutages = (dir: string): Store => answering(unclaimedFirst(dir), false, false);

await mock.module("./store.ts", () => ({
  ...stores,
  open: withOutages,
  unclaimed: unclaimedWithOutages,
}));

const toldOwner: string[] = [];

const ignoreLost = (): void => undefined;

await mock.module("./notice.ts", () => ({
  tellOwner: (text: string) => {
    toldOwner.push(text);

    return Promise.resolve(true);
  },
  cantStart: () => (why: string) => {
    toldOwner.push(`can't start: ${why}`);
  },
}));

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Once what the hub set going has ended: its commands to Claude, and its calls to the store, which a home across the network answers late (late.ts).
async function settled() {
  do {
    await commandsSettled();
  } while (await landed());
}

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
let hub: Hub;
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
[ "$1 $2" = "daemon status" ] && [ -f "${dir}/daemon.pid" ] && echo "pid: $(cat "${dir}/daemon.pid")"
[ "$1 $2" = "daemon stop" ] && rm -f "${dir}/daemon"
[ "$1" = "--version" ] && echo "2.1.0 (Claude Code)"
[ "$1 $2" = "daemon run" ] && echo >> "${dir}/daemon-runs" && while [ -f "${dir}/held" ]; do sleep 0.05; done
[ "$1 $2" = "daemon run" ] && rm -f "${dir}/down"
[ "$1" = "--bg" ] && echo "backgrounded · job12345 · test"
[ "$1" = "-p" ] && cat > "${dir}/rewound" && echo '{}' > "${dir}/projects/$(pwd | sed 's/[^a-zA-Z0-9]/-/g')/rewound-session.jsonl" && echo '{"session_id":"rewound-session","stop_reason":"end_turn"}'
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
  outage = undefined;
  toldOwner.length = 0;
  claimedAs(undefined);
  refusingOver = undefined;
  refusingKey = undefined;
  movedTo = undefined;

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
    file(dir).messages.take(payload.meta.key, SESSION);
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// stale: the registry's sessions started with what the hub no longer gives a session, as after an update.
async function start(
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
    tellAfter?: number;
  } = {},
) {
  const {
    idleStop,
    cacheWarm,
    compactAbove,
    reconnect,
    connect: connectWait = 0,
    capacity,
    tellAfter,
  } = options;

  if (options.registry) {
    file(dir).threads.keep(
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

  for (const { session: kept, cwd } of Object.values(options.registry ?? {})) {
    if (kept !== undefined) {
      saved(kept, cwd);
    }
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
  hub = await startHub({
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
        tellAfter,
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
  const path = args[args.indexOf("--settings") + 1] ?? "";

  return SettingsFile.parse(JSON.parse(readFileSync(path, "utf-8")));
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Without the digest of what each session started with, which only the renew tests look at.
function registry(): Record<string, Registered> {
  return Object.fromEntries(
    file(dir)
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
  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
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
    },
  });
  expect(states).toEqual([["chat:7", true]]);
});

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

test("a new thread prompt comes last, where --channels cannot swallow it", async () => {
  await start();
  hub.open("chat:8", "OpenAI", "find the latest model");
  const args = await launched();
  expect(args.at(-1)).toBe("find the latest model");
  expect(args.at(-3)).toBe("--settings");
});

test("queued messages reach the session when it connects, and its id is kept", async () => {
  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  saved();
  const { received } = await session("chat:7");
  await until(() => received.length);
  expect(received).toEqual([inbound(message)]);
  expect(registry()["chat:7"]).toEqual({ name: "Desk anchors", session: SESSION });
});

test("a stopped thread has its job record cleared, then resumes under the same id", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } }, agents: [] });
  await hub.deliver("chat:7", "Desk anchors", message);
  const args = await launched();
  expect(
    calls().find((each) => !["agents", "daemon", "--version"].includes(each[0] ?? "")),
  ).toEqual(["rm", SESSION.slice(0, 8)]);
  expect(args).toContain("--resume");
  expect(args[args.indexOf("--resume") + 1]).toBe(SESSION);
});

test("a stopped thread whose big conversation's cache has expired starts a new session that takes over from it", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } }, agents: [] });
  said(120_000, false, SESSION, clock.now() - 61 * 60_000);
  await hub.deliver("chat:7", "Desk anchors", message);
  const args = await launched();
  expect(args).not.toContain("--resume");
  expect(settingsOf(args).env.HEX_HANDOFF).toEndWith(`/${SESSION}.jsonl`);
});

test("a stopped thread resumes while its cache is warm", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } }, agents: [] });
  said(120_000, false, SESSION, clock.now() - 50 * 60_000);
  await hub.deliver("chat:7", "Desk anchors", message);
  const args = await launched();
  expect(args[args.indexOf("--resume") + 1]).toBe(SESSION);
  expect(settingsOf(args).env.HEX_HANDOFF).toBeUndefined();
});

test("a stopped thread with a small conversation resumes even once its cache has expired", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } }, agents: [] });
  said(60_000, false, SESSION, clock.now() - 3 * 60 * 60_000);
  await hub.deliver("chat:7", "Desk anchors", message);
  const args = await launched();
  expect(args[args.indexOf("--resume") + 1]).toBe(SESSION);
});

test("a thread whose session is still running is never relaunched", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
  });
  await hub.deliver("chat:7", "Desk anchors", message);
  await settled();
  expect(calls().every((each) => each[0] === "agents")).toBe(true);
  const { received } = await session("chat:7");
  await until(() => received.length);
  expect(heard(received)[0]?.content).toBe("hi");
});

test("an answer Claude couldn't give is asked again, never read as nothing running", async () => {
  await start({ agents: [{ sessionId: SESSION, pid: 42 }] });
  writeFileSync(join(dir, "unreadable"), "");
  hub.adopt("chat:7", "Desk anchors", SESSION);
  await hub.deliver("chat:7", "Desk anchors", message);
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
  await start({
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

test("threads that start together while Claude's daemon is down start it once", async () => {
  writeFileSync(join(dir, "down"), "");
  writeFileSync(join(dir, "held"), "");

  const daemonRuns = () =>
    existsSync(join(dir, "daemon-runs"))
      ? readFileSync(join(dir, "daemon-runs"), "utf-8").length
      : 0;

  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
  await hub.deliver("chat:8", "Lamp", message);
  await hub.deliver("chat:9", "Shelf", message);

  await until(() => daemonRuns() > 0);
  await time.advance(10_000);
  expect(daemonRuns()).toBe(1);
  rmSync(join(dir, "held"));
});

test("a daemon left on an older claude is stopped with its sessions kept, so the session starts on a current one", async () => {
  writeFileSync(join(dir, "daemon"), "2.0.9");
  await start({ main: "chat", general: true });
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
  await start({
    main: "chat",
    general: true,
    registry: { chat: { name: "hex", session: SESSION } },
  });
  await launched();

  const order = calls().map((each) => each[0]);

  expect(order.indexOf("--version")).toBeLessThan(order.indexOf("rm"));
});

test("a daemon on the claude that's installed is left running", async () => {
  await start({ main: "chat", general: true });
  await launched();
  expect(calls().some((each) => each[0] === "daemon" && each[1] === "stop")).toBe(false);
});

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Each login shell can put a directory of its own on PATH that links to the same commands, as fnm does for node.
async function daemonWithPath(ours: string, theirs: string) {
  const daemon = Bun.spawn(["sleep", "60"], { env: { PATH: `${theirs}:${process.env.PATH}` } });

  sleepers.push(daemon);
  writeFileSync(join(dir, "daemon.pid"), String(daemon.pid));
  const path = process.env.PATH;
  process.env.PATH = `${ours}:${path}`;

  try {
    await start({ main: "chat", general: true });
    await launched();
  } finally {
    process.env.PATH = path;
  }

  return calls().some((each) => each[0] === "daemon" && each[1] === "stop");
}

function commandsIn(name: string, commands: string[]) {
  const directory = join(dir, name);

  mkdirSync(directory);

  for (const command of commands) {
    writeFileSync(join(directory, command), "");
  }

  return directory;
}

function linkTo(name: string, target: string) {
  symlinkSync(target, join(dir, name));

  return join(dir, name);
}

test("a daemon whose PATH finds the same commands is left running, though through another directory", async () => {
  const node = commandsIn("node-24", ["node"]);

  expect(await daemonWithPath(linkTo("ours", node), linkTo("theirs", node))).toBe(false);
});

test("a daemon whose PATH lacks a command the hub's finds is stopped with its sessions kept", async () => {
  const ours = commandsIn("ours", ["only-here"]);

  expect(await daemonWithPath(ours, commandsIn("theirs", []))).toBe(true);
});

test("a daemon whose PATH finds another copy of a command than the hub's is stopped with its sessions kept", async () => {
  expect(await daemonWithPath(commandsIn("ours", ["node"]), commandsIn("theirs", ["node"]))).toBe(
    true,
  );
});

test("the main thread starts with the hub, under its name, with no prompt and no typing", async () => {
  await start({ main: "chat", general: true });
  const args = await launched();
  expect(args.slice(0, 5)).toEqual(["--bg", "--channels", CHANNEL, "--name", "hex"]);
  expect(args.at(-2)).toBe("--settings");
  expect(settingsOf(args).env.HEX_MAIN).toBe("1");
  expect(states).toEqual([]);
});

test("a running main thread is left to reconnect, and gets its messages when it does", async () => {
  await start({
    main: "chat",
    registry: { chat: { name: "chat", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
  });
  await hub.deliver("chat", "hex", message);
  await settled();
  expect(calls().every((each) => each[0] === "agents")).toBe(true);
  expect(registry().chat?.name).toBe("hex");
  const { received } = await session("chat");
  await until(() => received.length);
  expect(heard(received)[0]?.content).toBe("hi");
});

test("a main thread whose session is gone is resumed again, and is never stopped for being idle", async () => {
  await start({
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
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
    reconnect: 50,
  });
  const { close } = await session("chat:7");
  file(dir).turns.turned(SESSION, true, "2026-01-01T00:00:00.000Z");
  writeFileSync(join(dir, "agents"), "[]");
  close();
  await time.armed(50);
  expect(file(dir).turns.get(SESSION).ended).toBeUndefined();
  await time.lapse(50);
  const ended = await until(() => file(dir).turns.get(SESSION).ended);
  expect(ended > "2026-01-01T00:00:00.000Z").toBe(true);

  writeFileSync(join(dir, "agents"), JSON.stringify([{ sessionId: SESSION, pid: 42 }]));
  await hub.deliver("chat:7", "Desk anchors", message);
  const again = await session("chat:7");
  file(dir).turns.turned(SESSION, false, "2027-01-01T00:00:00.000Z");
  writeFileSync(join(dir, "agents"), "[]");
  again.close();
  await time.lapse(50);
  await settled();
  expect(file(dir).turns.get(SESSION).ended).toBe("2027-01-01T00:00:00.000Z");
});

test("what a session took and never answered goes to the thread's next session once it dies; what it answered stays answered", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
    reconnect: 50,
  });
  await hub.deliver("chat:7", "Desk anchors", { ...message, content: "answered" });
  const first = await session("chat:7");
  await until(() => first.received.length);
  file(dir).turns.turned(SESSION, true, "2026-01-01T00:00:00.000Z");
  fold(first.received);
  file(dir).turns.turned(SESSION, false);
  file(dir).turns.handled(SESSION);
  await first.send({ type: "state", thread: "chat:7", busy: false });
  await hub.deliver("chat:7", "Desk anchors", { ...message, content: "hanging" });
  await until(() => first.received.length === 2);
  file(dir).turns.turned(SESSION, true);
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

test("a hub that starts after its sessions died (a reboot, or a move to another machine) gives what they never answered to their threads' next sessions at once", async () => {
  const store = file(dir);
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
  await start({ agents: [] });
  await launched();
  const next = await session("chat:7");
  await until(() => next.received.length);
  expect(heard(next.received)[0]?.content).toBe("mid-turn");
  expect(store.turns.get(SESSION).ended).toBeDefined();
});

const agentsStillWork = async (store: File) => {
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

  store.messages.deliver(
    {
      key: "telegram:1:11",
      to: "chat:7",
      from: "telegram",
      author: "hex",
      body: "on it",
      meta: {},
    },
    SESSION,
  );

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
  expect(store.turns.get(SESSION).ended).toBeDefined();
  expect(store.turns.midTurn("chat:7")).toBe(true);
};

const startsAgainToldItsAgentsEnded = async (store: File, unanswered: string[] = []) => {
  await start({ agents: [], reconnect: 50 });
  await time.lapse(50);
  await launched();
  const next = await session("chat:7");
  await until(() => next.received.length > unanswered.length);
  await settled();
  const contents = heard(next.received).map(({ content }) => content);
  expect(contents.slice(0, -1)).toEqual(unanswered);
  expect(contents.at(-1)).toContain("background agents");
  expect(store.messages.get("telegram:1:10")?.taken?.by).toBe(SESSION);
  expect(store.turns.midTurn("chat:7")).toBe(false);
};

test("a session that died while its background agents still worked (a reboot) starts again, told by the hub that they ended, without the message it already answered", async () => {
  const store = file(dir);
  await agentsStillWork(store);
  await startsAgainToldItsAgentsEnded(store);
});

test("a session that died in a turn one of its agents' reports began starts again the same way", async () => {
  const store = file(dir);
  await agentsStillWork(store);
  store.turns.turned(SESSION, true);
  await startsAgainToldItsAgentsEnded(store);
});

test("a session that died mid-turn after starting background agents gives back that turn's message and is told the agents ended too", async () => {
  const store = file(dir);
  await agentsStillWork(store);
  store.messages.deliver({
    key: "telegram:1:12",
    to: "chat:7",
    from: "telegram",
    author: "owner",
    body: "and one more thing",
    meta: {},
  });
  store.turns.turned(SESSION, true);
  store.messages.take("telegram:1:12", SESSION);
  await startsAgainToldItsAgentsEnded(store, ["and one more thing"]);
});

test("a session the hub stops while idle has handled what it took, even with its turn left open (Esc in an attached terminal runs no Stop hook)", async () => {
  await start({ idleStop: 50, reconnect: 50 });
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  const line = await session("chat:7");
  await until(() => line.received.length);
  file(dir).turns.turned(SESSION, true, "2026-01-01T00:00:00.000Z");
  fold(line.received);
  await line.send({ type: "state", thread: "chat:7", busy: false });
  await time.lapse(50);
  await until(() => calls().some((each) => each[0] === "stop"));
  const starts = calls().filter((each) => each[0] === "--bg").length;
  line.close();
  await time.lapse(50);
  await settled();
  expect(file(dir).messages.untaken("chat:7")).toEqual([]);
  expect(file(dir).turns.get(SESSION).handled).toBeDefined();
  expect(calls().filter((each) => each[0] === "--bg").length).toBe(starts);
});

test("a session whose turn failed (StopFailure) keeps what it took when it stops, since its conversation holds it", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
    reconnect: 50,
  });
  await hub.deliver("chat:7", "Desk anchors", message);
  const line = await session("chat:7");
  await until(() => line.received.length);
  file(dir).turns.turned(SESSION, true, "2026-01-01T00:00:00.000Z");
  fold(line.received);
  file(dir).turns.turned(SESSION, false);
  writeFileSync(join(dir, "agents"), "[]");
  line.close();
  await time.lapse(50);
  await settled();
  expect(file(dir).messages.untaken("chat:7")).toEqual([]);
  expect(calls().some((each) => each[0] === "--bg")).toBe(false);
});

test("a session that dies before its conversation is saved leaves the thread on its last saved one", async () => {
  const OLD = SESSION;
  const NEW = "4460ed71-0000-4000-8000-000000000000";
  saved(OLD);
  await start({
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
  await start();
  const { call } = await session("chat:9");
  expect(await call("reply", { text: "yo" })).toEqual({
    content: [{ type: "text", text: "reply in chat:9" }],
  });
});

test("a permission prompt reaches the client with its thread, and the answer goes back to that session alone", async () => {
  await start();
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
  await start({
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
  await hub.deliver("chat:7", "Desk anchors", message);
  await until(() => back.received.length);
});

test("a session still running once its channel stays gone restarts in place, and gets what waited when it reconnects", async () => {
  bound("chat:7");
  await start({
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
  await hub.deliver("chat:7", "Desk anchors", message);
  const back = await session("chat:7");
  await until(() => back.received.length);
  expect(heard(back.received)[0]?.content).toBe("hi");
  await time.advance(150);
  expect(calls().filter((each) => each[0] === "respawn").length).toBe(1);
  expect(failures).toEqual([]);
});

test("a starting session gets as long as Claude Code is told to wait for its channel, and its message shows it waits until the session takes it", async () => {
  await start({ reconnect: 50, connect: 1000 });
  await hub.deliver("chat:7", "Desk anchors", message);
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
  await start({ reconnect: 50, connect: 200 });
  await hub.deliver("chat:7", "Desk anchors", message);
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
  await start({ reconnect: 50, connect: 60_000, agents: [] });
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  await time.lapse(50);
  await until(() => failures.length);
  expect(failures).toEqual([["chat:7", "its session ended before its channel connected"]]);
});

test("a session that restarts in place keeps what its launcher added to its settings, and gets the hub's current token", async () => {
  bound("chat:7");
  const path = join(dir, "sessions", "chat%3A7.json");
  writeFileSync(
    path,
    JSON.stringify({
      model: "claude-sonnet-5-5",
      claudeMdExcludes: ["/rules.md"],
      enabledPlugins: { "other@hex": true },
      env: { HEX_CHANNEL: CHANNEL, HEX_THREAD: "chat:7", HEX_TOKEN: "old", HEX_WAKE: "/wake.md" },
    }),
  );
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, startedAt: 1 }],
    reconnect: 50,
  });
  await time.lapse(50);
  await until(() => calls().find((each) => each[0] === "respawn"));
  const settings = SettingsFile.parse(JSON.parse(readFileSync(path, "utf-8")));
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
  await start({
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

test("a restart in place that can't write the session's settings file is a failed start, and the thread's next message starts it", async () => {
  bound("chat:7");
  const settings = join(dir, "sessions", "chat%3A7.json");
  const startedWith = join(dir, "sessions", "started-with.json");
  renameSync(settings, startedWith);
  mkdirSync(settings);
  writeFileSync(
    join(dir, "jobs", SESSION.slice(0, 8), "state.json"),
    JSON.stringify({
      state: "working",
      sessionId: SESSION,
      respawnFlags: ["--settings", startedWith],
    }),
  );
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, startedAt: 1 }],
    reconnect: 50,
  });
  await time.lapse(50);
  await until(() => failures.length);
  expect(failures).toEqual([["chat:7", matching(/chat%3A7\.json/u)]]);
  expect(respawns()).toEqual([]);
  rmSync(settings, { recursive: true });
  writeFileSync(join(dir, "agents"), "[]");
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
});

test("a wait for a session's channel that breaks is over, and the thread's next message takes its session up again", async () => {
  bound("chat:7");
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, startedAt: 1 }],
    reconnect: 50,
  });
  const { close } = await session("chat:7");
  const listing = spyOn(claude, "agents").mockRejectedValueOnce(new Error("no list of sessions"));

  try {
    close();
    await time.lapse(50);
    await time.advance(150);
    expect(listing).toHaveBeenCalledTimes(1);
    expect(respawns()).toEqual([]);
    await hub.deliver("chat:7", "Desk anchors", message);
    await time.lapse(50);
    await until(() => respawns().length);
    expect(failures).toEqual([]);
  } finally {
    listing.mockRestore();
  }
});

test("a starting session the hub stopped, since it couldn't restart it in place, is still reported when its start fails", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [],
    reconnect: 50,
  });
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ sessionId: SESSION, pid: EXITED, startedAt: 1 }]),
  );
  await time.lapse(50);
  await until(() => calls().find((each) => each[0] === "stop"));
  await job("job12345", { state: "failed", detail: "exit 1 before init" });
  await until(() => failures.length);
  expect(failures).toEqual([["chat:7", "exit 1 before init"]]);
});

test("a session still running mid-turn when the hub starts gets its window to reconnect before anything else starts for its thread", async () => {
  bound("chat:7");
  const store = file(dir);
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
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, startedAt: 1 }],
    reconnect: 50,
  });
  await time.armed(50);
  await settled();
  expect(calls().filter((each) => each[0] === "--bg" || each[0] === "respawn")).toEqual([]);
  expect(file(dir).turns.midTurn("chat:7")).toBe(true);
  await time.lapse(50);
  expect(await until(() => calls().find((each) => each[0] === "respawn"))).toEqual([
    "respawn",
    SESSION.slice(0, 8),
  ]);
});

test("a session that outlived the hub and never reconnects restarts in place", async () => {
  bound("chat:7");
  await start({
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
  await start({
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
  await start({
    registry: { "chat:7": { name: "Desk anchors" } },
    agents: [{ id: "job99999", sessionId: NEW, pid: 42, startedAt: clock.now() + 60_000 }],
    reconnect: 60_000,
  });
  await hub.deliver("chat:7", "Desk anchors", message);
  await settled();
  const { received } = await session("chat:7", NEW);
  await until(() => received.length);
  expect(calls().some((each) => each[0] === "--bg")).toBe(false);
});

test("a message for a running session with no channel waits for it, and starts it again once it has ended", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, startedAt: clock.now() + 60_000 }],
    reconnect: 50,
  });
  await hub.deliver("chat:7", "Desk anchors", message);
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
  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
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
  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
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
  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
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
  await start();
  const line = http("chat:7");
  const response = await line.open(crypto.randomUUID());
  expect(response.status).toBe(200);
  await hub.deliver("chat:7", "Desk anchors", message);
  await until(() => line.received.length);
  expect(calls().some((each) => each[0] === "--bg")).toBe(false);
  expect(await line.call("reply", { text: "yo" })).toEqual({
    content: [{ type: "text", text: "reply in chat:7" }],
  });
});

test("the hub declines the newest protocol, whose sessions get no channel, and offers one that has it", async () => {
  await start();
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
  await start();
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
  await start();
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
  await hub.deliver("chat:7", "Desk anchors", message);
  const settings = (await launched()).at(-1) ?? "";
  expect(statSync(settings).mode % 0o1000).toBe(0o600);
});

test("a session with no thread, or another channel's, gets no messages and acts on no thread", async () => {
  await start();
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
  await hub.deliver("chat:7", "Desk anchors", message);
  await settled();
  expect(other.received).toEqual([]);
});

test("busy and idle from session hooks reach the client, and a dropped session is idle", async () => {
  await start();
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
  await start({ idleStop: 50 });
  await hub.deliver("chat:7", "Desk anchors", message);
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
  await start({ idleStop: 50 });
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
  await start({
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
  await start({
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
  await start({
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
  await start({
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
  await start({
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
  await start({
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

test("a launcher that can't run fails the start instead of leaving it hanging", async () => {
  await start({ launcher: join(dir, "missing") });
  await hub.deliver("chat:7", "Desk anchors", message);
  await until(() => failures.length);
  expect(failures[0]?.[0]).toBe("chat:7");
  expect(states).toEqual([
    ["chat:7", true],
    ["chat:7", false],
  ]);
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

test("a session that fails to start is reported with its reason, and the next message retries", async () => {
  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
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
  await hub.deliver("chat:7", "Desk anchors", message);
  await until(() => calls().filter((each) => each[0] === "--bg").length === 2);
});

test("a start that throws before its session launches is a failed start for its thread, not an error for whoever asked for it", async () => {
  await start();
  const push = states.push.bind(states);

  states.push = () => {
    states.push = push;

    throw new Error("the chat can't be shown as working");
  };

  await hub.deliver("chat:7", "Desk anchors", message);
  await until(() => failures.length);
  expect(failures).toEqual([["chat:7", "the chat can't be shown as working"]]);
  expect(bgStarts()).toEqual([]);
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
});

test("a start that fails stops watching its job record", async () => {
  const { watchJob } = claude;
  const watches: unknown[] = [];

  const watching = spyOn(claude, "watchJob").mockImplementation((id, change) => {
    const opened = watchJob(id, change);
    const close = opened.close.bind(opened);
    watches.push(opened);

    opened.close = () => {
      watches.splice(watches.indexOf(opened), 1);
      close();
    };

    return opened;
  });

  try {
    await start();
    await hub.deliver("chat:7", "Desk anchors", message);
    await launched();
    expect(watches.length).toBe(1);
    await job("job12345", { state: "failed", detail: "exit 1 before init" });
    await until(() => failures.length);
    expect(watches).toEqual([]);
  } finally {
    watching.mockRestore();
  }
});

test("a start that fails before its session launches, as on a settings file it can't write, is reported, and the next message starts it", async () => {
  await start();
  const settings = join(dir, "sessions", "chat%3A7.json");
  mkdirSync(settings);
  await hub.deliver("chat:7", "Desk anchors", message);
  await until(() => failures.length);
  expect(failures).toEqual([["chat:7", matching(/chat%3A7\.json/u)]]);
  expect(states).toEqual([
    ["chat:7", true],
    ["chat:7", false],
  ]);
  expect(bgStarts()).toEqual([]);
  rmSync(settings, { recursive: true });
  await hub.deliver("chat:7", "Desk anchors", { ...message, content: "again" });
  await launched();
});

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A launcher whose starts each wait for the test: the first is under way once start1 is there and returns once go1 is, and so on. One let go with words fails with them, as claude --bg does.
function slowLauncher() {
  const launcher = join(dir, "launch");
  writeFileSync(
    launcher,
    `#!/bin/sh
n=1
until mkdir "${dir}/start$n" 2>/dev/null; do [ -d "${dir}" ] || exit 0; n=$((n + 1)); done
until [ -f "${dir}/go$n" ]; do [ -d "${dir}" ] || exit 0; sleep 0.02; done
[ -s "${dir}/go$n" ] && { cat "${dir}/go$n"; exit 1; }
exec claude "$@"
`,
  );
  chmodSync(launcher, 0o755);

  return launcher;
}

test("a start still under way when its thread closes doesn't fail the thread's next start when it fails", async () => {
  await start({ launcher: slowLauncher() });
  await hub.deliver("chat:7", "Desk anchors", message);
  await until(() => existsSync(join(dir, "start1")));
  void hub.retire("chat:7");
  await hub.deliver("chat:7", "Desk anchors", { ...message, content: "again" });
  await until(() => existsSync(join(dir, "start2")));
  writeFileSync(join(dir, "go1"), "claude: the daemon stopped answering");
  writeFileSync(join(dir, "go2"), "");
  await launched();
  const { received } = await session("chat:7");
  await until(() => heard(received).some((each) => each.content === "again"));
  expect(failures).toEqual([]);
});

test("a session that connects before the command that started it has returned is still seen to pause", async () => {
  const needs = "Answer the permission prompt in the terminal to continue";
  await start({ launcher: slowLauncher(), reconnect: 50 });
  await hub.deliver("chat:7", "Desk anchors", message);
  await until(() => existsSync(join(dir, "start1")));
  bound("chat:7", SESSION, "job12345");
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ id: "job12345", sessionId: SESSION, pid: process.pid, startedAt: 1 }]),
  );
  const line = http("chat:7");
  await line.initialize();
  await line.open();
  await line.rpc("tools/list");
  await until(() => line.listed() === 2);
  expect(bgStarts()).toEqual([]);
  writeFileSync(join(dir, "go1"), "");
  await launched();
  await turning("chat:7", line);
  await pauses("job12345", needs);
  await until(() => failures.length);
  expect(failures).toEqual([
    [
      "chat:7",
      `its session stopped on a question only its terminal can answer ("${needs}"), so your message got no answer. Your next message starts it again.`,
    ],
  ]);
});

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A launcher whose resumes fail as Claude Code fails one of a session no project folder has, its conversation in hex's folder gone as it resumes.
function forgetting() {
  const launcher = join(dir, "launch");
  const project = join(dir, "projects", join(dir, "hex").replaceAll(/[^a-zA-Z0-9]/gu, "-"));
  writeFileSync(
    launcher,
    `#!/bin/sh
case "$*" in *--resume*) rm -rf '${project}'; echo "backgrounded · jobgone1 · test"; exit 0;; esac
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

test("a thread whose session's conversation no project folder has, as after hex is restored on a new machine, starts a new session that takes over from hex.db", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } }, agents: [] });
  rmSync(join(dir, "projects"), { recursive: true });
  await hub.deliver("chat:7", "Desk anchors", message);
  const args = await launched();
  expect(args).not.toContain("--resume");
  expect(settingsOf(args).env.HEX_HANDOFF).toEndWith(`/${SESSION}.jsonl`);
  saved("2c3d4e5f-0000-4000-8000-000000000000");
  const { received } = await session("chat:7", "2c3d4e5f-0000-4000-8000-000000000000");
  await until(() => received.length);
  expect(received).toEqual([inbound(message)]);
  await until(() => registry()["chat:7"]?.session === "2c3d4e5f-0000-4000-8000-000000000000");
  expect(failures).toEqual([]);
});

test("a thread whose session's conversation vanishes as it resumes starts a new one, which hears why when it connects", async () => {
  await start({
    launcher: forgetting(),
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [],
  });
  await hub.deliver("chat:7", "Desk anchors", message);
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
  await start({
    launcher: forgetting(),
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [],
  });
  saved(SESSION, join(dir, "elsewhere"));
  await hub.deliver("chat:7", "Desk anchors", message);
  await until(() => failures.length);
  expect(failures).toEqual([["chat:7", `source session ${SESSION} not found`]]);
  expect(registry()["chat:7"]).toEqual({ name: "Desk anchors", session: SESSION });
});

test("a thread that would fork a session Claude Code no longer has starts a new one instead", async () => {
  await start({
    launcher: forgetting(),
    registry: { "chat:7": { name: "Desk anchors", from: SESSION } },
    agents: [],
  });
  await hub.deliver("chat:7", "Desk anchors", message);
  expect(await launched()).not.toContain("--resume");
  expect(registry()["chat:7"]).toEqual({ name: "Desk anchors" });
  expect(failures).toEqual([]);
});

test("a thread whose session failed to start starts again once another session connects, and gets the message that waited", async () => {
  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
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
  await start();
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

test("a thread whose starts keep failing says so in its chat with each message, and hex beside General hears of it once, at the third", async () => {
  await start({ main: "general", general: true, launcher: besideLauncher() });
  await launched();
  const general = await session("general");
  writeFileSync(
    join(dir, "jobs", "job12345", "state.json"),
    JSON.stringify({ state: "failed", detail: "exit 1 before init" }),
  );

  for (const n of [1, 2, 3, 4]) {
    await hub.deliver("chat:7", "Desk anchors", { ...message, content: `try ${n}` });
    await until(() => restsOf("chat:7") === n);
  }

  expect(failures).toEqual(Array.from({ length: 4 }, () => ["chat:7", "exit 1 before init"]));
  const run = await until(() => runs()[0]);
  expect(run.args.at(-1)).toContain(
    '[hub] hex couldn\'t start the session of telegram thread "Desk anchors" 3 times in a row: exit 1 before init. Its next message starts it again.',
  );
  expect(runs()).toHaveLength(1);
  expect(general.received).toEqual([]);
});

test("General hears of a thread that keeps failing once its hub is there, even when that's after the third", async () => {
  await start();
  writeFileSync(
    join(dir, "jobs", "job12345", "state.json"),
    JSON.stringify({ state: "failed", detail: "exit 1 before init" }),
  );

  for (const n of [1, 2, 3]) {
    await hub.deliver("chat:7", "Desk anchors", { ...message, content: `try ${n}` });
    await until(() => restsOf("chat:7") === n);
  }

  mkdirSync(join(dir, "general"));

  const general = await startHub({
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
    await hub.deliver("chat:7", "Desk anchors", { ...message, content: "try 4" });
    await until(() => restsOf("chat:7") === 4);
    await until(() => file(dir).messages.untaken("beside:general").length);
    expect(
      file(dir)
        .messages.untaken("beside:general")
        .map((row) => row.body),
    ).toEqual([
      '[hub] hex couldn\'t start the session of telegram thread "Desk anchors" 4 times in a row: exit 1 before init. Its next message starts it again.',
    ]);
  } finally {
    general.close();
  }
});

test("General whose start failed starts again with each next message, as its heartbeat, says so in its chat each time, and leaves itself no message", async () => {
  await start({ main: "general", general: true });
  await launched();
  writeFileSync(
    join(dir, "jobs", "job12345", "state.json"),
    JSON.stringify({ state: "failed", detail: "exit 1 before init" }),
  );

  for (const n of [1, 2, 3]) {
    if (n > 1) {
      await hub.deliver("general", "hex", { ...message, content: `try ${n}` });
    }

    await until(() => restsOf("general") === n);
    expect(calls().filter((each) => each[0] === "--bg")).toHaveLength(n);
  }

  expect(failures).toEqual(Array.from({ length: 3 }, () => ["general", "exit 1 before init"]));
  expect(
    file(dir)
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
  await start({ launcher });

  const tries = () =>
    existsSync(join(dir, "tries"))
      ? readFileSync(join(dir, "tries"), "utf-8").split("\n").length - 1
      : 0;

  await hub.deliver("chat:7", "Desk anchors", message);
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
  await hub.deliver("chat:7", "Desk anchors", { ...message, content: "again" });
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
  await start({ launcher });

  const tries = () =>
    existsSync(join(dir, "tries"))
      ? readFileSync(join(dir, "tries"), "utf-8").split("\n").length - 1
      : 0;

  await hub.deliver("chat:7", "Desk anchors", message);
  await until(() => failures.length);
  hub.open("chat:8", "OpenAI");
  await launched();
  await session("chat:8", "1b2c3d4e-0000-4000-8000-000000000000");
  await until(() => tries() === 2);
  await hub.deliver("chat:7", "Desk anchors", { ...message, content: "again" });
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
  await start({ launcher });

  const tries = () =>
    existsSync(join(dir, "tries"))
      ? readFileSync(join(dir, "tries"), "utf-8").split("\n").length - 1
      : 0;

  await hub.deliver("chat:7", "Desk anchors", message);
  await until(() => failures.length);
  hub.open("chat:8", "OpenAI");
  await launched();
  const connected = session("chat:8", "1b2c3d4e-0000-4000-8000-000000000000");
  await until(() => tries() === 2);
  await hub.deliver("chat:7", "Desk anchors", { ...message, content: "again" });
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
  await start({ reconnect: 50 });
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

test("a turn that fails on the API is told in its chat once, carries on once another thread's turn goes through, and waits for its next message if that fails too", async () => {
  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  const stuck = await session("chat:7");
  await until(() => stuck.received.length);
  const limited = "API Error: Server is temporarily limiting requests (not your usage limit)";
  const failure = { failed: true, error: "rate_limit", said: limited };
  await stuck.send({ type: "state", thread: "chat:7", busy: false, ...failure });
  await stuck.send({ type: "state", thread: "chat:7", busy: false, ...failure });
  expect(failures).toEqual([["chat:7", `${limited}\nIt carries on once turns go through again.`]]);

  hub.open("chat:8", "OpenAI");
  await until(() => bgStarts().length === 2);
  const other = await session("chat:8", "1b2c3d4e-0000-4000-8000-000000000000");
  await other.send({ type: "state", thread: "chat:8", busy: true });
  expect(stuck.received).toHaveLength(1);
  await other.send({ type: "state", thread: "chat:8", busy: false });
  await until(() => stuck.received.length === 2);
  expect(heard(stuck.received)[1]?.content).toStartWith(
    "[hub] Your last turn here failed on the API",
  );

  await stuck.send({ type: "state", thread: "chat:7", busy: true });
  await stuck.send({ type: "state", thread: "chat:7", busy: false, ...failure });
  expect(failures[1]).toEqual(["chat:7", `${limited}\nIts next message starts it again.`]);
  await other.send({ type: "state", thread: "chat:8", busy: false });
  await settled();
  expect(stuck.received).toHaveLength(2);
});

test("a turn that fails on a login that stopped working carries on once a turn goes through again, with no new message", async () => {
  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  const stuck = await session("chat:7");
  await until(() => stuck.received.length);
  const expired = "Failed to authenticate: OAuth session expired";

  await stuck.send({
    type: "state",
    thread: "chat:7",
    busy: false,
    failed: true,
    error: "authentication_failed",
    said: expired,
  });
  expect(failures).toEqual([["chat:7", `${expired}\nIt carries on once turns go through again.`]]);

  hub.open("chat:8", "OpenAI");
  await until(() => bgStarts().length === 2);
  const other = await session("chat:8", "1b2c3d4e-0000-4000-8000-000000000000");
  await other.send({ type: "state", thread: "chat:8", busy: false });
  await until(() => stuck.received.length === 2);
  expect(heard(stuck.received)[1]?.content).toStartWith(
    "[hub] Your last turn here failed on the API",
  );
});

test("a turn that fails for good is told in its chat, and waits for its next message", async () => {
  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  const stuck = await session("chat:7");
  await until(() => stuck.received.length);
  await stuck.send({
    type: "state",
    thread: "chat:7",
    busy: false,
    failed: true,
    error: "invalid_request",
    said: "API Error: 400 prompt is too long",
  });
  expect(failures).toEqual([
    ["chat:7", "API Error: 400 prompt is too long\nIts next message starts it again."],
  ]);
  await stuck.send({ type: "state", thread: "chat:7", busy: false });
  await settled();
  expect(stuck.received).toHaveLength(1);
});

const REFUSED = "choose: retry on fallback model or edit prompt";

const FLAGGED =
  "the model's safety filter flagged your message as cyber, so it got no answer. Your next message starts this topic again from just before it, still on fable, with the flagged message left out: send what you need in other words.";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The session's transcript: a turn that went through, then one whose reply the model's safeguards refused, or with first, only the refused one.
function refused(first = false) {
  const project = join(dir, "projects", join(dir, "hex").replaceAll(/[^a-zA-Z0-9]/gu, "-"));
  mkdirSync(project, { recursive: true });

  const entries = [
    ...(first
      ? []
      : [
          { type: "user", uuid: "u1", parentUuid: null, message: { content: "drones?" } },
          { type: "assistant", uuid: "a1", parentUuid: "u1", message: { content: "Plenty." } },
        ]),
    {
      type: "user",
      uuid: "u2",
      parentUuid: first ? null : "a1",
      message: { content: '<channel source="telegram" key="telegram:1:5">jamming?</channel>' },
    },
    {
      type: "assistant",
      uuid: "a2",
      parentUuid: "u2",
      message: { content: [], stop_reason: "refusal", stop_details: { category: "cyber" } },
    },
  ];

  writeFileSync(
    join(project, `${SESSION}.jsonl`),
    entries.map((entry) => JSON.stringify(entry)).join("\n"),
  );
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Claude Code pausing the session on a dialog, as Claude lists it and its job record says.
function pauses(jobId = "job12345", needs = REFUSED) {
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ sessionId: SESSION, pid: EXITED, status: "waiting" }]),
  );

  return job(jobId, { state: "working", sessionId: SESSION, needs });
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A session that took the message and began its turn.
async function turning(thread: string, connected?: ReturnType<typeof http>) {
  const line = connected ?? (await session(thread));
  await until(() => line.received.length);
  file(dir).turns.turned(SESSION, true, "2026-01-01T00:00:00.000Z");
  fold(line.received);
  await line.send({ type: "state", thread, busy: true });

  return line;
}

const rewinds = () => calls().filter((each) => each[0] === "-p");

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A message for the paused session, which stops it; Claude still lists it until the hub's wait for its channel runs out, and then it starts again.
async function restarts(content: string) {
  await hub.deliver("chat:7", "Desk anchors", { ...message, content });
  await until(() => calls().some((each) => each[0] === "stop"));
  await settled();
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ sessionId: NEXT, pid: process.pid, status: "busy" }]),
  );
  await time.lapse(50);
  await until(() => bgStarts().length === 2);
}

test("a turn the model's safeguards refuse is told once in its chat, and its next message starts the topic on its model from a copy of the conversation that ends before it, which takes only that message", async () => {
  await start({ reconnect: 50 });
  await hub.deliver("chat:7", "Desk anchors", { ...message, content: "jamming?" });
  await launched();
  hub.configure("chat:7", { model: "fable" });
  const line = await turning("chat:7");
  refused();
  await pauses();
  await until(() => failures.length);
  await job("job12345", { state: "working", sessionId: SESSION, needs: REFUSED });
  await settled();
  expect(failures).toEqual([["chat:7", FLAGGED]]);
  expect(states.at(-1)).toEqual(["chat:7", false]);
  expect(file(dir).turns.get(SESSION).ended).toBeDefined();

  await restarts("what bands do drones use?");
  expect(calls().find((each) => each[0] === "stop")).toEqual(["stop", SESSION.slice(0, 8)]);

  expect(rewinds()).toEqual([
    [
      "-p",
      "--resume",
      SESSION,
      "--fork-session",
      "--resume-session-at",
      "a1",
      "--strict-mcp-config",
      "--tools",
      "",
      "--output-format",
      "json",
      "--model",
      "fable",
    ],
  ]);

  expect(bgStarts()[1]).toContain("rewound-session");
  expect(bgStarts()[1]?.slice(bgStarts()[1]?.indexOf("--model"))).toContain("fable");
  const next = await session("chat:7", NEXT);
  await until(() => next.received.length);
  expect(heard(next.received).map(({ content }) => content)).toEqual(["what bands do drones use?"]);
  expect(line.received).toHaveLength(1);
  expect(failures.filter(([, why]) => why === FLAGGED)).toHaveLength(1);
});

test("a refused turn that was its conversation's first starts the topic in a new session, with no copy and nothing taken over", async () => {
  await start({ reconnect: 50 });
  await hub.deliver("chat:7", "Desk anchors", { ...message, content: "jamming?" });
  await launched();
  await turning("chat:7");
  refused(true);
  await pauses();
  await until(() => failures.length);
  await restarts("what bands do drones use?");
  expect(rewinds()).toEqual([]);
  expect(bgStarts()[1]).not.toContain("--resume");
  expect(bgStarts()[1]).not.toContain(SESSION);
});

test("a session paused on a question for its terminal, not a refusal, is told in plain words once, and its next message starts it again", async () => {
  const needs = "Answer the permission prompt in the terminal to continue";
  await start({ reconnect: 50 });
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  await turning("chat:7");
  await pauses("job12345", needs);
  await until(() => failures.length);
  expect(failures).toEqual([
    [
      "chat:7",
      `its session stopped on a question only its terminal can answer ("${needs}"), so your message got no answer. Your next message starts it again.`,
    ],
  ]);
  await restarts("again");
  expect(rewinds()).toEqual([]);
});

test("a session already paused on a refusal when the hub connects to it, its owner's message unanswered, has its chat told, by the job record under the session's short id", async () => {
  bound("chat:7");
  file(dir).messages.deliver({
    key: "telegram:1:5",
    to: "chat:7",
    from: "telegram",
    author: "owner",
    body: "jamming?",
    meta: {},
  });
  file(dir).turns.turned(SESSION, true, "2026-01-01T00:00:00.000Z");
  file(dir).messages.take("telegram:1:5", SESSION);
  writeFileSync(
    join(dir, "jobs", SESSION.slice(0, 8), "state.json"),
    JSON.stringify({ state: "working", sessionId: SESSION, needs: REFUSED }),
  );
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION, model: "fable" } },
    agents: [{ sessionId: SESSION, pid: EXITED, status: "waiting" }],
  });
  refused();
  const line = await session("chat:7");
  await until(() => failures.length);
  expect(failures).toEqual([["chat:7", FLAGGED]]);
  expect(line.received).toEqual([]);
  expect(bgStarts()).toEqual([]);
});

test("a turn Claude Code paused on a dialog isn't given to the thread's next session when the paused one ends", async () => {
  await start({ reconnect: 50 });
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  const line = await turning("chat:7");
  await pauses();
  await until(() => file(dir).turns.get(SESSION).ended);
  writeFileSync(join(dir, "agents"), "[]");
  line.close();
  await time.lapse(50);
  await settled();
  expect(file(dir).messages.untaken("chat:7")).toEqual([]);
  expect(bgStarts()).toHaveLength(1);
});

test("threads an outage stalled carry on one for each turn that goes through", async () => {
  await start();

  const stalled = [
    ["chat:7", SESSION],
    ["chat:9", "3d4e5f60-0000-4000-8000-000000000000"],
  ] as const;

  const lines = [];

  for (const [thread, id] of stalled) {
    hub.open(thread, thread);
    await until(() => bgStarts().length === lines.length + 1);
    const line = await session(thread, id);
    await line.send({ type: "state", thread, busy: false, failed: true, error: "overloaded" });
    lines.push(line);
  }

  const [first, second] = lines;
  hub.open("chat:8", "OpenAI");
  await until(() => bgStarts().length === 3);
  const other = await session("chat:8", "1b2c3d4e-0000-4000-8000-000000000000");
  await other.send({ type: "state", thread: "chat:8", busy: false });
  await until(() => first?.received.length === 1);
  await settled();
  expect(second?.received).toHaveLength(0);
  await other.send({ type: "state", thread: "chat:8", busy: false });
  await until(() => second?.received.length === 1);
  expect(first?.received).toHaveLength(1);
});

test("a thread whose session runs without its channel is retried once, not each time another session starts", async () => {
  const STUCK = "2c3d4e5f-0000-4000-8000-000000000000";
  bound("chat:10", STUCK);
  writeFileSync(join(dir, "agents"), JSON.stringify([{ sessionId: STUCK, pid: 42, startedAt: 1 }]));
  await start({ reconnect: 50 });
  await hub.deliver("chat:10", "Stuck", message);
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
  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
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
  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  await session("chat:7");
  await job("job12345", { state: "failed", detail: "later" });
  expect(failures).toEqual([]);
});

test("stopping a thread ends its session now, and its next message resumes it", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
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
  await hub.deliver("chat:7", "Desk anchors", message);
  const args = await launched();
  expect(args[args.indexOf("--resume") + 1]).toBe(SESSION);
  expect(registry()["chat:7"]).toEqual({ name: "Desk anchors", session: SESSION });
});

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The session's conversation as Claude Code keeps it, for a thread working in hex's folder.
function conversation() {
  const path = join(
    dir,
    "projects",
    join(dir, "hex").replaceAll(/[^a-zA-Z0-9]/gu, "-"),
    `${SESSION}.jsonl`,
  );

  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, '{"type":"user","message":{"content":"run for a while"}}\n');

  return () => readFileSync(path, "utf-8");
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A session Claude's daemon lists as working, as it does through a turn and while background agents run.
function working() {
  const process = Bun.spawn(["sleep", "60"]);
  sleepers.push(process);

  return [{ sessionId: SESSION, pid: process.pid, status: "busy" }];
}

test("the owner's interrupt presses Esc in a busy session, which keeps running, and ends the turn, in hex's record of it too", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: working(),
  });
  const transcript = conversation();
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: true });
  await until(() => states.length);
  file(dir).turns.turned(SESSION, true);
  await hub.interrupt("chat:7");
  expect(transcript()).toContain("[Request interrupted by user");
  expect(states.at(-1)).toEqual(["chat:7", false]);
  expect(file(dir).turns.get(SESSION).ended).toBeDefined();
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
});

test("an interrupted turn Claude still reports working counts as one with background work left, so a renew waits for it to be done", async () => {
  await start({
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
  await start({
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
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: working(),
  });
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
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: working(),
  });
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
  await start({
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
  await start({
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
  await start({
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
  await hub.deliver("chat:7", "Desk anchors", message);
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
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, status: "idle" }],
  });
  await session("chat:7");
  writeFileSync(join(dir, "unanswering"), "");
  void hub.stop("chat:7");
  await until(() => calls().find((each) => each[0] === "stop"));
});

test("a thread's model and effort are kept, and a running session takes them by starting again with its next message", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, status: "idle" }],
  });
  const { received } = await session("chat:7");
  await hub.deliver("chat:7", "Desk anchors", message);
  await until(() => received.length);
  fold(received);
  hub.configure("chat:7", { model: "fable", effort: "xhigh" });
  await hub.synced();
  expect(registry()["chat:7"]).toEqual({
    name: "Desk anchors",
    session: SESSION,
    model: "fable",
    effort: "xhigh",
  });
  await hub.deliver("chat:7", "Desk anchors", { author: "owner", content: "again", meta: {} });
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

test("a thread a client opens with its settings is in hex.db before its first message, so a restart still knows it", async () => {
  await start();
  hub.register("chat:7", "Desk anchors", join(dir, "desk"));
  hub.configure("chat:7", {});
  await hub.synced();
  expect(registry()["chat:7"]).toEqual({ name: "Desk anchors", cwd: join(dir, "desk") });
});

test("a thread saved with a full model id runs its family's alias, so it gets the newest model", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION, model: "claude-opus-5-5" } },
    agents: [],
  });
  await hub.deliver("chat:7", "Desk anchors", message);
  const args = await launched();
  expect(args[args.indexOf("--model") + 1]).toBe("opus");
});

test("a fresh thread with no capacity starts a new session instead of resuming its last, and says so in its env", async () => {
  await start({
    registry: { dm: { name: "DM", session: SESSION } },
    agents: [],
    fresh: (thread) => thread === "dm",
    capacity: 0,
  });
  await hub.deliver("dm", "DM", message);
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
  await start({
    registry: { dm: { name: "DM", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: old.pid, status: "busy" }],
    fresh: (thread) => thread === "dm",
    capacity: 0,
  });
  const { received, send } = await session("dm");
  await hub.deliver("dm", "DM", message);
  await until(() => received.length);
  expect(received).toEqual([inbound(message)]);
  fold(received);
  said(50_000);
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ sessionId: SESSION, pid: old.pid, status: "idle" }]),
  );
  await send({ type: "state", thread: "dm", busy: false });
  await hub.deliver("dm", "DM", { author: "owner", content: "next", meta: {} });
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
  await start({
    registry: { dm: { name: "DM", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 999_999, state: "blocked" }],
    fresh: (thread) => thread === "dm",
  });
  const { received, send } = await session("dm");
  await hub.deliver("dm", "DM", message);
  await until(() => received.length);
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ sessionId: SESSION, pid: 999_999, status: "idle" }]),
  );
  await send({ type: "state", thread: "dm", busy: true });
  await until(() => states.length);
  await hub.deliver("dm", "DM", { author: "owner", content: "more", meta: {} });
  await settled();
  expect(await toolCall("dm")).toContain("more");
  expect(calls().some((each) => each[0] === "stop" || each[0] === "--bg")).toBe(false);
});

const NEXT = "0a1b2c3d-0000-4000-8000-000000000001";

const dm = async (
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
  await start({
    registry: { dm: { name: "DM", session: SESSION } },
    agents,
    fresh: (thread) => thread === "dm",
    capacity: 1000,
    ...options,
  });
};

test("a fresh thread's warm session takes every message as it comes, and stays up while it rests", async () => {
  await dm(
    [{ sessionId: SESSION, pid: 999_999, status: "idle", startedAt: clock.now() + 60_000 }],
    {
      idleStop: 10,
    },
  );
  said(500);
  const { received, send } = await session("dm");
  await hub.deliver("dm", "DM", message);
  await send({ type: "state", thread: "dm", busy: false });
  await until(() => states.length);
  await hub.deliver("dm", "DM", { author: "owner", content: "next", meta: {} });
  await until(() => received.length === 2);
  await time.advance(100);
  expect(calls().some((each) => each[0] === "stop" || each[0] === "--bg")).toBe(false);
});

test("a fresh thread whose session stopped starts a new one, warm or not, since a start rewrites its view past the cache", async () => {
  await dm([]);
  said(500);
  await hub.deliver("dm", "DM", message);
  expect(await launched()).not.toContain("--resume");
  expect(calls().some((each) => each[0] === "rm")).toBe(false);
});

test("a fresh thread's session on a five-minute cache hands over five minutes after its last request, not an hour", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await dm(
    [{ sessionId: SESSION, pid: old.pid, status: "idle", startedAt: clock.now() + 60_000 }],
    {
      cacheWarm: 60_000,
    },
  );
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
  await dm([{ sessionId: SESSION, pid: old.pid, status: "busy", startedAt: clock.now() + 60_000 }]);
  const first = await session("dm");
  await hub.deliver("dm", "DM", message);
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
  await hub.deliver("dm", "DM", { author: "owner", content: "next", meta: {} });
  await until(() => next.received.length);
  expect(next.received[0]).toMatchObject({ type: "inbound", content: "next" });
  expect(first.received).toHaveLength(1);
});

test("a fresh thread's session hands over when its cache expires, timed from its last request", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await dm(
    [{ sessionId: SESSION, pid: old.pid, status: "idle", startedAt: clock.now() + 60_000 }],
    {
      cacheWarm: 400,
    },
  );
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
  await dm(
    [{ sessionId: SESSION, pid: old.pid, status: "idle", startedAt: clock.now() + 60_000 }],
    {
      cacheWarm: 60_000,
    },
  );
  said(500, false, SESSION, clock.now() - 61_000);
  const first = await session("dm");
  await time.lapse(0);
  await until(() => calls().find((each) => each[0] === "stop"));
  await hub.deliver("dm", "DM", message);
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
  await dm(
    [{ sessionId: SESSION, pid: 999_999, status: "idle", startedAt: clock.now() + 60_000 }],
    {
      capacity: 400_000,
      compactAbove: 150_000,
      idleStop: 20,
    },
  );
  said(200_000);
  const { send } = await session("dm");
  await send({ type: "state", thread: "dm", busy: false });
  await until(() => states.length);
  await time.advance(150);
  expect(calls().filter((each) => each[0] !== "agents")).toEqual([]);
});

test("a fresh thread's warm session that started with what the hub no longer gives starts over as a new one at its rest", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await dm([{ sessionId: SESSION, pid: old.pid, status: "idle", startedAt: 1 }], { stale: true });
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
  await dm(
    [{ id: "job99999", sessionId: NEXT, pid: 42, status: "idle", startedAt: clock.now() + 60_000 }],
    { reconnect: 60_000 },
  );
  await hub.deliver("dm", "DM", message);
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
  await start({
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
    await hub.deliver("voice", "voice", { author: "owner", content: turn, meta: {} });
    await until(() => heard(received).find((payload) => payload.content === turn));
  }

  expect(calls().some((each) => each[0] === "stop" || each[0] === "--bg")).toBe(false);
  await hub.deliver("voice", "voice", { author: "owner", content: "the call ended", meta: {} });
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
  await start({
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
  await hub.deliver("voice", "voice", { author: "call", content: "the call ended", meta: {} });
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
  await start({
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
  await start({
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
  await hub.deliver("voice", "voice", message);
  const again = await session("voice");
  await time.advance(100);
  expect(again.received).toEqual([]);
  expect(kept).toBe(false);
  old.kill();
});

test("a call whose restarted session fails to start goes on", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await start({
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

test("a call that comes while the last call's session is still on its turn keeps that session, warm, instead of waiting for a new one", async () => {
  await start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, status: "busy" }],
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
  void hub.keep("voice").then(() => (kept = true));
  await until(() => kept);
  await send({ type: "state", thread: "voice", busy: false });
  await time.advance(150);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
  expect(hub.session("voice")).toBe(SESSION);
});

test("a call that comes once a renew is starting the session over takes the new session as it starts, without starting it over again", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await start({
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
  await send({ type: "state", thread: "voice", busy: false });
  await until(() => calls().find((each) => each[0] === "stop"));
  let kept = false;
  void hub.keep("voice").then(() => (kept = true));
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
  await start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, status: "idle" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  const { received } = await session("voice");
  await hub.deliver("voice", "voice", message);
  await until(() => received.length);
  await hub.keep("voice");
  await time.advance(150);
  expect(calls().some((each) => each[0] === "stop" || each[0] === "--bg")).toBe(false);
});

test("a call keeps the session it finds once that session has taken a message, like the one that placed the call, before its first request is through", async () => {
  await start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42, status: "idle" }],
    reconnect: 60_000,
    fresh: () => true,
    capacity: 0,
  });
  const { received } = await session("voice");
  await hub.deliver("voice", "voice", message);
  await until(() => received.length);
  fold(received);
  await hub.keep("voice");
  await time.advance(150);
  expect(calls().some((each) => each[0] === "stop" || each[0] === "--bg")).toBe(false);
});

test("a session whose channel comes back before its rest still starts over for the call that ended", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  await start({
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
  await start({
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
  await start({
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
  await start({
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
  await start({
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
  await start({
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
  await start({
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
  await start({
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
  await start({
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
  await start({
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
  await start({
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
  await start({
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
  await start({
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
  await start({
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
  await start({
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
  await start({
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

test("a hub whose state folder is gone makes it again, with a new token", async () => {
  const state = join(dir, "gone");
  hub = await startHub({
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
  await start({
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
  await start({
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

test("a restart doesn't wait on a call its engine can't reach, and waits again once the engine is back on it", async () => {
  await start({
    main: "voice",
    registry: { voice: { name: "voice", session: SESSION } },
    fresh: () => true,
    capacity: 0,
  });
  let freed = false;
  await session("voice");
  said(500);
  void hub.keep("voice");
  hub.adrift("voice", true);
  hub.adrift("voice", false);
  void free().then(() => (freed = true));
  await time.advance(50);
  expect(freed).toBe(false);
  hub.adrift("voice", true);
  await until(() => freed);
  freed = false;
  hub.adrift("voice", false);
  void free().then(() => (freed = true));
  await time.advance(50);
  expect(freed).toBe(false);
  hub.renew("voice");
  await until(() => freed);
});

test("closing an idle thread stops its session right away, then forgets the thread", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
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
  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
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
  await start({
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
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  await settled();
  const callsBefore = calls().length;
  void hub.retire("chat:7");
  await hub.synced();
  expect(registry()["chat:7"]).toBeUndefined();
  await settled();
  expect(calls().slice(callsBefore)).toEqual([]);
});

test("closing a thread whose session Claude reports busy waits for its next idle", async () => {
  await start({
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
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  const { send } = await session("chat:7");
  await send({ type: "state", thread: "chat:7", busy: true });
  await until(() => states.length);
  void hub.retire("chat:7");
  await time.advance(100);
  expect(calls().some((each) => each[0] === "stop")).toBe(false);
  await send({ type: "state", thread: "chat:7", busy: false });
  await until(() => calls().find((each) => each[0] === "stop"));
});

test("threads are found by name or id, and renames are kept, in hex.db too", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION }, "chat:8": { name: "Clips" } },
  });
  expect(hub.find("desk anchors")).toBe("chat:7");
  expect(hub.find("chat:8")).toBe("chat:8");
  expect(() => hub.find("Nope")).toThrow('no thread named "Nope"');
  hub.rename("chat:8", "Video clips");
  expect(hub.find("Video clips")).toBe("chat:8");
  expect(hub.name("chat:8")).toBe("Video clips");
  expect(hub.name("chat:9")).toBeUndefined();
  await hub.synced();
  expect(registry()["chat:8"]?.name).toBe("Video clips");
  expect(file(dir).threads.list()).toEqual([
    { app: "telegram", thread: "chat:7", name: "Desk anchors", session: SESSION, open: true },
    { app: "telegram", thread: "chat:8", name: "Video clips", open: true },
  ]);
});

test("a thread hex.db keeps comes back with its folder and settings, and a closed one keeps its row", async () => {
  await start({
    registry: {
      "chat:7": { name: "Desk anchors", session: SESSION, cwd: "/work", model: "claude-opus-5-5" },
    },
  });
  expect(hub.threads()).toEqual(["chat:7"]);
  expect(hub.cwd("chat:7")).toBe("/work");
  await hub.retire("chat:7");
  expect(file(dir).threads.list()).toEqual([
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
    await start({ launcher });
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
  await start({ launcher, agents: [] });
  hub.open("t3:1", "project", undefined, project);
  await launched();
  saved(SESSION, project);
  const { close } = await session("t3:1");
  await until(() => registry()["t3:1"]);
  expect(registry()["t3:1"]).toEqual({ name: "project", cwd: project, session: SESSION });
  expect(hub.cwd("t3:1")).toBe(project);
  close();
  await until(() => states.some(([thread, busy]) => thread === "t3:1" && !busy));
  await hub.deliver("t3:1", "project", message);
  await until(() => readFileSync(join(dir, "cwd"), "utf-8").split("\n").length > 2);
  expect(readFileSync(join(dir, "cwd"), "utf-8").trim().split("\n")).toEqual([project, project]);
});

test("a thread in the hex folder keeps no folder of its own", async () => {
  await start();
  hub.open("chat:7", "Desk anchors", "go");
  await launched();
  saved();
  await session("chat:7");
  await until(() => registry()["chat:7"]);
  expect(registry()["chat:7"]).toEqual({ name: "Desk anchors", session: SESSION });
  expect(hub.cwd("chat:7")).toBeUndefined();
});

test("releasing an idle thread stops its session, then forgets it once the socket closes", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
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
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
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
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  expect(await hub.release("chat:7")).toBe(SESSION);
  expect(registry()["chat:7"]).toBeUndefined();
  expect(calls().filter(([command]) => command === "stop" || command === "--bg")).toEqual([]);
});

test("the main thread cannot be closed or released, nor a thread without a session", async () => {
  await start({ main: "chat", registry: { "chat:8": { name: "Clips" } } });
  expect(() => hub.retire("chat")).toThrow("the main thread stays open");
  expect(() => hub.release("chat")).toThrow("the main thread stays here");
  expect(() => hub.release("chat:8")).toThrow("this thread has no session yet");
});

test("an adopted thread clears the old job record, then resumes its session in its folder with the prompt last", async () => {
  await start({ agents: [] });
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
  await start();
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
      stdin: new Blob([
        JSON.stringify({
          hook_event_name,
          session_id: SESSION,
          ...(hook_event_name === "StopFailure" && {
            error: "rate_limit",
            last_assistant_message: "API Error: 429",
          }),
        }),
      ]),
    });

    await hook.exited;
    await until(() => received.length === (hook_event_name === "Stop" ? 1 : 2) || undefined);
  }

  server.close();
  expect(received).toEqual([
    { type: "state", thread: "t1", busy: false, session: SESSION },
    {
      type: "state",
      thread: "t1",
      busy: false,
      failed: true,
      error: "rate_limit",
      said: "API Error: 429",
      session: SESSION,
    },
  ]);
});

test("a session beside a thread never reports its turns as the thread's, even with a hub in its settings", async () => {
  const socket = join(dir, "state.sock");
  const received: string[] = [];

  const server = createServer((client) => {
    client.on("data", (chunk) => {
      received.push(String(chunk));
    });
  }).listen(socket);

  for (const hook_event_name of ["UserPromptSubmit", "StopFailure"]) {
    const hook = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "state.ts"),
        hook_event_name === "StopFailure" ? "idle" : "busy",
      ],
      {
        env: {
          ...process.env,
          HEX_HUB: socket,
          HEX_THREAD: "t1",
          HEX_BESIDE: SESSION,
          HEX_STORE: dir,
          MEMORY_DIR: "",
        },
        stdin: new Blob([
          JSON.stringify({ hook_event_name, session_id: SESSION, error: "authentication_failed" }),
        ]),
      },
    );

    expect(await hook.exited).toBe(0);
  }

  await Bun.sleep(100);
  server.close();
  expect(received).toEqual([]);
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

  await hook.exited;
  await until(() => received.length || undefined);
  server.close();
  expect(received).toEqual([{ type: "state", thread: "t1", busy: false }]);
});

test("a turn tells the hub it began whatever began it, so the owner's words wait for it, and a command that may run no turn tells it nothing", async () => {
  const socket = join(dir, "state.sock");
  const received: object[] = [];

  const server = createServer((client) => {
    client.on("data", (chunk) => {
      received.push(SeenLine.parse(JSON.parse(String(chunk))));
    });
  }).listen(socket);

  const began = async (prompt: string) => {
    const hook = Bun.spawn(["bun", join(import.meta.dir, "state.ts"), "busy"], {
      env: { ...process.env, HEX_HUB: socket, HEX_THREAD: "t1", HEX_STORE: dir, MEMORY_DIR: "" },
      stdin: new Blob([JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt })]),
    });

    await hook.exited;
  };

  await began("<task-notification>\n<task-id>b1</task-id>\n</task-notification>");
  await began('<cross-session-message from="Desk">\nthe build is green\n</cross-session-message>');
  await began("check the deploy");
  await until(() => received.length === 3 || undefined);
  await began("/compact");
  await began("<local-command-stdout>Compacted</local-command-stdout>");
  await began("<command-name>/model</command-name>");
  await began("check it again");
  await until(() => received.length === 4 || undefined);
  server.close();
  expect(received).toEqual(
    Array.from({ length: 4 }, () => ({ type: "state", thread: "t1", busy: true })),
  );
});

test("a main thread whose new session ends before its channel connects is reported and started again", async () => {
  await start({ main: "chat", agents: [], reconnect: 50 });
  expect(settingsOf(await launched()).env.HEX_MAIN).toBeUndefined();
  await time.lapse(50);
  expect(failures[0]).toEqual(["chat", "its session ended before its channel connected"]);
  await until(() => calls().filter((each) => each[0] === "--bg").length === 2);
});

test("a thread whose new session ends before its channel connects is reported, and its next message starts it again", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [],
    reconnect: 50,
  });
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  await time.lapse(50);
  expect(failures[0]).toEqual(["chat:7", "its session ended before its channel connected"]);
  await hub.deliver("chat:7", "Desk anchors", { ...message, content: "again" });
  await until(() => calls().filter((each) => each[0] === "--bg").length === 2);
  const { received } = await session("chat:7");
  await until(() => received.length === 2);
  expect(heard(received).map((m) => m.content)).toEqual(["hi", "again"]);
});

test("a session that restarts in place and then ends is reported, and the thread starts again on its next message", async () => {
  bound("chat:7");
  await start({
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
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The PostToolUse hook a session runs after each tool call, as its plugin registers it.
async function toolCall(thread: string, input: Record<string, string> = {}) {
  const run = Bun.spawn([process.execPath, join(import.meta.dir, "held.ts")], {
    stdin: new Blob([
      JSON.stringify({ session_id: SESSION, hook_event_name: "PostToolUse", ...input }),
    ]),
    stdout: "pipe",
    env: { ...process.env, HEX_STORE: dir, HEX_THREAD: thread, HEX_HUB: join(dir, "hub.sock") },
  });

  expect(await run.exited).toBe(0);
  await settled();

  return (await new Response(run.stdout).text()).trim();
}

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
    env: { ...env, HEX_HUB: join(dir, "hub.sock"), HEX_THREAD: "chat:7" },
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

test("only General's hub runs schedules.json", async () => {
  writeFileSync(join(dir, "hex", "schedules.json"), "{}");
  await start();
  expect(file(dir).scheduler.checked()).toBeUndefined();
  hub.close();
  await start({ main: "general", general: true });
  expect(await until(() => file(dir).scheduler.checked())).toBe(Math.floor(Date.now() / 60_000));
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

test("an operation keeps its result across Stop events regardless of elapsed time", async () => {
  const waiting: (() => void)[] = [];
  await start({
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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A launcher whose -p runs wait for a file named go, then print the file named said, if any, and exit with the code go holds, logging their arguments and HEX_BESIDE; anything else goes to the fake claude.
function besideLauncher() {
  const launcher = join(dir, "launch");
  writeFileSync(
    launcher,
    `#!/bin/sh
[ "$1" = -p ] || exec claude "$@"
jq -cn --arg beside "$HEX_BESIDE" '{beside: $beside, args: $ARGS.positional}' --args -- "$@" >> "${dir}/runs"
while [ ! -f "${dir}/go" ]; do [ -d "${dir}" ] || exit 0; sleep 0.02; done
[ -f "${dir}/said" ] && cat "${dir}/said"
exit "$(cat "${dir}/go")"
`,
  );
  chmodSync(launcher, 0o755);

  return launcher;
}

const Run = z.object({ beside: z.string(), args: z.array(z.string()) });

function runs() {
  return existsSync(join(dir, "runs"))
    ? readFileSync(join(dir, "runs"), "utf-8")
        .split("\n")
        .slice(0, -1)
        .map((each) => Run.parse(JSON.parse(each)))
    : [];
}

function timed(key: string, more: Record<string, string> = {}, schedule = "heartbeat") {
  file(dir).messages.deliver({
    key,
    to: "beside:general",
    from: "schedule",
    author: "prompt",
    body: `[${schedule}] Hourly check`,
    meta: { user: "schedule", schedule, ...more },
  });
}

test("a timer beside General runs in a session of its own, as hex in General's chat, and General's session never hears it", async () => {
  await start({ main: "general", general: true, launcher: besideLauncher() });
  await launched();
  const general = await session("general");
  timed("schedule:heartbeat@1");
  const run = await until(() => runs()[0]);
  const args = run?.args ?? [];
  expect(args.slice(0, 3)).toEqual(["-p", "--session-id", run?.beside ?? ""]);
  expect(args.at(-1)).toStartWith('<channel source="telegram" key="schedule:heartbeat@1"');
  expect(args.at(-1)).toContain("\n[heartbeat] Hourly check\n</channel>");
  const { env, enabledPlugins } = settingsOf(args);
  expect(enabledPlugins).toEqual({ "telegram@hex": true });
  expect(env).toMatchObject({ HEX_CHANNEL: CHANNEL, HEX_THREAD: "general", HEX_MAIN: "1" });
  expect(env.HEX_HUB).toBeUndefined();
  file(dir).messages.take("schedule:heartbeat@1", run?.beside ?? "");
  writeFileSync(join(dir, "go"), "0");
  await Bun.sleep(200);
  expect(general.received).toEqual([]);
  expect(failures).toEqual([]);
  expect(runs()).toHaveLength(1);
});

test("a session beside a thread speaks in its chat as itself, and is neither its inbound line nor its permission relay", async () => {
  await start({
    main: "general",
    general: true,
    call: async (thread) => {
      await hub.sent(thread, { content: "The landlord wrote." });

      return "sent";
    },
  });
  await launched();
  const general = await session("general");
  const beside = http("general", { "x-hex-beside": "beside-1" });
  await beside.initialize();
  await beside.open();
  await beside.rpc("tools/list");
  await beside.call("reply", { text: "The landlord wrote." });
  await beside.ask({
    request_id: "abcde",
    tool_name: "Bash",
    description: "ls",
    input_preview: "{}",
  });
  await hub.deliver("general", "hex", { ...message, content: "and now?" });
  await until(() => general.received.length);
  expect(heard(general.received).map((turn) => turn.content)).toEqual(["and now?"]);
  expect(beside.received).toEqual([]);
  expect(prompts).toEqual([]);
  expect(
    file(dir)
      .messages.said("general")
      .find((row) => row.body === "The landlord wrote.")?.taken?.by,
  ).toBe("beside-1");
});

const aTurnGoesThrough = () => sendToHub({ type: "state", thread: "chat:7", busy: false });

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What a session's prompt hook does as it takes its row, and its Stop hook as its turn goes through.
function takes(key: string, by: string) {
  const store = file(dir);
  store.turns.turned(by, true, new Date(Date.now() - 1000).toISOString());
  store.messages.take(key, by);
}

async function seesThrough(by: string) {
  await Bun.sleep(2);
  file(dir).turns.handled(by);
}

const ranFor = (key: string) =>
  until(() => runs().find((run) => run.args.at(-1)?.includes(`key="${key}"`) === true));

const CARRIES_ON = "\nIt carries on once turns go through again.";

test("a run beside a thread that never takes its row waits for a turn to go through, its chat hearing once, then is left if it fails again", async () => {
  writeFileSync(join(dir, "go"), "1");
  await start({ main: "general", general: true, launcher: besideLauncher() });
  await launched();
  timed("schedule:heartbeat@1");
  await until(() => failures.length);
  expect(failures).toEqual([
    ["general", `[heartbeat] ran beside this chat and failed: exit 1${CARRIES_ON}`],
  ]);
  expect(file(dir).messages.get("schedule:heartbeat@1")?.meta?.stalled).toBeString();
  await Bun.sleep(200);
  expect(runs()).toHaveLength(1);
  await aTurnGoesThrough();
  await until(() => failures.length === 2);
  expect(runs()).toHaveLength(2);
  expect(failures[1]).toEqual([
    "general",
    "[heartbeat] failed again beside this chat, so it won't run by itself again: exit 1",
  ]);
  expect(file(dir).messages.get("schedule:heartbeat@1")?.taken?.by).toBe("hub");
});

test("runs beside a thread the API refused tell its chat once, in the API's words, then carry on one for each turn that goes through", async () => {
  await start({ main: "general", general: true, launcher: besideLauncher() });
  await launched();
  timed("schedule:heartbeat@1");
  timed("schedule:catch-up@1", {}, "catch-up");
  takes("schedule:heartbeat@1", (await ranFor("schedule:heartbeat@1")).beside);
  takes("schedule:catch-up@1", (await ranFor("schedule:catch-up@1")).beside);
  writeFileSync(join(dir, "said"), "API Error: Connection refused");
  writeFileSync(join(dir, "go"), "1");
  await until(() => failures.length);
  await until(() =>
    ["schedule:heartbeat@1", "schedule:catch-up@1"].every(
      (key) => file(dir).messages.get(key)?.meta?.stalled !== undefined,
    ),
  );
  expect(failures).toHaveLength(1);
  expect(failures[0]?.[1]).toMatch(
    /^\[(heartbeat|catch-up)\] ran beside this chat and failed: API Error: Connection refused\nIt carries/u,
  );
  rmSync(join(dir, "go"));
  rmSync(join(dir, "said"));
  await aTurnGoesThrough();
  const third = await until(() => runs()[2]);
  expect(third.args.slice(0, 2)).toEqual(["-p", "--session-id"]);
  expect(third.args.at(-1)).toContain('key="schedule:heartbeat@1"');
  expect(third.args.at(-1)).not.toContain("stalled");
  await aTurnGoesThrough();
  await Bun.sleep(200);
  expect(runs()).toHaveLength(3);
  takes("schedule:heartbeat@1", third.beside);
  await seesThrough(third.beside);
  writeFileSync(join(dir, "go"), "0");
  const fourth = await until(() => runs()[3]);
  expect(fourth.args.at(-1)).toContain('key="schedule:catch-up@1"');
});

test("runs beside a thread that wait for a turn to go through still wait after a hub restart, and a timed one a newer run of its job will do is left to it", async () => {
  const stalled = { stalled: "2026-01-01T00:00:00.000Z" };
  timed("schedule:catch-up@1", stalled, "catch-up");
  timed("schedule:heartbeat@1", stalled);
  timed("schedule:catch-up@2", stalled, "catch-up");
  await start({ main: "general", general: true, launcher: besideLauncher() });
  await launched();
  await Bun.sleep(200);
  expect(runs()).toEqual([]);
  expect(failures).toEqual([]);
  await aTurnGoesThrough();
  const run = await until(() => runs()[0]);
  expect(run.args.at(-1)).toContain('key="schedule:heartbeat@1"');
  expect(file(dir).messages.get("schedule:catch-up@1")?.taken?.by).toBe("hub");
  expect(file(dir).messages.get("schedule:catch-up@2")?.taken).toBeUndefined();
});

test("a run beside a thread cut off with the machine, mid-turn or as its turn failed, runs again as the hub starts, even before Claude's daemon answers, and the logs of ended runs go", async () => {
  const store = file(dir);
  const minuteAgo = new Date(Date.now() - 60_000).toISOString();
  timed("schedule:once@1", {}, "once");
  timed("schedule:twice@1", {}, "twice");
  store.turns.turned("dead-beside", true, minuteAgo);
  store.messages.take("schedule:once@1", "dead-beside");
  store.turns.turned("failed-beside", true, minuteAgo);
  store.messages.take("schedule:twice@1", "failed-beside");
  store.turns.turned("failed-beside", false, new Date().toISOString());
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(join(dir, "sessions", "beside-dead-beside.log"), "API Error");
  writeFileSync(join(dir, "down"), "");
  await start({
    main: "general",
    general: true,
    launcher: besideLauncher(),
    registry: { general: { name: "General", session: SESSION } },
  });
  expect((await ranFor("schedule:once@1")).beside).not.toBe("dead-beside");
  expect((await ranFor("schedule:twice@1")).beside).not.toBe("failed-beside");
  expect(existsSync(join(dir, "sessions", "beside-dead-beside.log"))).toBe(false);
  expect(failures).toEqual([]);
});

test("a client that shows only its own turns can't be spoken into from beside, so its thread takes the row", async () => {
  clients.set("telegram", { hub, waits: true, place: () => Promise.reject(new Error("no")) });

  try {
    await start({ main: "general", general: true, launcher: besideLauncher() });
    await launched();
    timed("schedule:heartbeat@1");
    await until(() => file(dir).messages.get("schedule:heartbeat@1")?.to === "general");
    expect(runs()).toEqual([]);
  } finally {
    clients.delete("telegram");
  }
});

test("a job's news for a session beside a thread resumes that session once its run is over", async () => {
  await start({ main: "general", general: true, launcher: besideLauncher() });
  await launched();
  timed("schedule:heartbeat@1");
  const first = await until(() => runs()[0]);
  file(dir).messages.take("schedule:heartbeat@1", first.beside);
  file(dir).messages.deliver({
    key: "job:mail@1",
    to: first.beside,
    from: "job",
    author: "prompt",
    body: "[job] mail ended: success (exit 0).",
    meta: { user: "job" },
  });
  await Bun.sleep(100);
  expect(runs()).toHaveLength(1);
  saved(first.beside);
  writeFileSync(join(dir, "go"), "0");
  const second = await until(() => runs()[1]);
  expect(second.beside).toBe(first.beside);
  expect(second.args.slice(0, 3)).toEqual(["-p", "--resume", first.beside]);
  expect(second.args.at(-1)).toContain('key="job:mail@1"');
});

test("a job's news for a session beside a thread whose conversation this machine doesn't have starts a new session for it", async () => {
  await start({ main: "general", general: true, launcher: besideLauncher() });
  await launched();
  timed("schedule:heartbeat@1");
  const first = await until(() => runs()[0]);
  file(dir).messages.take("schedule:heartbeat@1", first.beside);
  file(dir).messages.deliver({
    key: "job:mail@1",
    to: first.beside,
    from: "job",
    author: "prompt",
    body: "[job] mail ended: success (exit 0).",
    meta: { user: "job" },
  });
  writeFileSync(join(dir, "go"), "0");
  const second = await until(() => runs()[1]);
  expect(second.beside).not.toBe(first.beside);
  expect(second.args.slice(0, 3)).toEqual(["-p", "--session-id", second.beside]);
  expect(second.args.at(-1)).toContain('key="job:mail@1"');
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

test("a session is live as its channel connects, so a thread closed while the hub reads what the session is given stops that session and stays closed", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  writeFileSync(
    join(dir, "jobs", "job12345", "state.json"),
    JSON.stringify({ state: "working", sessionId: SESSION }),
  );
  const line = http("chat:7");
  await line.initialize();
  await line.open();
  await line.rpc("tools/list");
  await until(() => line.listed() === 2);
  const closed = hub.retire("chat:7");
  await settled();
  expect(calls().filter(([command]) => command === "stop")).toHaveLength(1);
  line.close();
  expect(await closed).toBe(SESSION);
  await settled();
  expect(hub.threads()).toEqual([]);
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
  await settled();
  expect(heard(received).map((turn) => turn.content)).toEqual(["held"]);
});

const keysKept = () =>
  z
    .array(z.object({ key: z.string() }))
    .parse(file(dir).db.query("select key from messages order by n").all())
    .map(({ key }) => key);

async function onCall() {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
  });

  return await session("chat:7");
}

test("a message that comes while hex's store can't be reached reaches its session, is never said to be safe until the store has it, and lands once, by its key", async () => {
  const { received } = await onCall();
  outage = "unreached";
  const owed = { ...message, key: "1:60" };

  expect(await hub.deliver("chat:7", "Desk anchors", owed)).toBe(true);
  await until(() => heard(received).some(({ content }) => content === "hi"));
  expect(await settles(hub.synced())).toMatchObject({ status: "rejected" });
  expect(keysKept()).toEqual([]);

  outage = undefined;
  await hub.synced();
  expect(keysKept()).toEqual(["telegram:1:60"]);

  await hub.deliver("chat:7", "Desk anchors", owed);
  await hub.synced();
  await settled();
  expect(keysKept()).toEqual(["telegram:1:60"]);
  expect(heard(received).filter(({ content }) => content === "hi")).toHaveLength(1);
});

test("what the hub owes hex's store lands before what comes after it, and what a session took meanwhile lands as taken", async () => {
  const { send } = await onCall();
  outage = "unreached";
  await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:61" });
  await send({
    type: "state",
    thread: "chat:7",
    busy: true,
    taken: ["telegram:1:61"],
    session: SESSION,
  });
  await hub.sent("chat:7", { key: "reply", content: "on it" });

  outage = undefined;
  await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:62" });
  await hub.synced();
  expect(keysKept()).toEqual(["telegram:1:61", "telegram:reply", "telegram:1:62"]);
  expect(file(dir).messages.get("telegram:1:61")?.taken?.by).toBe(SESSION);
});

test("what a session's hooks couldn't keep while hex's store was unreachable, the hub keeps once it answers", async () => {
  const { send } = await onCall();
  outage = "unreached";

  const typed = {
    key: "terminal:1",
    to: "chat:7",
    from: "terminal",
    author: "owner" as const,
    body: "typed in the terminal",
    meta: { session: SESSION },
  };

  await send({ type: "owed", thread: "chat:7", said: [{ row: typed, by: SESSION }] });
  await settled();
  expect(await settles(hub.synced())).toMatchObject({ status: "rejected" });

  outage = undefined;
  await hub.synced();
  expect(file(dir).messages.get("terminal:1")).toMatchObject({
    body: "typed in the terminal",
    taken: { by: SESSION },
  });
});

test("a hub hex's store refused for an older tenure passes nothing on, says nothing is safe, and stops as one that lost hex", async () => {
  const { received } = await onCall();
  const heardLost: string[] = [];

  const unlisten = whenLost((why) => {
    heardLost.push(why);
  });

  outage = "lost";

  try {
    expect(await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:63" })).toBe(false);

    const synced = await settles(hub.synced());
    expect(synced.status === "rejected" && synced.reason instanceof LostError).toBe(true);
    expect(heardLost[0]).toContain("no longer holds hex");

    outage = undefined;
    expect(await settles(hub.synced())).toMatchObject({ status: "rejected" });
    await settled();
    expect(heard(received).some(({ content }) => content === "hi")).toBe(false);
  } finally {
    unlisten();
  }
});

test("a hub whose store can't be reached as it starts waits for it instead of failing, and starts once it answers", async () => {
  outage = "unreached";
  let started = false;

  const starting = (async () => {
    await start();
    started = true;
  })();

  await Bun.sleep(300);
  expect(started).toBe(false);

  outage = undefined;
  await starting;
  expect(started).toBe(true);
});

test("a message hex's store refuses outright reaches its session, and the store keeps a note of it under its key, so it's settled rather than lost", async () => {
  const { received } = await onCall();
  refusingOver = 300;
  const long = "x".repeat(400);

  expect(
    await hub.deliver("chat:7", "Desk anchors", { ...message, content: long, key: "1:64" }),
  ).toBe(true);
  await until(() => heard(received).some(({ content }) => content === long));
  await hub.synced();
  expect(file(dir).messages.get("telegram:1:64")).toMatchObject({
    body: matching(/^\[hub\] hex's store refused this message/u),
    meta: { refused: "true" },
  });
});

test("a hub whose hex.db moved to a store across the network keeps what it's given there, and restarts on it", async () => {
  const { received } = await onCall();
  const object = mkdtempSync(join(tmpdir(), "object-"));
  let heardMoved = 0;

  const unlisten = whenMoved(() => {
    heardMoved++;
  });

  try {
    movedTo = object;
    outage = "moved";
    await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:65" });
    await until(() => heard(received).some(({ content }) => content === "hi"));
    expect(heardMoved).toBeGreaterThan(0);

    await hub.synced();
    expect(file(object).messages.get("telegram:1:65")?.body).toBe("hi");
    expect(keysKept()).toEqual([]);
  } finally {
    unlisten();
    rmSync(object, { recursive: true, force: true });
  }
});

test("a thread opened or changed while hex's store can't take anything is saved once it can", async () => {
  await onCall();
  outage = "unreached";
  hub.register("chat:9", "New topic");
  hub.configure("chat:7", { model: "sonnet" });
  await settled();

  outage = undefined;
  await hub.synced();
  expect(registry()).toMatchObject({
    "chat:7": { name: "Desk anchors", model: "sonnet" },
    "chat:9": { name: "New topic" },
  });
});

test("what the hub kept after an outage carries the time it was given, so the turn's memory pass sees it", async () => {
  const { send } = await onCall();
  outage = "unreached";
  await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:66" });
  await send({
    type: "state",
    thread: "chat:7",
    busy: true,
    taken: ["telegram:1:66"],
    session: SESSION,
  });
  await settled();
  const turnEnded = new Date().toISOString();
  await Bun.sleep(20);

  outage = undefined;
  await hub.synced();
  expect(
    file(dir)
      .messages.observe(SESSION, turnEnded, "chat:7")
      .map(({ key }) => key),
  ).toEqual(["telegram:1:66"]);
});

test("what the hub owes hex's store outlives a restart during the outage, so hex's replies and what it was given aren't lost", async () => {
  await onCall();
  outage = "unreached";
  await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:67" });
  await hub.sent("chat:7", { key: "reply-67", content: "on it" });
  await settled();
  hub.close();
  hangUpAll();

  outage = undefined;
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  await hub.synced();
  expect(keysKept()).toEqual(["telegram:1:67", "telegram:reply-67"]);
});

test("the owner's words held for a turn that ends while hex's store can't take anything go on as it ends, before newer words, and only once", async () => {
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
    key: "1:68",
  });
  await settled();
  expect(heard(received)).toEqual([]);

  outage = "unreached";
  await send({ type: "state", thread: "chat:7", busy: false });
  await hub.deliver("chat:7", "Desk anchors", {
    author: "owner",
    content: "newer",
    meta: {},
    key: "1:69",
  });
  await until(() => received.length === 2);
  expect(heard(received).map((turn) => turn.content)).toEqual(["held", "newer"]);

  outage = undefined;
  await hub.synced();
  await settled();
  expect(heard(received).map((turn) => turn.content)).toEqual(["held", "newer"]);
  expect(file(dir).messages.get("telegram:1:68")?.body).toBe("held");
});

test("a message too long for hex's store keeps as much of it as the store takes, under its key", async () => {
  const { received } = await onCall();
  refusingOver = 7_500_000;
  const long = "x".repeat(8_000_000);

  await hub.deliver("chat:7", "Desk anchors", { ...message, content: long, key: "1:70" });
  await until(() => heard(received).some(({ content }) => content?.length === long.length));
  await hub.synced();

  const kept = file(dir).messages.get("telegram:1:70");
  expect(kept?.meta?.refused).toBe("cut");
  expect(kept?.body.startsWith("x".repeat(7_000_000))).toBe(true);
  expect(kept?.body).toContain("so it keeps only the part above");
});

test("a hub restarted while hex's store can't take anything keeps the thread changes it owed, rather than the store's older ones", async () => {
  await onCall();
  outage = "unreached";
  hub.register("chat:9", "New topic");
  hub.configure("chat:7", { model: "sonnet" });
  await settled();
  hub.close();
  hangUpAll();

  const restarting = start();
  await Bun.sleep(300);
  outage = undefined;
  await restarting;
  await hub.synced();
  await settled();
  expect(registry()).toMatchObject({
    "chat:7": { name: "Desk anchors", model: "sonnet" },
    "chat:9": { name: "New topic" },
  });
});

test("a hub whose spool can't be written goes on from memory, so a full disk never leaves hex deaf", async () => {
  const { received } = await onCall();
  mkdirSync(join(dir, "owed.telegram.json.next"));
  outage = "unreached";

  expect(await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:71" })).toBe(true);
  await until(() => heard(received).some(({ content }) => content === "hi"));
  expect(await settles(hub.synced())).toMatchObject({ status: "rejected" });

  outage = undefined;
  await hub.synced();
  expect(keysKept()).toEqual(["telegram:1:71"]);
});

test("a turn's last words a hook handed the hub during an outage keep the time it said them, so the turn's memory pass sees them", async () => {
  const { send } = await onCall();
  outage = "unreached";
  const spokeAt = new Date().toISOString();
  await Bun.sleep(5);
  const turnEnded = new Date().toISOString();

  const words = {
    key: "terminal:2",
    to: "chat:7",
    from: "terminal",
    author: "hex" as const,
    body: "Done.",
    meta: { session: SESSION },
    at: spokeAt,
  };

  await send({ type: "owed", thread: "chat:7", said: [{ row: words, by: SESSION }] });
  await settled();
  await Bun.sleep(20);

  outage = undefined;
  await hub.synced();
  expect(
    file(dir)
      .messages.observe(SESSION, turnEnded, "chat:7")
      .map(({ key }) => key),
  ).toEqual(["terminal:2"]);
});

test("a hub that learns another machine holds hex still lands what it owed as fact, through a client that never claimed, and lets go of its own state", async () => {
  await onCall();
  outage = "unreached";
  await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:80" });
  await hub.sent("chat:7", { key: "reply-80", content: "on it" });
  hub.register("chat:9", "New topic");
  await settled();

  const unlisten = whenLost(ignoreLost);
  outage = "lost";

  try {
    const synced = await settles(hub.synced());
    expect(synced.status === "rejected" && synced.reason instanceof LostError).toBe(true);
    expect(keysKept()).toEqual(["telegram:1:80", "telegram:reply-80"]);
    expect(registry()["chat:9"]).toBeUndefined();
    expect(existsSync(join(dir, "owed.telegram.json"))).toBe(false);
  } finally {
    unlisten();
  }
});

test("what a hub owed from before another hub held hex keeps its facts and lets go of its old threads", async () => {
  await onCall();
  claimedAs(4);
  outage = "unreached";
  await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:81" });
  hub.register("chat:9", "Old topic");
  await settled();
  hub.close();
  hangUpAll();

  outage = undefined;
  file(dir).threads.keep("telegram", { "chat:7": { name: "Desk anchors", session: "newer" } });
  claimedAs(9);
  await start();
  await hub.synced();
  await settled();
  expect(keysKept()).toContain("telegram:1:81");
  expect(registry()).toEqual({ "chat:7": { name: "Desk anchors", session: "newer" } });
});

test("a message hex's store refuses for what's in it is set aside whole, what comes after it lands, the owner hears which, and it lands at a start once the store takes it", async () => {
  const { received } = await onCall();
  refusingKey = "telegram:1:82";

  await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:82" });
  await hub.deliver("chat:7", "Desk anchors", { ...message, content: "again", key: "1:83" });
  await until(() => heard(received).some(({ content }) => content === "hi"));
  await hub.synced();
  expect(keysKept()).toEqual([matching(/^hub:refused:/u), "telegram:1:83"]);
  expect(toldOwner).toHaveLength(1);
  expect(toldOwner[0]).toContain("telegram:1:82");
  expect(toldOwner[0]).toContain("tries it again each time it starts");

  hub.close();
  hangUpAll();
  refusingKey = undefined;
  await start();
  await hub.synced();
  expect(keysKept()).toContain("telegram:1:82");
  expect(existsSync(join(dir, "refused.telegram.json"))).toBe(false);
});

test("a hub that waits a while for its store as it starts tells the owner", async () => {
  outage = "unreached";
  const starting = start({ tellAfter: 0 });
  await until(() => toldOwner.some((told) => told.startsWith("can't start")));

  outage = undefined;
  await starting;
});

test("a file hex restarted while its disk can't take anything keeps the thread changes it owed, through the claim a hub makes as it takes hex over", async () => {
  await takeOver(stores.open(dir));
  await onCall();
  outage = "unreached";
  hub.register("chat:9", "New topic");
  await settled();
  hub.close();
  hangUpAll();

  outage = undefined;
  await takeOver(stores.open(dir));
  await start();
  await hub.synced();
  expect(registry()["chat:9"]).toMatchObject({ name: "New topic" });
});

test("a spool the hex before this one wrote, as one list, is still paid", async () => {
  writeFileSync(
    join(dir, "owed.telegram.json"),
    JSON.stringify([
      {
        kind: "deliver",
        row: { key: "telegram:1:88", to: "chat:7", from: "telegram", author: "owner", body: "hi" },
      },
    ]),
  );

  await start();
  await hub.synced();
  expect(keysKept()).toEqual(["telegram:1:88"]);
});

test("the owner's words a hook took for the session without the session hearing them go to it from memory as the turn ends", async () => {
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
    key: "1:84",
  });
  await settled();
  file(dir).messages.takeHeld("chat:7", SESSION);

  await send({ type: "state", thread: "chat:7", busy: false });
  await until(() => received.length);
  await settled();
  expect(heard(received).map((turn) => turn.content)).toEqual(["held"]);
});

test("a hub's spool gains a line for each write it owes rather than being written whole each time", async () => {
  await onCall();
  outage = "unreached";
  await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:85" });
  const spool = join(dir, "owed.telegram.json");
  const { ino } = statSync(spool);
  await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:86" });
  await hub.deliver("chat:7", "Desk anchors", { ...message, key: "1:87" });
  await settled();

  expect(statSync(spool).ino).toBe(ino);
  expect(readFileSync(spool, "utf-8").trim().split("\n")).toHaveLength(3);
});
