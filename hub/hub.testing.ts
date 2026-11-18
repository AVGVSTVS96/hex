/* oxlint-disable import/no-mutable-exports -- what each test starts with, set before it runs, which the hub's test files read live */
import { afterEach, beforeEach, expect, mock } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
  existsSync,
  watch,
} from "node:fs";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { ATTACH } from "./claude.testing.ts";
import { settled as commandsSettled } from "./claude.ts";
import type { Job as JobRecord } from "./claude.ts";
import { clock, manual } from "./clock.ts";
import { startHub } from "./hub.ts";
import type { Call, Hub, HubOptions } from "./hub.ts";
import { claimedAs, landed } from "./kept.ts";
import { tool } from "./mcp.ts";
import type { ChannelServer, Permission } from "./mcp.ts";
import type { HubLine } from "./socket.ts";
import { stamp } from "./start.ts";
import * as stores from "./store.ts";
import { file, LostError, MovedError, RefusedError, UnreachedError } from "./store.ts";
import type { Author, Store } from "./store.ts";
import { hangUpAll, http as channelLine, port } from "./testing.ts";
import * as transcripts from "./transcripts.ts";
import { until } from "./until.ts";
import type { Message } from "./waiting.ts";

export const CHANNEL = "plugin:telegram@hex";

type Fault = {
  outage?: "unreached" | "lost" | "moved" | undefined;
  refusingOver?: number | undefined;
  refusingKey?: string | undefined;
  movedTo?: string | undefined;
  notWhole?: boolean | undefined;
};

export const fault: Fault = {};

const openedFirst = stores.open;
const outages = new Map<string, Store>();
export const storeCalls: string[] = [];
export const storeWaits = new Map<string, Promise<void>>();

const MessageArgs = z
  .tuple([z.looseObject({ body: z.string().optional(), key: z.string().optional() })])
  .rest(z.unknown());

function refusal(name: string | symbol, args: unknown[]) {
  if (fault.outage === "unreached") {
    return new UnreachedError("hex's store didn't answer");
  }

  if (fault.outage === "lost") {
    return new LostError("tenure 1 no longer holds hex: tenure 2 does");
  }

  if (fault.outage === "moved") {
    return new MovedError("hex's records moved");
  }

  const row = name === "deliver" ? MessageArgs.safeParse(args).data?.[0] : undefined;

  if (fault.refusingKey !== undefined && row?.key === fault.refusingKey) {
    return new RefusedError("CHECK constraint failed: key");
  }

  return fault.refusingOver !== undefined &&
    row?.body !== undefined &&
    row.body.length > fault.refusingOver
    ? new RefusedError("the row is over the store's limit")
    : undefined;
}

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
        storeCalls.push(String(name));
        await storeWaits.get(String(name));
        const refusing = claimed || fault.outage !== "lost" ? refusal(name, args) : undefined;

        if (refusing !== undefined && (fault.outage !== "moved" || movedFrom)) {
          throw refusing;
        }

        // oxlint-disable-next-line anti-slop/no-reflect-apply, typescript/no-unsafe-return -- whatever the store's own method answers
        return await Reflect.apply(value, target, args);
      };
    },
  });
}

function withOutages(dir: string): Store {
  const at = fault.movedTo ?? dir;
  const known = outages.get(at) ?? answering(openedFirst(at), fault.movedTo === undefined);
  outages.set(at, known);

  return known;
}

const unclaimedFirst = stores.unclaimed;
const unclaimedWithOutages = (dir: string): Store => answering(unclaimedFirst(dir), false, false);

await mock.module("./store.ts", () => ({
  ...stores,
  open: withOutages,
  unclaimed: unclaimedWithOutages,
}));

const transcriptsFirst = transcripts.sessionTranscripts;

await mock.module("./transcripts.ts", () => ({
  ...transcripts,
  sessionTranscripts: (given: Parameters<typeof transcriptsFirst>[0]) => {
    const first = transcriptsFirst(given);

    return {
      land: async (thread: string, fork?: string) =>
        (await first.land(thread, fork)) && fault.notWhole !== true,
    };
  },
}));

export const toldOwner: string[] = [];

export const ignoreLost = (): void => undefined;

await mock.module("./notice.ts", () => ({
  tellOwner: (text: string) => {
    toldOwner.push(text);

    return Promise.resolve(true);
  },
  cantStart: () => (why: string) => {
    toldOwner.push(`can't start: ${why}`);
  },
}));

