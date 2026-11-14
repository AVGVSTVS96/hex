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

import {
  besideOf,
  besideWhat,
  exited,
  jobOf,
  lastWords,
  prompt as besidePrompt,
  run as runBeside,
} from "./beside.ts";
import * as claude from "./claude.ts";
import { clock } from "./clock.ts";
import { holding } from "./holds.ts";
import { STARTUP } from "./loaded.ts";
import { endpoint, toolList } from "./mcp.ts";
import type { ChannelServer, Line, Permission, ToolArguments } from "./mcp.ts";
import { queue } from "./observe.ts";
import { fileOnly, held as filesIn, pictureOf, pictures, widthOverHeightOf } from "./pictures.ts";
import { restarts } from "./restarts.ts";
import { running as sessionsRunning } from "./running.ts";
import type { Session } from "./running.ts";
import { schedule } from "./schedule.ts";
import { asked, isAuthor, open, replied, shown, spoken, stateDir as storeOf } from "./store.ts";
import type { Author, MessageId, NewRow, Row, Store } from "./store.ts";
import { zoneOf } from "./zone.ts";

export { dispatch, tool } from "./mcp.ts";

export type { ChannelServer, Handlers, Permission, Tool, ToolArguments } from "./mcp.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// key: the app's own id for what the message is, so the app sending it again changes nothing. author: who wrote it, which every message a client delivers says (Store.deliver).
export type Message = {
  content: string;
  meta: Record<string, string>;
  key?: string;
  author?: Author;
};

export type Call = (thread: string, tool: string, args: ToolArguments) => Promise<string>;

export type State = (thread: string, busy: boolean, background: boolean) => void;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// turn: the session started, and its last turn failed on the API rather than its start.
export type Failed = (thread: string, reason: string, turn?: boolean) => void;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// still: the message waits for the thread's session, or else that wait is over.
export type Waits = (thread: string, message: Message, still: boolean) => void;

export type Settings = { model?: string | undefined; effort?: string | undefined };

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The choices a client offers for a thread's settings. Models are Claude Code's aliases, so a thread runs the newest model of the family it picked.
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
]);

type HubRequest = z.output<typeof HubRequestLine>;

export type HubLine = z.input<typeof HubRequestLine>;

export type Hub = ReturnType<typeof startHub>;

