import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";

import { z } from "zod";

import { begin, title as oneWord } from "../../hub/hub.ts";
import type { Held, VoiceLine } from "../../hub/hub.ts";
import { open } from "../../hub/store.ts";
import { findThread, followAgent, followThread } from "./activity.ts";
import type { Step, Thread } from "./activity.ts";
import { Board, opener } from "./board.ts";
import type { Page, Run } from "./board.ts";
import { Call, transcript } from "./call.ts";
import type { Mark, Sent, Speaker, Task } from "./call.ts";
import { CallLog, ending, usage } from "./calls.ts";
import type { CallRecord, Ending, Source } from "./calls.ts";
import { Changes } from "./changes.ts";
import type { tools } from "./channel.ts";
import { Chats } from "./chat.ts";
import type { Where } from "./chat.ts";
import { PORT, STATE_DIR, env } from "./env.ts";
import { line, Media } from "./media.ts";
import type { Item } from "./media.ts";
import { jobs, overall } from "./overall.ts";
import page from "./page.html" with { type: "text" };
import { clip, Questions } from "./questions.ts";
import type { Question } from "./questions.ts";
import { relay } from "./relay.ts";

function filled(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

// SAFETY: Bun's global WebSocket takes Bun.WebSocketOptions, headers among them; with lib "dom" loaded, its type shows only the browser's constructor.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the assertion widens the constructor to the options Bun's WebSocket accepts
const BunWebSocket = WebSocket as new (
  url: string,
  options: Bun.WebSocketOptions | string[],
) => WebSocket;

const KEY = env.OPENAI_API_KEY;
const VOICE = env.VOICE;
const MODEL = env.VOICE_MODEL ?? "gpt-live-1";
const API = `${env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"}/live/sessions`;
const TWILIO_SID = env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = env.TWILIO_NUMBER;
const TWILIO_API = env.TWILIO_BASE_URL ?? "https://api.twilio.com";
const CALLER_NUMBER = env.CALLER_NUMBER;
const PUBLIC_HOST = env.VOICE_PUBLIC_URL?.replace(/^\w+:\/\//u, "");

const PUBLIC_HOSTNAME = filled(PUBLIC_HOST)
  ? URL.parse(`https://${PUBLIC_HOST}`)?.hostname
  : undefined;

const TOKEN = env.VOICE_TOKEN;
const calls = new CallLog(join(STATE_DIR, "calls"));
const activity = new Changes();
const follows = new Map<string, () => void>();
let board: Board;
let yours: Questions;
let chats: Chats;
let media: Media;

const IDENTITY = (() => {
  try {
    return readFileSync(
      env.VOICE_INSTRUCTIONS ?? join(STATE_DIR, "instructions.md"),
      "utf-8",
    ).trim();
  } catch {
    return "You are the voice of a personal assistant, on a live call with the person it works for. Speak warmly and naturally, like a sharp friend: plain words, short answers.";
  }
})();

const VOICE_PROMPT = `${IDENTITY}

Backchannel policy: Use moderate backchannels. Acknowledge naturally without competing with the main response.

Interruption policy: Stop speaking when the caller interrupts. Listen to what they say.

Delegation policy:
Backend tools:
- Assistant: the caller's files, machines, projects, memory, messages, email, calendar and the web. It looks things up, takes actions, runs long tasks and ends the call. It also has the call's full transcript and knows what was sent, seen and done.

You and Assistant are both hex: what Assistant knows and can do, hex knows and can do. You yourself know only this conversation and what Assistant tells you, so questions about hex, its knowledge or the call itself are Assistant's to answer.

Generate <|SpawnThinking|> when:
- The caller asks something, wants something done or asks you to tell them what's going on, including how a task is going, what's running, and hanging up. Your task board holds only what this call started, never everything hex runs.
- The caller asks what you heard, know, can see or can do, or whether something happened or was done.
- The caller challenges something you said.
- A correction changes the work already requested.

Do not generate <|SpawnThinking|> when:
- The caller only greets or thanks you.
- You can answer from the conversation or a still-current result.
- You need a brief clarification to understand the request.

Generate <|SpawnThinking|> before giving an answer that depends on backend work, then tell the caller in a few words that you're on it.
Do not guess the result while waiting.
Say something is done only when the backend says so.
Say the audio cut, that you lack information, or that you can't see or do something only when the backend says so.`;

const MediaBody = z.object({ media: z.string() });

const StartBody = z.object({
  sdp: z.string().exactOptional(),
  voice: z.string().exactOptional(),
  from: z.string().exactOptional(),
  about: z.string().exactOptional(),
});

const InterruptionBody = z.object({
  kind: z.enum(["paused", "resumed"]),
  text: z.string().exactOptional(),
});

const EndBody = z.object({ sessionId: z.string() });

const AnswerBody = z.object({ label: z.string() });

const NoteBody = z.object({ text: z.string() });

const ChatBody = z.object({
  media: z.array(z.string()).default([]),
  text: z.string().default(""),
  key: z.unknown(),
});

const ChatKey = z.string().regex(/^app-[\w-]{8,60}$/u);

async function bodyOf<Schema extends z.ZodType>(request: Request, schema: Schema) {
  const parsed = schema.safeParse(await request.json().catch(() => null));

  return parsed.success ? parsed.data : undefined;
}

const SessionCreated = z.looseObject({
  session: z.looseObject({ id: z.string(), expires_at: z.number().exactOptional() }),
});

const ErrorDetail = z.looseObject({
  message: z.string().exactOptional(),
  client_event_id: z.string().exactOptional(),
  event_id: z.string().exactOptional(),
});

const Transcript = z.object({
  delta: z.string(),
  start_ms: z.number(),
  end_ms: z.number().exactOptional(),
});

const SessionUsage = z.object({ seconds: z.number() });

const VoiceEvent = z.discriminatedUnion("type", [
  Transcript.extend({ type: z.literal("session.input_transcript.delta") }),
  Transcript.extend({ type: z.literal("session.output_transcript.delta") }),
  z.object({
    type: z.literal("session.delegation.created"),
    delegation: z.object({ target: z.string().exactOptional(), id: z.string() }).exactOptional(),
    offset_ms: z.number().exactOptional(),
  }),
  z.object({
    type: z.enum([
      "session.commentary.appended",
      "session.thinking.appended",
      "session.instructions.appended",
    ]),
    client_event_id: z.string().exactOptional(),
  }),
  z.looseObject({
    type: z.literal("error"),
    client_event_id: z.string().exactOptional(),
    error: ErrorDetail.optional().catch(undefined),
  }),
  z.object({ type: z.literal("session.output_audio.delta"), delta: z.string() }),
  z.object({
    type: z.literal("session.usage.updated"),
    usage: SessionUsage,
    context_window: z.object({ usage_ratio: z.number().exactOptional() }).exactOptional(),
  }),
  z.object({
    type: z.literal("session.closed"),
    usage: SessionUsage.exactOptional(),
    reason: z.string().exactOptional(),
    client_event_id: z.string().exactOptional(),
  }),
]);

const SessionEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("error"), error: ErrorDetail.optional().catch(undefined) }),
  z.object({
    type: z.literal("session.started"),
    session: z.object({ id: z.string(), expires_at: z.number().exactOptional() }),
  }),
]);

const TwilioForm = z.record(z.string(), z.string());

const TwilioMessage = z.discriminatedUnion("event", [
  z.object({ event: z.literal("start"), start: z.object({ streamSid: z.string() }) }),
  z.object({ event: z.literal("stop") }),
  z.object({ event: z.literal("mark") }),
  z.object({ event: z.literal("media"), media: z.object({ payload: z.string() }) }),
]);

const Problem = z.object({
  error: z.object({ message: z.string() }).optional().catch(undefined),
  message: z.string().optional().catch(undefined),
});

const fineIfUnconfirmed = () => null;

type Pending = { resolve: () => void; reject: (error: Error) => void };

type Ring = { delegation: string; offset: number };

type Heard = (who: Speaker, startOnSessionTimeline: number, text: string) => void;

type Live = {
  id: string;
  shown: Map<string, Question>;
  socket: WebSocket;
  call: Call;
  record: Omit<CallRecord, "turns" | "tasks" | "moments">;
  pending: Map<string, Pending>;
  rings: Ring[];
  changes: Changes;
  spoke: number;
  warning?: ReturnType<typeof setTimeout>;
  speak?: ((audio: string) => void) | undefined;
  heard?: Heard | undefined;
  closing?: string;
  closed?: true;
};

type Attaching = { id: string; closing?: string };

type Placed = {
  to: string;
  why?: string | undefined;
  started: string;
  session?: string;
  notesForWhenItConnects: string[];
};

type Dial = {
  greeting: string;
  from: Source;
  token: string;
  why?: string | undefined;
  callee?: string;
  move?: boolean | undefined;
};

type Phone = Dial & {
  openai?: WebSocket;
  stream?: string;
  started?: true;
  refused?: true;
  unplayedChunks: number;
  voiceBeganAt?: number | undefined;
};

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* What the call engine asks of the voice thread's hub: hand its session a message, hold the
   session for a call (keep) or let it start over for the next (renew), wait for a renew on its
   way, and name the session now serving the thread. */
export type Hub = {
  deliver: (content: string, meta: Record<string, string>) => void;
  keep: () => Promise<void>;
  renew: () => void;
  renewal: () => Promise<void>;
  session: () => string | undefined;
};

type Args = { [Each in (typeof tools)[number] as Each["name"]]: z.output<Each["input"]> };

type ToolCall = { [Name in keyof Args]: [name: Name, args: Args[Name]] }[keyof Args];

