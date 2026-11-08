import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { FSWatcher } from "node:fs";
import { createServer } from "node:net";
import { basename, join } from "node:path";

import { z } from "zod";

import * as claude from "./claude.ts";
import { clock } from "./clock.ts";
import { holding } from "./holds.ts";
import { STARTUP } from "./loaded.ts";
import { endpoint, toolList } from "./mcp.ts";
import type { ChannelServer, Line, Permission, ToolArguments } from "./mcp.ts";
import { queue } from "./observe.ts";
import { schedule } from "./schedule.ts";
import { asked, isAuthor, open, replied, shown, spoken, stateDir as storeOf } from "./store.ts";
import type { Author, MessageId, NewRow, Row, Store } from "./store.ts";
import { zoneOf } from "./zone.ts";

export { dispatch, tool } from "./mcp.ts";

export type { ChannelServer, Handlers, Permission, Tool, ToolArguments } from "./mcp.ts";

export type Message = {
  content: string;
  meta: Record<string, string>;
  key?: string;
  author?: Author;
};

export type Call = (thread: string, tool: string, args: ToolArguments) => Promise<string>;

export type State = (thread: string, busy: boolean, background: boolean) => void;

export type Failed = (thread: string, reason: string) => void;

export type Waits = (thread: string, message: Message, still: boolean) => void;

export type Settings = { model?: string | undefined; effort?: string | undefined };

export const MODELS = [
  { value: "opus", name: "Opus" },
  { value: "sonnet", name: "Sonnet" },
  { value: "haiku", name: "Haiku" },
  { value: "fable", name: "Fable" },
];

export const EFFORTS = [
  { value: "low", name: "Low" },
  { value: "medium", name: "Medium" },
  { value: "high", name: "High" },
  { value: "xhigh", name: "Extra High" },
  { value: "max", name: "Max" },
];

export function family(model: string) {
  return MODELS.find(({ value }) => model.startsWith(`claude-${value}-`))?.value ?? model;
}

const PreviewFields = z.record(z.string(), z.json());

export function preview({ input_preview, description }: Permission): string {
  try {
    return Object.entries(PreviewFields.parse(JSON.parse(input_preview)))
      .filter(([, value]) => value !== description)
      .map(([key, value]) => `${key}: ${z.string().safeParse(value).data ?? JSON.stringify(value)}`)
      .join("\n");
  } catch {
    return input_preview;
  }
}

export type Questions = {
  answer: (thread: string, message: MessageId, label: string, via: string) => void;
  settle: (thread: string, message: MessageId, note: string) => void;
  reopen: (thread: string, message: MessageId, via: string) => void;
};

const messageId = z.union([z.number(), z.string()]);

const HubRequestLine = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("state"),
    thread: z.string(),
    busy: z.boolean(),
    background: z.boolean().optional(),
    failed: z.boolean().optional(),
    taken: z.array(z.string()).optional(),
    session: z.string().optional(),
  }),
  z.object({
    type: z.literal("open"),
    thread: z.string(),
    name: z.string(),
    prompt: z.string().optional(),
  }),
  z.object({
    type: z.literal("answer"),
    thread: z.string(),
    message: messageId,
    label: z.string(),
    via: z.string(),
  }),
  z.object({ type: z.literal("settle"), thread: z.string(), message: messageId, note: z.string() }),
  z.object({ type: z.literal("reopen"), thread: z.string(), message: messageId, via: z.string() }),
  z.object({
    type: z.literal("inbound"),
    thread: z.string(),
    content: z.string(),
    meta: z.record(z.string(), z.string()).optional(),
    key: z.string().optional(),
    author: z.custom<Author>(isAuthor).catch("prompt"),
  }),
  z.object({
    type: z.literal("mirror"),
    thread: z.string(),
    to: z.string(),
    where: z.string().optional(),
  }),
]);

type HubRequest = z.output<typeof HubRequestLine>;

export type Hub = ReturnType<typeof startHub>;

export type Limits = {
  idleStop: number;
  cacheWarm: number;
  compactAbove: number;
  reconnect: number;
  connect: number;
  capacity: number;
};

type Saved = Settings & {
  name: string;
  session?: string | undefined;
  from?: string | undefined;
  cwd?: string | undefined;
  launched?: string | undefined;
};

type Timer = ReturnType<typeof setTimeout>;

type SessionEnv = {
  HEX_CHANNEL: string;
  HEX_THREAD: string;
  HEX_HUB: string;
  HEX_PORT: string;
  HEX_TOKEN: string;
  HEX_STORE: string;
  MCP_TIMEOUT?: string;
  HEX_MAIN?: string;
  HEX_FRESH?: string;
  HEX_HELD?: string;
};

type Phase =
  | { is: "stopped" }
  | {
      is: "launching";
      job?: string;
      watch?: FSWatcher;
      deadline?: Timer | undefined;
      respawned?: boolean;
      again?: boolean | undefined;
    }
  | { is: "recovering"; deadline?: Timer | undefined; again?: boolean | undefined }
  | { is: "live"; line: Line };

type Run = {
  phase: Phase;
  queue: Message[];
  handed: Set<string>;
  turn: "busy" | "background" | "done";
  renew?: "asked" | "stale" | "underway" | undefined;
  rest?: Timer | undefined;
  leaving?: ((session: string) => void) | undefined;
  ending?: Promise<void> | undefined;
  interrupting?: Promise<void> | undefined;
  unsaved?: string | undefined;
  held: (() => void)[];
  awaited?: boolean | undefined;
  compacting?: number | undefined;
  failing?: { count: number; retried?: boolean; told?: boolean } | undefined;
  opening?: Opening | undefined;
  waiting: Map<string, Message>;
};

type Opening = { prompt?: string | undefined; fork?: string | undefined; quiet?: boolean };

export type VoiceLine = { play: (audio: string) => void; end: () => void };

export type Held = { hear: (audio: string) => void; hangUp: () => void };

export type CallEngine = {
  take?: (from: "discord", greeting: string, line: VoiceLine) => Held;
};

export const engine: CallEngine = {};

export type Turn = { from: "me" | "hex"; text: string; media?: { id: string; kind: string }[] };

export type Client = {
  hub: Hub;
  place: (
    name: string,
    where?: string,
    about?: string,
    cwd?: string,
  ) => Promise<{ thread: string; link: string }>;
  backfill?: (thread: string, turns: Turn[]) => Promise<void>;
  waits?: boolean;
  close?: () => Promise<void>;
  stop?: (thread: string) => void;
};

export const clients = new Map<string, Client>();

const retries = new Set<() => void>();

const answered = new Set<() => void>();

let generalHub: Hub | undefined;
const TELL_GENERAL_AFTER_FAILED_STARTS = 3;

let reached: (hub: Hub) => void;

