import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import { basename, join } from "node:path";

import { z } from "zod";

import {
  besideOf,
  besideWhat,
  jobOf,
  lastWords,
  prompt as besidePrompt,
  run as runBeside,
} from "./beside.ts";
import * as claude from "./claude.ts";
import { clock } from "./clock.ts";
import type { Timer } from "./clock.ts";
import { failedStarts } from "./failing.ts";
import type { Failed } from "./failing.ts";
import { sessionFiles } from "./files.ts";
import { holding } from "./holds.ts";
import { keeping, landed, OwedRow } from "./kept.ts";
import type { Owing } from "./kept.ts";
import { STARTUP } from "./loaded.ts";
import { endpoint } from "./mcp.ts";
import type { ChannelServer, Line, Permission, ToolArguments } from "./mcp.ts";
import { PASS, queue } from "./observe.ts";
import { ordered } from "./ordered.ts";
import { sessionPauses } from "./pauses.ts";
import { fileOnly, held as filesIn, pictureOf, pictures, widthOverHeightOf } from "./pictures.ts";
import { present } from "./present.ts";
import { restarts } from "./restarts.ts";
import { live } from "./running.ts";
import type { Session } from "./running.ts";
import { threadRuns } from "./runs.ts";
import { schedule } from "./schedule.ts";
import { threadSessions } from "./sessions.ts";
import { sessionStarts } from "./start.ts";
import { sessionStops } from "./stops.ts";
import { asked, isAuthor, open, replied, shown, spoken, stateDir as storeOf } from "./store.ts";
import type { Author, MessageId, NewRow, Row, Store, Told } from "./store.ts";
import { openThreads } from "./threads.ts";
import { wentThrough, whenThrough } from "./through.ts";
import { sessionTurns } from "./turns.ts";
import { messagesWaiting, toMessageWithKeyFirstForTheHook } from "./waiting.ts";
import type { Message, Waits } from "./waiting.ts";
import { zoneOf } from "./zone.ts";

export { dispatch, tool } from "./mcp.ts";

export type { ChannelServer, Handlers, Permission, Tool, ToolArguments } from "./mcp.ts";

export type { Failed } from "./failing.ts";

export type { Message, Waits } from "./waiting.ts";

export type Call = (thread: string, tool: string, args: ToolArguments) => Promise<string>;

export type State = (thread: string, busy: boolean, background: boolean) => void;

export type Settings = { model?: string | undefined; effort?: string | undefined };

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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What another process (the voice app, hex's check) can do with a question the client asked with buttons: answer it for the owner, settle it as no longer asked, or take an answer back.
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
    error: z.string().optional(),
    said: z.string().optional(),
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
  z.object({ type: z.literal("tookHeld"), thread: z.string(), keys: z.array(z.string()) }),
  z.object({
    type: z.literal("owed"),
    thread: z.string(),
    said: z
      .array(
        z.object({
          row: OwedRow,
          by: z.string(),
        }),
      )
      .optional(),
    pass: PASS.optional(),
  }),
]);

type HubRequest = z.output<typeof HubRequestLine>;

export type HubLine = z.input<typeof HubRequestLine>;

export type Hub = Awaited<ReturnType<typeof startHub>>;

// idleStop: how long a quiet session stays warm before it stops. cacheWarm: how long the main thread rests before it compacts, while its cache is still warm. Both sit just inside Claude Code's one-hour prompt cache, so coming back within the hour costs no new cache write. compactAbove: the context above which a session compacts before it rests. reconnect: how long a running session's channel may be gone before the session restarts to get it back. connect: how long a starting session waits for the hub to answer its channel, where Claude Code would give up after 30 seconds for good, so a hub running behind still gets its sessions' channels. Claude Code waits that long for each of a session's MCP servers, but a background session doesn't hold its turn for them. capacity: how much context a fresh thread's session holds before a new one takes over; with 0, every message that finds it done goes to a new one, and HEX_CHAT_CAPACITY changes it. handoffAbove: the context above which a thread whose session's cache has expired starts a new session that takes over from it, instead of resuming it and writing that whole context to the cache again: a new session starts at about 50k and reads back what it needs, so a smaller one costs more to replace than to resume. HEX_HANDOFF_ABOVE changes it. (see https://docs.claude.com/en/docs/build-with-claude/prompt-caching and https://code.claude.com/docs/en/mcp)
export type Limits = {
  idleStop: number;
  cacheWarm: number;
  compactAbove: number;
  reconnect: number;
  connect: number;
  capacity: number;
  handoffAbove: number;
};

type Run = {
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // asked: the session asked to start over (a call ended). stale: it started with what the hub no longer gives a session. underway: it's starting over, and its renewal waits for the new session.
  renew?: "asked" | "stale" | "underway" | undefined;
  rest?: Timer | undefined;
  leaving?: ((session: string) => void) | undefined;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The owner's Stop pressing Esc in the session, until the transcript shows it landed.
  interrupting?: Promise<void> | undefined;
  held: (() => void)[];
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A call waited for the session now connected to start, so it is as new as the call.
  awaited?: boolean | undefined;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // When the hub last had the session compact, until its context is back under compactAbove.
  compacting?: number | undefined;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Its last turn failed on the API, until a turn begins or goes through. waiting: the error clears without a word to this thread (a rate limit, a dropped connection, a login that works again), so it carries on at the next turn anywhere that goes through; resumed: the hub had it carry on, once; told: its chat heard it waits for its next message.
  stalled?: "waiting" | "resumed" | "told" | undefined;
};

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A call on a line a client holds, like a Discord voice channel: the line plays the voice's audio and ends when the call does, and the call engine hears the caller and can be hung up on. Audio is base64 PCM at 24 kHz, mono.
export type VoiceLine = { play: (audio: string) => void; end: () => void };

export type Held = { hear: (audio: string) => void; hangUp: () => void };

export type CallEngine = {
  take?: (from: "discord", greeting: string, line: VoiceLine) => Held;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A stop freezes the sessions on this machine while a live call still holds the hub, so the caller is told nothing can answer here.
  stops?: () => void;
};

export const engine: CallEngine = {};

export type Turn = {
  from: "me" | "hex";
  text: string;
  // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- hex voice reads a picture's width over height by this name
  media?: { id: string; kind: string; file?: string; shape?: number }[];
};

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Every client running in this process, so a thread can move between them. place() opens a thread on the client, led by its about line if given, for a session working in cwd, and returns its id and a link to it. backfill() posts a thread's chat so far into a thread it placed, in order.
export type Client = {
  hub: Hub;
  place: (
    name: string,
    where?: string,
    about?: string,
    cwd?: string,
  ) => Promise<{ thread: string; link: string }>;
  backfill?: (thread: string, turns: Turn[]) => Promise<void>;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The client shows only the turns its own messages start, so a session moved there waits for one.
  waits?: boolean;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // What the client does as the hub stops, once no call is live.
  close?: () => Promise<void>;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A stop hands the owner's messages to the hub that runs next, maybe on the cloud twin, so the client stops taking them in at once, while a live call still holds this hub.
  deafen?: () => Promise<void>;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The owner's stop as the client's own Stop does it, when it keeps state of its own about a turn.
  stop?: (thread: string) => void;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A local copy of a file the app holds by its own id, such as one a message carried.
  file?: (id: string) => Promise<string>;
};