let hub: Hub;
let HEX_STATE: string;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* Every step to the hub in the order the calls take them; a new call's first step waits out the
   last call's renew, so the new call's words reach the new session. */
let hubStepsInCallOrder = Promise.resolve();
let live: Live | undefined;

let attaching: Attaching | undefined;
let ended: string | undefined;
let seq = 0;
const dials = new Map<string, Dial>();
const placed = new Map<string, Placed>();
const RETRIES = [250, 1000, 2000, 4000, 8000];
const WARN_BEFORE = 120_000;
const HANDOFF_WAIT = 3000;
const ACK_WAIT = 10_000;

export async function tool(...[name, args]: ToolCall): Promise<string> {
  if (name === "running") {
    board.refresh();

    return overall(
      board.runs,
      board.strays(),
      await jobs(),
      open(HEX_STATE).names(),
      Date.now(),
      yours.view.asks,
    );
  }

  if (name === "phone") {
    return await dial(args);
  }

  if (name === "title") {
    return title(args.call, args);
  }

  if (name === "task") {
    return await task(args.id, args.state, args.text, args.call, args.agent);
  }

  if (name === "send") {
    return await pass(args.thread, args.about, args.text, args.app, args.channel);
  }

  if (name === "answer") {
    return await answerQuestion(args.id, args.label, "call").then(
      (sent) => `sent "${args.label}" to ${sent.topic}${missed(sent)}`,
    );
  }

  if (name === "note" && !live) {
    const ringing = [...placed.values()].findLast((call) => !filled(call.session));

    if (ringing) {
      ringing.notesForWhenItConnects.push(args.text);

      return "the call is still ringing; the voice gets this when it connects";
    }
  }

  if (name === "hang_up" && !live && attaching) {
    retire(attaching, `close_hex_${++seq}`);

    return "hung up; the voice gets its close once the connection is back";
  }

  if (!live) {
    throw new Error("no call is live");
  }

  switch (name) {
    case "say": {
      await tell(live, "say", args.text, args.delegation_id);

      return "said";
    }

    case "note": {
      await tell(live, "note", args.text, args.delegation_id);

      return "noted";
    }

    case "hang_up": {
      return await hangUpCall(live);
    }

    case "ask": {
      return showAsACardInTheTranscript(live, args.id);
    }

    default: {
      throw new Error(`unknown tool ${String(name)}`);
    }
  }
}

function send(call: Live, type: string, content: string, delegation?: string) {
  if (call.socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(
      new Error("the connection to the voice is coming back; try again in a few seconds"),
    );
  }

  const event_id = `${type.split(".")[1]}_${++seq}`;
  call.socket.send(JSON.stringify({ type, event_id, delegation_id: delegation ?? null, content }));

  return new Promise<void>((resolve, reject) => {
    const unconfirmedWouldHoldTheVoiceSessionsTurn = setTimeout(() => {
      call.pending.delete(event_id);
      reject(
        new Error(`the voice didn't confirm it within ${ACK_WAIT / 1000}s, so it may not have it`),
      );
    }, ACK_WAIT);

    const settled =
      <T>(then: (value: T) => void) =>
      (value: T) => {
        clearTimeout(unconfirmedWouldHoldTheVoiceSessionsTurn);
        then(value);
      };

    call.pending.set(event_id, { resolve: settled(resolve), reject: settled(reject) });
  });
}

async function tell(call: Live, kind: "say" | "note", text: string, delegation?: string) {
  await send(
    call,
    kind === "say" ? "session.commentary.append" : "session.thinking.append",
    text,
    delegation,
  );
  remember(call, kind, text);
}

function since(call: Live) {
  return Date.now() - Date.parse(call.record.started);
}

function remember(
  call: Live,
  kind: Mark["kind"],
  text: string,
  more: Pick<Mark, "ask" | "sent" | "media"> = {},
) {
  call.call.mark({ at: since(call), kind, text, ...more });
  save(call);
}

function save(call: Live) {
  calls.save(whole(call));
  call.changes.changed();
}

function whole(call: Live): CallRecord {
  return { ...call.record, ...call.call.record() };
}

async function task(
  id: string,
  state: Task["state"],
  text: string,
  call = live?.id ?? ended,
  agent?: string,
) {
  if (!filled(call)) {
    throw new Error("no call yet");
  }

  if (filled(agent) || state !== "running") {
    stop(call, id);
  }

  const following =
    live?.id === call && state === "running" && filled(agent)
      ? followAgent(agent, hub.session(), (step) => {
          see(call, id, step);
        })
      : undefined;

  if (following) {
    follows.set(`${call} ${id}`, () => {
      void following();
    });
  }

  const result = await mark(call, {
    ...current(call, id),
    id,
    state,
    text,
    ...(filled(agent) && { agent }),
  });

  return filled(agent) && live?.id === call && !following
    ? `${result}, but no transcript of agent ${agent} turned up, so the caller won't see its steps`
    : result;
}

async function pass(
  name: string,
  about: string,
  text: string,
  newThreadIn?: string,
  where?: string,
  call = live?.id ?? ended,
) {
  const known = filled(newThreadIn) ? undefined : findThread(HEX_STATE, name);

  if (!filled(newThreadIn) && !known) {
    throw new Error(`no hex thread is named ${name}; pass app to open one`);
  }

  if (filled(call) && live?.id !== call) {
    past(call);
  }

  const id = filled(call) ? fresh(call, about) : "";
  const meta = { user: "hex voice", ...(filled(id) && { voice_task: `${call}:${id}` }) };
  let thread = known;

  if (filled(newThreadIn)) {
    const opened = await begin(
      newThreadIn,
      oneWord(name),
      { content: text, author: "prompt", meta },
      { about: `From a call: ${about}`, ...(where !== undefined && { where }) },
    );

    thread = { app: newThreadIn, id: opened.thread, name, state: HEX_STATE };
  }

  if (!thread) {
    throw new Error(`no hex thread is named ${name}; pass app to open one`);
  }

  const toldTheVoiceWithoutHoldingUpTheWork =
    filled(call) && filled(id)
      ? mark(call, {
          id,
          state: "running",
          text: about,
          to: thread.name,
          agent: `${thread.app}:${thread.id}`,
        }).then(
          () => true,
          () => false,
        )
      : true;

  if (filled(call) && filled(id)) {
    watch(call, id, thread, filled(newThreadIn));
  }

  if (!filled(newThreadIn)) {
    try {
      await relay(HEX_STATE, thread.app, {
        type: "inbound",
        thread: thread.id,
        content: text,
        meta,
      });
    } catch (error) {
      if (filled(call) && filled(id)) {
        see(call, id, { end: "failed" });
      }

      throw error;
    }
  }

  const sent = filled(newThreadIn) ? `opened ${name} in ${newThreadIn}` : `sent to ${thread.name}`;

  if (!filled(id)) {
    return sent;
  }

  const told = await toldTheVoiceWithoutHoldingUpTheWork;

  return told
    ? `${sent}, on the board as ${id}`
    : `${sent}, on the board as ${id}, but the voice may not have heard of it; the work went out, so it needn't be sent again`;
}

function followWorkPastCallsSentOut() {
  const dayAgo = Date.now() - 24 * 60 * 60_000;

  for (const { id: call, started } of calls.list()) {
    if (Date.parse(started) < dayAgo) {
      break;
    }

    const latest = new Map(past(call).tasks.map((each) => [each.id, each]));

    for (const each of latest.values()) {
      let thread: Thread | undefined;

      try {
        thread =
          each.state === "running" && filled(each.to) && filled(each.agent)
            ? findThread(HEX_STATE, each.agent)
            : undefined;
      } catch (error) {
        process.stderr.write(
          `voice: ${call}'s task ${each.id} isn't followed again: ${String(error)}\n`,
        );
      }

      if (thread) {
        watch(call, each.id, thread, true);
      }
    }
  }
}

function watch(call: string, id: string, thread: Thread, readFromTheSessionsStart: boolean) {
  stop(call, id);
  const stops: (() => void)[] = [];
  let stopped = false;

  const holdOrStopAtOnceIfStopped = (off: () => void) => {
    if (stopped) {
      off();
    } else {
      stops.push(off);
    }
  };

  follows.set(`${call} ${id}`, () => {
    stopped = true;

    for (const off of stops.splice(0)) {
      off();
    }
  });
  holdOrStopAtOnceIfStopped(
    followThread(thread, dirname(HEX_STATE), `${call}:${id}`, readFromTheSessionsStart, (step) => {
      if (step.end === undefined) {
        see(call, id, step);
      } else {
        followTheBoardRowUntilItRests(call, id, thread, step.end, holdOrStopAtOnceIfStopped);
      }
    }),
  );
}

function followTheBoardRowUntilItRests(
  call: string,
  id: string,
  thread: Thread,
  end: NonNullable<Step["end"]>,
  hold: (off: () => void) => void,
) {
  const check = () => {
    const row = board.get(`${thread.app}:${thread.id}`);

    if (row?.state === "working") {
      see(call, id, { line: newest(row) });
    } else {
      see(call, id, { end: row?.state === "failed" ? "failed" : end });
    }
  };

  hold(board.listen(check));
  check();
}

function newest(row: Run) {
  return (
    row.agents.find((agent) => agent.state === "working" && filled(agent.line))?.line ?? row.line
  );
}

function fresh(call: string, about: string) {
  const slug = about
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 40);

  const stem = slug === "" ? "sent" : slug;
  let id = stem;

  for (let n = 2; current(call, id) !== undefined; n++) {
    id = `${stem}-${n}`;
  }

  return id;
}