export const up = new Promise<Hub>((resolve) => {
  reached = resolve;
});

export const PORT = Number(process.env.HEX_PORT ?? 8789);

const channels = new Map<string, (request: Request) => Promise<Response>>();

export function route(request: Request): Promise<Response> {
  return (
    channels.get(new URL(request.url).pathname)?.(request) ??
    Promise.resolve(new Response("Not Found", { status: 404 }))
  );
}

export async function listen(port = PORT): Promise<ReturnType<typeof Bun.serve>> {
  for (let held = false; ; held = true) {
    try {
      const server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: route });

      if (held) {
        process.stderr.write(`hub: port ${port} is free; starting\n`);
      }

      return server;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) {
        throw error;
      }
    }

    if (!held) {
      process.stderr.write(`hub: port ${port} is in use; this hub starts once it's free\n`);
    }

    await Bun.sleep(1000);
  }
}

export function tappable(text: string): string {
  return text.replaceAll(
    /buzz:\/\/[^\s)>\]\\]*[^\s)>\]\\.,;:!?'"]/gu,
    (url) => `https://hex-sand.vercel.app/open.html#${encodeURIComponent(url)}`,
  );
}

export function history(store: Store, thread: string, session?: string): Turn[] {
  const rows = store.said(thread);
  const start = present(session) ? (rows.find((row) => row.taken?.by === session)?.at ?? "9") : "";

  return rows.flatMap((row): Turn[] => {
    if (row.from === "terminal" || !row.taken || row.at < start) {
      return [];
    }

    if (replied(row)) {
      return shown(row) ? [{ from: "hex", text: row.body }] : [];
    }

    const text =
      spoken(row) && row.author === "owner" ? (row.from === "t3" ? asked(row.body) : row.body) : "";

    const media = carried(row.meta);

    return text ? [{ from: "me", text, ...(media && { media }) }] : [];
  });
}

export function carried(meta?: Record<string, string>): Turn["media"] {
  return meta?.media?.split("; ").map((entry) => {
    const [kind = "", id = ""] = entry.split(" ");

    return { id, kind };
  });
}

const Transcript = z.object({ text: z.string().optional() });

export async function transcribe(recording: () => Promise<string>): Promise<string | undefined> {
  const { TRANSCRIBE_URL: url, TRANSCRIBE_MODEL: model, TRANSCRIBE_API_KEY: key } = process.env;

  if (!present(url) || !present(model)) {
    return;
  }

  const path = await recording();
  const form = new FormData();
  form.append("file", Bun.file(path), basename(path));
  form.append("model", model);

  const res = await fetch(url, {
    method: "POST",
    body: form,
    headers: present(key) ? { authorization: `Bearer ${key}` } : {},
  });

  if (!res.ok) {
    throw new Error(`transcription failed: HTTP ${res.status}`);
  }

  const { text } = Transcript.parse(await res.json());
  const trimmed = text?.trim();

  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

const ESC_LANDS_WITHIN = 5000;

const LIMITS: Limits = {
  idleStop: 54 * 60_000,
  cacheWarm: 54 * 60_000,
  compactAbove: 150_000,
  reconnect: 20_000,
  connect: 300_000,
  capacity: capacityFrom(process.env.HEX_CHAT_CAPACITY),
};

function capacityFrom(tokens?: string) {
  if (!present(tokens)) {
    return 350_000;
  }

  if (!/^\d+$/u.test(tokens)) {
    throw new Error(`HEX_CHAT_CAPACITY must be a number of tokens, got "${tokens}"`);
  }

  return Number(tokens);
}

export function stamp(args: string[], server?: ChannelServer, startup: string[] = []) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        args,
        server ? { ...server, tools: toolList(server.tools) } : null,
        ...(startup.length ? [startup.map(contentsOf)] : []),
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}

type Read = string | [string, Read][] | null;

function contentsOf(path: string): Read {
  try {
    if (!statSync(path).isDirectory()) {
      return readFileSync(path, "utf-8");
    }

    return readdirSync(path)
      .toSorted()
      .map((name) => [name, contentsOf(join(path, name))]);
  } catch {
    return null;
  }
}

const onCall = new Set<Run>();
const hungUp: (() => void)[] = [];

export function free(): Promise<void> {
  return new Promise((resolve) => {
    if (onCall.size > 0) {
      hungUp.push(resolve);
    } else {
      resolve();
    }
  });
}

function hangUp(run: Run) {
  if (onCall.delete(run) && !onCall.size) {
    for (const resolve of hungUp.splice(0)) {
      resolve();
    }
  }
}

export function title(text: string): string {
  const word = text.trim();

  if (!/^[^\s_-]+$/u.test(word)) {
    throw new Error(`title must be one word, got "${word}"`);
  }

  return word;
}

function tokenOf(stateDir: string) {
  const file = join(stateDir, "token");

  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  }

  return readFileSync(file, "utf-8").trim();
}

function startupFiles(hex: string | undefined) {
  return hex === undefined || hex === ""
    ? []
    : Object.values(STARTUP)
        .flat()
        .map((path) => join(hex, path));
}

const ignore = (): void => undefined;

function present(text: string | undefined): text is string {
  return text !== undefined && text !== "";
}

function toMessageWithKeyFirstForTheHook(row: Row): Message {
  return { content: row.body, author: row.author, meta: { key: row.key, ...row.meta } };
}

