import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";

import { begin, title as oneWord, open, sentPicture } from "@hex/hub";
import type { Held, VoiceLine } from "@hex/hub";
import { z } from "zod";

import { brief, findThread, followAgent, followThread } from "./activity.ts";
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
import { jev } from "./jev.ts";
import { counted, line, Media } from "./media.ts";
import type { Item } from "./media.ts";
import { muting } from "./mute.ts";
import type { Muting } from "./mute.ts";
import { jobs, overall } from "./overall.ts";
import page from "./page.html" with { type: "text" };
import { MUTED, NOT_MUTED, UNMUTED, voicePrompt } from "./prompt.ts";
import { clip, Questions } from "./questions.ts";
import type { Question } from "./questions.ts";
import { relay } from "./relay.ts";
import { stopping } from "./stop.ts";
import type { Stopping } from "./stop.ts";
import { options, readStyle, Style, styleLines, writeStyle } from "./style.ts";
import type { VoiceStyle } from "./style.ts";

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
const OPENAI = env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const API = `${OPENAI}/live/sessions`;
const TWILIO_SID = env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = env.TWILIO_NUMBER;
const TWILIO_API = env.TWILIO_BASE_URL ?? "https://api.twilio.com";
const CALLER_NUMBER = env.CALLER_NUMBER;

const JEV = filled(env.OPENROUTER_API_KEY)
  ? jev(
      env.OPENROUTER_API_KEY,
      "~typesafe/jev-latest",
      `${env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"}/systemone`,
    )
  : undefined;

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

const MediaBody = z.object({
  media: z.union([z.string(), z.array(z.string()).min(1)]).transform((ids) => [ids].flat()),
});

const StartBody = z.object({
  sdp: z.string().exactOptional(),
  voice: z.string().exactOptional(),
  from: z.string().exactOptional(),
  about: z.string().exactOptional(),
  continues: z.string().exactOptional(),
});

const InterruptionBody = z.object({
  kind: z.enum(["paused", "resumed"]),
  text: z.string().exactOptional(),
});

const EndBody = z.object({ sessionId: z.string() });

const AnswerBody = z.object({ label: z.string(), media: z.array(z.string()).default([]) });

const NoteBody = z.object({ text: z.string(), media: z.array(z.string()).default([]) });

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
  z.object({
    type: z.literal("session.output_audio.delta"),
    delta: z.string(),
    end_ms: z.number().exactOptional(),
  }),
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

type Ring = { delegation: string; offset: number; asked: number; caughtUp?: true };

type Heard = (who: Speaker, startOnSessionTimeline: number, text: string) => void;

type Live = {
  id: string;
  shown: Map<string, Question>;
  socket: WebSocket;
  call: Call;
  record: Omit<CallRecord, "turns" | "tasks" | "moments">;
  pending: Map<string, Pending>;
  rings: Ring[];
  handoffs?: Set<string>;
  answer?: { text: string; at: number };
  failedSend?: string;
  ringing?: ReturnType<typeof setInterval> | undefined;
  changes: Changes;
  spoke: number;
  callerSpoke: number;
  clock?: { session: number; wall: number };
  away?: { told: boolean; settling?: ReturnType<typeof setTimeout> };
  lost?: { reason: string; at: string; giveUp: ReturnType<typeof setTimeout> };
  unattached?: number;
  shift?: number;
  usedBefore?: number;
  reopen?: ((call: Live, opening: Said[]) => void) | undefined;
  end?: (() => void) | undefined;
  speak?: ((audio: string) => void) | undefined;
  muLaw?: boolean | undefined;
  heard?: Heard | undefined;
  mute?: Muting | undefined;
  stop?: Stopping | undefined;
  closing?: string;
  closed?: true;
};

type Attaching = { id: string; session: string; since: number; closing?: string };

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
   session for a call (keep, which waits for a renew already starting the session over) or let it
   start over for the next (renew), and name the session now serving the thread. */