function current(call: string, id: string): Task | undefined {
  if (live?.id === call) {
    return live.call.task(id);
  }

  const moment = calls.get(call)?.tasks.findLast((each) => each.id === id);

  if (!moment) {
    return;
  }

  const { at: _at, ...latest } = moment;

  return latest;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* The change is on the call's record when mark returns, or it throws; what it returns settles once
   the voice has heard of it, on a live call. */
function mark(call: string, change: Task): Promise<string> {
  if (live?.id === call) {
    live.call.track(change, Date.now() - Date.parse(live.record.started));
    save(live);
    activity.changed();

    return send(live, "session.thinking.append", live.call.change(change.id)).then(
      () => "board updated",
    );
  }

  const record = past(call);
  calls.save({
    ...record,
    tasks: [...record.tasks, { ...change, at: Date.now() - Date.parse(record.started) }],
  });

  return Promise.resolve("that call has ended, so only its record changed");
}

function see(call: string, id: string, { line: newLine, end }: Step) {
  if (filled(newLine) && live?.id === call && live.call.see(id, newLine)) {
    activity.changed();
  }

  if (end === undefined) {
    return;
  }

  stop(call, id);
  const running = current(call, id);

  if (running?.state !== "running") {
    return;
  }

  const unheard = (cause: unknown) => {
    trace(`the voice didn't hear ${id} ${end}: ${messageOf(cause)}`);
  };

  try {
    void mark(call, { ...running, state: end }).catch(unheard);
  } catch (error) {
    trace(`couldn't mark ${id} ${end}: ${messageOf(error)}`);
  }
}

function messageOf(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function stop(call: string, id: string) {
  follows.get(`${call} ${id}`)?.();
  follows.delete(`${call} ${id}`);
}

function title(
  call: string,
  {
    title: name,
    summary,
    waiting,
  }: { title?: string | undefined; summary?: string | undefined; waiting?: string[] | undefined },
) {
  const change: Pick<CallRecord, "title" | "summary" | "waiting"> = {};

  if (filled(name)) {
    change.title = name;
  }

  if (filled(summary)) {
    change.summary = summary;
  }

  if (Array.isArray(waiting)) {
    change.waiting = waiting;
  }

  if (live?.id === call) {
    Object.assign(live.record, change);
    save(live);
  } else {
    calls.save({ ...past(call), ...change });
  }

  if (Array.isArray(waiting)) {
    yours.called();
  }

  return "saved";
}

function past(id: string) {
  const record = calls.get(id);

  if (!record) {
    throw new Error(`no call ${id}`);
  }

  return record;
}

async function hangUpCall(call: Live) {
  const asked = Date.now();
  const stillLive = () => live === call;
  const voiceSpokeLately = () => Date.now() - Math.max(asked, call.spoke) < 2000;

  while (stillLive() && Date.now() - asked < 20_000 && voiceSpokeLately()) {
    await Bun.sleep(250);
  }

  if (live !== call) {
    return "the call had already ended";
  }

  close(call, `close_hex_${++seq}`);

  return "hanging up";
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* The caller or hex hangs up, and the first hang-up is the one the call ends by. Each goes out at
   once over an open connection to the voice, so a later one retries a close the session didn't act
   on; without one, the first goes out once one opens or, if the call ends first, on a connection
   opened just for it. A phone or Discord call's socket is its session, so once that socket isn't
   open there's nothing left to close. */
function close(call: Live, event: string) {
  const state = call.socket.readyState;
  const socketIsTheSession = call.speak !== undefined;

  if (socketIsTheSession && state !== WebSocket.OPEN) {
    return;
  }

  call.closing ??= event;

  if (state === WebSocket.OPEN) {
    sendClose(call, event);
  }
}

function sendClose(call: Live, event = call.closing, socket = call.socket) {
  socket.send(JSON.stringify({ type: "session.close", event_id: event }));
  call.closed = true;
}

function closeSession(id: string, event: string) {
  const socket = sideband(id);
  let sent = false;
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "session.close", event_id: event }));
    sent = true;
    socket.close();
  });

  socket.addEventListener("close", () => {
    if (!sent) {
      trace(`couldn't send ${id} its close (${event})`);
    }
  });
}

function deliver(content: string, meta: Record<string, string>) {
  const time = clock();
  toHub(() => {
    hub.deliver(content, { ...meta, time });
  });
}

function toHub(step: () => void | Promise<void>) {
  const previous = hubStepsInCallOrder;

  hubStepsInCallOrder = (async () => {
    await previous;

    try {
      await step();
    } catch (error) {
      trace(`the hub step failed: ${String(error)}`);
    }
  })();
}