export async function settled() {
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

export function heard(received: unknown[]) {
  return Heard.array().parse(received);
}

export const Initialized = z.object({
  result: z.object({
    protocolVersion: z.string(),
    capabilities: z.object({ tools: z.unknown(), experimental: z.unknown() }),
    instructions: z.string(),
  }),
});

export const Declined = z.object({ error: z.object({ code: z.number() }) });

export function matching(pattern: RegExp): string {
  // oxlint-disable-next-line typescript/no-unsafe-return -- bun types its asymmetric matchers as any
  return expect.stringMatching(pattern);
}

export function partialHub(methods: Partial<Hub>): Hub {
  // SAFETY: each test that hands a client this hub calls only the methods it gave.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a stub client's hub needs only what the test calls
  return methods as Hub;
}

export const SettingsFile = z.looseObject({
  enabledPlugins: z.record(z.string(), z.boolean()),
  env: z.record(z.string(), z.string()),
});

export const SESSION = "0a1b2c3d-0000-4000-8000-000000000000";
export const message: Message = { content: "hi", author: "owner", meta: { chat_id: "1" } };

export const SERVER: ChannelServer = {
  title: "Telegram",
  instructions: 'Messages arrive as <channel source="telegram">.',
  tools: [tool({ name: "reply", description: "Reply.", input: z.object({}) })],
  permission: true,
};

const LINUX_PID_MAX_LIMIT = 4_194_304;
export const EXITED = LINUX_PID_MAX_LIMIT + 1;

export let dir: string;
export let hub: Hub;
export let states: [string, boolean][];
export let failures: [string, string][];
export let prompts: [string, Permission][];
export let holds: [string, string, boolean][];
export let time: ReturnType<typeof manual>;

export async function startTestHub(options: HubOptions) {
  hub = await startHub(options);
}

export const sockets: Socket[] = [];
export const sleepers: ReturnType<typeof Bun.spawn>[] = [];
export const listener = { port: port() };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-"));
  mkdirSync(join(dir, "hex"), { recursive: true });
  mkdirSync(join(dir, "jobs", "job12345"), { recursive: true });
  const fake = join(dir, "claude");
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
  fault.outage = undefined;
  storeWaits.clear();
  toldOwner.length = 0;
  claimedAs(undefined);
  fault.refusingOver = undefined;
  fault.refusingKey = undefined;
  fault.movedTo = undefined;
  fault.notWhole = undefined;

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

export function inbound(sent: Message) {
  return {
    type: "inbound",
    content: sent.content,
    meta: { key: matching(/^telegram:/u), ...sent.meta },
  };
}

export function fold(received: unknown[]) {
  for (const payload of Keyed.array().parse(received)) {
    file(dir).messages.take(payload.meta.key, SESSION);
  }
}

export async function start(
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

export const bgStarts = () => calls().filter((each) => each[0] === "--bg");

export const deskStarts = () =>
  calls().filter((each) => each[0] === "--bg" && each.join(" ").includes("chat%3A7"));

export const startedAgainFor = (thread: string) =>
  bgStarts()
    .slice(3)
    .find((each) => settingsOf(each).env.HEX_THREAD === thread) ?? [];

export const respawns = () => calls().filter((each) => each[0] === "respawn");

export const restsOf = (thread: string) =>
  states.filter(([each, busy]) => each === thread && !busy).length;

export const SeenLine = z.looseObject({});

export function hookSays(busy: boolean) {
  const socket = connect(join(dir, "hub.sock"));
  socket.on("connect", () => {
    socket.end(`${JSON.stringify({ type: "state", thread: "chat:9", busy })}\n`);
  });
}

export async function settles(promise: Promise<unknown>) {
  const [settledAs] = await Promise.allSettled([promise]);

  return settledAs;
}

export function calls(): string[][] {
  if (!existsSync(join(dir, "calls"))) {
    return [];
  }

  return readFileSync(join(dir, "calls"), "utf-8")
    .split("\n")
    .slice(0, -1)
    .map((each) => Args.parse(JSON.parse(each)));
}

export async function launched() {
  const started = await until(() => calls().find((each) => each[0] === "--bg"));
  await settled();

  return started;
}

export async function session(thread: string, id = SESSION) {
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

export function http(thread?: string, extra: Record<string, string> = {}, deaf = 0) {
  return {
    ...channelLine({ stateDir: dir, path: "/telegram", channel: CHANNEL, thread, extra, deaf }),
    send: (payload: HubLine) => sendToHub(payload),
  };
}

export function sendToHub(payload: HubLine) {
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

export function bound(thread: string, id = SESSION, jobId = id.slice(0, 8), channel = CHANNEL) {
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

export function job(id: string, record: JobRecord) {
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

export function saved(id = SESSION, folder = join(dir, "hex")) {
  const project = join(dir, "projects", folder.replaceAll(/[^a-zA-Z0-9]/gu, "-"));
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${id}.jsonl`), "{}\n");
}

export function said(tokens: number, compacted = false, id = SESSION, at = clock.now()) {
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

export function settingsOf(args: string[]) {
  const path = args[args.indexOf("--settings") + 1] ?? "";

  return SettingsFile.parse(JSON.parse(readFileSync(path, "utf-8")));
}

export function registry(): Record<string, Registered> {
  return Object.fromEntries(
    file(dir)
      .threads.list({ open: true })
      .map(({ app: _app, thread, open: _open, launched: _launched, fork, ...known }) => [
        thread,
        { ...known, ...(fork !== undefined && fork !== "" && { from: fork }) },
      ]),
  );
}

export function slowLauncher() {
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

export const NEXT = "0a1b2c3d-0000-4000-8000-000000000001";

export async function toolCall(thread: string, input: Record<string, string> = {}) {
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

export function besideLauncher() {
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

export function runs() {
  return existsSync(join(dir, "runs"))
    ? readFileSync(join(dir, "runs"), "utf-8")
        .split("\n")
        .slice(0, -1)
        .map((each) => Run.parse(JSON.parse(each)))
    : [];
}

export function stored(
  rows: { author: Author; body: string; from?: string; meta?: Record<string, string> }[],
  thread = "chat:7",
  takenBy: string | undefined = SESSION,
) {
  const store = file(dir);

  for (const [i, { from = "buzz", ...row }] of rows.entries()) {
    store.messages.deliver({ key: `${from}:${thread}-${i}`, to: thread, from, ...row }, takenBy);
  }
}