export type Hub = {
  deliver: (content: string, meta: Record<string, string>) => void;
  keep: () => Promise<void>;
  renew: () => void;
  session: () => string | undefined;
  interrupt: () => Promise<void>;
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
const GRACE = Number(env.VOICE_GRACE_SECONDS ?? 120) * 1000;
const PING_EVERY = 5000;
const QUIET_MOST = Number(env.VOICE_QUIET_SECONDS ?? 15) * 1000;
const CARRIES_ON = new Set(["expired", "connection_lost", "remote_hangup"]);
const CALLER_PAUSE = 1000;
const HANDOFF_WAIT = 3000;
const HANDOFF_MOST = 8000;
const ACK_WAIT = 10_000;
const QUIET = 2000;
const ANSWER_WAIT = 20_000;
const ANSWER_PAUSE = 3000;
const SAME_ANSWER = 10_000;
const STYLE_WAIT_MOST = 30_000;
const HANG_UP_MOST = 10_000;
const SETTLE = 1500;

export async function tool(...[name, args]: ToolCall): Promise<string> {
  if (name === "running") {
    board.refresh();

    return overall(
      board.runs,
      board.strays(),
      await jobs(),
      open(HEX_STATE).threads.names(),
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
    const call = live;

    try {
      const sent = await pass(args.thread, args.about, args.text, args.app, args.channel);
      delete call?.failedSend;

      return sent;
    } catch (error) {
      if (call) {
        call.failedSend = messageOf(error);
      }

      throw error;
    }
  }

  if (name === "style") {
    const { style, telling } = restyle(args);
    const now = styleLines(style).join(" ") || "the usual way of talking";
    const heard = telling ? ", and the voice switches to it once it finishes what it's saying" : "";

    return `saved: ${now}${heard}${filled(args.voice) ? `; the ${args.voice} voice starts with the next call` : ""}`;
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
      const handoff = handoffOf(live, args.delegation_id);

      if (filled(handoff)) {
        live.stop?.answered(handoff);
      }

      // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
      /* The session can write its answer in the same breath as the send it reports, before the
         send fails, and the caller then hears that it went. */
      if (filled(live.failedSend)) {
        const why = live.failedSend;
        delete live.failedSend;

        return `not said: send failed just before this (${why}), so tell the caller what actually happened`;
      }

      if (live.answer?.text === args.text && Date.now() - live.answer.at < SAME_ANSWER) {
        return "said already: the voice has this answer, so it isn't sent twice";
      }

      const answering = live;
      await untilTheirNewestWordsAreAnswered(answering);

      const held = await tell(answering, "say", args.text, handoff, {
        checked: args.checked,
      });

      answering.answer = { text: args.text, at: Date.now() };

      return held ? "the caller muted the voice: it says this once they unmute it" : "said";
    }

    case "note": {
      await tell(live, "note", args.text, handoffOf(live, args.delegation_id));

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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* The voice rejects an append naming a handoff it never made, and that error reaches every connection to the call, so an id the session copied wrong, a few letters dropped or a quote picked up, goes as the handoff it nearly matches, or as no handoff. A call picked back up after a restart doesn't know its earlier handoffs, so it sends ids as they come. */
function handoffOf(call: Live, id: string | undefined) {
  if (!filled(id) || call.handoffs === undefined || call.handoffs.has(id)) {
    return id;
  }

  const handoff = [...call.handoffs].find((known) => nearly(id, known));
  trace(`${call.id}: no handoff ${id}, so it goes as ${handoff ?? "no handoff"}`);

  return handoff;
}

function nearly(id: string, known: string) {
  const most = Math.min(id.length, known.length);
  let front = 0;
  let back = 0;

  while (front < most && id[front] === known[front]) {
    front++;
  }

  while (back < most - front && id.at(-1 - back) === known.at(-1 - back)) {
    back++;
  }

  return Math.max(id.length, known.length) - front - back <= 4;
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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* The voice reads a bare note out as if it were the answer it waits on, tested on gpt-live-1. */
const NOTED =
  "Background for you to know, not a result and not for the caller: say none of it unless the caller asks about it. ";

async function tell(
  call: Live,
  kind: "say" | "note",
  text: string,
  delegation?: string,
  more: Pick<Mark, "checked"> = {},
) {
  const held = kind === "say" && call.mute?.muted === true;

  await send(
    call,
    kind === "say" && !held ? "session.commentary.append" : "session.thinking.append",
    held
      ? `Say this once the caller unmutes you: ${text}`
      : kind === "note"
        ? `${NOTED}${text}`
        : text,
    delegation,
  );
  remember(call, kind, text, more);

  return held;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* An instruction cuts the voice off and has it answer, which a mute needs; an unmute goes quietly, since the voice already answers the caller's "unmute" itself. */
const STOPPED =
  "hex stopped your turn: the caller seemed to call off what they asked, in the words below. If they did, stop anything you started for it that still runs, then say what had already happened; if they didn't, carry on.";

async function callOff(call: Live, delegation: string) {
  if (live !== call) {
    return;
  }

  remember(call, "stopped", "You called it off, so hex stopped");
  await hub.interrupt();
  const turns = call.call.handOff();
  deliver([STOPPED, transcript(turns)].join("\n"), {
    call: call.id,
    delegation_id: delegation,
    stopped: "true",
  });
  save(call);
}

function hush(call: Live, muted: boolean, second: boolean) {
  if (live !== call) {
    return;
  }

  remember(
    call,
    muted ? "muted" : "unmuted",
    muted ? "You muted hex" : second ? "Not muted after all" : "You unmuted hex",
  );
  void send(
    call,
    muted ? "session.instructions.append" : "session.thinking.append",
    muted ? MUTED : second ? NOT_MUTED : UNMUTED,
  ).catch(fineIfUnconfirmed);
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* A call's voice and instructions are fixed when it starts, so a change mid-call reaches the voice as an instruction, and the voice itself changes from the next call. */
function restyle(change: VoiceStyle) {
  const before = styleLines(readStyle(STATE_DIR)).join(" ");
  const style = writeStyle(STATE_DIR, change);
  const lines = styleLines(style).join(" ");
  const telling = live !== undefined && lines !== before;

  if (live && telling) {
    void tellOnceQuiet(live, lines).catch(fineIfUnconfirmed);
  }

  return { style, telling };
}

async function tellOnceQuiet(call: Live, lines: string) {
  await untilQuiet(call, STYLE_WAIT_MOST);

  if (live === call) {
    await send(
      call,
      "session.instructions.append",
      `The caller changed how you talk. From now on: ${lines || "talk in your usual way."}`,
    );
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* An instruction cuts off whatever the voice is saying, so it waits until the voice is quiet, for so long at most. */
// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* The voice says an answer the moment it arrives, so one that lands on words the caller said after the last handoff takes their reply's place, and those words never get handed off: it waits while the caller talks and for the voice to take them up, for so long at most. */
async function untilTheirNewestWordsAreAnswered(call: Live) {
  const asked = Date.now();

  const unanswered = () =>
    live === call &&
    call.mute?.muted !== true &&
    call.rings.length === 0 &&
    call.callerSpoke > call.spoke &&
    !backchannel(call.call.unsent("you"));

  while (
    unanswered() &&
    Date.now() - call.callerSpoke < ANSWER_PAUSE &&
    Date.now() - asked < ANSWER_WAIT
  ) {
    await Bun.sleep(100);
  }
}

async function untilQuiet(call: Live, most: number, from = 0) {
  const asked = Date.now();
  const stillLive = () => live === call;
  const voiceSpokeLately = () => Date.now() - Math.max(from, call.spoke) < QUIET;

  while (stillLive() && Date.now() - asked < most && voiceSpokeLately()) {
    await Bun.sleep(100);
  }
}

async function changeStyle(request: Request) {
  const change = await bodyOf(request, Style);

  if (!change) {
    return new Response("personality, pace, words or voice, from GET /settings", { status: 400 });
  }

  return Response.json({ settings: restyle(change).style, ...options() });
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* Turns are timed on the session's own timeline, which falls behind the wall clock when audio
   stalls (70s on one phone call), so moments go on it too: the newest point OpenAI timed, plus the
   time since it came in. */
function since(call: Live) {
  const now = Date.now();

  return call.clock
    ? call.clock.session + now - call.clock.wall
    : now - Date.parse(call.record.started);
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* A call carried on in a new session starts that session's timeline over at zero, so its times
   move up to where the call was. */
function onCall(call: Live, ms: number) {
  return ms + (call.shift ?? 0);
}

function timed(call: Live, at: number | undefined) {
  if (at !== undefined && at > (call.clock?.session ?? -1)) {
    call.clock = { session: at, wall: Date.now() };
  }
}

function remember(
  call: Live,
  kind: Mark["kind"],
  text: string,
  more: Pick<Mark, "ask" | "sent" | "media" | "checked"> = {},
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
    live.call.track(change, since(live));
    save(live);
    activity.changed();

    return send(live, "session.thinking.append", `${NOTED}${live.call.change(change.id)}`).then(
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
  await untilQuiet(call, HANG_UP_MOST, asked);

  if (live !== call) {
    return "the call had already ended";
  }

  if (call.callerSpoke > asked) {
    const said = call.call.record().turns.findLast((turn) => turn.who === "you")?.text;

    return `not hung up: the caller spoke after you asked to${filled(said) ? ` ("${said}")` : ""}. If they still want to go, hang_up again; otherwise answer them.`;
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
  if (call.lost) {
    call.closing ??= event;
    call.closed = true;
    finish(call, "close_requested", call.closing);

    return;
  }

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
  const words = turns.length ? transcript(turns) : "(no new words since the last handoff)";
  call.stop?.handed(delegation, words);
  deliver(words, {
    call: call.id,
    delegation_id: delegation,
    at: `${(offset / 1000).toFixed(1)}s`,
    ...(filled(call.record.callee) && { callee: call.record.callee }),
  });
  save(call);
}

function hear(call: Live, who: Speaker, event: z.output<typeof Transcript>) {
  const begun = onCall(call, event.start_ms);
  const end = onCall(call, event.end_ms ?? event.start_ms);
  call.call.hear({ who, text: event.delta, start: begun, end });
  call.heard?.(who, begun, event.delta);
  call.changes.changed();
  timed(call, end);

  if (who === "you") {
    call.callerSpoke = Date.now();
  }

  for (const due of call.rings) {
    if (due.offset <= begun) {
      due.caughtUp = true;
    }
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* gpt-live-1 can hand off while the caller is still mid-sentence, so a handoff waits for the words
   after it to come in and for the caller to pause, and goes without them after a while. */
function ringOnceTheCallerPauses(call: Live) {
  call.ringing ??= setInterval(() => {
    const now = Date.now();
    const paused = now - call.callerSpoke >= CALLER_PAUSE;

    for (const due of live === call ? [...call.rings] : []) {
      const waited = now - due.asked;

      if (waited < HANDOFF_MOST && !(paused && (due.caughtUp === true || waited >= HANDOFF_WAIT))) {
        break;
      }

      call.rings.shift();
      ring(call, due);
    }

    if (!call.rings.length || live !== call) {
      clearInterval(call.ringing);
      call.ringing = undefined;
    }
  }, 100);
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
  clearTimeout(call.lost?.giveUp);
  clearInterval(call.ringing);
  clearTimeout(call.away?.settling);
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
  call.record = { ...call.record, ended: call.lost?.at ?? new Date().toISOString(), end, reason };
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
  void checkCredit();
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- clears the reconnect handler listen() set
  call.socket.onclose = null;
  call.socket.close();

  if (filled(call.closing) && call.closed !== true && call.speak === undefined) {
    closeSession(sessionOf(call), call.closing);
  }

  call.end?.();
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
    call: resumed,
    speak,
    muLaw,
    heard,
    notes = [],
    hello,
    about,
    reopen,
    end,
  }: {
    reopen?: Live["reopen"];
    end?: Live["end"];
    call?: Call;
    speak?: Live["speak"];
    muLaw?: boolean;
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
    call: resumed ?? new Call(),
    record,
    pending: new Map(),
    rings: [],
    ...(resumed === undefined && { handoffs: new Set<string>() }),
    changes: new Changes(),
    spoke: 0,
    callerSpoke: 0,
    speak,
    muLaw,
    heard,
    reopen,
    end,
  };

  if (JEV) {
    const unheard = (error: Error) => {
      trace(`Jev: ${error.message}`);
    };

    next.mute = muting(
      JEV,
      (muted, second) => {
        hush(next, muted, second);
      },
      unheard,
    );
    next.stop = stopping(
      JEV,
      (delegation) => {
        void callOff(next, delegation);
      },
      unheard,
    );
  }

  live = next;
  save(next);
  activity.changed();
  toHub(async () => {
    await hub.keep();
    const claude = hub.session();

    if (claude === undefined) {
      delete next.record.claude;
    } else {
      next.record.claude = claude;
    }
  });
  listen(next, socket);
  deliver(
    hello ??
      [
        `A call started.${filled(record.why) ? ` You placed it because: ${record.why}` : ""}`,
        ...(about ? [about.claude] : []),
        ...lastCalls(record.id),
        talksLike(),
        "Send the voice what it should know right away, with note.",
      ].join("\n"),
    { call: record.id, started: "true", from: record.from, ...(about && { task: about.id }) },
  );

  for (const text of notes.splice(0)) {
    void tell(next, "note", text).catch(fineIfUnconfirmed);
  }

  return next;
}

function talksLike() {
  const { words, ...rest } = readStyle(STATE_DIR);
  const set = styleLines(rest);

  return `How the caller set the voice to talk: ${set.length ? set.join(" ") : "nothing set"}${filled(words) ? ` Their words: ${words}` : ""}`;
}

const LAST_CALLS = 5;

function lastCalls(now: string) {
  const held = calls
    .list()
    .filter((call) => call.id !== now && (filled(call.title) || filled(call.summary)))
    .slice(0, LAST_CALLS)
    .toReversed()
    .map(({ started, seconds, title: name, summary: what, waiting }) =>
      [
        `- ${new Date(started).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}, ${Math.max(1, Math.round(seconds / 60))} min: ${name ?? "untitled"}.`,
        what,
        waiting !== undefined && waiting.length > 0
          ? `Left waiting: ${waiting.join("; ")}.`
          : undefined,
      ]
        .filter(filled)
        .join(" "),
    );

  return held.length ? ["Your last calls with the caller, newest last:", ...held] : [];
}

type Topic = { id: string; claude: string; voice: string };

function runTopic(run: Run): Topic {
  return {
    id: run.id,
    claude: `The caller started it with Talk it through on a task. ${opener(run)}`,
    voice: `The caller tapped Talk it through on a task, so name it now in a sentence, with its last update and how old that is, then listen: Assistant checks what's new. ${opener(run)} Its last update came ${ago(run.at)}.`,
  };
}

function ago(at: string) {
  const minutes = Math.round((Date.now() - Date.parse(at)) / 60_000);

  if (!Number.isFinite(minutes)) {
    return "at a time hex doesn't know";
  }

  if (minutes < 2) {
    return "just now";
  }

  return minutes < 90 ? `${minutes} minutes ago` : `${Math.round(minutes / 60)} hours ago`;
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
  const items = sent?.media.map((each) => media.get(each)) ?? [];

  if (!items.length || !items.every((item) => item !== undefined)) {
    return new Response("Name a photo or video sent to /media", { status: 400 });
  }

  if (live?.id !== id) {
    return new Response("That call is not live", { status: 409 });
  }

  for (const item of items) {
    remember(live, item.kind, "", { media: item.id });
  }

  deliver(`The caller sent this from the app: ${items.map(line).join(" ")}`, {
    call: live.id,
    image_path: items.flatMap((item) => item.images).join("; "),
  });
  void send(
    live,
    "session.instructions.append",
    `The caller just sent ${counted(items)} in the app. Only Assistant can see it: generate <|SpawnThinking|> now, then tell the caller in a few words that you're having a look.`,
  ).catch(fineIfUnconfirmed);

  return new Response(null, { status: 204 });
}

async function upload(request: Request) {
  const type = request.headers.get("content-type");

  if (type === null || type === "" || !Media.takes(type)) {
    return new Response(
      "Send a JPEG, PNG, HEIC, GIF, WebP, TIFF or AVIF photo, or an MP4 or QuickTime video",
      {
        status: 415,
      },
    );
  }

  try {
    const { id, kind } = await media.add(type, await request.blob());

    return Response.json({ id, kind }, { status: 201 });
  } catch (error) {
    return new Response(messageOf(error), { status: 422 });
  }
}

async function showImage(id: string) {
  const image = media.get(id)?.images[0];
  const sent = image === undefined ? await sentPicture(open(HEX_STATE), id) : undefined;
  const path = image ?? sent?.path;

  return path === undefined
    ? new Response("404", { status: 404 })
    : new Response(Bun.file(path), sent && { headers: { "content-type": sent.type } });
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

async function answerQuestion(id: string, label: string, via: "call" | "app", items: Item[] = []) {
  const call = live;
  const question = yours.find(id) ?? call?.shown.get(id);
  const sent = await yours.answer(id, label, via, items);

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

    if (!parsed.success || call.socket !== socket) {
      return;
    }

    const event = parsed.data;

    switch (event.type) {
      case "session.input_transcript.delta": {
        hear(call, "you", event);
        call.mute?.heard(
          event.delta,
          onCall(call, event.start_ms),
          onCall(call, event.end_ms ?? event.start_ms),
        );
        call.stop?.heard(event.delta);

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

        call.handoffs?.add(event.delegation.id);
        call.rings.push({
          delegation: event.delegation.id,
          offset: onCall(call, event.offset_ms ?? Number.NaN),
          asked: Date.now(),
        });
        timed(call, event.offset_ms === undefined ? undefined : onCall(call, event.offset_ms));
        ringOnceTheCallerPauses(call);

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
        if (audible(event.delta, call.muLaw === true)) {
          call.spoke = Date.now();
        }

        timed(call, event.end_ms === undefined ? undefined : onCall(call, event.end_ms));
        call.speak?.(event.delta);

        return;
      }

      case "session.usage.updated": {
        call.record.usage = usage(
          (call.usedBefore ?? 0) + event.usage.seconds,
          event.context_window?.usage_ratio ?? call.record.usage?.context,
        );

        return;
      }

      case "session.closed": {
        if (event.usage) {
          call.record.usage = usage(
            (call.usedBefore ?? 0) + event.usage.seconds,
            call.record.usage?.context,
          );
        }

        if (!filled(call.closing) && CARRIES_ON.has(event.reason ?? "")) {
          lost(call, event.reason ?? "connection_lost");

          return;
        }

        // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
        /* The app drops its own connection as it hangs up, and OpenAI can close the session for
           that before it reads the hang-up, so once someone hung up the call ends by them. */
        if (filled(call.closing)) {
          finish(call, "close_requested", call.closing);
        } else {
          finish(call, event.reason ?? "closed", event.client_event_id);
        }
      }
    }
  });

  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- replaces the close handler a reattach set
  socket.onclose = () => {
    if (call.socket === socket) {
      reconnect(call, Date.now() - opened < 5000 ? attempt + 1 : 0);
    }
  };
}

function reconnect(call: Live, attempt: number) {
  if (live !== call || call.lost) {
    return;
  }

  letGo(call, "the connection to the voice dropped and is coming back; try again in a few seconds");
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  /* A close sent on the dropped connection may never have reached the session, so it goes out
     again. */
  delete call.closed;

  const socketIsTheSession = call.speak !== undefined;
  const hungUp = filled(call.closing);

  if (socketIsTheSession && !hungUp) {
    lost(call, "connection_lost");

    return;
  }

  if (socketIsTheSession || (hungUp && attempt >= RETRIES.length)) {
    finish(call, "close_requested", call.closing);

    return;
  }

  if (attempt === 0 || call.unattached === undefined) {
    call.unattached = Date.now();
  }

  const was = sessionOf(call);
  const moved = () => live !== call || sessionOf(call) !== was || call.lost !== undefined;
  trace(`lost the connection to ${was}, reattaching (try ${attempt + 1})`);
  setTimeout(
    () => {
      if (moved()) {
        return;
      }

      const socket = sideband(was);
      socket.addEventListener("open", () => {
        if (moved()) {
          if (live !== call && filled(call.closing) && call.closed !== true) {
            sendClose(call, call.closing, socket);
          }

          // oxlint-disable-next-line unicorn/prefer-add-event-listener -- clears the handler below
          socket.onclose = null;
          socket.close();

          return;
        }

        trace(`reattached to ${was}`);
        call.socket = socket;
        listen(call, socket, attempt);
      });

      // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
      /* The caller's app holds the call, not this connection, so losing it doesn't end the call: the
       engine keeps coming back, and the app can carry the call on in a new session meanwhile. A
       session OpenAI won't serve for as long as a lost call waits to carry on is as good as gone. */
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- listen() replaces it once the socket opens
      socket.onclose = async () => {
        const over = filled(call.closing) ? undefined : await sessionOver(call);

        if (moved()) {
          return;
        }

        if (over === "no answer") {
          call.unattached = Date.now();
        }

        if (over === "expired" || over === "connection_lost") {
          lost(call, over);
        } else if (!filled(call.closing) && Date.now() - (call.unattached ?? 0) >= GRACE) {
          trace(`${was} wasn't served for ${GRACE / 1000}s and nothing carried ${call.id} on`);
          finish(call, "connection_lost");
        } else {
          reconnect(call, attempt + 1);
        }
      };
    },
    RETRIES[Math.min(attempt, RETRIES.length - 1)],
  );
}

async function sessionOver(call: Live) {
  if (expired(call.record)) {
    return "expired";
  }

  const gone = await sessionGone(sessionOf(call));

  return gone === "gone" ? "connection_lost" : gone;
}

function expired({ expires }: Pick<CallRecord, "expires">) {
  return filled(expires) && Date.parse(expires) <= Date.now();
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* OpenAI answers a plain GET on a session's attach URL with 400 while the session lives. Once it's
   gone the answer is 404 or 503, and 503 is also what a brief outage looks like, so only 404
   settles it. No answer at all means hex can't reach OpenAI, which says nothing about the session,
   so the wait a call gets to come back counts only time OpenAI could be asked. It can take 5s to
   answer for a session that just ended. */
async function sessionGone(id: string): Promise<"gone" | "maybe not" | "no answer"> {
  try {
    const { status } = await fetch(`${API}/${id}/attach`, {
      headers: { Authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(15_000),
    });

    return status === 404 ? "gone" : "maybe not";
  } catch {
    return "no answer";
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* A session OpenAI ends without either side hanging up, its time limit or a lost connection, isn't
   the end of the call: the call carries on in a new session, opened by the caller's app for an app
   call and by the engine for a phone or Discord call, and ends only if none opens for a while. */
function lost(call: Live, reason: string) {
  if (live !== call || call.lost) {
    return;
  }

  trace(`${sessionOf(call)} ended (${reason}); ${call.id} waits to carry on`);
  call.lost = {
    reason,
    at: new Date().toISOString(),
    giveUp: setTimeout(() => {
      finish(call, reason);
    }, GRACE),
  };
  letGo(call, "the voice is reconnecting; try again in a few seconds");
  call.reopen?.(call, carryOnWith(call, reason));
}

function carried(call: Live, socket: WebSocket, next: string, expires: string | undefined) {
  const before = call.socket;
  const reason = call.lost?.reason ?? "connection_lost";
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- clears the reconnect handler listen() set
  before.onclose = null;

  if (!call.lost && before.readyState === WebSocket.OPEN) {
    before.send(JSON.stringify({ type: "session.close", event_id: `close_hex_${++seq}` }));
  }

  before.close();
  clearTimeout(call.lost?.giveUp);
  delete call.lost;
  delete call.closed;
  delete call.unattached;
  letGo(call, "the voice moved to a new session; send it again");
  call.handoffs = new Set();
  call.shift = since(call);
  call.usedBefore = call.record.usage?.seconds ?? 0;
  call.record = { ...call.record, session: next, ...(expires !== undefined && { expires }) };
  call.socket = socket;
  trace(`${call.id} carried on in ${next} (${reason})`);
  remember(
    call,
    "reconnected",
    reason === "expired"
      ? "The call hit OpenAI's time limit and carried on"
      : "The connection dropped and came back",
  );
  listen(call, socket);
  deliver(
    `The call's voice session ended (${reason}) and the call carried on in a new one, which knows the call so far. Answers to earlier handoffs reach it without their handoff.`,
    { call: call.id, carried: reason },
  );
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* gpt-live-1 stays silent when the call so far comes as one developer message, and says it's back when it comes as the call's own turns. */
function carryOnWith(call: Pick<Live, "call" | "mute">, reason: string): Said[] {
  const turns = call.call
    .record()
    .turns.slice(-40)
    .map(({ who, text }): Said =>
      who === "you"
        ? { type: "message", role: "user", content: [{ type: "input_text", text }] }
        : { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
    );

  return [
    ...turns,
    developer(
      [
        reason === "expired"
          ? "This call carries on from a session that hit its time limit; the caller heard only a short pause. Don't mention it: finish anything you were cut off saying, otherwise listen."
          : "The caller's connection dropped for a moment and this call carries on. Say in a few words that you're back, then finish anything you were cut off saying, or ask what they said while you were gone.",
        ...(call.mute?.muted === true ? [MUTED] : []),
      ].join("\n"),
    ),
  ];
}

function letGo(call: Live, why: string) {
  for (const pending of call.pending.values()) {
    pending.reject(new Error(why));
  }

  call.pending.clear();
}

function sessionOf(call: Pick<Live, "id" | "record">) {
  return call.record.session ?? call.id;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* A network that goes away leaves a connection open that hears nothing and tells nobody (13 minutes
   on Nov 10), so each connection to the voice is pinged, and dropped once nothing has come back for
   a while or it never opened; whatever handles its close then brings it back. */
function voiceSocket(url: string) {
  // SAFETY: Bun's WebSocket has ping and terminate, which lib "dom" leaves out of its type.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- widens to the methods Bun's WebSocket has
  const socket = new BunWebSocket(url, {
    headers: { Authorization: `Bearer ${KEY}` },
  }) as WebSocket & {
    ping: () => void;
    terminate: () => void;
  };

  let heard = Date.now();

  const alive = () => {
    heard = Date.now();
  };

  for (const type of ["open", "message", "pong"]) {
    socket.addEventListener(type, alive);
  }

  const keepAlive = setInterval(() => {
    if (socket.readyState === WebSocket.CLOSED) {
      clearInterval(keepAlive);
    } else if (Date.now() - heard >= QUIET_MOST) {
      trace(
        `nothing came back from the voice for ${QUIET_MOST / 1000}s, so hex dropped that connection`,
      );
      clearInterval(keepAlive);
      socket.terminate();
    } else if (socket.readyState === WebSocket.OPEN) {
      socket.ping();
    }
  }, PING_EVERY);

  return socket;
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
      !expired(record);

    if (latest) {
      reattach({ id, session: record.session ?? id, since: Date.now() });
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

function reattach(pending: Attaching, attempt = 0) {
  const { id, session: attachTo } = pending;
  const socket = sideband(attachTo);
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

      if (record && live?.id !== id) {
        closeOut(record);
      } else if (!live && !filled(pending.closing)) {
        toHub(hub.renew);
      }

      return;
    }

    const { turns: _turns, tasks: _tasks, moments: _moments, ...rest } = record;
    trace(`picked ${record.id} back up after a restart`);
    follow(socket, rest, {
      call: Call.resume(record),
      hello: resumedHello(
        record,
        "picked it back up. The caller is still on it, and the voice kept its own memory of the call.",
      ),
    });
  });

  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- listen() replaces this handler once the call is live
  socket.onclose = () => {
    if (filled(pending.closing)) {
      closeSession(attachTo, pending.closing);

      return;
    }

    if (live?.id !== id) {
      void attachAgain(pending, attempt);
    }
  };
}

function resumedHello(record: CallRecord, how: string) {
  const so = record.turns.slice(-40).map(({ who, at, text }) => ({ who, text, start: at }));

  return [
    `A call resumed: hex's service restarted during call ${record.id} and ${how}`,
    ...(filled(record.why) ? [`You placed it because: ${record.why}`] : []),
    ...(so.length ? ["The call so far:", transcript(so)] : []),
    ...(record.tasks.length ? [Call.resume(record).board()] : []),
  ].join("\n");
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* A session that ended while hex was down can't be attached back to, but the caller's app is still
   carrying the call on, so the call waits for it as long as a lost call would. */
async function attachAgain(pending: Attaching, attempt: number) {
  const record = calls.get(pending.id);
  const gone = record !== undefined && !live ? await sessionGone(pending.session) : "gone";

  if (filled(pending.closing)) {
    closeSession(pending.session, pending.closing);

    return;
  }

  if (attaching !== pending) {
    return;
  }

  if (gone === "no answer") {
    pending.since = Date.now();
  }

  const giveUp = () => {
    attaching = undefined;
    const now = calls.get(pending.id);

    if (now) {
      closeOut(now);
    } else if (!live) {
      toHub(hub.renew);
    }
  };

  if (!record || live || Date.now() - pending.since >= GRACE) {
    giveUp();

    return;
  }

  if (gone === "gone") {
    trace(`${pending.session} is gone; ${pending.id} waits for the app to carry it on`);
    setTimeout(
      () => {
        if (attaching === pending && !filled(pending.closing)) {
          giveUp();
        }
      },
      pending.since + GRACE - Date.now(),
    );

    return;
  }

  trace(`couldn't attach back to ${pending.session} yet, trying again (try ${attempt + 1})`);
  setTimeout(
    () => {
      if (filled(pending.closing)) {
        closeSession(pending.session, pending.closing);
      } else if (attaching === pending) {
        reattach(pending, attempt + 1);
      }
    },
    RETRIES[Math.min(attempt, RETRIES.length - 1)],
  );
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
  moved: (socket: WebSocket) => void;
  refused: (reason: string) => void;
  closed: () => void;
};

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* A phone or Discord call's socket is its session, so the call carries on through a new socket the
   line's audio moves to; the line itself stays up until the call ends. */
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
  moved,
  refused,
  closed,
}: Passed) {
  const voice = readStyle(STATE_DIR).voice ?? VOICE;
  let up = false;
  let refusing = false;

  const refuseOnce = (reason: string) => {
    if (up || refusing) {
      return;
    }

    refusing = true;
    refused(reason);
  };

  const connect = (opening: Said[], carrying?: Live) => {
    const openai = voiceSocket(API);
    let begun = false;

    openai.addEventListener("open", () => {
      openai.send(
        JSON.stringify({
          type: "session.start",
          session: session(
            { audio: { format, ...(filled(voice) && { output: { voice } }) } },
            opening,
          ),
        }),
      );
    });

    openai.addEventListener("message", ({ data }) => {
      const parsed = SessionEvent.safeParse(JSON.parse(String(data)));

      if (begun || !parsed.success) {
        return;
      }

      const event = parsed.data;

      if (carrying) {
        if (event.type === "error") {
          trace(`OpenAI refused to carry the ${name} call on: ${JSON.stringify(event.error)}`);
          openai.close();

          return;
        }

        begun = true;

        if (live !== carrying || filled(carrying.closing)) {
          openai.send(JSON.stringify({ type: "session.close", event_id: `close_hex_${++seq}` }));
          openai.close();

          return;
        }

        moved(openai);
        carried(carrying, openai, event.session.id, expiry(event.session.expires_at));

        return;
      }

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

      begun = true;
      up = true;
      started(event.session.id);
      const expires = expiry(event.session.expires_at);
      follow(
        openai,
        base(event.session.id, from, {
          ...(voice !== undefined && { voice }),
          ...(why !== undefined && { why }),
          ...(callee !== undefined && { callee }),
          ...(expires !== undefined && { expires }),
        }),
        {
          speak: play,
          muLaw: format.type === "audio/pcmu",
          heard,
          notes,
          end: closed,
          reopen: (call, text) => {
            connect(text, call);
          },
        },
      );
    });

    openai.addEventListener("close", ({ code, reason }) => {
      trace(`OpenAI closed the ${name} session (${code} ${reason})`);

      if (carrying) {
        const tryAgain = () => !begun && live === carrying && carrying.lost !== undefined;

        if (tryAgain()) {
          setTimeout(() => {
            if (tryAgain()) {
              connect(opening, carrying);
            }
          }, RETRIES[2]);
        }

        return;
      }

      if (!up) {
        refuseOnce(
          `OpenAI closed the ${name} session before it started (${code} ${reason === "" ? "no reason" : reason})`,
        );
        closed();
      }
    });

    return openai;
  };

  return connect([developer(greeting)]);
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
    moved: (socket) => {
      twilio.data.openai = socket;
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

  let openai: WebSocket = passThrough({
    name: from,
    from,
    greeting,
    format: { type: "audio/pcm", rate: 24_000 },
    play: voiceLine.play,
    started: () => {
      up = true;
    },
    moved: (socket) => {
      openai = socket;
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
      if (up && openai.readyState === WebSocket.OPEN) {
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

const SILENT = 100;

function fromMuLaw(byte: number) {
  const bits = 255 - byte;
  const magnitude = ((bits % 16) * 8 + 132) * 2 ** Math.floor((bits % 128) / 16) - 132;

  return bits >= 128 ? -magnitude : magnitude;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* gpt-live-1 streams audio the whole call, silence included, so only what's loud is the voice
   talking. Phone audio is 8-bit μ-law, the rest 16-bit PCM. */
export function audible(base64: string, muLaw: boolean) {
  const bytes = Buffer.from(base64, "base64");
  const samples = muLaw ? bytes.length : Math.floor(bytes.length / 2);
  let sum = 0;

  for (let i = 0; i < samples; i++) {
    sum += Math.abs(muLaw ? fromMuLaw(bytes[i] ?? 255) : bytes.readInt16LE(i * 2));
  }

  return samples > 0 && sum / samples > SILENT;
}

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

const NO_CREDIT = /no credits|insufficient_quota|exceeded your current quota/iu;
const BILLING = "https://platform.openai.com/settings/organization/billing";
let credit: "ok" | "out" | undefined;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* OpenAI shows an API key no balance, so the cheapest request there is, a one-token embedding,
   says whether the key has credit left. It's asked as hex starts, after each call and daily, so
   running out reaches the caller before their next call fails. */
async function checkCredit() {
  if (!filled(KEY)) {
    return;
  }

  let reason: string | undefined;

  try {
    const response = await fetch(`${OPENAI}/embeddings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: "a" }),
    });

    const text = response.status === 429 ? await response.text() : "";
    reason = NO_CREDIT.test(text) ? problem(text) : undefined;
  } catch {
    return;
  }

  outOfCredit(reason);
}

function outOfCredit(reason: string | undefined) {
  const was = credit;
  credit = reason === undefined ? "ok" : "out";

  if (credit === "out" && was !== "out") {
    deliver(
      `OpenAI says the voice's API key has no credit left (${reason}), so the next call will fail before it starts. Tell the caller now with send to General, with where to add credit: ${BILLING}`,
      { credit: "out" },
    );
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
      if (twilio.data.started === true && twilio.data.openai?.readyState === WebSocket.OPEN) {
        twilio.data.openai.send(
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
  client?: {
    data_channel: { allowed_client_events: string[]; allowed_server_events: { type: string }[] };
  };
};

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* The app's data channel gets every server event unless told otherwise, the errors the engine's own
   commands cause included, and an app that hangs up on one loses a call that was fine. */
const APP_HEARS = [
  "session.started",
  "session.input_transcript.delta",
  "session.output_transcript.delta",
  "session.input_audio.muted",
  "session.input_audio.unmuted",
  "session.closed",
].map((type) => ({ type }));

type Said = {
  type: "message";
  role: "developer" | "user" | "assistant";
  content: { type: "input_text" | "output_text"; text: string }[];
};

function developer(text: string): Said {
  return { type: "message", role: "developer", content: [{ type: "input_text", text }] };
}

function session(extra: SessionExtra = {}, opening: Said[] = []) {
  return {
    model: MODEL,
    instructions: voicePrompt(IDENTITY, readStyle(STATE_DIR), clock(), JEV !== undefined),
    delegation: { type: "client" },
    ...(opening.length > 0 && { input: opening }),
    ...extra,
  };
}

async function start(request: Request) {
  if (!filled(KEY)) {
    return new Response(`Set OPENAI_API_KEY in ${join(STATE_DIR, ".env")}`, { status: 503 });
  }

  const body = StartBody.safeParse(await request.json());

  const {
    sdp,
    voice = readStyle(STATE_DIR).voice ?? VOICE,
    from: origin,
    about,
    continues,
  } = body.success ? body.data : {};

  if (!filled(sdp)) {
    return new Response("An SDP offer is required", { status: 400 });
  }

  if (filled(continues)) {
    return await carryOn(continues, sdp);
  }

  const from = origin === "app" ? "app" : "web";
  const topic = topicOf(about);
  let response: Response;

  try {
    response = await openSession(sdp, voice, [
      developer(topic?.voice ?? "Greet the caller in a few words, then listen."),
    ]);
  } catch (error) {
    const reason = `couldn't reach OpenAI: ${messageOf(error)}`;
    failed({ from, end: "no-connect", reason, ...(voice !== undefined && { voice }) });

    return new Response(reason, { status: 502 });
  }

  if (!response.ok) {
    const text = await refusal(response);
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

async function openSession(sdp: string, voice: string | undefined, opening: Said[]) {
  return await fetch(API, {
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
              allowed_server_events: APP_HEARS,
            },
          },
        },
        opening,
      ),
      transport: { type: "webrtc", sdp },
    }),
  });
}

async function refusal(response: Response) {
  const text = await response.text();

  if (response.status === 429 && NO_CREDIT.test(text)) {
    credit = "out";
  }

  return text;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* The caller's app lost its connection to the voice, or the session hit its time limit, and opens
   a new one for the same call: the call keeps its id, its record and hex's session. A call hex was
   picking back up after a restart carries on the same way, from its record. */
async function carryOn(id: string, sdp: string) {
  const call = carriable(id);
  const pending = call ? undefined : attachingBackTo(id);
  const held = pending && calls.get(id);
  const from = call ?? (held && { call: Call.resume(held), record: held });

  if (!from) {
    return new Response("That call has ended", { status: 410 });
  }

  let response: Response;

  try {
    response = await openSession(
      sdp,
      from.record.voice,
      carryOnWith(from, call?.lost?.reason ?? "connection_lost"),
    );
  } catch (error) {
    return new Response(`couldn't reach OpenAI: ${messageOf(error)}`, { status: 502 });
  }

  if (!response.ok) {
    const text = await refusal(response);
    trace(`OpenAI refused to carry ${id} on (${response.status}): ${problem(text)}`);

    return new Response(text, { status: response.status });
  }

  const created = SessionCreated.parse(await response.json());
  const next = created.session.id;
  const expires = expiry(created.session.expires_at);
  const now = carriable(id);

  if (now) {
    carried(now, sideband(next), next, expires);
  } else if (pending && attachingBackTo(id) === pending) {
    carryOnAfterRestart(pending, next, expires);
  } else {
    closeSession(next, call?.closing ?? pending?.closing ?? `close_hex_${++seq}`);

    return new Response("That call has ended", { status: 410 });
  }

  return Response.json({ ...created, session: { ...created.session, id } }, { status: 201 });
}

function carriable(id: string) {
  return live?.id === id && live.speak === undefined && !filled(live.closing) ? live : undefined;
}

function attachingBackTo(id: string) {
  return attaching?.id === id && !filled(attaching.closing) ? attaching : undefined;
}

function carryOnAfterRestart(pending: Attaching, next: string, expires: string | undefined) {
  const record = calls.get(pending.id);

  if (!record) {
    return;
  }

  attaching = undefined;
  const { turns: _turns, tasks: _tasks, moments: _moments, ...rest } = record;
  trace(`${record.id} carried on in ${next} after a restart`);

  const call = follow(
    sideband(next),
    { ...rest, session: next, ...(expires !== undefined && { expires }) },
    {
      call: Call.resume(record),
      hello: resumedHello(
        record,
        "the caller's app carried it on in a new voice session, which knows the call so far.",
      ),
    },
  );

  call.shift = Date.now() - Date.parse(record.started);
  call.usedBefore = record.usage?.seconds ?? 0;
  remember(call, "reconnected", "The connection dropped and came back");
}

const PAUSED =
  "The caller's phone took over their audio, a phone call or Siri: they can't hear you or talk. Stay quiet until they're back.";

const RESUMED =
  "The caller can hear you and talk again. Carry on where you were, without greeting them again: if you were cut off mid-answer, finish it in a sentence; if not, just listen.";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* iOS can flap the audio session many times a second (8 times in 12s on one call), so the voice
   hears only where it settled: a blink tells it nothing. */
async function interruption(request: Request, id: string) {
  const body = await bodyOf(request, InterruptionBody);

  if (!body) {
    return new Response("kind is paused or resumed", { status: 400 });
  }

  const { kind, text } = body;

  if (live?.id !== id) {
    return new Response("That call is not live", { status: 409 });
  }

  const call = live;
  call.away ??= { told: false };
  const { away } = call;
  clearTimeout(away.settling);
  away.settling = setTimeout(() => {
    const gone = kind === "paused";

    if (live !== call || away.told === gone) {
      return;
    }

    away.told = gone;
    remember(
      call,
      kind,
      filled(text) ? text : gone ? "Your phone took over the audio" : "Back on the call",
    );
    void send(call, "session.instructions.append", gone ? PAUSED : RESUMED).catch(
      fineIfUnconfirmed,
    );
  }, SETTLE);

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
      ? new Response(Bun.file(file), { headers: { "Cache-Control": "no-cache" } })
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
      const body = await bodyOf(request, AnswerBody);
      const items = mediaOf(body?.media ?? []);

      if (!items) {
        return new Response(CHAT_FIELD_PROBLEMS.media, { status: 400 });
      }

      const typed = body?.label.trim() ?? "";
      const label = typed === "" ? photos(items) : typed;

      if (!filled(label)) {
        return new Response("An answer needs its label", { status: 400 });
      }

      const sent = await answerQuestion(key, label, "app", items);
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
      const body = await bodyOf(request, NoteBody);
      const items = mediaOf(body?.media ?? []);

      if (!items) {
        return new Response(CHAT_FIELD_PROBLEMS.media, { status: 400 });
      }

      const typed = body?.text.trim() ?? "";
      const text = typed === "" ? photos(items) : typed;

      if (text === "") {
        return new Response("A note needs its text", { status: 400 });
      }

      const sent = await questions.note(key, text, "app", items);
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
          `The caller marked the card for ${key} as not needing them; its threads are told to decide or do it themselves${missed(sent)}.`,
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
  const thread = filled(key) ? runs.find(key) : undefined;

  if (thread && verb === "chat") {
    return request.method === "POST" ? sendChat(request, thread) : showChat(url, thread);
  }

  if (thread && !filled(verb) && request.method === "GET") {
    return showPage(url, runs, key);
  }

  const run = filled(key) ? runs.get(key) : undefined;

  if (!run) {
    return new Response("404", { status: 404 });
  }

  if (verb === "talk" && request.method === "POST") {
    return talkAbout(runTopic(run));
  }

  if (verb === "stop" && request.method === "POST") {
    return done(() => {
      chats.stop(run);
    });
  }
}

async function showPage(url: URL, runs: Board, key: string) {
  const read = () => {
    const found = runs.find(key);

    return (
      found && {
        ...found,
        ...("steps" in found && {
          steps: found.steps.map((step) => ({ ...step, brief: brief(step) })),
        }),
        ...yours.of(found.id),
      }
    );
  };

  const after = url.searchParams.get("after");

  if (after !== null && after !== "" && Number(after) === runs.version) {
    const end = Date.now() + 25_000;
    const before = JSON.stringify(read());

    while (Date.now() < end && JSON.stringify(read()) === before) {
      await runs.changes(runs.version, end - Date.now());
    }
  }

  const shown = read();

  return shown
    ? Response.json({ version: runs.version, ...shown })
    : new Response("404", { status: 404 });
}

async function showChat(url: URL, run: Run | Page) {
  const where = (): Where => {
    const serving = board.session(run.id);

    return serving === undefined ? { ...run } : { ...run, session: serving };
  };

  const after = url.searchParams.get("after");

  const chat =
    after !== null && after !== ""
      ? await chats.next(where, Number(after), 25_000)
      : chats.of(where());

  return Response.json(chat);
}

const CHAT_FIELD_PROBLEMS = {
  media: "Name each photo or video by the id /media gave it",
  text: "Send some words, or a photo or video",
  key: "Name the message with a key starting app-",
};

async function sendChat(request: Request, run: Run | Page) {
  const raw: unknown = await request.json().catch(() => null);
  const parsed = ChatBody.safeParse(raw ?? {});

  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];

    return new Response(field === "media" ? CHAT_FIELD_PROBLEMS.media : CHAT_FIELD_PROBLEMS.text, {
      status: 400,
    });
  }

  const { media: names, text, key } = parsed.data;
  const items = mediaOf(names);

  if (!items) {
    return new Response(CHAT_FIELD_PROBLEMS.media, { status: 400 });
  }

  if (text.trim() === "" && items.length === 0) {
    return new Response(CHAT_FIELD_PROBLEMS.text, { status: 400 });
  }

  const named = ChatKey.safeParse(key);

  if (!named.success) {
    return new Response(CHAT_FIELD_PROBLEMS.key, { status: 400 });
  }

  return await done(() => chats.send(run, text.trim(), named.data, items));
}

function mediaOf(names: string[]) {
  const items = names.map((name) => media.get(name));

  return items.every((item) => item !== undefined) ? items : undefined;
}

function photos(items: Item[]) {
  if (items.length === 0) {
    return "";
  }

  const kinds = new Set(items.map((item) => item.kind));
  const kind = kinds.size === 1 ? [...kinds][0] : "photo or video";

  return items.length === 1 ? `a ${kind}` : `${items.length} ${kind}s`;
}

async function done(act: () => Promise<void> | void) {
  try {
    await act();

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

  if (pathname === "/settings" && request.method === "GET") {
    return Response.json({ settings: readStyle(STATE_DIR), ...options() });
  }

  if (pathname === "/settings" && request.method === "PUT") {
    return changeStyle(request);
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
  void checkCredit();
  setInterval(() => void checkCredit(), 24 * 60 * 60_000);

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