function clock() {
  return new Date().toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function ring(call: Live, { delegation, offset }: Ring) {
  const turns = call.call.handOff();
  deliver(turns.length ? transcript(turns) : "(no new words since the last handoff)", {
    call: call.id,
    delegation_id: delegation,
    at: `${(offset / 1000).toFixed(1)}s`,
    ...(filled(call.record.callee) && { callee: call.record.callee }),
  });
  save(call);
}

function hear(call: Live, who: Speaker, event: z.output<typeof Transcript>) {
  const end = event.end_ms ?? event.start_ms;
  call.call.hear({ who, text: event.delta, start: event.start_ms, end });
  call.heard?.(who, event.start_ms, event.delta);
  call.changes.changed();

  for (let due = call.rings[0]; due && due.offset <= event.start_ms; due = call.rings[0]) {
    call.rings.shift();
    ring(call, due);
  }
}

const ENDINGS: Record<Ending, string> = {
  you: "the caller hung up",
  hex: "hex ended it",
  dropped: "the connection dropped",
  expired: "it hit its time limit",
  "no-connect": "it never connected",
  "no-answer": "nobody answered",
  busy: "the line was busy",
};

function finish(call: Live, reason: string, by?: string) {
  if (live !== call) {
    return;
  }

  live = undefined;
  ended = call.id;
  clearTimeout(call.warning);
  const end = ending(reason, by);

  for (const pending of call.pending.values()) {
    pending.reject(new Error(`the call ended (${reason})`));
  }

  for (const each of call.call.activity()) {
    const subagentWhoseStepsShowOnlyOnTheLiveCall = filled(each.agent) && !filled(each.to);

    if (subagentWhoseStepsShowOnlyOnTheLiveCall) {
      stop(call.id, each.id);
    }
  }

  for (const pending of call.rings.splice(0)) {
    ring(call, pending);
  }

  const rest = call.call.handOff();
  call.record = { ...call.record, ended: new Date().toISOString(), end, reason };
  save(call);
  activity.changed();
  deliver(
    [
      `The call ended: ${ENDINGS[end]} (${reason}). Name it with title.`,
      ...(rest.length ? ["Last words:", transcript(rest)] : []),
    ].join("\n"),
    {
      call: call.id,
      ended: end,
      reason,
      ...(filled(call.record.callee) && { callee: call.record.callee }),
    },
  );
  toHub(hub.renew);
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- clears the reconnect handler listen() set
  call.socket.onclose = null;
  call.socket.close();

  if (filled(call.closing) && call.closed !== true && call.speak === undefined) {
    closeSession(call.id, call.closing);
  }
}

type Failure = Required<Pick<CallRecord, "from" | "end" | "reason">> & Partial<CallRecord>;

function failed(record: Failure, to?: string) {
  const now = new Date().toISOString();
  const id = record.id ?? `failed-${Date.now().toString(36)}`;
  calls.save({ id, started: now, turns: [], tasks: [], ...record, ended: now });

  const where =
    record.from === "phone-out"
      ? `Your phone call to ${to ?? "the caller"}`
      : `A call from ${record.from === "phone-in" ? "the caller's phone" : record.from === "discord" ? "a Discord voice channel" : `the ${record.from}`}`;

  deliver(
    [
      `${where} didn't happen: ${ENDINGS[record.end]} (${record.reason}).`,
      ...(filled(record.why) ? [`You were calling because: ${record.why}`] : []),
    ].join("\n"),
    { call: id, ended: record.end, reason: record.reason },
  );
  trace(`${id} ${record.end}: ${record.reason}`);
}

function follow(
  socket: WebSocket,
  record: Live["record"],
  {
    call = new Call(),
    speak,
    heard,
    notes = [],
    hello,
    about,
  }: {
    call?: Call;
    speak?: Live["speak"];
    heard?: Live["heard"];
    notes?: string[] | undefined;
    hello?: string;
    about?: Topic | undefined;
  } = {},
) {
  if (live) {
    const by = live.closing;
    close(live, "close-you-moved");
    finish(
      live,
      filled(by) ? "close_requested" : "moved to a new call",
      live.closing ?? "close-you-moved",
    );
  }

  if (attaching) {
    retire(attaching, "close-you-moved");
  }

  const next: Live = {
    id: record.id,
    shown: new Map(),
    socket,
    call,
    record,
    pending: new Map(),
    rings: [],
    changes: new Changes(),
    spoke: 0,
    speak,
    heard,
  };

  live = next;
  save(next);
  activity.changed();
  toHub(async () => {
    await hub.renewal();
    await hub.keep();
    const claude = hub.session();

    if (claude === undefined) {
      delete next.record.claude;
    } else {
      next.record.claude = claude;
    }
  });
  listen(next, socket);
  warn(next);
  deliver(
    hello ??
      [
        `A call started.${filled(record.why) ? ` You placed it because: ${record.why}` : ""}`,
        ...(about ? [about.claude] : []),
        "Send the voice what it should know right away, with note.",
      ].join("\n"),
    { call: record.id, started: "true", from: record.from, ...(about && { task: about.id }) },
  );

  for (const text of notes.splice(0)) {
    void tell(next, "note", text).catch(fineIfUnconfirmed);
  }

  return next;
}

type Topic = { id: string; claude: string; voice: string };

function runTopic(run: Run): Topic {
  return {
    id: run.id,
    claude: `The caller started it with Talk it through on a task. ${opener(run)}`,
    voice: `The caller tapped Talk it through on a task, so bring it up now in a sentence or two, then listen. ${opener(run)}`,
  };
}

function halfDone({ partly, undoing }: Question) {
  if (undoing === true) {
    return " [taking back its answer stopped partway: only Undo in the app finishes it]";
  }

  return filled(partly)
    ? ` ["${partly}" already went out to part of it: only "${partly}" finishes it, or Undo in the app]`
    : "";
}

function walkTopic(questions: Question[]): Topic {
  const list = questions.map(
    (question, i) =>
      `${i + 1}. ${question.id} · ${question.topic} · ${question.question}${filled(question.context) ? ` (${clip(question.context.replaceAll(/\s+/gu, " ").trim(), 280)})` : ""} Options: ${question.options.map((option) => `${option.label}${option.pick === true ? " (hex’s pick)" : ""}`).join(" / ")}${filled(question.tag) ? ` [${question.tag}]` : ""}${halfDone(question)}`,
  );

  return {
    id: "asks",
    claude: [
      `The caller tapped Go through them with hex: walk them through the ${questions.length} things waiting on them, one at a time, in this order. For each, put it on screen with ask, say it in a sentence or two with hex's pick if it has one, and listen. When they say a choice, answer sends it to the thread that asked; when they tap the card instead, a message tells you. Move on when they skip one. Say so when a choice costs money or goes out in their name.`,
      ...list,
    ].join("\n"),
    voice: `The caller wants to go through what's waiting on them, one at a time. Generate <|SpawnThinking|> now, then say you'll start with the first one: the backend brings each one up.`,
  };
}

function talkAbout(topic: Topic) {
  if (!live) {
    return new Response("No call is live", { status: 409 });
  }

  deliver(`The caller asked for this from the app during the call. ${topic.claude}`, {
    call: live.id,
    task: topic.id,
  });
  void send(live, "session.instructions.append", topic.voice).catch(fineIfUnconfirmed);

  return new Response(null, { status: 204 });
}

async function showMedia(request: Request, id: string) {
  const sent = await bodyOf(request, MediaBody);
  const item = sent && media.get(sent.media);

  if (!item) {
    return new Response("Name a photo or video sent to /media", { status: 400 });
  }

  if (live?.id !== id) {
    return new Response("That call is not live", { status: 409 });
  }

  remember(live, item.kind, "", { media: item.id });
  deliver(`The caller sent this from the app: ${line(item)}`, {
    call: live.id,
    image_path: item.images.join("; "),
  });
  void send(
    live,
    "session.instructions.append",
    `The caller just sent a ${item.kind} in the app. Only Assistant can see it: generate <|SpawnThinking|> now, then tell the caller in a few words that you're having a look.`,
  ).catch(fineIfUnconfirmed);

  return new Response(null, { status: 204 });
}

async function upload(request: Request) {
  const type = request.headers.get("content-type");

  if (type === null || type === "" || !Media.takes(type)) {
    return new Response("Send a JPEG, PNG or HEIC photo, or an MP4 or QuickTime video", {
      status: 415,
    });
  }

  try {
    const { id, kind } = await media.add(type, await request.blob());

    return Response.json({ id, kind }, { status: 201 });
  } catch (error) {
    return new Response(messageOf(error), { status: 422 });
  }
}

function showImage(id: string) {
  const image = media.get(id)?.images[0];

  return image === undefined ? new Response("404", { status: 404 }) : new Response(Bun.file(image));
}

function showAsACardInTheTranscript(call: Live, id: string) {
  const question = yours.find(id);

  if (!question) {
    throw new Error(`no open ask ${id}`);
  }

  call.shown.set(id, question);
  remember(call, "ask", question.question, { ask: id });
  activity.changed();

  return `showing "${question.question}" to the caller`;
}

function missed({ missed: unreached }: Sent) {
  return unreached ? `, but ${unreached} of its copies or threads couldn't be reached` : "";
}

async function answerQuestion(id: string, label: string, via: "call" | "app") {
  const call = live;
  const question = yours.find(id) ?? call?.shown.get(id);
  const sent = await yours.answer(id, label, via);

  if (call && live === call && question) {
    call.shown.set(id, question);
    remember(call, "answered", label, { ask: id, sent });
    activity.changed();
  }

  return sent;
}

function listen(call: Live, socket: WebSocket, attempt = 0) {
  const opened = Date.now();

  const hungUp = () => {
    if (filled(call.closing) && call.closed !== true && live === call) {
      sendClose(call);
    }
  };

  if (socket.readyState === WebSocket.OPEN) {
    hungUp();
  } else {
    socket.addEventListener("open", hungUp, { once: true });
  }

  socket.addEventListener("message", ({ data }) => {
    const parsed = VoiceEvent.safeParse(JSON.parse(String(data)));

    if (!parsed.success) {
      return;
    }

    const event = parsed.data;

    switch (event.type) {
      case "session.input_transcript.delta": {
        hear(call, "you", event);

        return;
      }

      case "session.output_transcript.delta": {
        call.spoke = Date.now();
        hear(call, "voice", event);

        return;
      }

      case "session.delegation.created": {
        if (event.delegation?.target !== "client") {
          return;
        }

        const pending = { delegation: event.delegation.id, offset: event.offset_ms ?? Number.NaN };
        call.rings.push(pending);

        const goesWithoutTheWordsAfterIt = () => {
          const i = live === call ? call.rings.indexOf(pending) : -1;

          for (const due of i < 0 ? [] : call.rings.splice(0, i + 1)) {
            ring(call, due);
          }
        };

        setTimeout(goesWithoutTheWordsAfterIt, HANDOFF_WAIT);

        return;
      }

      case "session.commentary.appended":
      case "session.thinking.appended":
      case "session.instructions.appended": {
        const confirmed = event.client_event_id ?? "";
        call.pending.get(confirmed)?.resolve();
        call.pending.delete(confirmed);

        return;
      }

      case "error": {
        const id =
          event.client_event_id ?? event.error?.client_event_id ?? event.error?.event_id ?? "";

        const refused = call.pending.get(id);
        call.pending.delete(id);

        if (refused) {
          refused.reject(new Error(event.error?.message ?? JSON.stringify(event)));

          return;
        }

        trace(JSON.stringify(event));

        return;
      }

      case "session.output_audio.delta": {
        call.spoke = Date.now();
        call.speak?.(event.delta);

        return;
      }

      case "session.usage.updated": {
        call.record.usage = usage(
          event.usage.seconds,
          event.context_window?.usage_ratio ?? call.record.usage?.context,
        );

        return;
      }

      case "session.closed": {
        if (event.usage) {
          call.record.usage = usage(event.usage.seconds, call.record.usage?.context);
        }

        finish(
          call,
          event.reason ?? "closed",
          event.reason === "close_requested" && filled(call.closing)
            ? call.closing
            : event.client_event_id,
        );
      }
    }
  });

  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- replaces the close handler a reattach set
  socket.onclose = () => {
    reconnect(call, Date.now() - opened < 5000 ? attempt + 1 : 0);
  };
}

function reconnect(call: Live, attempt: number) {
  if (live !== call) {
    return;
  }

  for (const pending of call.pending.values()) {
    pending.reject(
      new Error(
        "the connection to the voice dropped and is coming back; try again in a few seconds",
      ),
    );
  }

  call.pending.clear();
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  /* A close sent on the dropped connection may never have reached the session, so it goes out
     again. */
  delete call.closed;

  const socketIsTheSession = call.speak !== undefined;

  if (socketIsTheSession || attempt >= RETRIES.length) {
    const appCallWouldGoOnWithNothingBehindTheVoice = !filled(call.closing) && !socketIsTheSession;

    finish(call, filled(call.closing) ? "close_requested" : "connection_lost", call.closing);

    if (appCallWouldGoOnWithNothingBehindTheVoice) {
      closeSession(call.id, `close_hex_${++seq}`);
    }

    return;
  }

  trace(`lost the connection to ${call.id}, reattaching (try ${attempt + 1})`);
  setTimeout(() => {
    if (live !== call) {
      return;
    }

    const socket = sideband(call.id);
    socket.addEventListener("open", () => {
      if (live !== call) {
        if (filled(call.closing) && call.closed !== true) {
          sendClose(call, call.closing, socket);
        }

        socket.close();

        return;
      }

      trace(`reattached to ${call.id}`);
      call.socket = socket;
      listen(call, socket, attempt);
    });

    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- listen() replaces it once the socket opens
    socket.onclose = () => {
      reconnect(call, attempt + 1);
    };
  }, RETRIES[attempt]);
}

function warn(call: Live) {
  const { expires } = call.record;

  if (!filled(expires)) {
    return;
  }

  const left = Date.parse(expires) - Date.now();

  if (!(left > WARN_BEFORE)) {
    return;
  }

  call.warning = setTimeout(() => {
    if (live !== call) {
      return;
    }

    const at = new Date(Date.parse(expires)).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });

    remember(call, "warned", `Two minutes left: the call ends at ${at}`);
    void send(
      call,
      "session.instructions.append",
      "This call hits its time limit in about two minutes. Tell the caller now, in a sentence, so they can wrap up or call back.",
    ).catch(fineIfUnconfirmed);
    deliver(
      `This call hits its time limit at ${at}, about two minutes from now. Wrap up anything the caller needs before it ends.`,
      { call: call.id, expires },
    );
  }, left - WARN_BEFORE);
}