export function startHub({
  stateDir,
  storeDir = storeOf(stateDir),
  channel,
  server,
  port = PORT,
  main,
  mainName = "main",
  general = false,
  call,
  state,
  failed,
  waits,
  permission,
  questions,
  args = () => [],
  fresh = () => false,
  limits,
  hexDir = process.cwd(),
  launcher = "claude",
  startup = startupFiles(process.env.HEX_STARTUP),
  link,
}: {
  stateDir: string;
  storeDir?: string | undefined;
  channel: string;
  server: ChannelServer;
  port?: number | undefined;
  main?: string | undefined;
  mainName?: string | undefined;
  general?: boolean | undefined;
  call: Call;
  state: State;
  failed: Failed;
  waits?: Waits | undefined;
  permission?: ((thread: string, request: Permission) => void) | undefined;
  questions?: Questions | undefined;
  args?: ((thread: string) => string[]) | undefined;
  fresh?: ((thread: string) => boolean) | undefined;
  limits?: Partial<Limits> | undefined;
  hexDir?: string | undefined;
  launcher?: string | undefined;
  startup?: string[] | undefined;
  link?: ((thread: string) => string | undefined) | undefined;
}) {
  const { idleStop, cacheWarm, compactAbove, reconnect, connect, capacity } = {
    ...LIMITS,
    ...limits,
  };

  const caller = new AsyncLocalStorage<string>();
  const socketPath = join(stateDir, "hub.sock");
  const sessionsDir = join(stateDir, "sessions");
  const runs = new Map<string, Run>();
  const plugin = channel.replace(/^plugin:/u, "");
  const path = `/${plugin.split("@")[0]}`;
  const app = path.slice(1);
  let db: Store | undefined;
  const threads: Map<string, Saved> = openThreads();
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  save();
  const token = tokenOf(stateDir);
  const inherited = claude.inherited();
  let closed = false;
  const closing = new AbortController();
  const serving = () => !closed;

  function openThreads(): Map<string, Saved> {
    db ??= open(storeDir);

    return new Map(
      db
        .threads({ app, open: true })
        .map(({ app: _app, open: _open, link: _link, thread, fork, model, ...known }) => [
          thread,
          {
            ...known,
            ...(present(model) && { model: family(model) }),
            ...(present(fork) && { from: fork }),
          },
        ]),
    );
  }

  function keepIn(store: Store, saved: Map<string, Saved>) {
    store.keepThreads(
      app,
      Object.fromEntries(
        [...saved].map(([thread, known]) => [
          thread,
          {
            name: known.name,
            ...(known.session !== undefined && { session: known.session }),
            ...(known.cwd !== undefined && { cwd: known.cwd }),
            ...(known.model !== undefined && { model: known.model }),
            ...(known.effort !== undefined && { effort: known.effort }),
            ...(known.launched !== undefined && { launched: known.launched }),
            ...(known.from !== undefined && { fork: known.from }),
            ...withLink(thread),
          },
        ]),
      ),
    );
  }

  function withLink(thread: string) {
    const given = linkOf(thread);

    return given === undefined ? {} : { link: given };
  }

  function linkOf(thread: string) {
    try {
      return link?.(thread);
    } catch (error) {
      process.stderr.write(`hub: no link for ${app} thread ${thread}: ${String(error)}\n`);
    }
  }

  function save() {
    kept((store) => {
      keepIn(store, threads);
    }, undefined);
  }

  function runOf(thread: string): Run {
    let run = runs.get(thread);

    if (!run) {
      runs.set(
        thread,
        (run = {
          phase: { is: "stopped" },
          queue: [],
          handed: new Set(),
          turn: "done",
          held: [],
          waiting: new Map(),
        }),
      );
    }

    return run;
  }

  function become(run: Run, phase: Phase) {
    const was = run.phase;

    if (was.is === "launching") {
      was.watch?.close();
    }

    if (was.is === "launching" || was.is === "recovering") {
      clock.clearTimeout(was.deadline);
    }

    run.phase = phase;
  }

  function underway(run: Run) {
    return run.phase.is === "launching" || run.phase.is === "live";
  }

  function setState(thread: string, working: boolean, background = false) {
    const run = runOf(thread);
    state(thread, working, background);
    claim(thread);
    run.turn = working ? "busy" : background ? "background" : "done";

    if (run.turn === "done" && (run.renew === "asked" || run.renew === "stale")) {
      void renew(thread, run.renew === "asked");
    }

    rest(thread, run.turn === "done");
    letGo(thread);
  }

  async function renew(thread: string, rested = false) {
    const run = runOf(thread);
    const session = current(thread);

    if (!present(session)) {
      return;
    }

    const running = await claude.agent(session, serving);

    if (
      !(run.renew === "asked" || run.renew === "stale") ||
      run.turn === "busy" ||
      onCall.has(run) ||
      (!rested && running?.status === "busy")
    ) {
      return;
    }

    run.renew = running && (thread === main || fresh(thread)) ? "underway" : undefined;

    if (run.renew) {
      void cycle(thread, running);
    } else {
      void stop(thread);
    }

    letGo(thread);
  }

  function pending(run: Run) {
    return run.renew === "underway" || (!!run.renew && run.turn !== "background");
  }

  function renewal(thread: string): Promise<void> {
    const run = runOf(thread);

    if (!pending(run)) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      run.held.push(resolve);
    });
  }

  function letGo(thread: string) {
    const run = runOf(thread);

    if (pending(run)) {
      return;
    }

    for (const resolve of run.held.splice(0)) {
      resolve();
    }
  }

  function rest(thread: string, rested = false) {
    const run = runOf(thread);
    clock.clearTimeout(run.rest);
    run.rest = undefined;

    if (run.turn === "busy" || run.phase.is !== "live") {
      return;
    }

    if (thread === main) {
      run.rest = clock.setTimeout(() => void stopIfIdle(thread), cacheWarm);
    } else if (run.leaving) {
      void stop(thread);
    } else if (fresh(thread)) {
      const left = warmFor(thread);

      if (left === 0 && rested) {
        void handOff(thread, true);
      } else if (left !== undefined) {
        run.rest = clock.setTimeout(() => void handOff(thread), left);
      }
    } else {
      run.rest = clock.setTimeout(() => void stopIfIdle(thread), idleStop);
    }
  }

  function warmFor(thread: string) {
    const session = current(thread);

    const {
      sent: context,
      at,
      short,
    } = present(session) ? claude.usage(cwdOf(thread), session) : { sent: 0 };

    if (!context) {
      return;
    }

    return context >= capacity
      ? 0
      : Math.max(
          0,
          (at ?? clock.now()) + (short === true ? cacheWarm / 12 : cacheWarm) - clock.now(),
        );
  }

  function spent(thread: string) {
    return fresh(thread) && !onCall.has(runOf(thread)) && warmFor(thread) === 0;
  }

  async function handOff(thread: string, rested = false) {
    const run = runOf(thread);
    run.rest = undefined;
    const running = await claude.agent(current(thread) ?? "", serving);

    if (running && run.turn !== "busy" && (rested || running.status === "idle") && spent(thread)) {
      void cycle(thread, running);
    }
  }

  async function stopIfIdle(thread: string) {
    const run = runOf(thread);
    run.rest = undefined;
    const session = current(thread);

    if (!present(session)) {
      return;
    }

    const running = await claude.agent(session, serving);

    if (run.turn === "busy" || running?.status === "busy") {
      return;
    }

    const { sent: context, failed: failedAt } = claude.usage(cwdOf(thread), session);

    if (running && !run.leaving && !fresh(thread) && !onCall.has(run) && context > compactAbove) {
      if (failedAt === undefined) {
        compact(thread, running);

        return;
      }

      run.compacting ??= failedAt;
    }

    if (thread !== main) {
      void stop(thread);
    }
  }

  function compact(thread: string, running?: claude.Agent) {
    runOf(thread).compacting = clock.now();
    void cycle(thread, running, "/compact", true);
  }

  async function recompact() {
    for (const [thread, run] of runs) {
      const session = current(thread);

      if (run.compacting === undefined || !present(session)) {
        continue;
      }

      const { sent: context, failed: failedAt } = claude.usage(cwdOf(thread), session);

      if (context <= compactAbove) {
        run.compacting = undefined;
        continue;
      }

      const resting = run.phase.is === "live" || run.phase.is === "stopped";

      if (
        failedAt === undefined ||
        failedAt < run.compacting ||
        !resting ||
        run.turn === "busy" ||
        run.ending ||
        run.leaving ||
        onCall.has(run)
      ) {
        continue;
      }

      const running = await claude.agent(session, serving);

      if (running?.status !== "busy") {
        compact(thread, running);
      }
    }
  }

  function stop(thread: string, running?: claude.Agent) {
    const run = runOf(thread);
    clock.clearTimeout(run.rest);
    run.rest = undefined;
    const session = running?.sessionId ?? current(thread);

    if (!present(session)) {
      return Promise.resolve();
    }

    if (run.ending) {
      return run.ending;
    }

    const ending: Promise<void> = (running ? Promise.resolve(running) : claude.listing(session))
      .then((agent) => {
        if (closed) {
          return;
        }

        kept((store) => {
          store.handled(session);
        }, undefined);
        void claude.stop(session);

        return agent && claude.exited(agent.pid);
      })
      .finally(() => (run.ending = undefined));

    return (run.ending = ending);
  }

  function retire(thread: string): Promise<string> {
    if (thread === main) {
      throw new Error("the main thread stays open");
    }

    return new Promise((resolve) => {
      const run = runOf(thread);
      run.leaving = resolve;

      if (run.phase.is !== "live") {
        forget(thread, resolve);

        return;
      }

      void stopIfIdle(thread);
    });
  }

  function release(thread: string) {
    if (thread === main) {
      throw new Error("the main thread stays here");
    }

    if (!present(threads.get(thread)?.session)) {
      throw new Error("this thread has no session yet");
    }

    return retire(thread);
  }

  function forget(thread: string, leaving: (session: string) => void) {
    const run = runOf(thread);
    const session = threads.get(thread)?.session ?? "";
    threads.delete(thread);
    save();
    become(run, { is: "stopped" });
    clock.clearTimeout(run.rest);
    runs.delete(thread);
    rmSync(settingsOf(thread), { force: true });
    rmSync(heldOf(thread), { recursive: true, force: true });
    leaving(session);
  }

  function adopt(thread: string, name: string, session: string, prompt?: string, cwd?: string) {
    threads.set(thread, { name, session, ...(present(cwd) && { cwd }) });
    save();

    if (present(prompt)) {
      void launch(thread, name, { prompt });
    }
  }

  function find(nameOrThread: string) {
    if (threads.has(nameOrThread)) {
      return nameOrThread;
    }

    const wanted = nameOrThread.trim().toLowerCase();

    const matches = [...threads].flatMap(([thread, known]) =>
      known.name.toLowerCase() === wanted ? [thread] : [],
    );

    const [only] = matches;

    if (matches.length > 1) {
      throw new Error(`more than one thread is named "${nameOrThread}"`);
    }

    if (only === undefined) {
      throw new Error(`no thread named "${nameOrThread}"`);
    }

    return only;
  }

  function savedOf(thread: string) {
    const known = threads.get(thread);

    if (!known) {
      throw new Error(`${app} thread ${thread} isn't open in this hub`);
    }

    return known;
  }

  function rename(thread: string, name: string) {
    const known = threads.get(thread);

    if (!known || known.name === name) {
      return;
    }

    known.name = name;
    save();
  }

  function follow(thread: string, name: string, session: string, cwd?: string) {
    threads.set(thread, { name, from: session, ...(present(cwd) && { cwd }) });
    save();
  }

  function register(thread: string, name: string, cwd?: string) {
    const known = threads.get(thread) ?? { name, ...(present(cwd) && { cwd }) };
    threads.set(thread, known);

    return known;
  }

  async function launch(
    thread: string,
    name: string,
    {
      cwd,
      again,
      ...given
    }: Opening & { cwd?: string | undefined; again?: boolean | undefined } = {},
  ) {
    const run = runOf(thread);

    if (closed || underway(run)) {
      return;
    }

    if (present(given.prompt) || present(given.fork)) {
      run.opening = given;
    }

    const { prompt, fork, quiet = false } = run.opening ?? {};
    const known = register(thread, name, cwd);
    claim(thread);

    if ((present(prompt) && !quiet) || run.queue.length > 0) {
      setState(thread, true);
    }

    const phase: Phase = { is: "launching", again };
    become(run, phase);

    for (const message of waiting(thread)) {
      mark(thread, message);
    }

    if (present(fork) && !run.failing) {
      await start(thread, prompt, fork);

      return;
    }

    const running = await sessionOf(thread);

    if (run.phase !== phase) {
      return;
    }

    if (running) {
      become(run, { is: "recovering", again });

      recover(thread);

      return;
    }

    cut(thread);

    if (!present(fork) && present(known.session) && !fresh(thread)) {
      await claude.rm(known.session);
    }

    if (run.phase === phase) {
      await start(thread, prompt, fork);
    }
  }

  async function sessionOf(thread: string) {
    const running = await claude.agents(serving);

    return (
      running.find((agent) => agent.sessionId === current(thread)) ??
      running.find((agent) => boundTo(agent) === thread)
    );
  }

  function boundTo(agent: claude.Agent) {
    const env = claude.settingsOf(agent)?.env;

    return env?.HEX_CHANNEL === channel ? env.HEX_THREAD : undefined;
  }

  function extra(thread: string) {
    const { model, effort } = savedOf(thread);

    return [
      ...(present(model) ? ["--model", model] : []),
      ...(present(effort) ? ["--effort", effort] : []),
      ...args(thread),
    ];
  }

  function stale(thread: string) {
    return (
      (threads.get(thread)?.launched ?? stamp([], server)) !== stamp(extra(thread), server, startup)
    );
  }

  function configure(thread: string, settings: Settings) {
    const known = savedOf(thread);

    if ("model" in settings) {
      if (present(settings.model)) {
        known.model = settings.model;
      } else {
        delete known.model;
      }
    }

    if ("effort" in settings) {
      if (present(settings.effort)) {
        known.effort = settings.effort;
      } else {
        delete known.effort;
      }
    }

    save();
  }

  function settingsOf(thread: string) {
    return join(sessionsDir, `${encodeURIComponent(thread)}.json`);
  }

  function heldOf(thread: string) {
    return join(sessionsDir, encodeURIComponent(thread));
  }

  function writeSettings(thread: string, launched: ReturnType<typeof claude.settingsOf> = {}) {
    const env: SessionEnv = {
      HEX_CHANNEL: channel,
      HEX_THREAD: thread,
      HEX_HUB: socketPath,
      HEX_PORT: String(port),
      HEX_TOKEN: token,
      HEX_STORE: storeDir,
    };

    if (connect) {
      env.MCP_TIMEOUT = String(connect);
    }

    if (general && thread === main) {
      env.HEX_MAIN = "1";
    }

    if (fresh(thread)) {
      env.HEX_FRESH = "1";
    } else {
      env.HEX_HELD = heldOf(thread);
    }

    writeFileSync(
      settingsOf(thread),
      JSON.stringify({
        ...launched,
        enabledPlugins: { ...launched?.enabledPlugins, [plugin]: true },
        env: { ...launched?.env, ...env },
      }),
      { mode: 0o600 },
    );
  }

  async function start(thread: string, prompt?: string, fork?: string) {
    const known = savedOf(thread);
    writeSettings(thread);

    if (present(prompt)) {
      kept(
        (store) =>
          store.deliver(
            {
              key: `hub:${thread}:${Bun.hash(prompt).toString(36)}`,
              to: thread,
              from: "hub",
              author: "prompt",
              body: prompt,
              meta: {},
            },
            "hub",
          ),
        false,
      );
    }

    const launchArgs = extra(thread);
    const launched = stamp(launchArgs, server, startup);

    if (known.launched !== launched) {
      known.launched = launched;
      save();
    }

    const source = fork ?? (present(known.session) ? undefined : known.from);

    const resumeArgs = present(source)
      ? ["--resume", source, "--fork-session"]
      : present(known.session) && !fresh(thread)
        ? ["--resume", known.session]
        : [];

    try {
      watchJob(
        thread,
        await claude.start(
          launcher,
          [
            "--channels",
            channel,
            "--name",
            known.name,
            ...resumeArgs,
            ...launchArgs,
            "--settings",
            settingsOf(thread),
            ...(present(prompt) ? [prompt] : []),
          ],
          { cwd: known.cwd ?? hexDir, env: inherited },
        ),
      );
    } catch (error) {
      fail(thread, error instanceof Error ? error.message : String(error));
    }
  }

  function watchJob(thread: string, job: string) {
    const phase = runOf(thread).phase;

    if (phase.is !== "launching") {
      return;
    }

    phase.job = job;
    recover(thread);

    const check = () => {
      const { state: status, detail } = claude.record(job);

      if (status === "failed") {
        fail(
          thread,
          detail === undefined || detail === "" ? "the session failed to start" : detail,
        );
      }
    };

    try {
      phase.watch = claude.watchJob(job, check);
      check();
    } catch {
      process.stderr.write(
        `hub: no job record for ${job}, so a failed start of ${thread} can't be seen\n`,
      );
    }
  }

  function fail(thread: string, reason: string) {
    const run = runOf(thread);
    const { phase } = run;

    if (phase.is !== "launching") {
      return;
    }

    become(run, { is: "stopped" });

    if (lost(thread, reason)) {
      return void launch(thread, savedOf(thread).name, { again: phase.again });
    }

    if (run.renew === "underway") {
      run.renew = undefined;
    }

    run.failing ??= { count: 0 };
    const { failing } = run;
    failing.count++;

    if (phase.again !== true) {
      failing.retried = false;
    }

    process.stderr.write(
      `hub: ${thread}'s session failed to start, ${failing.count} in a row: ${reason}\n`,
    );

    for (const message of waiting(thread)) {
      mark(thread, message);
    }

    if (phase.again !== true || failing.count === 1) {
      failed(thread, reason);
    }

    const generalMain = generalHub?.main;

    if (
      failing.count >= TELL_GENERAL_AFTER_FAILED_STARTS &&
      failing.told !== true &&
      generalHub &&
      generalMain !== undefined &&
      !(general && thread === main)
    ) {
      failing.told = true;
      const content = `[hub] hex couldn't start the session of ${app} thread "${threads.get(thread)?.name ?? thread}" ${failing.count} times in a row: ${reason}. Its next message starts it again.`;
      generalHub.deliver(generalMain, generalHub.name(generalMain) ?? "hex", {
        content,
        author: "prompt",
        meta: { user: "hub" },
      });
    }

    setState(thread, false);
  }

  function lost(thread: string, reason: string) {
    const known = threads.get(thread);
    const run = runOf(thread);
    const session = /source session (\S+) not found/u.exec(reason)?.[1];

    if (
      !known ||
      !present(session) ||
      ![known.session, known.from, run.opening?.fork].includes(session) ||
      claude.saved(session)
    ) {
      return false;
    }

    const key = `hub:${thread}:lost:${session}`;
    const body = `[hub] Claude Code no longer has the conversation of session ${session}, which this thread was to continue, so you're a new session without it; say so when you reply.`;

    if (
      !kept((store) => {
        store.deliver({
          key,
          to: thread,
          from: "hub",
          author: "prompt",
          body,
          meta: { user: "hub" },
        });

        return true;
      }, false)
    ) {
      return false;
    }

    run.handed.add(key);
    process.stderr.write(
      `hub: ${thread} lets go of session ${session}, which Claude Code can't find, and starts a new one\n`,
    );

    if (known.session === session) {
      delete known.session;
    }

    if (known.from === session) {
      delete known.from;
    }

    if (run.opening?.fork === session) {
      delete run.opening.fork;
    }

    save();

    return true;
  }

  function kept<T>(use: (store: Store) => T, otherwise: T): T {
    try {
      db ??= open(storeDir);

      return use(db);
    } catch (error) {
      process.stderr.write(
        `hub: ${join(storeDir, "hex.db")} failed, so the hub goes on from memory: ${String(error)}\n`,
      );

      return otherwise;
    }
  }

  function deliver(thread: string, name: string, message: Message, along?: () => boolean): boolean {
    const { author } = message;

    if (!author) {
      throw new Error(`a message to ${thread} has no author`);
    }

    const key = `${app}:${message.key ?? randomUUID()}`;
    const { content, meta } = message;

    const added = kept(
      (store) =>
        store.write(
          () =>
            (!along || along()) &&
            store.deliver({
              key,
              to: thread,
              from: app,
              author,
              body: content,
              meta,
            }),
        ),
      along ? false : undefined,
    );

    if (added === false) {
      return false;
    }

    pass(thread, name, added ? { content, meta: { key, ...meta } } : { content, meta });

    return true;
  }

  function sent(
    thread: string,
    { key, content, meta = {} }: Partial<Message> & { content: string },
  ) {
    const row: NewRow = {
      key: `${app}:${key ?? randomUUID()}`,
      to: thread,
      from: app,
      author: "hex",
      body: content,
      meta,
    };

    kept((store) => store.deliver(row, current(caller.getStore() ?? thread) ?? "hub"), false);
  }

  function pass(thread: string, name: string, message: Message) {
    const { handed } = runOf(thread);
    const { key } = message.meta;

    if (present(key) && handed.has(key)) {
      return;
    }

    if (present(key)) {
      handed.add(key);
    }

    forward(thread, name, message);
  }

  function forward(thread: string, name: string, message: Message) {
    const run = runOf(thread);

    const { ending } = run;

    if (ending) {
      hold(thread, message);
      void (async () => {
        await ending;
        resume(thread, name);
      })();

      return;
    }

    if (run.phase.is === "live") {
      if ((stale(thread) && !onCall.has(run)) || spent(thread)) {
        void refresh(thread, message);
      } else {
        run.phase.line.send({ type: "inbound", ...message });
      }

      return;
    }

    hold(thread, message);

    if (run.phase.is === "launching") {
      run.phase.again = false;
    }

    void launch(thread, name);
  }

  function hold(thread: string, message: Message) {
    runOf(thread).queue.push(message);
    mark(thread, message);
  }

  function mark(thread: string, message: Message) {
    const run = runOf(thread);
    const { key } = message.meta;

    if (!present(key) || run.waiting.has(key)) {
      return;
    }

    run.waiting.set(key, message);
    waits?.(thread, message, true);
  }

  function waiting(thread: string): Message[] {
    const rows = kept((store) => store.untaken(thread), []);

    return [
      ...rows.map(toMessageWithKeyFirstForTheHook),
      ...runOf(thread).queue.filter((message) => !present(message.meta.key)),
    ];
  }

  function wake() {
    if (closed) {
      return;
    }

    const rows = kept<Row[] | undefined>((store) => store.untaken([...threads.keys()]), undefined);

    if (!rows) {
      return;
    }

    for (const row of rows) {
      const known = threads.get(row.to);

      if (known) {
        pass(row.to, known.name, toMessageWithKeyFirstForTheHook(row));
      }
    }

    const untaken = new Set(rows.map((row) => row.key));

    for (const [thread, run] of runs) {
      for (const [key, message] of run.waiting) {
        if (untaken.has(key)) {
          continue;
        }

        run.waiting.delete(key);
        waits?.(thread, message, false);
      }
    }
  }

  function retry() {
    for (const [thread, run] of runs) {
      if (
        !run.failing ||
        run.failing.retried === true ||
        run.phase.is !== "stopped" ||
        !(thread === main || run.opening || waiting(thread).length)
      ) {
        continue;
      }

      run.failing.retried = true;
      void launch(thread, threads.get(thread)?.name ?? thread, { again: true });
    }
  }

  function took(keys: string[] | undefined, session: string | undefined) {
    if (keys === undefined || session === undefined) {
      return;
    }

    for (const key of keys) {
      kept((store) => store.take(key, session), false);
    }
  }

  function resume(thread: string, name: string) {
    const run = runOf(thread);

    if (!run.queue.length || run.leaving) {
      return;
    }

    if (run.phase.is === "live" || run.phase.is === "recovering") {
      become(run, { is: "stopped" });
    }

    void launch(thread, name);
  }

  async function restart(thread: string, prompt?: string) {
    const session = current(thread);

    if (!present(session)) {
      await launch(thread, savedOf(thread).name, { prompt });

      return;
    }

    void cycle(thread, await claude.agent(session, serving), prompt);
  }

  async function refresh(thread: string, message: Message) {
    const run = runOf(thread);
    const phase = run.phase;
    const running = await claude.agent(current(thread) ?? "", serving);

    if (run.phase !== phase || phase.is !== "live") {
      forward(thread, savedOf(thread).name, message);

      return;
    }

    const working = fresh(thread)
      ? run.turn === "busy" || (running !== undefined && running.status !== "idle")
      : running?.status === "busy";

    if (working && run.queue.length === 0) {
      phase.line.send({ type: "inbound", ...message });

      return;
    }

    hold(thread, message);
    void cycle(thread, running);
  }

  async function cycle(thread: string, running?: claude.Agent, prompt?: string, quiet = false) {
    const run = runOf(thread);

    if (running) {
      await stop(thread, running);
    }

    if (run.phase.is === "live" || run.phase.is === "recovering") {
      become(run, { is: "stopped" });
    }

    void launch(thread, savedOf(thread).name, { prompt, quiet });
  }

  function welcome(thread: string, line: Line) {
    const run = runOf(thread);

    if (run.ending) {
      return;
    }

    const was = run.phase;
    const job = was.is === "launching" ? was.job : undefined;
    become(run, { is: "live", line });
    run.failing = undefined;
    run.opening = undefined;

    if (general && thread === main) {
      reached(api);
    }

    if (run.renew !== "asked") {
      run.renew = undefined;
    }

    if (!threads.has(thread)) {
      threads.set(thread, { name: thread });
    }

    const id = present(job) ? claude.record(job).sessionId : undefined;

    if (present(id)) {
      note(thread, id);
    }

    const given = waiting(thread);

    for (const message of given) {
      mark(thread, message);
      line.send({ type: "inbound", ...message });
    }

    run.handed = new Set(given.flatMap((message) => message.meta.key ?? []));
    run.queue.length = 0;
    run.awaited = run.held.length > 0;
    rest(thread);
    letGo(thread);

    if (stale(thread)) {
      run.renew = "stale";
      void renew(thread);
    }

    void (async () => {
      const running = await sessionOf(thread);

      if (running && run.phase.is === "live" && run.phase.line === line) {
        note(thread, running.sessionId);
      }
    })();

    if (was.is === "launching") {
      for (const each of retries) {
        each();
      }
    }
  }

  function note(thread: string, session: string) {
    runOf(thread).unsaved = threads.get(thread)?.session === session ? undefined : session;
    claim(thread);
  }

  function drop(thread: string, line: Line) {
    const run = runs.get(thread);

    if (run?.phase.is !== "live" || run.phase.line !== line) {
      return;
    }

    become(run, { is: "recovering" });
    setState(thread, false);

    if (run.leaving) {
      forget(thread, run.leaving);

      return;
    }

    for (const message of waiting(thread)) {
      mark(thread, message);
    }

    recover(thread);
  }

  function recover(thread: string, since = clock.now(), pid?: number) {
    const run = runOf(thread);
    const phase = run.phase;

    if (closed || phase.is === "stopped" || phase.is === "live" || phase.deadline) {
      return;
    }

    const reconnectOrRecover = async () => {
      phase.deadline = undefined;
      const starting = phase.is === "launching" && clock.now() - since < connect;

      if (starting && pid !== undefined && pid !== 0 && claude.alive(pid)) {
        recover(thread, since, pid);

        return;
      }

      const running = await sessionOf(thread);

      if (run.phase !== phase) {
        return;
      }

      if (!running) {
        gone(thread);

        return;
      }

      if ((running.startedAt ?? 0) >= since) {
        recover(thread);

        return;
      }

      if (starting) {
        recover(thread, since, running.pid);

        return;
      }

      if (claude.settingsOf(running)) {
        await respawn(thread, running);

        return;
      }

      void cycle(thread, running);
    };

    phase.deadline = clock.setTimeout(() => void reconnectOrRecover(), reconnect);
  }

  function gone(thread: string) {
    const run = runOf(thread);
    const started = run.phase.is === "launching";
    cut(thread);

    if (started) {
      fail(thread, "its session ended before its channel connected");
    } else {
      become(run, { is: "stopped" });
    }

    if (thread === main) {
      revive();
    } else if (!started && waiting(thread).length) {
      void launch(thread, threads.get(thread)?.name ?? thread);
    }
  }

  function cut(thread: string) {
    const given = new Set(kept((store) => store.cut(thread, current(thread)), []));

    if (!given.size) {
      return;
    }

    process.stderr.write(
      `hub: ${thread}'s session ended without answering ${given.size} of its messages, so the thread's next session gets them\n`,
    );

    for (const message of waiting(thread)) {
      if (given.has(message.meta.key ?? "")) {
        mark(thread, message);
      }
    }
  }

  async function respawn(thread: string, running: claude.Agent) {
    const run = runOf(thread);
    const id = running.id ?? running.sessionId.slice(0, 8);

    if (run.phase.is === "launching" && run.phase.respawned === true) {
      process.stderr.write(`hub: ${thread}'s session ${id} restarted and still has no channel\n`);

      fail(thread, "its session runs, but its channel never connects");

      return;
    }

    process.stderr.write(
      `hub: ${thread}'s session ${id} runs without its channel, so it restarts in place\n`,
    );

    if (run.phase.is === "launching") {
      run.phase.respawned = true;
    } else {
      become(run, {
        is: "launching",
        respawned: true,
        again: run.phase.is === "recovering" && run.phase.again,
      });
    }

    const phase = run.phase;
    writeSettings(thread, claude.settingsOf(running));
    await claude.respawn(running);

    if (run.phase === phase) {
      recover(thread);
    }
  }

  function claim(thread: string) {
    const run = runOf(thread);
    const known = threads.get(thread);

    if (
      !present(run.unsaved) ||
      !known ||
      !existsSync(claude.transcript(cwdOf(thread), run.unsaved))
    ) {
      return;
    }

    known.session = run.unsaved;
    delete known.from;
    run.unsaved = undefined;
    save();
  }

  function cwdOf(thread: string) {
    return threads.get(thread)?.cwd ?? hexDir;
  }

  function current(thread: string) {
    return runs.get(thread)?.unsaved ?? threads.get(thread)?.session;
  }

  function keep(thread: string) {
    const run = runOf(thread);

    if (run.renew !== "underway") {
      run.renew = undefined;
    }

    const session = current(thread);

    if (
      run.awaited !== true &&
      present(session) &&
      run.phase.is === "live" &&
      run.turn === "done" &&
      !run.handed.size &&
      warmFor(thread) === undefined &&
      !kept((store) => store.took(session), true)
    ) {
      run.renew = "underway";
      void stop(thread).then(() => cycle(thread));

      return renewal(thread).then(() => void onCall.add(run));
    }

    onCall.add(run);
    letGo(thread);

    return renewal(thread);
  }

  function renewAsked(thread: string) {
    const run = runOf(thread);

    if (run.renew !== "underway") {
      run.renew = "asked";
    }

    hangUp(run);
  }

  const serve = endpoint(
    path.slice(1),
    channel,
    token,
    server,
    {
      call: (thread, tool, toolArgs) => caller.run(thread, () => call(thread, tool, toolArgs)),
      permission: (thread, request) => permission?.(thread, request),
      open: welcome,
      close: drop,
    },
    (db ??= open(storeDir)),
    () => zoneOf(hexDir) ?? Temporal.Now.timeZoneId(),
  );

  channels.set(path, serve);

  rmSync(socketPath, { force: true });

  const sock = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf-8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;

      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);

        try {
          handle(HubRequestLine.parse(JSON.parse(raw)));
        } catch (error) {
          process.stderr.write(`hub: dropped a bad line: ${String(error)}\n`);
        }
      }
    });
    socket.on("error", ignore);
  }).listen(socketPath);

  function handle(request: HubRequest) {
    switch (request.type) {
      case "state": {
        took(request.taken, request.session);
        setState(request.thread, request.busy, request.background === true);

        if (!request.busy && request.failed !== true) {
          for (const each of answered) {
            each();
          }
        }

        return;
      }

      case "open": {
        void launch(request.thread, request.name, {
          ...(request.prompt !== undefined && { prompt: request.prompt }),
        });

        return;
      }

      case "answer": {
        questions?.answer(request.thread, request.message, request.label, request.via);

        return;
      }

      case "settle": {
        questions?.settle(request.thread, request.message, request.note);

        return;
      }

      case "reopen": {
        questions?.reopen(request.thread, request.message, request.via);

        return;
      }

      case "inbound": {
        inbound(request.thread, {
          content: request.content,
          meta: request.meta ?? {},
          ...(request.key !== undefined && { key: request.key }),
          author: request.author,
        });

        return;
      }

      case "mirror": {
        const thread = find(request.thread);

        void (async () => {
          try {
            const mirrored = await mirror(api, thread, request.to, request.where);
            process.stderr.write(`hub: mirrored ${request.thread} to ${mirrored}\n`);
          } catch (error) {
            process.stderr.write(
              `hub: couldn't mirror ${request.thread} to ${request.to}: ${String(error)}\n`,
            );
          }
        })();
      }
    }
  }

  function inbound(id: string, message: Message) {
    const thread = id.startsWith(`${app}:`) ? id.slice(app.length + 1) : id;

    const known = threads.get(thread);

    if (known) {
      return deliver(thread, known.name, message);
    }

    process.stderr.write(
      `hub: no open ${app} thread ${thread}, so a message for it from ${message.meta?.user ?? "a local tool"} was dropped\n`,
    );
  }

  function interrupt(thread: string): Promise<void> {
    const run = runOf(thread);
    run.interrupting ??= press(thread).finally(() => (run.interrupting = undefined));

    return run.interrupting;
  }

  async function press(thread: string): Promise<void> {
    const run = runOf(thread);
    const session = current(thread);

    if (!present(session) || run.turn === "background") {
      return;
    }

    const agent = await claude.listing(session);

    if (!agent) {
      return;
    }

    if (run.turn === "done" && agent.state !== "working") {
      return;
    }

    const deadline = new AbortController();

    const timer = clock.setTimeout(() => {
      deadline.abort();
    }, ESC_LANDS_WITHIN);

    const pressed = new Date().toISOString();

    let how: Awaited<ReturnType<typeof claude.interrupt>> | undefined;

    try {
      how = await claude.interrupt(
        cwdOf(thread),
        session,
        AbortSignal.any([deadline.signal, closing.signal]),
      );
    } catch (error) {
      process.stderr.write(`hub: couldn't interrupt ${thread}'s turn: ${String(error)}\n`);
    } finally {
      clock.clearTimeout(timer);
    }

    if (closing.signal.aborted || current(thread) !== session) {
      return;
    }

    if (how === "interrupted") {
      kept((store) => {
        store.handled(session, pressed);
      }, undefined);
      setState(thread, false, true);

      if (
        (await claude.listing(session))?.state !== "working" &&
        runOf(thread).turn === "background"
      ) {
        setState(thread, false);
      }

      return;
    }

    process.stderr.write(`hub: Esc didn't interrupt ${thread}'s turn\n`);
  }

  function halt(thread: string) {
    const run = runs.get(thread);

    if (run?.failing) {
      run.failing.retried = true;
    }

    if (run?.opening) {
      run.opening = present(run.opening.fork) ? { fork: run.opening.fork } : undefined;
    }

    return stop(thread);
  }

  function revive() {
    if (!present(main) || closed || runOf(main).phase.is === "live") {
      return;
    }

    rename(main, mainName);
    void launch(main, mainName, { again: true });
  }

  if (present(main) || threads.size > 0) {
    void (async () => {
      const running = await claude.agents(serving);

      const outlived = new Set(
        [...threads.keys()].filter((thread) =>
          running.some((agent) => agent.sessionId === current(thread) || boundTo(agent) === thread),
        ),
      );

      const cutShort = [...threads.keys()].filter(
        (thread) => !outlived.has(thread) && kept((store) => store.midTurn(thread), false),
      );

      for (const thread of [...outlived, ...cutShort]) {
        const run = runOf(thread);

        if (run.phase.is !== "stopped") {
          continue;
        }

        become(run, { is: "recovering" });
        recover(thread);
      }

      if (present(main) && !(fresh(main) && outlived.has(main)) && !cutShort.includes(main)) {
        revive();
      }

      wake();
    })();
  }

  const unwatch = kept((store) => store.watch(wake), ignore);
  const unschedule = general && present(main) ? schedule(storeDir, hexDir, main) : ignore;
  const unhold = general && present(main) ? holding(storeDir) : ignore;
  const retryCompactions = () => void recompact();

  const api = {
    deliver,
    sent,
    said: (key: string) => kept((store) => store.latest(`${app}:${key}`), null),
    command: restart,
    configure,
    settings: (thread: string): Settings => ({
      model: threads.get(thread)?.model,
      effort: threads.get(thread)?.effort,
    }),
    register: (thread: string, name: string, cwd?: string) => void register(thread, name, cwd),
    open: (thread: string, name: string, prompt?: string, cwd?: string) =>
      void launch(thread, name, { prompt, cwd }),
    fork: (thread: string, name: string, session: string, prompt: string, cwd?: string) =>
      void launch(thread, name, { prompt, fork: session, cwd }),
    main,
    renewal,
    keep,
    renew: renewAsked,
    session: current,
    turned: (thread: string) => {
      const session = current(thread);

      if (present(session)) {
        queue(storeDir, { session, by: new Date().toISOString(), thread });
      }
    },
    running: sessionOf,
    threads: () => [...threads.keys()],
    save,
    name: (thread: string) => threads.get(thread)?.name,
    cwd: (thread: string) => threads.get(thread)?.cwd,
    stop: halt,
    interrupt,
    answer: (thread: string, request_id: string, behavior: "allow" | "deny") => {
      const { phase } = runOf(thread);

      if (phase.is === "live") {
        phase.line.send({ type: "permission", request_id, behavior });
      }
    },
    release,
    adopt,
    follow,
    history: (thread: string) => kept((store) => history(store, thread, current(thread)), []),
    retire,
    find,
    rename,
    close: () => {
      closed = true;
      unwatch();
      unschedule();
      unhold();
      retries.delete(retry);
      answered.delete(retryCompactions);

      if (generalHub === api) {
        generalHub = undefined;
      }

      sock.close();

      if (channels.get(path) === serve) {
        channels.delete(path);
      }

      closing.abort();

      for (const run of runs.values()) {
        become(run, { is: "stopped" });
        clock.clearTimeout(run.rest);
        hangUp(run);
      }
    },
  };

  retries.add(retry);
  answered.add(retryCompactions);

  if (general && present(main)) {
    generalHub = api;
  }

  return api;
}