class Clients extends Map<string, Client> {
  private readonly awaited = new Map<string, (() => void)[]>();

  override set(app: string, joining: Client) {
    super.set(app, joining);
    this.awaited.get(app)?.forEach((tell) => {
      tell();
    });
    this.awaited.delete(app);

    return this;
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Once the app's client runs in this process, for a channel that shows another's threads: the channels load in no order.
  joined(app: string): Promise<void> {
    return this.has(app)
      ? Promise.resolve()
      : new Promise((resolve) => {
          this.awaited.set(app, [...(this.awaited.get(app) ?? []), resolve]);
        });
  }
}

export const clients = new Clients();

let generalHub: Hub | undefined;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Claude Code's StopFailure errors that clear on their own, or once an account has room or the login works again; a refused connection reaches the hook as server_error.
const PASSING_API_ERRORS = new Set([
  "rate_limit",
  "overloaded",
  "server_error",
  "billing_error",
  "authentication_failed",
]);

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Resolves with the hub serving General once General's session first connects to it: from then on, hex works on the code this process runs.
let reached: (hub: Hub) => void;

export const up = new Promise<Hub>((resolve) => {
  reached = resolve;
});

export const PORT = Number(process.env.HEX_PORT ?? 8789);

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Each hub's channel under its plugin's name, behind the one HTTP listener serve.ts opens.
const channels = new Map<string, (request: Request) => Promise<Response>>();

export function route(request: Request): Promise<Response> {
  return (
    channels.get(new URL(request.url).pathname)?.(request) ??
    Promise.resolve(new Response("Not Found", { status: 404 }))
  );
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// serve.ts's listener. A hub a stop left running holds the port until it has finished its call and exited, so the next one waits for the port instead of failing to start, which bin/hex would count against the commit. It tries each second, since nothing says the port is free: a connection to the old hub that hasn't sent anything is never accepted, so it can stay open after the hub exits.
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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Chat apps only link web addresses, so a buzz:// link goes through a page on hex's site that opens it.
export function tappable(text: string): string {
  return text.replaceAll(
    /buzz:\/\/[^\s)>\]\\]*[^\s)>\]\\.,;:!?'"]/gu,
    (url) => `https://hex-sand.vercel.app/open.html#${encodeURIComponent(url)}`,
  );
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A thread's chat, oldest first: what the owner said that a session took in, and hex's replies as first sent; with a session, from the first message that session took, the conversation it has.
export async function history(store: Store, thread: string, session?: string): Promise<Turn[]> {
  const rows = await store.messages.said(thread);
  const start = present(session) ? (rows.find((row) => row.taken?.by === session)?.at ?? "9") : "";

  return rows.flatMap((row): Turn[] => {
    if (row.from === "terminal" || !row.taken || row.at < start) {
      return [];
    }

    const sent = pictures(row);
    const words = sent.length > 0 && fileOnly(row) ? "" : row.body;

    if (replied(row)) {
      return shown(row)
        ? [{ from: "hex", text: words, ...(sent.length > 0 && { media: sent }) }]
        : [];
    }

    const media = carried(row.meta) ?? (sent.length > 0 ? sent : undefined);

    if (!spoken(row) || row.author !== "owner") {
      return [];
    }

    const text = row.from === "t3" ? asked(row.body) : media === sent ? words : row.body;

    return text !== "" || media !== undefined
      ? [{ from: "me", text, ...(media && { media }) }]
      : [];
  });
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The hex app's photos and clips a message carried, listed in its meta as "<kind> <id>; ...", with their files, where kept, in the same order in "files".
export function carried(meta?: Record<string, string>): Turn["media"] {
  const files = meta?.files?.split("; ") ?? [];

  return meta?.media?.split("; ").map((entry, i) => {
    const [kind = "", id = ""] = entry.split(" ");
    const file = files[i];
    const widthOverHeight = kind === "photo" ? widthOverHeightOf(file) : undefined;

    return {
      id,
      kind,
      ...(present(file) && { file }),
      ...(widthOverHeight !== undefined &&
        widthOverHeight > 0 && {
          // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- hex voice reads a picture's width over height by this name
          shape: widthOverHeight,
        }),
    };
  });
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Where a file a chat message holds is on disk, fetched from its app when only the app keeps it.
export async function heldFile(store: Store, key: string, at: number) {
  const row = await store.messages.get(key);
  const kept = row ? filesIn(row)[at] : undefined;

  if (!kept || !row) {
    return;
  }

  const path = kept.path ?? (await clients.get(row.from)?.file?.(kept.telegram ?? ""));

  return present(path) ? { path, type: kept.type ?? "application/octet-stream" } : undefined;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The file of a picture history() named, or undefined when the id names none.
export async function sentPicture(store: Store, id: string) {
  const picture = pictureOf(id);

  return picture && (await heldFile(store, picture.key, picture.at));
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A message's words without the line it ends with for each photo or clip it carried.
export function typed(body: string, items: number) {
  return items ? body.split("\n").slice(0, -items).join("\n") : body;
}

const Transcript = z.object({ text: z.string().optional() });

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// TRANSCRIBE_URL is any OpenAI-compatible /audio/transcriptions endpoint.
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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Claude Code shows nothing when Esc meets a turn with nothing left to interrupt, so a press gets this long to show in the transcript; a real one shows in under a second.
const ESC_LANDS_WITHIN = 5000;

// Claude Code keeps a conversation in the prompt cache for an hour after its last request, and compacts a background session only when told to. It retries a dropped HTTP server at about 0, 1, 3, 7 and 15 seconds, then gives up for good. https://docs.claude.com/en/docs/build-with-claude/prompt-caching
const LIMITS: Limits = {
  idleStop: 54 * 60_000,
  cacheWarm: 54 * 60_000,
  compactAbove: 150_000,
  reconnect: 20_000,
  connect: 300_000,
  capacity: tokensFrom("HEX_CHAT_CAPACITY", 350_000),
  handoffAbove: tokensFrom("HEX_HANDOFF_ABOVE", 80_000),
};

function tokensFrom(name: string, fallback: number) {
  const tokens = process.env[name];

  if (!present(tokens)) {
    return fallback;
  }

  if (!/^\d+$/u.test(tokens)) {
    throw new Error(`${name} must be a number of tokens, got "${tokens}"`);
  }

  return Number(tokens);
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A voice call runs in this process (its call engine holds the caller's audio), so a restart waits for every thread on a call to hang up. A call whose engine has lost its link to it runs nothing here, and the next hub's engine picks it back up, so a restart doesn't wait on it.
const onCall = new Set<Run>();
const adrift = new Set<Run>();
const hungUp: (() => void)[] = [];

export function free(): Promise<void> {
  return new Promise((resolve) => {
    hungUp.push(resolve);
    settle();
  });
}

function settle() {
  if ([...onCall].every((run) => adrift.has(run))) {
    for (const resolve of hungUp.splice(0)) {
      resolve();
    }
  }
}

function hangUp(run: Run) {
  onCall.delete(run);
  adrift.delete(run);
  settle();
}

export function title(text: string): string {
  const word = text.trim();

  if (!/^[^\s_-]+$/u.test(word)) {
    throw new Error(`title must be one word, got "${word}"`);
  }

  return word;
}

function startupFiles(hex: string | undefined) {
  return hex === undefined || hex === ""
    ? []
    : Object.values(STARTUP)
        .flat()
        .map((path) => join(hex, path));
}

const ignore = (): void => undefined;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What a session's hooks couldn't keep while hex's store didn't answer, which the hub keeps once it does.
function owedByHooks(
  owing: Owing,
  { said = [], pass: turn }: Extract<HubRequest, { type: "owed" }>,
) {
  for (const { row, by } of said) {
    owing.owe({ kind: "deliver", row, by });
  }

  if (turn) {
    owing.owe({ kind: "pass", pass: turn });
  }
}

export async function startHub({
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
  journal,
}: {
  stateDir: string;
  storeDir?: string | undefined;
  channel: string;
  server: ChannelServer;
  port?: number | undefined;
  main?: string | undefined;
  mainName?: string | undefined;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The main thread is hex's General: its settings env says HEX_MAIN, and the hub runs schedules.json.
  general?: boolean | undefined;
  call: Call;
  state: State;
  failed: Failed;
  waits?: Waits | undefined;
  permission?: ((thread: string, request: Permission) => void) | undefined;
  questions?: Questions | undefined;
  args?: ((thread: string) => string[]) | undefined;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A fresh thread's session is never compacted: its launcher builds what a new session knows of the chat, and a new one takes over once the old one's context or cache is spent.
  fresh?: ((thread: string) => boolean) | undefined;
  limits?: Partial<Limits> | undefined;
  hexDir?: string | undefined;
  launcher?: string | undefined;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // What the launcher's sessions read only as they start (STARTUP, in the hex folder HEX_STARTUP names): a change to one renews sessions like a change to the channel does.
  startup?: string[] | undefined;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Where the app opens a thread, which hex.db keeps with it.
  link?: ((thread: string) => string | undefined) | undefined;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The systemd journal General follows for units that keep restarting; a hub without one follows none.
  journal?: (() => string[]) | undefined;
}) {
  const { idleStop, cacheWarm, compactAbove, reconnect, connect, capacity, handoffAbove } = {
    ...LIMITS,
    ...limits,
  };

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The session that made the tool call in progress.
  const caller = new AsyncLocalStorage<string | undefined>();
  const socketPath = join(stateDir, "hub.sock");
  const runs = threadRuns();
  const generalThread = general && present(main) ? main : undefined;
  const plugin = channel.replace(/^plugin:/u, "");
  const path = `/${plugin.split("@")[0]}`;
  const app = path.slice(1);
  let started = false;

  const owing = keeping(storeDir, {
    spool: join(stateDir, `owed.${app}.json`),
    letGo: (thread, rows) => {
      if (started) {
        heldLetGo(thread, rows);
      }
    },
    queue: (turn) => queue(storeDir, turn),
  });

  const { kept, must } = owing;
  const threads = await openThreads({ app, storeDir, owing, hexDir, link });
  started = true;
  const turns = sessionTurns({ overdue: (thread) => void letHeldGo(thread) });
  const waiting = messagesWaiting({ runs, kept, waits });

  const files = sessionFiles({
    stateDir,
    channel,
    plugin,
    socketPath,
    port,
    storeDir,
    connect,
    generalThread,
    fresh,
  });

  const starts = sessionStarts({
    threads,
    files,
    kept,
    launcher,
    channel,
    server,
    startup,
    args,
    handoffAbove,
    fresh,
  });

  let closed = false;
  const closing = new AbortController();
  const serving = () => !closed;
  const zone = () => zoneOf(hexDir) ?? Temporal.Now.timeZoneId();

  const stops = sessionStops({ runs, threads, kept, serving, stopping });

  const failing = failedStarts({
    runs,
    threads,
    waiting,
    kept,
    app,
    main,
    generalThread,
    generalHubMain: () => generalHub?.main,
    failed,
  });

  const pauses = sessionPauses({ runs, threads, waiting, turns, kept, serving, turnEnded, failed });

  const sessions = threadSessions({
    runs,
    threads,
    waiting,
    files,
    starts,
    stops,
    failing,
    pauses,
    kept,
    serving,
    channel,
    main,
    mainName,
    fresh,
    connect,
    reconnect,
    turnBegan,
    turnEnded,
    startFailed,
  });

  const hubRuns = runs.part((): Run => ({ held: [] }));
  const runOf = hubRuns.of;

  function turnBegan(thread: string) {
    state(thread, true, false);
    threads.claim(thread);
    turns.began(thread);
    rest(thread);
    letGo(thread);
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A held message let go can start a session, and with it a turn, so what follows reads the turn as it is then.
  async function turnEnded(thread: string, background = false) {
    const run = runOf(thread);
    state(thread, false, background);
    threads.claim(thread);
    turns.ended(thread, background);
    await letHeldGo(thread);

    if (turns.of(thread).is === "done" && (run.renew === "asked" || run.renew === "stale")) {
      void renew(thread, run.renew === "asked");
    }

    rest(thread, turns.of(thread).is === "done");
    letGo(thread);
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A thread renews at its next rest: the main thread and a fresh thread start over as soon as the process exits, any other when its next message resumes it. A keep (a call started) cancels it. When the session asked for it, a rest the Stop hook reported with no agents working is taken as it is: Claude's own status lags the hook and counts a running shell as busy, so checking it could put the renew off for good, and a session that asked is done with what its shells were for.
  async function renew(thread: string, rested = false) {
    const run = runOf(thread);
    const turn = turns.of(thread);
    const session = threads.current(thread);

    if (!present(session)) {
      return;
    }

    const running = await claude.agent(session, serving);

    if (
      !(run.renew === "asked" || run.renew === "stale") ||
      turn.is === "busy" ||
      turn.untaken === true ||
      onCall.has(run) ||
      (!rested && running?.status === "busy")
    ) {
      return;
    }

    run.renew = running && (thread === main || fresh(thread)) ? "underway" : undefined;

    if (run.renew) {
      void sessions.cycle(thread, running);
    } else {
      void stops.stop(thread);
    }

    letGo(thread);
  }

  function startFailed(thread: string) {
    const run = runOf(thread);

    if (run.renew === "underway") {
      run.renew = undefined;
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A renew is on its way while the thread's session winds down its turn or restarts, but not while it waits on background agents, which can take as long as they like.
  function pending(thread: string) {
    const run = runOf(thread);

    return run.renew === "underway" || (!!run.renew && turns.of(thread).is !== "background");
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Resolves once the thread's renew is through (its new session connected) or off, right away when none is on its way, so a voice call can wait for the new session.
  function renewal(thread: string): Promise<void> {
    const run = runOf(thread);

    if (!pending(thread)) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      run.held.push(resolve);
    });
  }

  function letGo(thread: string) {
    const run = runOf(thread);

    if (pending(thread)) {
      return;
    }

    for (const resolve of run.held.splice(0)) {
      resolve();
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A running session that isn't busy stops after a while; its next message resumes it. The main thread keeps running, and compacts before its cache goes cold.
  function rest(thread: string, rested = false) {
    const run = runOf(thread);
    const standing = sessions.of(thread);
    clock.clearTimeout(run.rest);
    run.rest = undefined;

    if (turns.of(thread).is === "busy" || standing.phase.is !== "live") {
      return;
    }

    if (thread === main) {
      run.rest = clock.setTimeout(() => void stopIfIdle(thread), cacheWarm);
    } else if (run.leaving) {
      void stops.stop(thread);
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

  // A fresh thread keeps one session running, which takes its messages while its context has room and its cache is warm. Once either is spent, a new session built from the chat takes over at the old one's rest, so the next message finds it running: after the cache expires, the old session would send its whole context uncached, and a new one costs no more. warmFor is how long a session stays worth its messages, undefined before its first request: cacheWarm of an hour's cache, or as much of a shorter one (claude.cacheLife). https://docs.claude.com/en/docs/build-with-claude/prompt-caching
  function warmFor(thread: string) {
    const session = threads.current(thread);

    const {
      sent: context,
      at,
      short,
    } = present(session) ? claude.usage(threads.cwd(thread), session) : { sent: 0 };

    if (!context) {
      return;
    }

    const keepsWarm = (cacheWarm * claude.cacheLife(short)) / claude.cacheLife();

    return context >= capacity ? 0 : Math.max(0, (at ?? clock.now()) + keepsWarm - clock.now());
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A session on a call takes every message of the call, so a call never changes sessions midway.
  function spent(thread: string) {
    return fresh(thread) && !onCall.has(runOf(thread)) && warmFor(thread) === 0;
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // At a rest the Stop hook reported with no agents working, Claude's own status still says busy for about a second, so a session that filled up on that turn hands over without asking it.
  async function handOff(thread: string, rested = false) {
    const run = runOf(thread);
    const turn = turns.of(thread);
    run.rest = undefined;
    const running = await claude.agent(threads.current(thread) ?? "", serving);

    if (running && turn.is !== "busy" && (rested || running.status === "idle") && spent(thread)) {
      void sessions.cycle(thread, running);
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The Stop hook ends a turn, but background tasks keep a session busy past it, so Claude's own status decides; a busy session reports idle again when it's done. A big conversation compacts first, while its cache is warm: resumed after the cache expires, it would be written to the cache whole again.
  async function stopIfIdle(thread: string) {
    const run = runOf(thread);
    const turn = turns.of(thread);
    const pause = pauses.of(thread);
    run.rest = undefined;
    const session = threads.current(thread);

    if (!present(session)) {
      return;
    }

    const running = await claude.agent(session, serving);

    if (turn.is === "busy" || running?.status === "busy" || pause.paused === true) {
      return;
    }

    const { sent: context, failed: failedAt } = claude.usage(threads.cwd(thread), session);

    if (running && !run.leaving && !fresh(thread) && !onCall.has(run) && context > compactAbove) {
      if (failedAt === undefined) {
        compact(thread, running);

        return;
      }

      run.compacting ??= failedAt;
    }

    if (thread !== main) {
      void stops.stop(thread);
    }
  }

  function compact(thread: string, running?: claude.Agent) {
    runOf(thread).compacting = clock.now();
    void sessions.cycle(thread, running, "/compact", true);
  }

  async function recompact() {
    for (const [thread, run] of hubRuns.all()) {
      const session = threads.current(thread);

      if (run.compacting === undefined || !present(session)) {
        continue;
      }

      const { sent: context, failed: failedAt } = claude.usage(threads.cwd(thread), session);

      if (context <= compactAbove) {
        run.compacting = undefined;
        continue;
      }

      const standing = sessions.of(thread);
      const resting = standing.phase.is === "live" || standing.phase.is === "stopped";

      if (
        failedAt === undefined ||
        failedAt < run.compacting ||
        !resting ||
        turns.of(thread).is === "busy" ||
        stops.ending(thread) ||
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

  function stopping(thread: string) {
    const run = runOf(thread);
    clock.clearTimeout(run.rest);
    run.rest = undefined;
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Resolves with the thread's session once it has stopped and the thread is forgotten, in hex.db too.
  function retire(thread: string): Promise<string> {
    if (thread === main) {
      throw new Error("the main thread stays open");
    }

    return new Promise((resolve) => {
      runOf(thread).leaving = resolve;

      if (sessions.of(thread).phase.is !== "live") {
        forget(thread, resolve);

        return;
      }

      void stopIfIdle(thread);
    });
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Like retire, for a thread whose session another client resumes.
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
    const session = threads.close(thread);
    sessions.end(thread);
    clock.clearTimeout(run.rest);
    runs.forget(thread);
    turns.forget(thread);
    files.forget(thread);
    void (async () => {
      await threads.save();
      leaving(session);
    })();
  }

  function adopt(thread: string, name: string, session: string, prompt?: string, cwd?: string) {
    threads.open(thread, { name, session, ...(present(cwd) && { cwd }) });

    if (present(prompt)) {
      sessions.launch(thread, name, { prompt });
    }
  }

  function configure(thread: string, settings: Settings) {
    const { model, effort } = { ...threads.of(thread), ...settings };

    threads.update(thread, {
      model: present(model) ? model : undefined,
      effort: present(effort) ? effort : undefined,
    });
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Each thread's deliveries pass their messages on one at a time, in the order they came, whichever the store answers first.
  const delivering = ordered();

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A message is kept before anything else happens to it, so once this resolves the app can be told it arrived: a crash from then on leaves it with hex, for whichever session serves the thread next. A key kept already is the app sending it again. along: the change to hex's records the message tells of, like the answer a tap gives, kept in the same write (questions.told); when it changes nothing, or the store can't take it, there's nothing to tell. Whether the thread is told.
  async function deliver(
    thread: string,
    name: string,
    message: Message,
    along?: Told,
  ): Promise<boolean> {
    const { author } = message;

    if (!author) {
      throw new Error(`a message to ${thread} has no author`);
    }

    const key = `${app}:${message.key ?? randomUUID()}`;
    const { content, meta } = message;

    const row: NewRow = { key, to: thread, from: app, author, body: content, meta };

    const adding = along
      ? must({ kind: "told", app, thread, change: along, row }, false)
      : must({ kind: "deliver", row }, undefined);

    return await delivering(thread, async () => {
      const added = await adding;

      if (added === false || owing.lost()) {
        return false;
      }

      // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
      // A call that failed may still have landed, so the message keeps its key, which keeps a look that finds it from passing it on again, and the queue keeps it for the next session in case it didn't.
      if (added === undefined) {
        waiting.notKept(key);
      }

      pass(thread, name, { content, author, meta: { key, ...meta } });

      return true;
    });
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // What hex said in a thread, kept as its session sent it: a reply, a post, a failed send with meta.failed. The session that wrote it has it already, so it wakes nothing.
  async function sent(
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

    const by = caller.getStore() ?? threads.current(thread) ?? "hub";
    await must({ kind: "deliver", row, by }, false);
  }

  function pass(thread: string, name: string, message: Message) {
    if (waiting.pass(thread, message)) {
      forward(thread, name, message);
    }
  }

  function forward(thread: string, name: string, message: Message, released = false) {
    const ending = stops.ending(thread);

    if (ending) {
      waiting.hold(thread, message);
      void (async () => {
        await ending;
        resume(thread);
      })();

      return;
    }

    const standing = sessions.of(thread);

    if (standing.phase.is === "live") {
      if (
        pauses.of(thread).paused === true ||
        (starts.stale(thread) && !onCall.has(runOf(thread))) ||
        spent(thread)
      ) {
        void refresh(thread, message);
      } else {
        handInOrHold(thread, name, standing.phase.line, message, released);
      }

      return;
    }

    waiting.hold(thread, message);
    sessions.waitedOn(thread);
    sessions.launch(thread, name);
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Claude Code labels a channel message that comes mid-turn as not from its user, so the owner's words wait for the session's next tool call, where hub/held.ts gives them as hook feedback, which Claude Code treats as the user's; the turn's end sends any still waiting (letHeldGo), and a message that comes while it does goes after them. A turn counts from the message that starts it, not from its hook's report. The hold is asked of the store as the turn is read, so a turn's end after it lets it go; one the store doesn't hold goes to the session after all, or on again when that session's line is gone by then. A session that just connected takes nothing new until it's given what waited (waiting.catchUp).
  function handInOrHold(
    thread: string,
    name: string,
    line: Line,
    message: Message,
    released = false,
  ) {
    const { key } = message.meta;
    const session = threads.current(thread);
    const letting = releasing.get(thread);

    if (waiting.catchingUp(thread, line)) {
      waiting.hold(thread, message);

      return;
    }

    if (letting && !released) {
      void (async () => {
        await letting;
        forward(thread, name, message);
      })();

      return;
    }

    if (!turns.active(thread) || message.author !== "owner" || !present(key) || !present(session)) {
      turns.handIn(thread, line, message);

      return;
    }

    void (async () => {
      if (await kept((store) => store.messages.hold(key, session), false)) {
        heldHere.set(thread, [...(heldHere.get(thread) ?? []), message]);

        return;
      }

      const { phase } = sessions.of(thread);

      if (phase.is === "live" && phase.line === line) {
        turns.handIn(thread, line, message);
      } else {
        forward(thread, name, message);
      }
    })();
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Each thread's latest letting go of what was held for its turn, until what it let go has gone on.
  const releasing = new Map<string, Promise<unknown>>();

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The owner's words this hub had the store hold for a turn, so a turn that ends while the store can't let them go still gives them first, from memory (goneOnFromMemory), before anything that came after them.
  const heldHere = new Map<string, Message[]>();
  const goneOnFromMemory = new Set<string>();

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // What a turn's end let go goes on: as it ends, or once the store answers again when it ended in an outage, less what went on from memory meanwhile.
  function heldLetGo(thread: string, rows: Row[]) {
    const name = threads.get(thread)?.name;

    for (const row of rows) {
      if (!goneOnFromMemory.delete(row.key) && name !== undefined) {
        forward(thread, name, toMessageWithKeyFirstForTheHook(row), true);
      }
    }
  }

  async function letHeldGo(thread: string) {
    const { promise, resolve } = Promise.withResolvers();
    releasing.set(thread, promise);
    const remembered = heldHere.get(thread) ?? [];
    heldHere.delete(thread);

    try {
      await must({ kind: "letHeldGo", thread }, false);
      const name = threads.get(thread)?.name;

      if (owing.owes({ kind: "letHeldGo", thread }) && name !== undefined) {
        for (const message of remembered) {
          goneOnFromMemory.add(message.meta.key ?? "");
          forward(thread, name, message, true);
        }
      }
    } finally {
      if (releasing.get(thread) === promise) {
        releasing.delete(thread);
      }

      resolve(undefined);
    }
  }

  let waking: Promise<void> | undefined;
  let rang = false;

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Messages kept outside this hub reach its threads as the bell rings, and at its start so do any that no session took before the hub stopped. One look at the store at a time, and one more after it when the bell rang meanwhile, so an older look never lands after a newer one. The bell also rings as a store across the network reconnects, so what the hub owes it goes first.
  function wake() {
    if (closed) {
      return;
    }

    void owing.pay();

    if (waking) {
      rang = true;

      return;
    }

    waking = (async () => {
      try {
        do {
          rang = false;
          await look();
        } while (rang);
      } catch (error) {
        process.stderr.write(`hub: a look at hex.db failed: ${String(error)}\n`);
      } finally {
        waking = undefined;
      }
    })();
  }

  async function look() {
    if (closed) {
      return;
    }

    const noLongerWaiting = waiting.settler();

    const [rows, besideThem] = await Promise.all([
      kept<Row[] | undefined>((store) => store.messages.untaken(threads.ids()), undefined),
      besideRows(),
    ]);

    if (!rows || closed) {
      return;
    }

    for (const row of rows) {
      const known = threads.get(row.to);

      if (known) {
        pass(row.to, known.name, toMessageWithKeyFirstForTheHook(row));
      }
    }

    for (const row of besideThem) {
      if (row.meta?.stalled === undefined) {
        void beside(row);
      }
    }

    noLongerWaiting(new Set(rows.map((row) => row.key)));
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Each session running beside a thread, by the row it was started for, if this hub started it.
  const besides = new Map<string, string | undefined>();
  let besideStarted: Promise<void> = Promise.resolve();

  const besideAddresses = () => threads.ids().map(besideOf);
  const besideRows = () => kept((store) => store.messages.beside(besideAddresses()), []);

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A row beside a thread starts a session of its own, as hex in the thread's chat, which takes the row itself; one for a session that ran beside it resumes that session once its run is over, where this machine has its conversation. A client that shows only the turns its own messages start can't be spoken into from beside, so there the row goes to the thread.
  async function beside(row: Row & { beside: string; resume?: string }) {
    await besideStarted;
    const thread = besideWhat(row.beside);
    const resumed = row.resume;
    const known = thread === undefined ? undefined : threads.get(thread);

    if (
      closed ||
      thread === undefined ||
      !known ||
      [...besides.values()].includes(row.key) ||
      (resumed !== undefined && besides.has(resumed))
    ) {
      return;
    }

    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // The row is this run's from here on, so a wake while the store is asked about it starts no second run.
    const session = resumed !== undefined && claude.saved(resumed) ? resumed : randomUUID();
    besides.set(session, row.key);

    if (resumed !== undefined && live().has(resumed)) {
      besides.delete(session);

      return;
    }

    if (clients.get(app)?.waits === true) {
      await kept((store) => store.messages.readdress(row.key, thread), false);
      besides.delete(session);

      return;
    }

    files.writeBeside(thread);

    const code = await runBeside(
      [
        launcher,
        "-p",
        ...(session === resumed ? ["--resume", session] : ["--session-id", session]),
        ...starts.launchArgs(thread),
        "--settings",
        files.besideSettingsOf(thread),
        besidePrompt(app, row, zone()),
      ],
      {
        cwd: threads.cwd(thread),
        env: {
          HEX_CHANNEL: channel,
          HEX_THREAD: thread,
          HEX_BESIDE: session,
          CLAUDE_CODE_SESSION_NAME: `${known.name}/${jobOf(row)}`,
        },
        log: files.besideLog(session),
      },
    );

    await besideEnded(thread, session, row.key, `exit ${code}`);
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Each thread's runs beside it end one at a time, so each reads what the one before it left.
  const besideEnding = ordered();

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A run beside a thread that saw its turn through is a turn that went through. One that didn't, as on an API error, waits for one to go through anywhere, as a thread's turn does, and its chat hears once while runs there wait; one that waited already is left, and its chat hears that. The run is the hub's until the store has its end, so no look starts it again before then.
  async function besideEnded(
    thread: string,
    session: string,
    key?: string,
    exit = "its session ended",
  ) {
    const said = lastWords(files.besideLog(session));

    if (closed) {
      return;
    }

    const { waited, given, left } = await besideEnding(thread, async () => {
      const before = await besideRows();

      const ended = await kept((store) => store.turns.besideEnded(session, key), {
        given: [],
        left: [],
      });

      besides.delete(session);

      return {
        waited: before.some(
          (row) => row.beside === besideOf(thread) && row.meta?.stalled !== undefined,
        ),
        ...ended,
      };
    });

    if (closed) {
      return;
    }

    const why = said === "" ? exit : said;

    for (const row of left) {
      failed(
        thread,
        `[${jobOf(row)}] failed again beside this chat, so it won't run by itself again: ${why}`,
        true,
      );
    }

    const [first] = given;

    if (first && !waited) {
      failed(
        thread,
        `[${jobOf(first)}] ran beside this chat and failed: ${why}\nIt carries on once turns go through again.`,
        true,
      );
    }

    if (!given.length && !left.length) {
      wentThrough("turn");
    }

    wake();
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // One run that waits beside a thread, for each turn that goes through, so the runs an outage stopped don't all start at once.
  async function releaseBeside() {
    await kept((store) => store.messages.supersede(besideAddresses()), undefined);
    const stalled = (await besideRows()).filter((row) => row.meta?.stalled !== undefined);

    if (stalled.some((row) => [...besides.values()].includes(row.key))) {
      return;
    }

    const [next] = stalled;

    if (next) {
      void beside(next);
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // As the hub starts, a run beside a thread cut off with the machine gives back what it took, to run again; one that outlived the last hub is waited on to its end; and the logs of runs that ended go. No run starts until then (besideStarted), so none is taken for one cut off.
  function besideStart() {
    const alive = live();
    files.sweepBesideLogs((session) => alive.has(session));

    for (const run of alive.values()) {
      const thread =
        run.thread?.startsWith(`${app}:`) === true ? run.thread.slice(app.length + 1) : undefined;

      if (
        run.beside !== undefined &&
        thread !== undefined &&
        (thread === main || threads.has(thread))
      ) {
        void waitBeside(thread, run);
      }
    }

    return kept(async (store) => {
      for (const dead of await store.turns.unfinishedBeside([...alive.keys()])) {
        await store.turns.besideEnded(dead, undefined, undefined, false);
      }
    }, undefined);
  }

  async function waitBeside(thread: string, run: Session) {
    besides.set(run.id, undefined);
    await claude.exited(run.pid);
    await besideEnded(thread, run.id);
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A turn the API refused ends with what set it off unanswered and nothing to start it again, and the session can't say why when its requests don't go through. So the thread's chat hears the API's error from the hub, and whether it carries on: one that clears does, once, at the next turn anywhere that goes through (resumeStalled), and the chat hears again only when that changes.
  function stall(thread: string, error = "unknown", said?: string) {
    const run = runOf(thread);
    const was = run.stalled;
    run.stalled = PASSING_API_ERRORS.has(error) && was !== "resumed" ? "waiting" : "told";
    process.stderr.write(`hub: ${thread}'s turn failed on the API (${error})\n`);

    if (was === run.stalled) {
      return;
    }

    const why = (said !== undefined && said !== "" ? said : error).slice(0, 400);

    const next =
      run.stalled === "waiting"
        ? "It carries on once turns go through again."
        : "Its next message starts it again.";

    failed(thread, `${why}\n${next}`, true);
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // One thread for each turn that goes through, so the threads an outage stalled don't all hit the API in the same moment.
  function resumeStalled() {
    for (const [thread, run] of hubRuns.all()) {
      if (run.stalled !== "waiting" || turns.of(thread).is === "busy") {
        continue;
      }

      run.stalled = "resumed";
      void deliver(thread, threads.get(thread)?.name ?? thread, {
        content:
          "[hub] Your last turn here failed on the API, and turns go through again now: carry on with it.",
        author: "prompt",
        meta: { user: "hub" },
      });

      return;
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A session that started before hex kept messages can't mark one taken itself, so its hook says so here.
  async function took(keys: string[] | undefined, session: string | undefined) {
    if (keys === undefined || session === undefined) {
      return;
    }

    await Promise.all(keys.map((key) => must({ kind: "take", key, by: session }, false)));
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Messages that came while the thread's session was stopping resume it once it's gone, unless a restart already took them.
  function resume(thread: string) {
    if (waiting.of(thread).queue.length && !runOf(thread).leaving) {
      void sessions.cycle(thread);
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Delivers a message to a fresh start of the thread's session, so it gets new launch arguments or, in a fresh thread, a new session; a session still working, on its turn or on background agents, keeps running and takes it as it is, unless earlier messages already wait for the new start or Claude Code paused it on a dialog no one could read. A session that took over while Claude was asked gets the message as any message would.
  async function refresh(thread: string, message: Message) {
    const standing = sessions.of(thread);
    const waited = waiting.of(thread);
    const phase = standing.phase;
    const running = await claude.agent(threads.current(thread) ?? "", serving);

    if (standing.phase !== phase || phase.is !== "live") {
      forward(thread, threads.of(thread).name, message);

      return;
    }

    const working =
      running?.status !== "waiting" &&
      (fresh(thread)
        ? turns.active(thread) || (running !== undefined && running.status !== "idle")
        : running?.status === "busy");

    if (working && waited.queue.length === 0) {
      handInOrHold(thread, threads.of(thread).name, phase.line, message);

      return;
    }

    waiting.hold(thread, message);
    void sessions.cycle(thread, running);
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A session's channel connected over HTTP: its session is the one the hub started, or the one Claude reports running for the thread. One that only reconnects still owes a renew it asked for. One that reconnects while it's being stopped gets nothing, since what it took would end with it. It's live at once, and is given what waits for it once that's read (waiting.catchUp), unless its line is gone by then.
  async function welcome(thread: string, line: Line) {
    const was = sessions.connected(thread, line);

    if (!was) {
      return;
    }

    if (thread === generalThread) {
      reached(api);
    }

    const run = runOf(thread);

    if (run.renew !== "asked") {
      run.renew = undefined;
    }

    sessions.track(thread, was, line);
    const read = await waiting.catchUp(thread, line);
    const { phase } = sessions.of(thread);

    if (phase.is !== "live" || phase.line !== line) {
      return;
    }

    const given = waiting.connected(thread, line, read);
    turns.connected(thread, given.length > 0);
    run.awaited = run.held.length > 0;
    rest(thread);
    letGo(thread);

    if (starts.stale(thread)) {
      run.renew = "stale";
      void renew(thread);
    }

    sessions.noteRunning(thread, line);

    if (was.is === "launching") {
      wentThrough("start");
    }
  }

  async function drop(thread: string, line: Line) {
    if (!sessions.dropped(thread, line)) {
      return;
    }

    const run = runOf(thread);
    await turnEnded(thread);

    if (run.leaving) {
      forget(thread, run.leaving);

      return;
    }

    await waiting.markAll(thread);
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A thread is on a call from its keep until its renew, which starts the next call in a new session. That session starts when the last call ends and can wait hours for the next, so a call that finds it still waiting for its first message starts it over, reading memory as it is now, unless a call waited for it to start. The stop comes first, so a message meanwhile waits for the new session, and the call is on once that session connects, so a restart that never gets there doesn't hold up the hub's own. Resolves once the session the call runs in is connected.
  async function keep(thread: string) {
    const run = runOf(thread);

    if (run.renew !== "underway") {
      run.renew = undefined;
    }

    const session = threads.current(thread);

    const untouched = () =>
      run.awaited !== true &&
      threads.current(thread) === session &&
      sessions.of(thread).phase.is === "live" &&
      turns.of(thread).is === "done" &&
      !waiting.of(thread).handed.size &&
      warmFor(thread) === undefined;

    if (
      present(session) &&
      untouched() &&
      !(await kept((store) => store.messages.took(session), true)) &&
      untouched()
    ) {
      run.renew = "underway";
      void stops.stop(thread).then(() => sessions.cycle(thread));
      await renewal(thread);
      onCall.add(run);

      return;
    }

    onCall.add(run);
    letGo(thread);
    await renewal(thread);
  }

  function drift(thread: string, away: boolean) {
    const run = runOf(thread);

    if (away) {
      adrift.add(run);
    } else {
      adrift.delete(run);
    }

    settle();
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
    files.token,
    server,
    {
      // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
      // A tool can send into another thread: what it sends there is still its caller's session's words.
      call: (thread, tool, toolArgs, by) =>
        caller.run(by ?? threads.current(thread), () => call(thread, tool, toolArgs)),
      permission: (thread, request) => permission?.(thread, request),
      open: (thread, line) => void welcome(thread, line),
      close: (thread, line) => void drop(thread, line),
    },
    open(storeDir),
    zone,
  );

  channels.set(path, serve);

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Where a session's hooks and hex's own tools reach the hub, one JSON line each.
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
          inOrder(HubRequestLine.parse(JSON.parse(raw)));
        } catch (error) {
          process.stderr.write(`hub: dropped a bad line: ${String(error)}\n`);
        }
      }
    });
    socket.on("error", ignore);
  }).listen(socketPath);

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A thread's lines are handled one at a time, in the order they came, each once the store has answered what the one before it asked.
  const handling = ordered();

  function inOrder(request: HubRequest) {
    void handling(request.thread, async () => {
      try {
        await handle(request);
      } catch (error) {
        process.stderr.write(
          `hub: a ${request.type} line for ${request.thread} failed: ${String(error)}\n`,
        );
      }
    });
  }

  async function handle(request: HubRequest) {
    switch (request.type) {
      case "state": {
        await took(request.taken, request.session);

        const run = runOf(request.thread);

        if (request.failed === true) {
          stall(request.thread, request.error, request.said);
        } else if (!request.busy || run.stalled !== "resumed") {
          run.stalled = undefined;
        }

        if (request.busy) {
          turnBegan(request.thread);
        } else {
          await turnEnded(request.thread, request.background === true);
        }

        if (!request.busy && request.failed !== true) {
          wentThrough("turn");
        }

        return;
      }

      case "open": {
        sessions.launch(request.thread, request.name, { prompt: request.prompt });

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
        await inbound(request.thread, {
          content: request.content,
          meta: request.meta ?? {},
          ...(request.key !== undefined && { key: request.key }),
          author: request.author,
        });

        return;
      }

      case "tookHeld": {
        const keys = new Set(request.keys);
        heldHere.set(
          request.thread,
          (heldHere.get(request.thread) ?? []).filter(({ meta }) => !keys.has(meta.key ?? "")),
        );

        return;
      }

      case "owed": {
        owedByHooks(owing, request);

        return;
      }

      case "mirror": {
        const thread = threads.find(request.thread);

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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A local message reaches a thread this hub already has, named by its key or its <app>:<key> id. Any other would open a stray thread here that later wakes find first.
  async function inbound(id: string, message: Message) {
    const thread = id.startsWith(`${app}:`) ? id.slice(app.length + 1) : id;

    const known = threads.get(thread);

    if (known) {
      await deliver(thread, known.name, message);

      return;
    }

    process.stderr.write(
      `hub: no open ${app} thread ${thread}, so a message for it from ${message.meta?.user ?? "a local tool"} was dropped\n`,
    );
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The owner's Stop ends the turn as Esc does in a terminal: the session and what it started in the background keep running, and the next message continues the conversation. A turn the hooks report over is left alone; one they never reported (the hub restarted) is the daemon's to say. An Esc that doesn't land changes nothing, and the owner can press Stop again.
  function interrupt(thread: string): Promise<void> {
    const run = runOf(thread);
    run.interrupting ??= press(thread).finally(() => (run.interrupting = undefined));

    return run.interrupting;
  }

  async function press(thread: string): Promise<void> {
    const turn = turns.of(thread);
    const session = threads.current(thread);

    if (!present(session) || turn.is === "background") {
      return;
    }

    const agent = await claude.listing(session);

    if (!agent) {
      return;
    }

    if (turn.is === "done" && agent.state !== "working") {
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
        threads.cwd(thread),
        session,
        AbortSignal.any([deadline.signal, closing.signal]),
      );
    } catch (error) {
      process.stderr.write(`hub: couldn't interrupt ${thread}'s turn: ${String(error)}\n`);
    } finally {
      clock.clearTimeout(timer);
    }

    if (closing.signal.aborted || threads.current(thread) !== session) {
      return;
    }

    if (how === "interrupted") {
      // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
      // An interrupt runs no Stop hook, so the hub records the turn's end in hex's record of it, as of the press, settling what the session took: a turn begun since then is left running.
      await kept((store) => store.turns.handled(session, pressed), undefined);
      await turnEnded(thread, true);

      if (
        (await claude.listing(session))?.state !== "working" &&
        turns.of(thread).is === "background"
      ) {
        await turnEnded(thread);
      }

      return;
    }

    process.stderr.write(`hub: Esc didn't interrupt ${thread}'s turn\n`);
  }

  function halt(thread: string) {
    failing.halted(thread);

    return stops.stop(thread);
  }

  if (present(main) || threads.ids().length > 0) {
    void (async () => {
      await sessions.hubStarted(await claude.agents(serving));
      wake();
    })();
  }

  const unwatch = await kept((store) => store.watch(wake), ignore);
  besideStarted = besideStart();
  const unschedule = present(generalThread) ? schedule(storeDir, hexDir, generalThread) : ignore;
  const unhold = present(generalThread) ? holding(storeDir) : ignore;

  const unrestart =
    present(generalThread) && journal !== undefined
      ? restarts(storeDir, generalThread, journal)
      : ignore;

  const api = {
    deliver,
    sent,
    said: (key: string) => kept((store) => store.messages.latest(`${app}:${key}`), null),
    command: sessions.restart,
    configure,
    settings: (thread: string): Settings => ({
      model: threads.get(thread)?.model,
      effort: threads.get(thread)?.effort,
    }),
    register: threads.register,
    open: (thread: string, name: string, prompt?: string, cwd?: string) => {
      sessions.launch(thread, name, { prompt, cwd });
    },
    fork: (thread: string, name: string, session: string, prompt: string, cwd?: string) => {
      sessions.launch(thread, name, { prompt, fork: session, cwd });
    },
    main,
    fresh,
    renewal,
    keep,
    adrift: drift,
    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // Once what this hub and every other in the process wrote can't be lost.
    synced: async () => {
      await landed();
      await owing.synced();
    },
    renew: renewAsked,
    session: threads.current,
    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // A turn cut short, which runs no Stop hook, queues its memory pass here.
    turned: async (thread: string) => {
      const session = threads.current(thread);

      if (present(session)) {
        await must(
          { kind: "pass", pass: { session, by: new Date().toISOString(), thread } },
          false,
        );
      }
    },
    running: sessions.sessionOf,
    threads: threads.ids,
    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // Saves the threads again, for an app that learned links it couldn't give before.
    save: threads.save,
    name: (thread: string) => threads.get(thread)?.name,
    cwd: (thread: string) => threads.get(thread)?.cwd,
    stop: halt,
    interrupt,
    answer: (thread: string, request_id: string, behavior: "allow" | "deny") => {
      const { phase } = sessions.of(thread);

      if (phase.is === "live") {
        phase.line.send({ type: "permission", request_id, behavior });
      }
    },
    release,
    adopt,
    follow: (thread: string, name: string, session: string, cwd?: string) => {
      threads.open(thread, { name, fork: session, ...(present(cwd) && { cwd }) });
    },
    history: (thread: string) =>
      kept((store) => history(store, thread, threads.current(thread)), []),
    retire,
    find: threads.find,
    rename: (thread: string, name: string) => {
      threads.update(thread, { name });
    },
    close: () => {
      closed = true;
      unwatch();
      unschedule();
      unhold();
      unrestart();

      if (generalHub === api) {
        generalHub = undefined;
      }

      sock.close();

      if (channels.get(path) === serve) {
        channels.delete(path);
      }

      closing.abort();

      for (const thread of runs.threads()) {
        sessions.end(thread);
        const run = runOf(thread);
        clock.clearTimeout(run.rest);
        turns.close(thread);
        hangUp(run);
      }
    },
  };

  whenThrough("start", () => void sessions.retry(), closing.signal);
  whenThrough("turn", () => void recompact(), closing.signal);
  whenThrough("turn", resumeStalled, closing.signal);
  whenThrough("turn", () => void releaseBeside(), closing.signal);

  if (present(generalThread)) {
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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The app that takes the owner's words for a thread when they're written in another client: it holds the thread, and shows more than the turns it starts itself, as T3 Code does (waits).
function taking(app: string, thread: string) {
  const there = clients.get(app);
  const name = there?.hub.name(thread);

  return there && there.waits !== true && present(name) ? { there, name } : undefined;
}

export const writable = (app: string, thread: string) => taking(app, thread) !== undefined;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Each thread's last showing of the owner's words, so the next waits for it and they show in the order they were written.
const showing = new Map<string, Promise<void>>();

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The owner's words for a thread, written in another client: the thread's app takes them as it does its own messages, then shows them where the thread lives, so its chat there holds everything said in it. A key sent again changes nothing. Whether the thread can take them.
export async function say(
  app: string,
  thread: string,
  message: Omit<Message, "author">,
): Promise<boolean> {
  const home = taking(app, thread);

  if (!home) {
    return false;
  }

  const { there, name } = home;
  const id = `${app}:${thread}`;
  const earlier = showing.get(id);
  const taken = there.hub.deliver(thread, name, { ...message, author: "owner" });

  showing.set(
    id,
    (async () => {
      await earlier;

      try {
        if (!(await taken)) {
          return;
        }

        const photos = pictures({ key: `${app}:${message.key ?? ""}`, meta: message.meta });
        const media = carried(message.meta) ?? (photos.length > 0 ? photos : undefined);
        const words = photos.length > 0 && fileOnly({ author: "owner", body: message.content });
        await there.backfill?.(thread, [
          { from: "me", text: words ? "" : message.content, ...(media && { media }) },
        ]);
      } catch (error) {
        process.stderr.write(
          `hub: couldn't show the owner's words in ${app} thread ${thread}: ${String(error)}\n`,
        );
      }
    })(),
  );

  await taken;

  return true;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Opens a thread on any client and starts its session: on a prompt, its first message as the session starts, or on a message that reaches it the way the app's own messages do.
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
    await there.hub.deliver(opened.thread, name, first);
  }

  return opened;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Opens the thread on another client and posts its chat so far there; the backfill settles either way.
async function carry(from: Hub, thread: string, to: string, name: string, where?: string) {
  const target = client(to);
  const session = from.session(thread);

  if (!present(session)) {
    throw new Error("this thread has no session yet");
  }

  const cwd = from.cwd(thread);

  const { thread: dest, link } = await target.place(name, where, undefined, cwd);
  const chat = await from.history(thread);

  const filled = (async () => {
    try {
      await target.backfill?.(dest, chat);
    } catch (error) {
      process.stderr.write(`hub: couldn't backfill ${to} thread ${dest}: ${String(error)}\n`);
    }
  })();

  return { target, session, dest, link, filled, cwd };
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Moves a thread to another client: its session stops here and resumes there, memory intact, once its chat is backfilled. The main thread never leaves, and a thread its app owns (copy) stays, so a copy continues instead.
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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Opens a copy of the thread on another client with its chat so far, and leaves it here. The copy continues the thread's session as a fork with its first message, so the two never share a session.
export async function mirror(from: Hub, thread: string, to: string, where?: string) {
  const name = from.name(thread) ?? thread;
  const { target, session, dest, link, filled, cwd } = await carry(from, thread, to, name, where);
  target.hub.follow(dest, name, session, cwd);
  await filled;

  return link;
}