function voiceSocket(url: string) {
  return new BunWebSocket(url, { headers: { Authorization: `Bearer ${KEY}` } });
}

function sideband(id: string) {
  return voiceSocket(`${API}/${id}/attach`);
}

function expiry(seconds?: number) {
  return seconds === undefined || seconds === 0
    ? undefined
    : new Date(seconds * 1000).toISOString();
}

function base(id: string, from: Source, extra: Partial<CallRecord> = {}): Live["record"] {
  return { id, started: new Date().toISOString(), from, ...extra };
}

function recover() {
  const unended = calls.list().filter((call) => !filled(call.ended));

  for (const [i, { id }] of unended.entries()) {
    const record = calls.get(id);

    if (!record) {
      continue;
    }

    const latest =
      i === 0 &&
      filled(KEY) &&
      (record.from === "app" || record.from === "web") &&
      !(filled(record.expires) && Date.parse(record.expires) < Date.now());

    if (latest) {
      reattach(record);
    } else {
      closeOut(record);
    }
  }
}

function closeOut(record: CallRecord, hungUpWhileAttaching?: string) {
  const heard = Math.max(
    0,
    ...record.turns.map((turn) => turn.at),
    ...record.tasks.map((each) => each.at),
    ...(record.moments ?? []).map((moment) => moment.at),
  );

  const by = filled(hungUpWhileAttaching) ? hungUpWhileAttaching : undefined;

  const reason =
    by === "close-you-moved"
      ? "moved to a new call"
      : by === undefined
        ? "hex's service restarted and the call was gone"
        : "close_requested";

  const end = ending(reason, hungUpWhileAttaching);
  calls.save({
    ...record,
    ended:
      by === undefined
        ? new Date(Date.parse(record.started) + heard).toISOString()
        : new Date().toISOString(),
    end,
    reason,
  });
  trace(
    `closed out ${record.id}: ${by === undefined ? "it never got an end" : "hung up while it was picked back up"}`,
  );
  deliver(`The call ended: ${ENDINGS[end]} (${reason}). Name it with title.`, {
    call: record.id,
    ended: end,
    reason,
  });

  if (!live) {
    if (by !== undefined) {
      ended = record.id;
    }

    toHub(hub.renew);
  }
}

function retire(pending: Attaching, event: string) {
  attaching = undefined;
  pending.closing = event;
  const record = calls.get(pending.id);

  if (record) {
    closeOut(record, event);
  } else if (!live) {
    toHub(hub.renew);
  }
}

function reattach({ id }: CallRecord) {
  const socket = sideband(id);
  const pending: Attaching = { id };
  attaching = pending;
  socket.addEventListener("open", () => {
    if (attaching === pending) {
      attaching = undefined;
    }

    const record = filled(pending.closing) ? undefined : calls.get(id);

    if (!record || live) {
      socket.send(
        JSON.stringify({
          type: "session.close",
          event_id: pending.closing ?? `close_hex_${++seq}`,
        }),
      );
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- clears the handler below, which would close the call out again
      socket.onclose = null;
      socket.close();

      if (record) {
        closeOut(record);
      } else if (!live && !filled(pending.closing)) {
        toHub(hub.renew);
      }

      return;
    }

    const { turns, tasks, moments: _moments, ...rest } = record;
    const so = turns.slice(-40).map(({ who, at, text }) => ({ who, text, start: at }));
    trace(`picked ${record.id} back up after a restart`);
    follow(socket, rest, {
      call: Call.resume(record),
      hello: [
        `A call resumed: hex's service restarted during call ${record.id} and picked it back up. The caller is still on it, and the voice kept its own memory of the call.`,
        ...(filled(record.why) ? [`You placed it because: ${record.why}`] : []),
        ...(so.length ? ["The call so far:", transcript(so)] : []),
        ...(tasks.length ? [Call.resume(record).board()] : []),
      ].join("\n"),
    });
  });

  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- listen() replaces this handler once the call is live
  socket.onclose = () => {
    if (attaching === pending) {
      attaching = undefined;
    }

    if (filled(pending.closing)) {
      closeSession(id, pending.closing);

      return;
    }

    if (live?.id === id) {
      return;
    }

    const record = calls.get(id);

    if (record) {
      closeOut(record);
    } else if (!live) {
      toHub(hub.renew);
    }
  };
}

async function dial({
  to = CALLER_NUMBER,
  why,
  move = false,
}: { to?: string | undefined; why?: string | undefined; move?: boolean | undefined } = {}) {
  if (
    !filled(KEY) ||
    !filled(TWILIO_SID) ||
    !filled(TWILIO_TOKEN) ||
    !filled(TWILIO_NUMBER) ||
    !filled(PUBLIC_HOST)
  ) {
    throw new Error(
      `phone calls need TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER and VOICE_PUBLIC_URL in ${join(STATE_DIR, ".env")}`,
    );
  }

  if (!filled(to)) {
    throw new Error("no number to call: pass to, or set CALLER_NUMBER");
  }

  if (move && to !== CALLER_NUMBER) {
    throw new Error("a call moves only to the caller's own phone: leave out to");
  }

  if (live && filled(live.record.callee)) {
    throw new Error(
      move
        ? `hex is on a call to ${live.record.callee}; move once it ends`
        : `a call to ${live.record.callee} is live, and another would end it: ring again once it ends, which a message tells you`,
    );
  }

  if ((live || attaching) && !move) {
    throw new Error(
      "a call is live, and another would end it: tell the caller on this one with say or note",
    );
  }

  const token = crypto.randomUUID();

  const greeting = filled(why)
    ? `You placed this phone call because: ${why}. Greet them briefly and tell them why you're calling, then listen.`
    : "You placed this phone call. Greet them briefly first, then listen.";

  const youInTheTranscriptIsThem = to !== CALLER_NUMBER;
  dials.set(token, {
    greeting,
    from: "phone-out",
    token,
    why,
    move,
    ...(youInTheTranscriptIsThem && { callee: to }),
  });
  placed.set(token, { to, why, started: new Date().toISOString(), notesForWhenItConnects: [] });
  setTimeout(() => {
    if (!filled(placed.get(token)?.session)) {
      placed.delete(token);
    }
  }, 300_000);

  const response = await fetch(`${TWILIO_API}/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`)}` },
    body: new URLSearchParams({
      To: to,
      From: TWILIO_NUMBER,
      Url: `https://${PUBLIC_HOST}/twilio/${token}/twiml`,
      StatusCallback: `https://${PUBLIC_HOST}/twilio/status/${token}`,
    }),
  });

  if (!response.ok) {
    dials.delete(token);
    placed.delete(token);
    const reason = `Twilio refused the call: ${problem(await response.text())}`;
    failed({ from: "phone-out", end: "no-connect", reason, ...(why !== undefined && { why }) }, to);
    throw new Error(reason);
  }

  return `ringing ${to}; if nobody answers or it fails, a message tells you`;
}

async function phoneStatus(request: Request, token: string) {
  const form = await signed(request);

  if (!form) {
    return new Response("forbidden", { status: 403 });
  }

  const call = placed.get(token);
  const state = form.CallStatus ?? "null";
  trace(`Twilio call ${state}${filled(call?.session) ? ` (${call.session})` : ""}`);

  if (!call || !["completed", "busy", "no-answer", "failed", "canceled"].includes(state)) {
    return new Response(null, { status: 204 });
  }

  placed.delete(token);
  dials.delete(token);

  if (filled(call.session)) {
    return new Response(null, { status: 204 });
  }

  const error = filled(form.ErrorCode) ? `, Twilio error ${form.ErrorCode}` : "";
  failed(
    {
      ...(filled(form.CallSid) && { id: form.CallSid }),
      from: "phone-out",
      started: call.started,
      ...(call.why !== undefined && { why: call.why }),
      end: state === "busy" ? "busy" : state === "no-answer" ? "no-answer" : "no-connect",
      reason:
        state === "completed"
          ? `the phone picked up for ${form.CallDuration ?? 0}s but the voice never joined${error}`
          : `Twilio: ${state}${error}`,
    },
    call.to,
  );

  return new Response(null, { status: 204 });
}

type Passed = {
  name: string;
  from: Source;
  callee?: string | undefined;
  move?: boolean | undefined;
  greeting: string;
  why?: string | undefined;
  format: { type: string; rate: number };
  play: (audio: string) => void;
  heard?: Live["heard"];
  notes?: string[] | undefined;
  started: (session: string) => void;
  refused: (reason: string) => void;
  closed: () => void;
};