function client(app: string) {
  const there = clients.get(app);

  if (!there) {
    throw new Error(
      `${app} isn't connected${clients.size ? `; threads open in ${[...clients.keys()].join(", ")}` : ""}`,
    );
  }

  return there;
}

export async function begin(
  app: string,
  name: string,
  first: string | Message,
  { about, where, cwd }: { about?: string; where?: string; cwd?: string } = {},
) {
  const there = client(app);
  const opened = await there.place(name, where, about);

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- first is TypeScript's own union of a prompt and a message, not unparsed input
  if (typeof first === "string") {
    there.hub.open(opened.thread, name, first, cwd);
  } else {
    there.hub.register(opened.thread, name, cwd);
    there.hub.deliver(opened.thread, name, first);
  }

  return opened;
}

async function carry(from: Hub, thread: string, to: string, name: string, where?: string) {
  const target = client(to);
  const session = from.session(thread);

  if (!present(session)) {
    throw new Error("this thread has no session yet");
  }

  const cwd = from.cwd(thread);
  const { thread: dest, link } = await target.place(name, where, undefined, cwd);

  const filled = (async () => {
    try {
      await target.backfill?.(dest, from.history(thread));
    } catch (error) {
      process.stderr.write(`hub: couldn't backfill ${to} thread ${dest}: ${String(error)}\n`);
    }
  })();

  return { target, session, dest, link, filled, cwd };
}

export async function move(
  from: Hub,
  thread: string,
  to: string,
  name: string,
  where?: string,
  copy = thread === from.main,
) {
  const { target, session, dest, link, filled, cwd } = await carry(from, thread, to, name, where);

  const prompt =
    target.waits === true
      ? undefined
      : `This conversation just moved to ${to}, into the thread "${name}". Your ${to} tools now post there. Carry on where you left off.`;

  if (copy) {
    void (async () => {
      await filled;

      if (prompt === undefined) {
        target.hub.follow(dest, name, session, cwd);
      } else {
        target.hub.fork(dest, name, session, prompt, cwd);
      }
    })();
  } else {
    void (async () => {
      const [released] = await Promise.all([from.release(thread), filled]);
      target.hub.adopt(dest, name, released, prompt, cwd);
    })();
  }

  return link;
}

export async function mirror(from: Hub, thread: string, to: string, where?: string) {
  const name = from.name(thread) ?? thread;
  const { target, session, dest, link, filled, cwd } = await carry(from, thread, to, name, where);
  target.hub.follow(dest, name, session, cwd);
  await filled;

  return link;
}
