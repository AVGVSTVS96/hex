import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import { basename, join } from "node:path";

import { z } from "zod";

import { sessionsBeside } from "./besides.ts";
import { threadCalls } from "./calls.ts";
import * as claude from "./claude.ts";
import { failedStarts } from "./failing.ts";
import type { Failed } from "./failing.ts";
import { sessionFiles } from "./files.ts";
import { holding } from "./holds.ts";
import { threadInbox } from "./inbox.ts";
import { turnInterrupts } from "./interrupt.ts";
import { keeping, landed, OwedRow } from "./kept.ts";
import type { Owing } from "./kept.ts";
import { STARTUP } from "./loaded.ts";
import { endpoint } from "./mcp.ts";
import type { ChannelServer, Line, Permission, ToolArguments } from "./mcp.ts";
import { cantStart, tellOwner } from "./notice.ts";
import { PASS, queue } from "./observe.ts";
import { ordered } from "./ordered.ts";
import { sessionPauses } from "./pauses.ts";
import { fileOnly, held as filesIn, pictureOf, pictures, widthOverHeightOf } from "./pictures.ts";
import { present } from "./present.ts";
import { threadRenewals } from "./renewals.ts";
import { sessionRests } from "./rest.ts";
import { restarts } from "./restarts.ts";
import { threadRuns } from "./runs.ts";
import { schedule } from "./schedule.ts";
import { threadSessions } from "./sessions.ts";
import { stalledTurns } from "./stalls.ts";
import { sessionStarts } from "./start.ts";
import { sessionStops } from "./stops.ts";
import { asked, isAuthor, open, replied, shown, spoken, stateDir as storeOf } from "./store.ts";
import type { Author, MessageId, NewRow, Store } from "./store.ts";
import { openThreads } from "./threads.ts";
import { wentThrough, whenThrough } from "./through.ts";
import { sessionTurns } from "./turns.ts";
import { messagesWaiting } from "./waiting.ts";
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
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // How long a hub waits for a store that doesn't answer as it starts before the owner hears.
  tellAfter: number;
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