function passThrough({
  name,
  from,
  callee,
  move,
  greeting,
  why,
  format,
  play,
  heard,
  notes,
  started,
  refused,
  closed,
}: Passed) {
  const openai = voiceSocket(API);
  let up = false;
  let refusing = false;

  const refuseOnce = (reason: string) => {
    if (up || refusing) {
      return;
    }

    refusing = true;
    refused(reason);
  };

  openai.addEventListener("open", () => {
    openai.send(
      JSON.stringify({
        type: "session.start",
        session: session(
          { audio: { format, ...(filled(VOICE) && { output: { voice: VOICE } }) } },
          greeting,
        ),
      }),
    );
  });

  openai.addEventListener("message", ({ data }) => {
    const parsed = SessionEvent.safeParse(JSON.parse(String(data)));

    if (!parsed.success) {
      return;
    }

    const event = parsed.data;

    if (event.type === "error") {
      refuseOnce(
        `OpenAI refused the ${name} session: ${event.error?.message ?? JSON.stringify(event.error)}`,
      );

      return;
    }

    const callerAlreadyHungUp = openai.readyState !== WebSocket.OPEN;

    if (callerAlreadyHungUp) {
      return;
    }

    const placedCallPickedUpWhileAnotherIsLive =
      from === "phone-out" &&
      (filled(live?.record.callee) ||
        ((live !== undefined || attaching !== undefined) && move !== true));

    if (placedCallPickedUpWhileAnotherIsLive) {
      refuseOnce("it picked up while another call was live, so it was let go");

      return;
    }

    up = true;
    started(event.session.id);
    const expires = expiry(event.session.expires_at);
    follow(
      openai,
      base(event.session.id, from, {
        ...(VOICE !== undefined && { voice: VOICE }),
        ...(why !== undefined && { why }),
        ...(callee !== undefined && { callee }),
        ...(expires !== undefined && { expires }),
      }),
      { speak: play, heard, notes },
    );
  });
  openai.addEventListener("close", ({ code, reason }) => {
    trace(`OpenAI closed the ${name} session (${code} ${reason})`);
    refuseOnce(
      `OpenAI closed the ${name} session before it started (${code} ${reason === "" ? "no reason" : reason})`,
    );
    closed();
  });

  return openai;
}

function answer(twilio: Bun.ServerWebSocket<Phone>) {
  twilio.data.openai = passThrough({
    name: "phone",
    from: twilio.data.from,
    callee: twilio.data.callee,
    move: twilio.data.move,
    greeting: twilio.data.greeting,
    why: twilio.data.why,
    format: { type: "audio/pcmu", rate: 8000 },
    notes: placed.get(twilio.data.token)?.notesForWhenItConnects,
    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    /* Twilio plays what it's sent as it comes, faster than it's said, and echoes each mark once
       the audio before it has played or been cleared. */
    play: (audio) => {
      twilio.send(
        JSON.stringify({
          event: "media",
          streamSid: twilio.data.stream,
          media: { payload: audio },
        }),
      );
      twilio.send(
        JSON.stringify({ event: "mark", streamSid: twilio.data.stream, mark: { name: "voice" } }),
      );
      twilio.data.unplayedChunks++;
    },
    heard: (who, begun, text) => {
      const phone = twilio.data;

      if (phone.unplayedChunks === 0) {
        return;
      }

      if (who === "voice") {
        phone.voiceBeganAt ??= begun;

        return;
      }

      const talkingOverTheVoice =
        phone.voiceBeganAt !== undefined && begun >= phone.voiceBeganAt && !backchannel(text);

      if (talkingOverTheVoice) {
        twilio.send(JSON.stringify({ event: "clear", streamSid: phone.stream }));
        phone.voiceBeganAt = undefined;
      }
    },
    started: (sessionId) => {
      twilio.data.started = true;
      const call = placed.get(twilio.data.token);

      if (call) {
        call.session = sessionId;
      }
    },
    refused: (reason) => {
      refuse(twilio, reason);
    },
    closed: () => {
      twilio.close();
    },
  });
}

export function take(from: Source, greeting: string, voiceLine: VoiceLine): Held {
  if (!filled(KEY)) {
    throw new Error(`calls need OPENAI_API_KEY in ${join(STATE_DIR, ".env")}`);
  }

  let up = false;
  let gone = false;

  const openai: WebSocket = passThrough({
    name: from,
    from,
    greeting,
    format: { type: "audio/pcm", rate: 24_000 },
    play: voiceLine.play,
    started: () => {
      up = true;
    },
    refused: (reason) => {
      if (!gone) {
        failed({ from, end: "no-connect", reason });
      }

      gone = true;
      openai.close();
      voiceLine.end();
    },
    closed: voiceLine.end,
  });

  return {
    hear: (audio) => {
      if (up) {
        openai.send(JSON.stringify({ type: "session.input_audio.append", audio }));
      }
    },
    hangUp: () => {
      if (!up) {
        gone = true;

        openai.close();

        return;
      }

      closeSocket(openai, `close-you-${from}`);
    },
  };
}

const LISTENING = new Set([
  "mm",
  "mmm",
  "hm",
  "hmm",
  "mhm",
  "mmhm",
  "mmhmm",
  "mm-hmm",
  "mm-hm",
  "uh-huh",
  "uhhuh",
  "uh",
  "um",
  "ah",
  "oh",
  "yeah",
  "yep",
  "yup",
  "yes",
  "ok",
  "okay",
  "right",
  "sure",
]);

function backchannel(text: string) {
  return text
    .toLowerCase()
    .replaceAll(/[^a-z\s-]/gu, " ")
    .split(/\s+/u)
    .filter((word) => word.replaceAll("-", "") !== "")
    .every((word) => LISTENING.has(word));
}

function refuse(twilio: Bun.ServerWebSocket<Phone>, reason: string) {
  if (twilio.data.refused === true) {
    return;
  }

  twilio.data.refused = true;
  const call = placed.get(twilio.data.token);
  placed.delete(twilio.data.token);
  failed(
    {
      from: twilio.data.from,
      end: "no-connect",
      reason,
      ...(twilio.data.why !== undefined && { why: twilio.data.why }),
      ...(call && { started: call.started }),
    },
    call?.to,
  );
  twilio.close();
}

function problem(text: string) {
  try {
    const parsed = Problem.safeParse(JSON.parse(text));
    const said = parsed.success ? (parsed.data.error?.message ?? parsed.data.message) : undefined;

    return (said ?? text).slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

function trace(text: string) {
  process.stderr.write(`voice: ${text}\n`);
}

function twiml(body: string) {
  return new Response(`<Response>${body}</Response>`, { headers: { "content-type": "text/xml" } });
}

function stream(token: string) {
  return twiml(`<Connect><Stream url="wss://${PUBLIC_HOST}/twilio/${token}" /></Connect>`);
}

async function signed(request: Request) {
  const parsed = TwilioForm.safeParse(Object.fromEntries(await request.formData()));

  if (!parsed.success) {
    return;
  }

  const form = parsed.data;

  const params = Object.keys(form)
    .toSorted()
    .map((key) => `${key}${form[key] ?? ""}`)
    .join("");

  const signature = createHmac("sha1", TWILIO_TOKEN ?? "")
    .update(`https://${PUBLIC_HOST}${new URL(request.url).pathname}${params}`)
    .digest("base64");

  return filled(TWILIO_TOKEN) && same(request.headers.get("x-twilio-signature") ?? "", signature)
    ? form
    : undefined;
}

async function pickUp(request: Request) {
  const form = await signed(request);

  if (!form || form.From === undefined || form.From !== CALLER_NUMBER) {
    return twiml("<Reject />");
  }

  const token = crypto.randomUUID();
  dials.set(token, {
    greeting: "They called you. Answer briefly, then listen.",
    from: "phone-in",
    token,
  });

  return stream(token);
}

function hearPhone(twilio: Bun.ServerWebSocket<Phone>, raw: string | Buffer) {
  const parsed = TwilioMessage.safeParse(JSON.parse(String(raw)));

  if (!parsed.success) {
    return;
  }

  const message = parsed.data;

  switch (message.event) {
    case "start": {
      twilio.data.stream = message.start.streamSid;
      trace(`Twilio stream ${message.event}`);

      return;
    }

    case "stop": {
      trace(`Twilio stream ${message.event}`);
      hangUp(twilio);

      return;
    }

    case "mark": {
      twilio.data.unplayedChunks = Math.max(0, twilio.data.unplayedChunks - 1);

      if (twilio.data.unplayedChunks === 0) {
        delete twilio.data.voiceBeganAt;
      }

      return;
    }

    case "media": {
      if (twilio.data.started === true) {
        twilio.data.openai?.send(
          JSON.stringify({ type: "session.input_audio.append", audio: message.media.payload }),
        );
      }
    }
  }
}

function hangUp(twilio: Bun.ServerWebSocket<Phone>) {
  const openai = twilio.data.openai;

  if (!openai) {
    return;
  }

  if (twilio.data.started === true) {
    closeSocket(openai, "close-you-phone");

    return;
  }

  twilio.data.refused = true;
  openai.close();
}

function closeSocket(openai: WebSocket, event: string) {
  if (live?.socket === openai) {
    close(live, event);
  } else if (openai.readyState === WebSocket.OPEN) {
    openai.send(JSON.stringify({ type: "session.close", event_id: event }));
  }
}

type SessionExtra = {
  audio?: { format?: Passed["format"]; output?: { voice: string } };
  client?: { data_channel: { allowed_client_events: string[] } };
};

function session(extra: SessionExtra = {}, opening?: string) {
  return {
    model: MODEL,
    instructions: `${VOICE_PROMPT}\n\nThe call started ${clock()}, the caller's local time.`,
    delegation: { type: "client" },
    ...(filled(opening) && {
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: opening }] },
      ],
    }),
    ...extra,
  };
}