// idleStop: how long a quiet session stays warm before it stops. cacheWarm: how long the main thread rests before it compacts, while its cache is still warm. Both sit just inside Claude Code's one-hour prompt cache, so coming back within the hour costs no new cache write. compactAbove: the context above which a session compacts before it rests. compactWindow: the auto-compact window a thread's session runs with, a fresh thread's aside, which hands off at capacity. Claude Code compacts about 15-35k tokens under it, mid-turn, so a session in steady use, which never rests long enough to compact, stays small; the hex folder's own setting still holds for its terminal sessions, and for its threads too when it's smaller. HEX_COMPACT_WINDOW changes it. reconnect: how long a running session's channel may be gone before the session restarts to get it back. connect: how long a starting session waits for the hub to answer its channel, where Claude Code would give up after 30 seconds for good, so a hub running behind still gets its sessions' channels. Claude Code waits that long for each of a session's MCP servers, but a background session doesn't hold its turn for them. capacity: how much context a fresh thread's session holds before a new one takes over; with 0, every message that finds it done goes to a new one, and HEX_CHAT_CAPACITY changes it. handoffAbove: the context above which a thread whose session's cache has expired starts a new session that takes over from it, instead of resuming it and writing that whole context to the cache again: a new session starts at about 50k and reads back what it needs, so a smaller one costs more to replace than to resume. HEX_HANDOFF_ABOVE changes it. (see https://docs.claude.com/en/docs/build-with-claude/prompt-caching and https://code.claude.com/docs/en/mcp)
export type Limits = {
  idleStop: number;
  cacheWarm: number;
  compactAbove: number;
  compactWindow: number;
  reconnect: number;
  connect: number;
  capacity: number;
  handoffAbove: number;
};

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// from: the session the thread continues as a fork with its first message, until it has its own.
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
  HEX_HANDOFF?: string;
  HEX_HELD?: string;
};

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Where a thread's session stands. launching: the hub started or restarted it and waits for its channel, so one that ends first failed to start. recovering: it runs without its channel, which Claude Code may still bring back. Either wait ends at its deadline.
type Phase =
  | { is: "stopped" }
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // again: the hub started the thread again on its own (retry, revive), not for a message or prompt.
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
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The kept messages the hub has passed on since its session's channel last connected.
  handed: Set<string>;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // From the session's hooks; background: its turn ended with agents still working.
  turn: "busy" | "background" | "done";
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A message went to the running session after its last turn began: until a turn begins that takes it, a rest reported meanwhile is the turn before it ending.
  untaken?: boolean | undefined;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A message went to the session while it rested, so a turn is starting that its hook hasn't reported yet; under load that report can take seconds. Ends at the report, or at TURN_REPORTS_WITHIN for a message that ran no turn, like a copy the session already had.
  starting?: Timer | undefined;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // asked: the session asked to start over (a call ended). stale: it started with what the hub no longer gives a session. underway: it's starting over, and its renewal waits for the new session.
  renew?: "asked" | "stale" | "underway" | undefined;
  rest?: Timer | undefined;
  leaving?: ((session: string) => void) | undefined;
  ending?: Promise<void> | undefined;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The owner's Stop pressing Esc in the session, until the transcript shows it landed.
  interrupting?: Promise<void> | undefined;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A new session whose conversation Claude hasn't saved yet.
  unsaved?: string | undefined;
  held: (() => void)[];
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A call waited for the session now connected to start, so it is as new as the call.
  awaited?: boolean | undefined;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // When the hub last had the session compact, until its context is back under compactAbove.
  compacting?: number | undefined;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The starts that failed in a row since the thread's session last connected; retried: another session's start set one off since a message's last failed, told: General heard.
  failing?: { count: number; retried?: boolean; told?: boolean } | undefined;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Its last turn failed on the API, until a turn begins or goes through. waiting: the error clears on its own (a rate limit, a dropped connection), so it carries on at the next turn anywhere that goes through; resumed: the hub had it carry on, once; told: its chat heard it waits for its next message.
  stalled?: "waiting" | "resumed" | "told" | undefined;
  opening?: Opening | undefined;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The kept messages the client was told wait for a session, by key, until one takes them.
  waiting: Map<string, Message>;
};

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What a new session starts with: its first prompt, and the session it continues as a fork. quiet: the prompt is the hub's own (a compaction), so the thread doesn't show as working.
type Opening = { prompt?: string | undefined; fork?: string | undefined; quiet?: boolean };

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A call on a line a client holds, like a Discord voice channel: the line plays the voice's audio and ends when the call does, and the call engine hears the caller and can be hung up on. Audio is base64 PCM at 24 kHz, mono.
export type VoiceLine = { play: (audio: string) => void; end: () => void };

export type Held = { hear: (audio: string) => void; hangUp: () => void };