// Claude Code keeps a conversation in the prompt cache for an hour after its last request, and compacts a background session only when told to. It retries a dropped HTTP server at about 0, 1, 3, 7 and 15 seconds, then gives up for good. https://docs.claude.com/en/docs/build-with-claude/prompt-caching
const LIMITS: Limits = {
  idleStop: 54 * 60_000,
  cacheWarm: 54 * 60_000,
  compactAbove: 150_000,
  reconnect: 20_000,
  connect: 300_000,
  capacity: tokensFrom("HEX_CHAT_CAPACITY", 350_000),
  handoffAbove: tokensFrom("HEX_HANDOFF_ABOVE", 80_000),
  tellAfter: 60_000,
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
  const {
    idleStop,
    cacheWarm,
    compactAbove,
    reconnect,
    connect,
    capacity,
    handoffAbove,
    tellAfter,
  } = { ...LIMITS, ...limits };

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The session that made the tool call in progress.
  const caller = new AsyncLocalStorage<string | undefined>();
  const socketPath = join(stateDir, "hub.sock");
  const runs = threadRuns();
  const calls = threadCalls(runs);
  const generalThread = general && present(main) ? main : undefined;
  const plugin = channel.replace(/^plugin:/u, "");
  const path = `/${plugin.split("@")[0]}`;
  const app = path.slice(1);
  let started = false;

  const owing = keeping(storeDir, {
    spool: join(storeDir, `owed.${app}.json`),
    earlier: stateDir === storeDir ? [] : [join(stateDir, `owed.${app}.json`)],
    refused: join(storeDir, `refused.${app}.json`),
    letGo: (thread, rows) => {
      if (started) {
        inbox.heldLetGo(thread, rows);
      }
    },
    queue: (turn, store) => queue(storeDir, turn, store),
    tell: (why) => void tellOwner(why),
  });

  const { kept, must } = owing;

  const threads = await openThreads({
    app,
    storeDir,
    owing,
    hexDir,
    link,
    tell: cantStart(storeDir),
    tellAfter,
  });

  started = true;
  const turns = sessionTurns({ overdue: (thread) => void inbox.letHeldGo(thread) });
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

  const stops = sessionStops({
    runs,
    threads,
    kept,
    serving,
    stopping: (thread) => {
      rests.cancel(thread);
    },
  });

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
    startFailed: (thread) => {
      renewals.startFailed(thread);
    },
  });

  const rests = sessionRests({
    runs,
    threads,
    turns,
    sessions,
    stops,
    pauses,
    calls,
    serving,
    main,
    fresh,
    idleStop,
    cacheWarm,
    compactAbove,
    capacity,
    forget,
  });

  const renewals = threadRenewals({
    runs,
    threads,
    turns,
    waiting,
    sessions,
    starts,
    stops,
    rests,
    calls,
    kept,
    serving,
    main,
    fresh,
  });

  const besides = sessionsBeside({
    threads,
    files,
    starts,
    kept,
    serving,
    app,
    main,
    channel,
    launcher,
    zone,
    ownTurnsOnly: () => clients.get(app)?.waits === true,
    failed,
    wake: () => {
      inbox.wake();
    },
  });

  const inbox = threadInbox({
    threads,
    turns,
    waiting,
    sessions,
    starts,
    stops,
    pauses,
    rests,
    calls,
    besides,
    owing,
    serving,
    app,
    fresh,
  });

  const stalls = stalledTurns({ runs, threads, turns, inbox, failed });

  const interrupts = turnInterrupts({
    runs,
    threads,
    turns,
    kept,
    closing: closing.signal,
    turnEnded,
  });

  function turnBegan(thread: string) {
    state(thread, true, false);
    threads.claim(thread);
    turns.began(thread);
    rests.rest(thread);
    renewals.letGo(thread);
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A held message let go can start a session, and with it a turn, so what follows reads the turn as it is then.
  async function turnEnded(thread: string, background = false) {
    state(thread, false, background);
    threads.claim(thread);
    turns.ended(thread, background);
    await inbox.letHeldGo(thread);
    renewals.atRest(thread);
    rests.rest(thread, turns.of(thread).is === "done");
    renewals.letGo(thread);
  }

  function forget(thread: string, leaving: (session: string) => void) {
    const session = threads.close(thread);
    sessions.end(thread);
    rests.cancel(thread);
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

    renewals.connecting(thread);
    sessions.track(thread, was, line);
    const read = await waiting.catchUp(thread, line);
    const { phase } = sessions.of(thread);

    if (phase.is !== "live" || phase.line !== line) {
      return;
    }

    const given = waiting.connected(thread, line, read);
    turns.connected(thread, given.length > 0);
    renewals.noteAwaited(thread);
    rests.rest(thread);
    renewals.connected(thread);
    sessions.noteRunning(thread, line);

    if (was.is === "launching") {
      wentThrough("start");
    }
  }

  async function drop(thread: string, line: Line) {
    if (!sessions.dropped(thread, line)) {
      return;
    }

    const resting = rests.of(thread);
    await turnEnded(thread);

    if (resting.leaving) {
      forget(thread, resting.leaving);

      return;
    }

    await waiting.markAll(thread);
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
        await inbox.took(request.taken, request.session);

        if (request.failed === true) {
          stalls.stall(request.thread, request.error, request.said);
        } else {
          stalls.passed(request.thread, request.busy);
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
        await inbox.inbound(request.thread, {
          content: request.content,
          meta: request.meta ?? {},
          ...(request.key !== undefined && { key: request.key }),
          author: request.author,
        });

        return;
      }

      case "tookHeld": {
        inbox.tookHeld(request.thread, request.keys);

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

  function halt(thread: string) {
    failing.halted(thread);

    return stops.stop(thread);
  }

  if (present(main) || threads.ids().length > 0) {
    void (async () => {
      await sessions.hubStarted(await claude.agents(serving));
      inbox.wake();
    })();
  }

  const unwatch = await kept((store) => store.watch(inbox.wake), ignore);
  besides.hubStarted();
  const unschedule = present(generalThread) ? schedule(storeDir, hexDir, generalThread) : ignore;
  const unhold = present(generalThread) ? holding(storeDir) : ignore;

  const unrestart =
    present(generalThread) && journal !== undefined
      ? restarts(storeDir, generalThread, journal)
      : ignore;

  const api = {
    deliver: inbox.deliver,
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
    renewal: renewals.renewal,
    keep: renewals.keep,
    adrift: calls.drift,
    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // Once what this hub and every other in the process wrote can't be lost.
    synced: async () => {
      await landed();
      await owing.synced();
    },
    renew: renewals.renewAsked,
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
    interrupt: interrupts.interrupt,
    answer: (thread: string, request_id: string, behavior: "allow" | "deny") => {
      const { phase } = sessions.of(thread);

      if (phase.is === "live") {
        phase.line.send({ type: "permission", request_id, behavior });
      }
    },
    release: rests.release,
    adopt,
    follow: (thread: string, name: string, session: string, cwd?: string) => {
      threads.open(thread, { name, fork: session, ...(present(cwd) && { cwd }) });
    },
    history: (thread: string) =>
      kept((store) => history(store, thread, threads.current(thread)), []),
    retire: rests.retire,
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
        rests.cancel(thread);
        turns.close(thread);
        calls.hangUp(thread);
      }
    },
  };

  whenThrough("start", () => void sessions.retry(), closing.signal);
  whenThrough("turn", () => void rests.recompact(), closing.signal);
  whenThrough("turn", stalls.resume, closing.signal);
  whenThrough("turn", () => void besides.release(), closing.signal);

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