async function start(request: Request) {
  if (!filled(KEY)) {
    return new Response(`Set OPENAI_API_KEY in ${join(STATE_DIR, ".env")}`, { status: 503 });
  }

  const body = StartBody.safeParse(await request.json());
  const { sdp, voice = VOICE, from: origin, about } = body.success ? body.data : {};

  if (!filled(sdp)) {
    return new Response("An SDP offer is required", { status: 400 });
  }

  const from = origin === "app" ? "app" : "web";
  const topic = topicOf(about);
  let response: Response;

  try {
    response = await fetch(API, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        session: session(
          {
            ...(filled(voice) && { audio: { output: { voice } } }),
            client: {
              data_channel: {
                allowed_client_events: [
                  "session.input_audio.mute",
                  "session.input_audio.unmute",
                  "session.close",
                ],
              },
            },
          },
          topic?.voice,
        ),
        transport: { type: "webrtc", sdp },
      }),
    });
  } catch (error) {
    const reason = `couldn't reach OpenAI: ${messageOf(error)}`;
    failed({ from, end: "no-connect", reason, ...(voice !== undefined && { voice }) });

    return new Response(reason, { status: 502 });
  }

  if (!response.ok) {
    const text = await response.text();
    failed({
      from,
      end: "no-connect",
      reason: `OpenAI refused the call (${response.status}): ${problem(text)}`,
      ...(voice !== undefined && { voice }),
    });

    return new Response(text, { status: response.status });
  }

  const result: unknown = await response.json();
  const { session: started } = SessionCreated.parse(result);
  const expires = expiry(started.expires_at);
  follow(
    sideband(started.id),
    base(started.id, from, {
      ...(voice !== undefined && { voice }),
      ...(expires !== undefined && { expires }),
    }),
    { about: topic },
  );

  return Response.json(result, { status: 201 });
}

const PAUSED =
  "The caller's phone took over their audio, a phone call or Siri: they can't hear you or talk. Stay quiet until they're back.";

const RESUMED =
  "The caller is back. If you were in the middle of something, pick it back up in a sentence.";

async function interruption(request: Request, id: string) {
  const body = await bodyOf(request, InterruptionBody);

  if (!body) {
    return new Response("kind is paused or resumed", { status: 400 });
  }

  const { kind, text } = body;

  if (live?.id !== id) {
    return new Response("That call is not live", { status: 409 });
  }

  remember(
    live,
    kind,
    filled(text) ? text : kind === "paused" ? "Your phone took over the audio" : "Back on the call",
  );
  void send(live, "session.instructions.append", kind === "paused" ? PAUSED : RESUMED).catch(
    fineIfUnconfirmed,
  );

  return new Response(null, { status: 204 });
}

async function endSession(request: Request) {
  const body = await bodyOf(request, EndBody);

  if (!body) {
    return new Response("Name the call to end with sessionId", { status: 400 });
  }

  const { sessionId } = body;

  if (live?.id === sessionId) {
    close(live, "close-you-app");
  } else if (attaching?.id === sessionId) {
    retire(attaching, "close-you-app");
  }

  return new Response(null, { status: 204 });
}

function same(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}

function allowed(request: Request) {
  return !filled(TOKEN) || same(request.headers.get("authorization") ?? "", `Bearer ${TOKEN}`);
}

function postedFromAnotherSiteOrRebound(request: Request) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");

  return (
    !nameNoSiteCanPointHere(url.hostname) ||
    (request.method !== "GET" && origin !== null && URL.parse(origin)?.host !== url.host)
  );
}

function nameNoSiteCanPointHere(host: string) {
  return (
    isIP(host.replaceAll(/^\[|\]$/gu, "")) > 0 ||
    /^[^.]+$|(^|\.)localhost$|\.ts\.net$/u.test(host) ||
    host === PUBLIC_HOSTNAME
  );
}