export type CallEngine = {
  take?: (from: "discord", greeting: string, line: VoiceLine) => Held;
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

export const clients = new Map<string, Client>();

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Each hub's restart of its threads whose session failed to start, run whenever a session this process started connects: a start just went through, so theirs can too.
const retries = new Set<() => void>();

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Each hub's retry of its compactions that failed (the account pool out of usage, the network down), run whenever a session's turn ends with an answer: requests go through again.
const answered = new Set<() => void>();

let generalHub: Hub | undefined;
const TELL_GENERAL_AFTER_FAILED_STARTS = 3;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Claude Code's StopFailure errors that clear on their own or once an account has room again; a refused connection reaches the hook as server_error.
const PASSING_API_ERRORS = new Set(["rate_limit", "overloaded", "server_error", "billing_error"]);

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
export function history(store: Store, thread: string, session?: string): Turn[] {
  const rows = store.messages.said(thread);
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
  const row = store.messages.get(key);
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
const TURN_REPORTS_WITHIN = 60_000;

// Claude Code keeps a conversation in the prompt cache for an hour after its last request, and compacts a background session only when told to. It retries a dropped HTTP server at about 0, 1, 3, 7 and 15 seconds, then gives up for good. https://docs.claude.com/en/docs/build-with-claude/prompt-caching
const LIMITS: Limits = {
  idleStop: 54 * 60_000,
  cacheWarm: 54 * 60_000,
  compactAbove: 150_000,
  compactWindow: tokensFrom("HEX_COMPACT_WINDOW", 200_000),
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
// A window is a number of tokens or "auto", the model's own, which is larger than any the hub sets.
const Window = z.number().optional().catch(undefined);

const Windows = z.looseObject({
  autoCompactWindow: Window,
  modelSettings: z.record(z.string(), z.looseObject({ autoCompactWindow: Window })).optional(),
});

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The smallest auto-compact window the hex folder's settings set, for every model or one. A thread's settings override the folder's, so the hub sets its window only when it's the smaller.
function folderWindow(hexDir: string) {
  const windows = [".claude/settings.json", ".claude/settings.local.json"].flatMap((file) => {
    try {
      const settings = Windows.parse(JSON.parse(readFileSync(join(hexDir, file), "utf-8")));

      return [
        settings.autoCompactWindow,
        ...Object.values(settings.modelSettings ?? {}).map((model) => model.autoCompactWindow),
      ];
    } catch {
      return [];
    }
  });

  return Math.min(...windows.filter((window) => window !== undefined));
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What a session reads only as it starts: its launch arguments, its channel's instructions and tools, and the files and folders its launcher loads that way. hex.db keeps a digest of what each thread's session started with.
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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// An update rewrites these while the hub runs, so a file gone midway reads as missing.
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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A hub's sessions show it this in a header, since any local user can reach its port.
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
  const {
    idleStop,
    cacheWarm,
    compactAbove,
    compactWindow,
    reconnect,
    connect,
    capacity,
    handoffAbove,
  } = {
    ...LIMITS,
    ...limits,
  };

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The session that made the tool call in progress.
  const caller = new AsyncLocalStorage<string | undefined>();
  const socketPath = join(stateDir, "hub.sock");
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Each thread's session reads its settings, binding and token from here, so none of it shows in a process's arguments, and a respawn reads the thread's current ones.
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The app's open threads, from hex.db: the hub starts only once it can read them, so no save closes threads it never loaded.
  function openThreads(): Map<string, Saved> {
    db ??= open(storeDir);

    return new Map(
      db.threads
        .list({ app, open: true })
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The app gives each thread's link as it knows it now; one it can't give keeps the last it gave.
  function keepIn(store: Store, saved: Map<string, Saved>) {
    store.threads.keep(
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // hex.db keeps a closed thread's row, with its name, for whatever reads one.
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
    clock.clearTimeout(run.starting);
    run.starting = undefined;

    if (working) {
      run.untaken = undefined;
    } else {
      letHeldGo(thread);
    }

    if (run.turn === "done" && (run.renew === "asked" || run.renew === "stale")) {
      void renew(thread, run.renew === "asked");
    }

    rest(thread, run.turn === "done");
    letGo(thread);
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A thread renews at its next rest: the main thread and a fresh thread start over as soon as the process exits, any other when its next message resumes it. A keep (a call started) cancels it. When the session asked for it, a rest the Stop hook reported with no agents working is taken as it is: Claude's own status lags the hook and counts a running shell as busy, so checking it could put the renew off for good, and a session that asked is done with what its shells were for.
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
      run.untaken === true ||
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A renew is on its way while the thread's session winds down its turn or restarts, but not while it waits on background agents, which can take as long as they like.
  function pending(run: Run) {
    return run.renew === "underway" || (!!run.renew && run.turn !== "background");
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Resolves once the thread's renew is through (its new session connected) or off, right away when none is on its way, so a voice call can wait for the new session.
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A running session that isn't busy stops after a while; its next message resumes it. The main thread keeps running, and compacts before its cache goes cold.
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

  // A fresh thread keeps one session running, which takes its messages while its context has room and its cache is warm. Once either is spent, a new session built from the chat takes over at the old one's rest, so the next message finds it running: after the cache expires, the old session would send its whole context uncached, and a new one costs no more. warmFor is how long a session stays worth its messages, undefined before its first request. Its cache lives an hour on a Claude subscription and five minutes by default on an API key; the transcript records which. https://docs.claude.com/en/docs/build-with-claude/prompt-caching
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A session on a call takes every message of the call, so a call never changes sessions midway.
  function spent(thread: string) {
    return fresh(thread) && !onCall.has(runOf(thread)) && warmFor(thread) === 0;
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // At a rest the Stop hook reported with no agents working, Claude's own status still says busy for about a second, so a session that filled up on that turn hands over without asking it.
  async function handOff(thread: string, rested = false) {
    const run = runOf(thread);
    run.rest = undefined;
    const running = await claude.agent(current(thread) ?? "", serving);

    if (running && run.turn !== "busy" && (rested || running.status === "idle") && spent(thread)) {
      void cycle(thread, running);
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The Stop hook ends a turn, but background tasks keep a session busy past it, so Claude's own status decides; a busy session reports idle again when it's done. A big conversation compacts first, while its cache is warm: resumed after the cache expires, it would be written to the cache whole again.
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // `claude stop` returns before the process exits, and the session keeps its channel until it does, so a message meanwhile waits for the exit (forward). Its process is found while Claude still lists it, before the stop; when Claude can't say, the stop goes ahead without the wait. The hub stops a session only when it's idle or the owner asks, so what it took is handled.
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
          store.turns.handled(session);
        }, undefined);
        void claude.stop(session);

        return agent && claude.exited(agent.pid);
      })
      .finally(() => (run.ending = undefined));

    return (run.ending = ending);
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Resolves with the thread's session once it has stopped and the thread is forgotten.
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
    const session = threads.get(thread)?.session ?? "";
    threads.delete(thread);
    save();
    become(run, { is: "stopped" });
    clock.clearTimeout(run.rest);
    runs.delete(thread);
    rmSync(settingsOf(thread), { force: true });
    rmSync(besideSettingsOf(thread), { force: true });
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A start's prompt and the session it forks are kept until a session connects, so the next start after a failed one, a retry or the thread's next message, starts with them; its cwd is kept in hex.db.
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

    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // A fork's first start has no session to find; after a failed one, the session it started may run on.
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
    const daemonChecked = claude.restartStaleDaemon();

    if (!present(fork) && present(known.session) && !fresh(thread)) {
      await claude.rm(known.session);
    }

    if (run.phase === phase) {
      await start(thread, prompt, fork, daemonChecked);
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The running session serving a thread: its current one, or one started for it whose conversation isn't saved yet.
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A session that started with other arguments or another channel starts over: with its next message for a changed model or effort, and at its next rest after an update, so a crash or a plain restart of the hub leaves every session running. A thread with no record started its session with none of its own arguments, before the hub kept one.
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

  function besideSettingsOf(thread: string) {
    return join(sessionsDir, `beside-${encodeURIComponent(thread)}.json`);
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Where the thread's session keeps the copy of its instruction files it loads (bin/instructions hold).
  function heldOf(thread: string) {
    return join(sessionsDir, encodeURIComponent(thread));
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A respawn reads the same file, so it gets the hub's current token too. It runs without the launcher, so the file keeps what the launcher added and renews only the hub's keys.
  function writeSettings(
    thread: string,
    launched: ReturnType<typeof claude.settingsOf> = {},
    takesOverFrom?: string,
  ) {
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

    if (present(takesOverFrom)) {
      env.HEX_HANDOFF = takesOverFrom;
    }

    writeFileSync(
      settingsOf(thread),
      JSON.stringify({
        ...(!fresh(thread) &&
          compactWindow < folderWindow(hexDir) && { autoCompactWindow: compactWindow }),
        ...launched,
        enabledPlugins: { ...launched?.enabledPlugins, [plugin]: true },
        env: { ...launched?.env, ...env },
      }),
      { mode: 0o600 },
    );
  }

  async function start(
    thread: string,
    prompt?: string,
    fork?: string,
    daemonChecked?: Promise<void>,
  ) {
    const known = savedOf(thread);
    const takesOverFrom = present(prompt) || present(fork) ? undefined : expired(thread);
    writeSettings(thread, {}, takesOverFrom);

    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // The session's hooks keep what's typed in it as the owner's; this one is hex's.
    if (present(prompt)) {
      kept(
        (store) =>
          store.messages.deliver(
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
      : present(known.session) && !fresh(thread) && !present(takesOverFrom)
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
          daemonChecked,
        ),
      );
    } catch (error) {
      fail(thread, error instanceof Error ? error.message : String(error));
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The transcript of a thread's saved session whose prompt cache has expired (an hour, or 5 minutes for a short one), when it holds more than a new session costs to start and catch up. A start with a prompt, like /compact, needs the old conversation itself, so it resumes.
  function expired(thread: string) {
    const session = savedOf(thread).session;

    if (!present(session) || fresh(thread)) {
      return;
    }

    const { sent: context, at, short } = claude.usage(cwdOf(thread), session);
    const cacheLife = short === true ? 5 * 60_000 : 60 * 60_000;

    return context > handoffAbove && at !== undefined && clock.now() - at > cacheLife
      ? claude.transcript(cwdOf(thread), session)
      : undefined;
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A run of failed starts ends when the thread's session connects. Its chat hears of each one a message or prompt set off, but of one the hub set off on its own only as the run's first, and General hears once, from the third on. General's own failed starts reach only its chat, which needs no session to read them.
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
      const body = `[hub] hex couldn't start the session of ${app} thread "${threads.get(thread)?.name ?? thread}" ${failing.count} times in a row: ${reason}. Its next message starts it again.`;
      kept(
        (store) =>
          store.messages.deliver({
            key: `hub:${app}:${thread}:failing@${randomUUID()}`,
            to: besideOf(generalMain),
            from: "hub",
            author: "prompt",
            body,
            meta: { user: "hub" },
          }),
        false,
      );
    }

    setState(thread, false);
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Claude Code failed a start for not finding the session it resumed or forked, and no project folder has its conversation, so the thread lets go of it once a note is kept that tells its next session why it starts without it. One another folder has fails as any start does.
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
        store.messages.deliver({
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The store while it opens and writes; without it the hub goes on from memory, as it did before it had one, so a failing disk never leaves hex deaf.
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A message is kept before anything else happens to it, so once this returns the app can be told it arrived: a crash from then on leaves it with hex, for whichever session serves the thread next. A key kept already is the app sending it again. along: the change to hex's records the message tells of, like the answer a tap gives, made in the same write so both land or neither does; when it changes nothing, or hex.db can't take it, there's nothing to tell. Whether the thread is told.
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
            store.messages.deliver({
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

    pass(thread, name, added ? { content, author, meta: { key, ...meta } } : { content, meta });

    return true;
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // What hex said in a thread, kept as its session sent it: a reply, a post, a failed send with meta.failed. The session that wrote it has it already, so it wakes nothing.
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

    kept(
      (store) => store.messages.deliver(row, caller.getStore() ?? current(thread) ?? "hub"),
      false,
    );
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
      } else if (!heldForTheTurn(thread, message)) {
        handIn(thread, run.phase.line, message);
      }

      return;
    }

    hold(thread, message);

    if (run.phase.is === "launching") {
      run.phase.again = false;
    }

    void launch(thread, name);
  }

  function handIn(thread: string, line: Line, message: Message) {
    runOf(thread).untaken = true;
    beginTurn(thread);
    line.send({ type: "inbound", ...message });
  }

  function beginTurn(thread: string) {
    const run = runOf(thread);

    if (run.turn === "busy" || run.starting !== undefined) {
      return;
    }

    run.starting = clock.setTimeout(() => {
      run.starting = undefined;
      letHeldGo(thread);
    }, TURN_REPORTS_WITHIN);
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Claude Code labels a channel message that comes mid-turn as not from its user, so the owner's words wait for the session's next tool call, where hub/held.ts gives them as hook feedback, which Claude Code treats as the user's; the turn's end sends any still waiting (letHeldGo). A turn counts from the message that starts it, not from its hook's report.
  function heldForTheTurn(thread: string, message: Message) {
    const { key } = message.meta;
    const session = current(thread);
    const run = runOf(thread);

    return (
      (run.turn === "busy" || run.starting !== undefined) &&
      message.author === "owner" &&
      present(key) &&
      present(session) &&
      kept((store) => store.messages.hold(key, session), false)
    );
  }

  function letHeldGo(thread: string) {
    const rows = kept((store) => store.messages.letHeldGo(thread), []);

    for (const row of rows) {
      forward(thread, savedOf(thread).name, toMessageWithKeyFirstForTheHook(row));
    }
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // What a thread's next session gets: every message no session has taken, and any the store couldn't keep.
  function waiting(thread: string): Message[] {
    const rows = kept((store) => store.messages.untaken(thread), []);

    return [
      ...rows.map(toMessageWithKeyFirstForTheHook),
      ...runOf(thread).queue.filter((message) => !present(message.meta.key)),
    ];
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Messages kept outside this hub reach its threads as the bell rings, and at its start so do any that no session took before the hub stopped.
  function wake() {
    if (closed) {
      return;
    }

    const rows = kept<Row[] | undefined>(
      (store) => store.messages.untaken([...threads.keys()]),
      undefined,
    );

    if (!rows) {
      return;
    }

    for (const row of rows) {
      const known = threads.get(row.to);

      if (known) {
        pass(row.to, known.name, toMessageWithKeyFirstForTheHook(row));
      }
    }

    for (const row of besideRows()) {
      if (row.meta?.stalled === undefined) {
        void beside(row);
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Each session running beside a thread, by the row it was started for.
  const besides = new Map<string, string>();

  const besideAddresses = () => [...threads.keys()].map(besideOf);
  const besideRows = () => kept((store) => store.messages.beside(besideAddresses()), []);
  const besideLog = (session: string) => join(sessionsDir, `beside-${session}.log`);

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A row beside a thread starts a session of its own, as hex in the thread's chat, which takes the row itself; one for a session that ran beside it resumes that session once its run is over. A client that shows only the turns its own messages start can't be spoken into from beside, so there the row goes to the thread.
  async function beside(row: Row & { beside: string; resume?: string }) {
    const thread = besideWhat(row.beside);
    const resumed = row.resume;
    const known = thread === undefined ? undefined : threads.get(thread);

    if (
      closed ||
      thread === undefined ||
      !known ||
      [...besides.values()].includes(row.key) ||
      (resumed !== undefined &&
        (besides.has(resumed) || kept((store) => sessionsRunning(store).has(resumed), true)))
    ) {
      return;
    }

    if (clients.get(app)?.waits === true) {
      kept((store) => store.messages.readdress(row.key, thread), false);

      return;
    }

    const session = resumed ?? randomUUID();
    besides.set(session, row.key);
    writeBesideSettings(thread);

    const code = await runBeside(
      [
        launcher,
        "-p",
        ...(resumed === undefined ? ["--session-id", session] : ["--resume", session]),
        ...extra(thread),
        "--settings",
        besideSettingsOf(thread),
        besidePrompt(app, row, zoneOf(hexDir) ?? Temporal.Now.timeZoneId()),
      ],
      {
        cwd: cwdOf(thread),
        env: {
          HEX_CHANNEL: channel,
          HEX_THREAD: thread,
          HEX_BESIDE: session,
          CLAUDE_CODE_SESSION_NAME: `${known.name}/${jobOf(row)}`,
        },
        log: besideLog(session),
      },
    );

    besides.delete(session);
    besideEnded(thread, session, row.key, `exit ${code}`);
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A run beside a thread that saw its turn through is a turn that went through. One that didn't, as on an API error, waits for one to go through anywhere, as a thread's turn does, and its chat hears once while runs there wait; one that waited already is left, and its chat hears that.
  function besideEnded(thread: string, session: string, key?: string, exit = "its session ended") {
    const said = lastWords(besideLog(session));

    if (closed) {
      return;
    }

    const waited = besideRows().some(
      (row) => row.beside === besideOf(thread) && row.meta?.stalled !== undefined,
    );

    const { given, left } = kept((store) => store.turns.besideEnded(session, key), {
      given: [],
      left: [],
    });

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
      for (const each of answered) {
        each();
      }
    }

    wake();
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // One run that waits beside a thread, for each turn that goes through, so the runs an outage stopped don't all start at once.
  function releaseBeside() {
    kept((store) => {
      store.messages.supersede(besideAddresses());
    }, undefined);

    const stalled = besideRows().filter((row) => row.meta?.stalled !== undefined);

    if (stalled.some((row) => [...besides.values()].includes(row.key))) {
      return;
    }

    const [next] = stalled;

    if (next) {
      void beside(next);
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // As the hub starts, a run beside a thread cut off with the machine gives back what it took, to run again; one that outlived the last hub is waited on to its end; and the logs of runs that ended go.
  function besideStart() {
    const alive = kept((store) => sessionsRunning(store), new Map<string, Session>());

    kept((store) => {
      for (const dead of store.turns.unfinishedBeside(besideAddresses(), [...alive.keys()])) {
        store.turns.besideEnded(dead, undefined, undefined, false);
      }
    }, undefined);

    for (const file of readdirSync(sessionsDir)) {
      const session = /^beside-(.+)\.log$/u.exec(file)?.[1];

      if (session !== undefined && !alive.has(session)) {
        rmSync(join(sessionsDir, file), { force: true });
      }
    }

    for (const run of alive.values()) {
      const thread =
        run.thread?.startsWith(`${app}:`) === true ? run.thread.slice(app.length + 1) : undefined;

      if (run.beside !== undefined && thread !== undefined && threads.has(thread)) {
        void waitBeside(thread, run);
      }
    }
  }

  async function waitBeside(thread: string, run: Session) {
    besides.set(run.id, "");
    await exited(run.pid);
    besides.delete(run.id);
    besideEnded(thread, run.id);
  }

  function writeBesideSettings(thread: string) {
    writeFileSync(
      besideSettingsOf(thread),
      JSON.stringify({
        enabledPlugins: { [plugin]: true },
        env: {
          HEX_CHANNEL: channel,
          HEX_THREAD: thread,
          HEX_PORT: String(port),
          HEX_TOKEN: token,
          HEX_STORE: storeDir,
          ...(general && thread === main && { HEX_MAIN: "1" }),
        },
      }),
      { mode: 0o600 },
    );
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A thread whose session failed to start keeps its prompt and the messages it was handed waiting, and the main thread is always running, so each starts again once starts go through. Once for each failed start a message set off: one that fails even then has a problem of its own, and waits for its next message.
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
    for (const [thread, run] of runs) {
      if (run.stalled !== "waiting" || run.turn === "busy") {
        continue;
      }

      run.stalled = "resumed";
      deliver(thread, threads.get(thread)?.name ?? thread, {
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
  function took(keys: string[] | undefined, session: string | undefined) {
    if (keys === undefined || session === undefined) {
      return;
    }

    for (const key of keys) {
      kept((store) => store.messages.take(key, session), false);
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Messages that came while the thread's session was stopping resume it once it's gone, unless a restart already took them.
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Claude Code runs a slash command like /compact only as a session's first prompt, and reads its launch arguments only at start, so a running session stops and resumes for either.
  async function restart(thread: string, prompt?: string) {
    const session = current(thread);

    if (!present(session)) {
      await launch(thread, savedOf(thread).name, { prompt });

      return;
    }

    void cycle(thread, await claude.agent(session, serving), prompt);
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Delivers a message to a fresh start of the thread's session, so it gets new launch arguments or, in a fresh thread, a new session; a session still working, on its turn or on background agents, keeps running and takes it as it is, unless earlier messages already wait for the new start. A session that took over while Claude was asked gets the message as any message would.
  async function refresh(thread: string, message: Message) {
    const run = runOf(thread);
    const phase = run.phase;
    const running = await claude.agent(current(thread) ?? "", serving);

    if (run.phase !== phase || phase.is !== "live") {
      forward(thread, savedOf(thread).name, message);

      return;
    }

    const working = fresh(thread)
      ? run.turn === "busy" ||
        run.starting !== undefined ||
        (running !== undefined && running.status !== "idle")
      : running?.status === "busy";

    if (working && run.queue.length === 0) {
      if (!heldForTheTurn(thread, message)) {
        handIn(thread, phase.line, message);
      }

      return;
    }

    hold(thread, message);
    void cycle(thread, running);
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Resuming before the old process exits starts a copy, so it waits for the exit. The stopped session's stream can close after that, so it isn't waited for.
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A session's channel connected over HTTP: its session is the one the hub started, or the one Claude reports running for the thread. One that only reconnects still owes a renew it asked for. One that reconnects while it's being stopped gets nothing, since what it took would end with it.
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

    kept((store) => store.messages.letHeldGo(thread), []);
    const given = waiting(thread);

    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // They wait until the session takes them, though an earlier hub may be the one that said so.
    for (const message of given) {
      mark(thread, message);
      line.send({ type: "inbound", ...message });
    }

    run.handed = new Set(given.flatMap((message) => message.meta.key ?? []));
    run.untaken = given.length > 0;
    clock.clearTimeout(run.starting);
    run.starting = undefined;

    if (given.length > 0) {
      beginTurn(thread);
    }

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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A session without its channel gets Claude Code's reconnect window to come back, and a starting one, still running each time the hub looks, also the time Claude Code waits for the hub to answer its channel. After that, one still running restarts in place (a turn it was on runs again) if it started before the wait did, or else gets another window; a start that ended is reported, a gone main thread starts again, and a thread whose messages waited on a session that has since ended resumes. pid: the starting session's process, which the hub looks at itself until its wait is over.
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

      // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
      // A respawn starts from the flags the session started with, which read the thread's current settings file only for a session the hub started that way.
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A session that died mid-turn ran no Stop hook, so its turn ends in hex's record of it here, and what it took without answering waits for the thread's next session. Only for a thread none of whose sessions runs.
  function cut(thread: string) {
    const given = new Set(kept((store) => store.turns.cut(thread, current(thread)), []));

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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A session that dies before Claude saves its conversation can't be resumed, so the thread keeps its last saved session until the new one has a conversation on disk.
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A thread is on a call from its keep until its renew, which starts the next call in a new session. That session starts when the last call ends and can wait hours for the next, so a call that finds it still waiting for its first message starts it over, reading memory and live status as they are now, unless a call waited for it to start. The stop comes first, so a message meanwhile waits for the new session, and the call is on once that session connects, so a restart that never gets there doesn't hold up the hub's own. Resolves once the session the call runs in is connected.
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
      !kept((store) => store.messages.took(session), true)
    ) {
      run.renew = "underway";
      void stop(thread).then(() => cycle(thread));

      return renewal(thread).then(() => void onCall.add(run));
    }

    onCall.add(run);
    letGo(thread);

    return renewal(thread);
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
    token,
    server,
    {
      // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
      // A tool can send into another thread: what it sends there is still its caller's session's words.
      call: (thread, tool, toolArgs, by) =>
        caller.run(by ?? current(thread), () => call(thread, tool, toolArgs)),
      permission: (thread, request) => permission?.(thread, request),
      open: welcome,
      close: drop,
    },
    (db ??= open(storeDir)),
    () => zoneOf(hexDir) ?? Temporal.Now.timeZoneId(),
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

        const run = runOf(request.thread);

        if (request.failed === true) {
          stall(request.thread, request.error, request.said);
        } else if (!request.busy || run.stalled !== "resumed") {
          run.stalled = undefined;
        }

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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A local message reaches a thread this hub already has, named by its key or its <app>:<key> id. Any other would open a stray thread here that later wakes find first.
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The owner's Stop ends the turn as Esc does in a terminal: the session and what it started in the background keep running, and the next message continues the conversation. A turn the hooks report over is left alone; one they never reported (the hub restarted) is the daemon's to say. An Esc that doesn't land changes nothing, and the owner can press Stop again.
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
      // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
      // An interrupt runs no Stop hook, so the hub records the turn's end in hex's record of it, as of the press, settling what the session took: a turn begun since then is left running.
      kept((store) => {
        store.turns.handled(session, pressed);
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // After the owner's stop only the thread's next message starts it again, without the prompt it was opened with, though a moved copy still starts from the conversation it forks.
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The main thread is always running: started with the hub, and started again when its session is gone.
  function revive() {
    if (!present(main) || closed || runOf(main).phase.is === "live") {
      return;
    }

    rename(main, mainName);
    void launch(main, mainName, { again: true });
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Sessions that outlived the hub (a hub restart) reconnect, or recover. A fresh main thread's launch never resumes, so one still running waits for its session instead of starting another.
  if (present(main) || threads.size > 0) {
    void (async () => {
      const running = await claude.agents(serving);

      const outlived = new Set(
        [...threads.keys()].filter((thread) =>
          running.some((agent) => agent.sessionId === current(thread) || boundTo(agent) === thread),
        ),
      );

      // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
      // One that was mid-turn when the hub stopped, with no session running for it (a reboot, or hex moved to another machine), has nothing to reconnect: its next session gets what it left at once. The list is from a supervisor that answered, so a session missing from it isn't running.
      const cutShort = [...threads.keys()].filter(
        (thread) => !outlived.has(thread) && kept((store) => store.turns.midTurn(thread), false),
      );

      for (const thread of [...outlived, ...cutShort]) {
        const run = runOf(thread);

        if (run.phase.is !== "stopped") {
          continue;
        }

        if (outlived.has(thread)) {
          become(run, { is: "recovering" });
          recover(thread);
        } else {
          gone(thread);
        }
      }

      if (present(main) && !(fresh(main) && outlived.has(main)) && !cutShort.includes(main)) {
        revive();
      }

      besideStart();
      wake();
    })();
  }

  const unwatch = kept((store) => store.watch(wake), ignore);
  const unschedule = general && present(main) ? schedule(storeDir, hexDir, main) : ignore;
  const unhold = general && present(main) ? holding(storeDir) : ignore;

  const unrestart =
    general && present(main) && journal !== undefined ? restarts(storeDir, main, journal) : ignore;

  const retryCompactions = () => void recompact();

  const api = {
    deliver,
    sent,
    said: (key: string) => kept((store) => store.messages.latest(`${app}:${key}`), null),
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
    fresh,
    renewal,
    keep,
    adrift: drift,
    synced: () => kept((store) => store.synced(), Promise.resolve()),
    renew: renewAsked,
    session: current,
    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // A turn cut short, which runs no Stop hook, queues its memory pass here.
    turned: (thread: string) => {
      const session = current(thread);

      if (present(session)) {
        queue(storeDir, { session, by: new Date().toISOString(), thread });
      }
    },
    running: sessionOf,
    threads: () => [...threads.keys()],
    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // Saves the threads again, for an app that learned links it couldn't give before.
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
      unrestart();
      retries.delete(retry);
      answered.delete(retryCompactions);
      answered.delete(resumeStalled);
      answered.delete(releaseBeside);

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
        clock.clearTimeout(run.starting);
        hangUp(run);
      }
    },
  };

  retries.add(retry);
  answered.add(retryCompactions);
  answered.add(resumeStalled);
  answered.add(releaseBeside);

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
export function say(app: string, thread: string, message: Omit<Message, "author">): boolean {
  const home = taking(app, thread);

  if (!home) {
    return false;
  }

  const { there, name } = home;

  if (there.hub.deliver(thread, name, { ...message, author: "owner" })) {
    const id = `${app}:${thread}`;
    const earlier = showing.get(id);

    showing.set(
      id,
      (async () => {
        await earlier;

        try {
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
  }

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
    there.hub.deliver(opened.thread, name, first);
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

  const filled = (async () => {
    try {
      await target.backfill?.(dest, from.history(thread));
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