function home(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for");
  const local = forwarded === null || forwarded === "";

  // oxlint-disable-next-line typescript/no-base-to-string -- imported with type "text", page is the file's text; Bun types every .html import as an HTML bundle
  const html = String(page);

  return new Response(html.replace("__VOICE_TOKEN__", local && filled(TOKEN) ? TOKEN : ""), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function showActivity(url: URL) {
  const after = url.searchParams.get("after");

  if (after !== null && after !== "") {
    await activity.changes(Number(after), 25_000);
  }

  return Response.json({
    version: activity.version,
    call: live?.id ?? null,
    tasks: live ? [...live.call.activity(), ...elsewhere(live)] : [],
    asks: live ? cards(live) : [],
  });
}

function elsewhere(call: Live): (Task & { line?: string })[] {
  const following = new Set(
    call.call
      .activity()
      .flatMap((each) => (each.state === "running" && filled(each.agent) ? [each.agent] : [])),
  );

  return board.runs
    .filter(
      (row) =>
        row.state === "working" &&
        row.app !== "voice" &&
        !following.has(`${row.app}:${row.thread}`),
    )
    .map((row) => ({
      id: row.id,
      state: "running",
      text: row.name,
      to: row.name,
      line: newest(row),
    }));
}

function cards(call: Live) {
  const marks = call.call.record().moments;

  const shown = marks.flatMap((moment) => {
    const question =
      moment.kind === "ask" && moment.ask !== undefined ? call.shown.get(moment.ask) : undefined;

    return question ? [{ moment, question }] : [];
  });

  return shown.map(({ moment, question }, i) => {
    const next =
      shown.slice(i + 1).find((later) => later.moment.ask === moment.ask)?.moment.at ?? Infinity;

    const answered = marks.findLast(
      (reply) =>
        reply.kind === "answered" &&
        reply.ask === moment.ask &&
        reply.at >= moment.at &&
        reply.at < next,
    );

    const undone =
      marks.findLast((undo) => undo.kind === "undone" && undo.ask === moment.ask)?.at ?? -1;

    return {
      at: moment.at,
      ask: question,
      ...(answered && answered.at > undone && { answer: answered.text, sent: answered.sent }),
    };
  });
}

function topicOf(about?: string): Topic | undefined {
  if (about === "asks") {
    return walkTopic(yours.view.asks);
  }

  const run = filled(about) ? board.get(about) : undefined;

  return run && runTopic(run);
}

async function showRuns(url: URL, runs: Board) {
  const after = url.searchParams.get("after");

  if (after !== null && after !== "") {
    await runs.changes(Number(after), 25_000);
  }

  return Response.json({ version: runs.version, tasks: runs.rows(), finished: runs.finished });
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* The Tasks button's counts: threads that need you and are working, and how many things are yours,
   as many as Tasks lists under Needs you: every question, everything stuck, and every thread that
   needs you without a question. */
async function showSummary(url: URL, runs: Board, questions: Questions) {
  const version = () => runs.counts.version + questions.counts.version;
  const after = Number(url.searchParams.get("after"));

  if (after === version()) {
    await Promise.race([
      runs.counts.changes(runs.counts.version, 25_000),
      questions.counts.changes(questions.counts.version, 25_000),
    ]);
  }

  const asked = new Set(questions.view.asks.map((question) => question.task));
  const unasked = runs.rows().filter((row) => row.state === "needs" && !asked.has(row.id)).length;

  return Response.json({
    version: version(),
    ...runs.summary,
    yours: questions.view.asks.length + questions.view.stuck.length + unasked,
  });
}

async function showQuestions(url: URL, questions: Questions) {
  const after = url.searchParams.get("after");

  if (after !== null && after !== "") {
    await questions.changes(Number(after), 25_000);
  }

  return Response.json({ version: questions.version, ...questions.view });
}

async function questionRoutes(request: Request, url: URL) {
  const questions = yours;

  if (url.pathname === "/asks" && request.method === "GET") {
    const after = url.searchParams.get("after");

    if (after === null || after === "") {
      questions.opened();
    }

    return await showQuestions(url, questions);
  }

  if (url.pathname === "/asks/check" && request.method === "GET") {
    return questions.lastCheck
      ? Response.json(questions.lastCheck)
      : new Response("No check yet", { status: 404 });
  }

  const [, shown, n] = /^\/asks\/([^/]+)\/shots\/(\d+)$/u.exec(url.pathname) ?? [];

  if (filled(shown) && request.method === "GET") {
    const file = questions.shot(decodeURIComponent(shown), Number(n));

    return file !== undefined && (await Bun.file(file).exists())
      ? new Response(Bun.file(file))
      : new Response("No such screenshot", { status: 404 });
  }

  const [, asked] = /^\/asks\/([^/]+)\/words$/u.exec(url.pathname) ?? [];

  if (filled(asked) && request.method === "GET") {
    const words = questions.words(decodeURIComponent(asked));

    return words ? Response.json(words) : new Response("Nothing to show", { status: 404 });
  }

  if (url.pathname === "/asks/talk" && request.method === "POST") {
    return talkAbout(walkTopic(questions.view.asks));
  }

  const [, kind, id, verb] =
    /^\/(asks|stuck|fresh)\/([^/]+)\/(answer|note|dismiss|undo|act|read)$/u.exec(url.pathname) ??
    [];

  if (!filled(kind) || id === undefined || request.method !== "POST") {
    return new Response("404", { status: 404 });
  }

  try {
    const key = decodeURIComponent(id);

    const callTheCardIsOn =
      live?.shown.has(key) === true &&
      live.call.record().moments.some((moment) => moment.kind === "ask" && moment.ask === key)
        ? live
        : undefined;

    const callThatHadItsAnswer =
      live?.call
        .record()
        .moments.some((moment) => moment.kind === "answered" && moment.ask === key) === true
        ? live
        : undefined;

    const stillOnTheCall = (call = callTheCardIsOn) => (call && live === call ? call : undefined);

    if (kind === "asks" && verb === "answer") {
      const label = (await bodyOf(request, AnswerBody))?.label;

      if (!filled(label)) {
        return new Response("An answer needs its label", { status: 400 });
      }

      const sent = await answerQuestion(key, label, "app");
      const call = stillOnTheCall();

      if (call) {
        deliver(
          `The caller tapped "${label}" on the card for ${key}; it's sent to its thread${missed(sent)}.`,
          { call: call.id },
        );
      }

      return Response.json(sent);
    }

    if (kind === "asks" && verb === "note") {
      const text = (await bodyOf(request, NoteBody))?.text.trim() ?? "";

      if (text === "") {
        return new Response("A note needs its text", { status: 400 });
      }

      const sent = await questions.note(key, text, "app");
      const call = stillOnTheCall();

      if (call) {
        deliver(
          `The caller wrote a note on the card for ${key}: "${text}". It's sent to its thread, and the question stays open.`,
          { call: call.id },
        );
      }

      return Response.json(sent);
    }

    if (kind === "asks" && verb === "dismiss") {
      const question = questions.find(key);
      const sent = await questions.dismiss(key, "app");
      const call = stillOnTheCall();

      if (call) {
        if (question) {
          call.shown.set(key, question);
        }

        remember(call, "answered", "Not needed", { ask: key, sent });
        activity.changed();
        deliver(
          `The caller marked the card for ${key} not needed; its threads are told${missed(sent)}.`,
          { call: call.id },
        );
      }

      return Response.json(sent);
    }

    if (kind === "asks" && verb === "undo") {
      try {
        await questions.undo(key, "app");
      } finally {
        const call = questions.answered(key) ? undefined : stillOnTheCall(callThatHadItsAnswer);

        if (call) {
          remember(call, "undone", "Taken back", { ask: key });
          activity.changed();
        }
      }

      const card = stillOnTheCall();

      if (card) {
        deliver(`The caller took back what they gave on the card for ${key}; it's open again.`, {
          call: card.id,
        });
      }
    } else if (kind === "stuck" && verb === "act") {
      await questions.act(key);
    } else if (kind === "fresh" && verb === "read") {
      questions.read(key);
    } else {
      return new Response("404", { status: 404 });
    }
  } catch (error) {
    return new Response(messageOf(error), { status: 409 });
  }

  return new Response(null, { status: 204 });
}

function runRoutes(request: Request, url: URL) {
  const runs = board;

  if (url.pathname === "/tasks" && request.method === "GET") {
    return showRuns(url, runs);
  }

  if (url.pathname === "/tasks/summary" && request.method === "GET") {
    return showSummary(url, runs, yours);
  }

  const [, id, verb] = /^\/tasks\/([^/]+)(?:\/(talk|chat|stop))?$/u.exec(url.pathname) ?? [];
  const key = filled(id) ? decodeURIComponent(id) : "";
  const pageToRead = filled(key) && request.method === "GET" ? runs.find(key) : undefined;

  if (pageToRead && verb === "chat") {
    const offTheBoard = !runs.get(key);

    return showChat(url, pageToRead, offTheBoard);
  }

  if (pageToRead && !filled(verb)) {
    return Response.json({ ...pageToRead, ...yours.of(pageToRead.id) });
  }

  const run = filled(key) ? runs.get(key) : undefined;

  if (!run) {
    return new Response("404", { status: 404 });
  }

  if (verb === "talk" && request.method === "POST") {
    return talkAbout(runTopic(run));
  }

  if (verb === "chat" && request.method === "POST") {
    return sendChat(request, run);
  }

  if (verb === "stop" && request.method === "POST") {
    return done(() => {
      chats.stop(run);
    });
  }
}

async function showChat(url: URL, run: Run | Page, readOnly = false) {
  const where = (): Where => {
    const serving = board.session(run.id);

    return serving === undefined ? { ...run } : { ...run, session: serving };
  };

  const after = url.searchParams.get("after");

  const chat =
    after !== null && after !== ""
      ? await chats.next(where, Number(after), 25_000)
      : chats.of(where());

  return Response.json(readOnly ? { ...chat, sends: false } : chat);
}

const CHAT_FIELD_PROBLEMS = {
  media: "Name each photo or video by the id /media gave it",
  text: "Send some words, or a photo or video",
  key: "Name the message with a key starting app-",
};

async function sendChat(request: Request, run: Run) {
  const raw: unknown = await request.json().catch(() => null);
  const parsed = ChatBody.safeParse(raw ?? {});

  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];

    return new Response(field === "media" ? CHAT_FIELD_PROBLEMS.media : CHAT_FIELD_PROBLEMS.text, {
      status: 400,
    });
  }

  const { media: names, text, key } = parsed.data;
  const items: Item[] = [];

  for (const name of names) {
    const item = media.get(name);

    if (!item) {
      return new Response(CHAT_FIELD_PROBLEMS.media, { status: 400 });
    }

    items.push(item);
  }

  if (text.trim() === "" && items.length === 0) {
    return new Response(CHAT_FIELD_PROBLEMS.text, { status: 400 });
  }

  const named = ChatKey.safeParse(key);

  if (!named.success) {
    return new Response(CHAT_FIELD_PROBLEMS.key, { status: 400 });
  }

  return done(() => {
    chats.send(run, text.trim(), named.data, items);
  });
}

function done(act: () => void) {
  try {
    act();

    return new Response(null, { status: 204 });
  } catch (error) {
    return new Response(messageOf(error), { status: 409 });
  }
}

async function showCall(id: string, url: URL) {
  const after = url.searchParams.get("after");

  if (after !== null && after !== "" && live?.id === id) {
    await live.changes.changes(Number(after), 25_000);
  }

  if (live?.id === id) {
    return Response.json({ ...whole(live), version: live.changes.version });
  }

  const record = calls.get(id);

  return record ? Response.json(record) : new Response("404", { status: 404 });
}

async function listCalls(url: URL) {
  const after = url.searchParams.get("after");

  if (after !== null && after !== "") {
    await calls.changes(Number(after), 25_000);
  }

  return Response.json({ version: calls.version, live: live?.id, calls: calls.list() });
}

function routes(request: Request) {
  const { pathname } = new URL(request.url);

  if (pathname === "/session" && request.method === "POST") {
    return start(request);
  }

  if (pathname === "/session" && request.method === "DELETE") {
    return endSession(request);
  }

  if (pathname === "/calls" && request.method === "GET") {
    return listCalls(new URL(request.url));
  }

  if (pathname === "/activity" && request.method === "GET") {
    return showActivity(new URL(request.url));
  }

  if (pathname === "/tasks" || pathname.startsWith("/tasks/")) {
    return runRoutes(request, new URL(request.url));
  }

  if (/^\/(asks|stuck|fresh)(\/|$)/u.test(pathname)) {
    return questionRoutes(request, new URL(request.url));
  }

  if (pathname === "/media" && request.method === "POST") {
    return upload(request);
  }

  const [, image] = /^\/media\/([\w-]+)$/u.exec(pathname) ?? [];

  if (filled(image) && request.method === "GET") {
    return showImage(image);
  }

  const [, callId, verb] = /^\/calls\/([\w-]+)(?:\/(moments|media))?$/u.exec(pathname) ?? [];

  if (!filled(callId)) {
    return pathname === "/phone" && request.method === "POST" ? moveToPhone() : undefined;
  }

  if (verb === "moments" && request.method === "POST") {
    return interruption(request, callId);
  }

  if (verb === "media" && request.method === "POST") {
    return showMedia(request, callId);
  }

  if (!filled(verb) && request.method === "GET") {
    return showCall(callId, new URL(request.url));
  }

  if (!filled(verb) && request.method === "DELETE") {
    if (live?.id === callId) {
      return new Response("That call is still going", { status: 409 });
    }

    return new Response(null, { status: calls.delete(callId) ? 204 : 404 });
  }
}

async function moveToPhone() {
  try {
    return new Response(await dial({ move: true }));
  } catch (error) {
    return new Response(messageOf(error), { status: 502 });
  }
}

export function serve(voiceHub: Hub, state: string) {
  hub = voiceHub;
  HEX_STATE = state;
  board = new Board(state, dirname(state));
  chats = new Chats(state);
  media = new Media(join(state, "voice", "media"));
  board.listen(() => {
    activity.changed();
    chats.changed();
  });
  yours = new Questions(state);
  recover();
  followWorkPastCallsSentOut();

  return Bun.serve<Phone>({
    port: PORT,
    hostname: "127.0.0.1",
    idleTimeout: 40,
    fetch(request, server) {
      const { pathname } = new URL(request.url);

      if (pathname === "/twilio/incoming" && request.method === "POST") {
        return pickUp(request);
      }

      const [, statusToken] = /^\/twilio\/status\/([\w-]+)$/u.exec(pathname) ?? [];

      if (filled(statusToken) && request.method === "POST") {
        return phoneStatus(request, statusToken);
      }

      const [, token = "", twimlPath] = /^\/twilio\/([\w-]+)(\/twiml)?$/u.exec(pathname) ?? [];
      const dialed = dials.get(token);

      if (filled(token)) {
        trace(
          `Twilio ${request.method} ${filled(twimlPath) ? "TwiML" : "stream"}, ${dialed ? "known" : "unknown"} token`,
        );
      }

      if (dialed && filled(twimlPath)) {
        return stream(token);
      }

      if (dialed && dials.delete(token)) {
        return server.upgrade(request, { data: { ...dialed, unplayedChunks: 0 } })
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      }

      if (postedFromAnotherSiteOrRebound(request)) {
        return new Response("Forbidden", { status: 403 });
      }

      if (pathname === "/") {
        return home(request);
      }

      if (!allowed(request)) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "www-authenticate": "Bearer" },
        });
      }

      return routes(request) ?? new Response("404", { status: 404 });
    },
    websocket: {
      open: answer,
      message: hearPhone,
      close: hangUp,
    },
  });
}
