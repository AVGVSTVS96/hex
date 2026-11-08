import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

import {
  stripLocalCommandMetadata,
  toAcpNotifications,
} from "@agentclientprotocol/claude-agent-acp";
import { decrypt, encrypt, getConversationKey } from "nostr-tools/nip44";
import type { Event } from "nostr-tools/pure";
import { z } from "zod";

import { interrupted } from "../../hub/claude.ts";
import { loaded } from "../../hub/loaded.ts";
import type { Relay } from "./relay.ts";

type Frame = {
  seq: number;
  timestamp: string;
  kind: string;
  agentIndex: number | null;
  channelId: string | null;
  sessionId: string | null;
  turnId: string | null;
  startedAt?: string;
  payload: Json;
};

type Json = z.core.util.JSONType;

type Branch = Json[] | { [key: string]: Json };

type Leaf = { text: string; replace: (text: string) => void };

type Transcript = {
  path: string;
  offset: number;
  rest: Buffer;
  since: number;
  tools: Parameters<typeof toAcpNotifications>[3];
  tasks: NonNullable<NonNullable<Parameters<typeof toAcpNotifications>[6]>["taskState"]>;
  stopped: boolean;
};

type Turn = {
  id: string;
  thread: string;
  channel: string;
  startedAt: string;
  beat: number;
  session?: string | undefined;
  transcript?: Transcript;
  ending?: boolean;
  cut?: boolean;
};

type Target = { channel: string; thread?: string; session?: string };

const KIND = 24_200;
const LIMIT = 65_535;
const TICK = 1000;
const LIVENESS = 10_000;
const FRESH = 300;
const BACKLOG = 4 * 1024 * 1024;
const LOG_LINES = 1000;
const LOG_LINE_BYTES = 4096;
const LOG_LEASE = 60_000;

const calledOnlyByHooks = () =>
  Promise.reject(new Error("a replayed transcript registers no hooks to call the client"));

const client: Parameters<typeof toAcpNotifications>[4] = {
  sessionUpdate: calledOnlyByHooks,
  requestPermission: calledOnlyByHooks,
  readTextFile: calledOnlyByHooks,
  writeTextFile: calledOnlyByHooks,
  createElicitation: calledOnlyByHooks,
  completeElicitation: calledOnlyByHooks,
  extNotification: calledOnlyByHooks,
};

const logger = {
  // oxlint-disable-next-line eslint/no-empty-function -- the ACP converter's info lines stay out of the hub log
  log: () => {},
  error: (...args: unknown[]) => {
    process.stderr.write(`buzz hub: activity: ${args.join(" ")}\n`);
  },
};

const transcriptEntry = z.looseObject({
  timestamp: z.string(),
  type: z.string(),
  subtype: z.string().exactOptional(),
  isSidechain: z.boolean().exactOptional(),
  isMeta: z.boolean().exactOptional(),
  origin: z.looseObject({}).exactOptional(),
  uuid: z.string().exactOptional(),
  toolUseResult: z.unknown().exactOptional(),
  message: z
    .looseObject({ id: z.string().exactOptional(), content: z.unknown().exactOptional() })
    .exactOptional(),
});

const acpContent = z.union([
  z.string(),
  z.custom<Exclude<Parameters<typeof toAcpNotifications>[0], string>>(Array.isArray),
]);

const json = z.json();

const controlRequest = z.union([
  z.looseObject({
    type: z.literal("cancel_turn"),
    channelId: z.string(),
    requestId: json.exactOptional(),
  }),
  z.looseObject({ type: z.literal("log_follow"), tail: z.unknown().exactOptional() }),
]);

export function startActivity({
  relay,
  secretKey,
  owner,
  hexDir,
  cancel,
}: {
  relay: Relay;
  secretKey: Uint8Array;
  owner: string;
  hexDir: string;
  cancel: (target: Target) => "sent" | "no_active_turn" | "ambiguous_target";
}) {
  const key = getConversationKey(secretKey, owner);

  const projects = join(
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    "projects",
    hexDir.replaceAll(/[^a-zA-Z0-9]/gu, "-"),
  );

  const turns = new Map<string, Turn>();
  const announced = new Set<string>();
  const queue: { frame: Frame; bytes: number }[] = [];
  const logs: string[] = [];
  let following = 0;
  let streamed: string[] = [];
  let dropped = 0;
  let seq = 1;
  let backlog = 0;
  let sending = false;

  function push(kind: string, payload: Json, turn?: Turn, channel = turn?.channel ?? null) {
    const frame: Frame = {
      seq: seq++,
      timestamp: new Date().toISOString(),
      kind,
      agentIndex: turn ? 0 : null,
      channelId: channel,
      sessionId: turn?.session ?? null,
      turnId: turn?.id ?? null,
      payload,
    };

    if (turn) {
      frame.startedAt = turn.startedAt;
    }

    cutMiddleOfLongestStringUntilItFits(frame);
    const bytes = size(frame);
    queue.push({ frame, bytes });
    backlog += bytes;

    while (backlog > BACKLOG) {
      backlog -= queue.shift()?.bytes ?? 0;
    }
  }

  function busy({
    thread,
    channel,
    session,
    triggers,
  }: {
    thread: string;
    channel: string;
    session?: string | undefined;
    triggers: string[];
  }) {
    const turn = turns.get(thread);

    if (turn?.ending === true) {
      finish(turn);
    } else if (turn) {
      if (session !== undefined && session !== "" && !turn.transcript) {
        follow(turn, session, false);
      }

      return;
    }

    const opened: Turn = {
      id: randomUUID(),
      thread,
      channel,
      startedAt: new Date().toISOString(),
      beat: Date.now(),
      session,
    };

    turns.set(thread, opened);
    push(
      "turn_started",
      { source: "channel", triggeringEventIds: triggers, ...root(opened) },
      opened,
    );

    if (session !== undefined && session !== "") {
      follow(opened, session, true);
    }
  }

  function follow(turn: Turn, session: string, startedWithTurn: boolean) {
    turn.session = session;
    const path = join(projects, `${session}.jsonl`);
    turn.transcript = {
      path,
      offset: startedWithTurn ? sizeOf(path) : 0,
      rest: Buffer.alloc(0),
      since: Date.parse(turn.startedAt),
      tools: {},
      tasks: new Map(),
      stopped: false,
    };

    if (announced.has(session)) {
      return;
    }

    announced.add(session);
    push(
      "acp_write",
      {
        jsonrpc: "2.0",
        id: 0,
        method: "session/new",
        params: { cwd: hexDir, mcpServers: [], systemPrompt: instructions() },
      },
      turn,
    );
  }

  function read(turn: Turn) {
    const transcript = turn.transcript;

    if (!transcript) {
      return;
    }

    let fd;

    try {
      fd = openSync(transcript.path, "r");
    } catch {
      return;
    }

    try {
      const end = fstatSync(fd).size;

      if (end <= transcript.offset) {
        return;
      }

      const chunk = Buffer.alloc(end - transcript.offset);
      readSync(fd, chunk, 0, chunk.length, transcript.offset);
      transcript.offset = end;
      const data = Buffer.concat([transcript.rest, chunk]);
      const last = data.lastIndexOf(10);
      transcript.rest = data.subarray(last + 1);

      if (last !== -1) {
        for (const line of data.subarray(0, last).toString("utf-8").split("\n")) {convert(turn, line);}
      }
    } finally {
      closeSync(fd);
    }
  }

  function convert(turn: Turn, line: string) {
    const { transcript, session } = turn;
    let raw: unknown;

    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }

    const parsed = transcriptEntry.safeParse(raw);

    if (!transcript || session === undefined || !parsed.success) {
      return;
    }

    const entry = parsed.data;

    if (!(Date.parse(entry.timestamp) >= transcript.since)) {
      return;
    }

    if (entry.type === "system" && entry.subtype === "stop_hook_summary") {
      transcript.stopped = true;
    }

    if (interrupted(entry)) {
      transcript.stopped = true;
    } else if (entry.type === "assistant" && entry.isSidechain !== true) {
      transcript.stopped = false;
    }

    if ((entry.type !== "assistant" && entry.type !== "user") || entry.isSidechain === true) {
      return;
    }

    const promptInjectedByChannelOrPluginThatThePanelLinksInstead =
      entry.type === "user" && (entry.isMeta === true || entry.origin !== undefined);

    if (promptInjectedByChannelOrPluginThatThePanelLinksInstead) {
      return;
    }

    const content = acpContent.safeParse(
      entry.type === "user"
        ? stripLocalCommandMetadata(entry.message?.content)
        : entry.message?.content,
    );

    if (!content.success) {
      return;
    }

    const options: NonNullable<Parameters<typeof toAcpNotifications>[6]> = {
      registerHooks: false,
      replay: true,
      cwd: hexDir,
      taskState: transcript.tasks,
      toolUseResult: entry.toolUseResult,
    };

    const messageId = entry.type === "assistant" ? entry.message?.id : entry.uuid;

    if (messageId !== undefined) {
      options.messageId = messageId;
    }

    const notifications = toAcpNotifications(
      content.data,
      entry.type,
      session,
      transcript.tools,
      client,
      logger,
      options,
    );

    for (const notification of notifications) {
      const serialized = JSON.stringify(notification);
      const params = json.parse(JSON.parse(serialized));
      push("acp_read", { jsonrpc: "2.0", method: "session/update", params }, turn);
    }
  }

  function idle(thread: string) {
    const turn = turns.get(thread);

    if (!turn) {
      return;
    }

    turn.ending = true;
    read(turn);

    if (turn.cut === true || !turn.transcript || turn.transcript.stopped) {
      finish(turn);
    }
  }

  function stopped(thread: string) {
    const turn = turns.get(thread);

    if (!turn) {
      return;
    }

    turn.cut = true;

    if (turn.ending === true) {
      finish(turn);
    }
  }

  function finish(turn: Turn) {
    read(turn);
    turns.delete(turn.thread);
    push("turn_completed", {}, turn);
  }

  function instructions() {
    const files = loaded(join(hexDir, "AGENTS.md"));

    const body = files
      .map(([path, text]) => `── ${relative(hexDir, path)} ──\n${text.trim()}`)
      .join("\n\n");

    return `<workspace>\n${hexDir}\n</workspace>\n\n<agent-instructions>\n${body}\n</agent-instructions>`;
  }

  function control(event: Event) {
    if (
      event.pubkey !== owner ||
      !event.tags.some(([name, value]) => name === "frame" && value === "control")
    ) {
      return;
    }

    if (Math.abs(event.created_at - Date.now() / 1000) > FRESH) {
      return;
    }

    let raw: unknown;

    try {
      raw = JSON.parse(decrypt(event.content, key));
    } catch (error) {
      process.stderr.write(
        `buzz hub: dropped an unreadable activity control frame: ${String(error)}\n`,
      );

      return;
    }

    const request = controlRequest.safeParse(raw);

    if (request.data?.type === "cancel_turn") {
      const { channelId, requestId } = request.data;
      const status = cancel(onlyTurnIn(channelId));
      const result: Json = { type: "cancel_turn", status };

      if (requestId !== undefined) {
        result.requestId = requestId;
      }

      push("control_result", result, undefined, channelId);
    } else if (request.data?.type === "log_follow") {
      const tail = Math.max(0, Math.min(LOG_LINES, Number(request.data.tail) || 0));
      following = Date.now() + LOG_LEASE;
      streamed = [];
      dropped = 0;
      push("log", bounded(tail ? logs.slice(-tail) : [], 0));
    }
  }

  function onlyTurnIn(channel: string): Target {
    const [only, ...others] = [...turns.values()].filter((turn) => turn.channel === channel);

    if (!only || others.length > 0) {
      return { channel };
    }

    const found: Target = { channel, thread: only.thread };

    if (only.session !== undefined && only.session !== "") {
      found.session = only.session;
    }

    return found;
  }

  function log(text: string) {
    const line = clip(text, LOG_LINE_BYTES);
    logs.push(line);

    if (logs.length > LOG_LINES) {
      logs.shift();
    }

    if (Date.now() > following) {
      return;
    }

    streamed.push(line);

    if (streamed.length > LOG_LINES) {
      streamed.shift();
      dropped++;
    }
  }

  function bounded(lines: string[], skipped: number) {
    const base = size({
      seq,
      timestamp: new Date().toISOString(),
      kind: "log",
      agentIndex: null,
      channelId: null,
      sessionId: null,
      turnId: null,
      payload: { lines: [], dropped: skipped + lines.length },
    });

    let total =
      base + lines.reduce((sum, line) => sum + Buffer.byteLength(JSON.stringify(line)) + 1, 0);

    let first = 0;

    for (; total > LIMIT; first++) {
      total -= Buffer.byteLength(JSON.stringify(lines[first] ?? "")) + 1;
    }

    return { lines: lines.slice(first), dropped: skipped + first };
  }

  function tick() {
    for (const turn of turns.values()) {
      read(turn);

      if (turn.ending === true && turn.transcript?.stopped === true) {
        finish(turn);
        continue;
      }

      if (Date.now() - turn.beat < LIVENESS) {
        continue;
      }

      turn.beat = Date.now();
      push("turn_liveness", root(turn), turn);
    }

    if (streamed.length > 0 || dropped > 0) {
      push("log", bounded(streamed, dropped));
    }

    streamed = [];
    dropped = 0;

    const front = queue[0];

    if (sending || !front) {
      return;
    }

    sending = true;
    void send(sameChannelBatchFrom(front.frame.channelId)).finally(() => {
      sending = false;
    });
  }

  function sameChannelBatchFrom(channel: string | null): Frame {
    const picked: Frame[] = [];
    let total = 0;
    let full = false;

    const kept = queue.filter(({ frame, bytes }) => {
      if (full || frame.channelId !== channel) {
        return true;
      }

      if (picked.length > 0 && size(batch([frame])) + total + picked.length > LIMIT) {
        full = true;

        return true;
      }

      picked.push(frame);
      total += bytes;

      return false;
    });

    queue.splice(0, queue.length, ...kept);
    backlog -= total;

    const [only] = picked;

    return picked.length === 1 && only ? only : batch(picked);
  }

  async function send(frame: Frame) {
    try {
      await relay.publish({
        kind: KIND,
        content: encrypt(JSON.stringify(frame), key),
        tags: [
          ["p", owner],
          ["agent", relay.pubkey],
          ["frame", "telemetry"],
        ],
      });
    } catch (error) {
      process.stderr.write(
        `buzz hub: dropped an activity frame: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  const unsubscribe = relay.subscribe(
    [
      {
        kinds: [KIND],
        "#p": [relay.pubkey],
        authors: [owner],
        since: Math.floor(Date.now() / 1000),
      },
    ],
    control,
  );

  const timer = setInterval(tick, TICK);

  return {
    busy,
    idle,
    stopped,
    log,
    close() {
      clearInterval(timer);
      unsubscribe();
      turns.clear();
    },
  };
}

function root(turn: Turn) {
  return /^[0-9a-f]{64}$/u.test(turn.thread) ? { threadRootEventId: turn.thread } : {};
}

function batch(events: Frame[]): Frame {
  const last = events.at(-1);

  if (!last) {
    throw new Error("a batch takes at least one frame");
  }

  const { payload: _payload, ...rest } = last;

  return { ...rest, kind: "batch", payload: { events } };
}

function size(value: Frame) {
  return Buffer.byteLength(JSON.stringify(value));
}

function sizeOf(path: string) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function clip(text: string, bytes: number) {
  if (Buffer.byteLength(text) <= bytes) {
    return text;
  }

  let clipped = Buffer.from(text).subarray(0, bytes).toString("utf-8");

  while (Buffer.byteLength(clipped) > bytes) {
    clipped = clipped.slice(0, -1);
  }

  return clipped;
}

function cutMiddleOfLongestStringUntilItFits(frame: Frame) {
  for (let over = size(frame) - LIMIT; over > 0; over = size(frame) - LIMIT) {
    const leaf = longest(frame.payload, (text) => {
      frame.payload = text;
    });

    if (!leaf || leaf.text.length <= 64) {
      frame.payload = { elided: `${frame.kind} payload too large` };

      return;
    }

    const cut = Math.min(leaf.text.length, over + 64);
    const kept = leaf.text.length - cut;
    const keptTail = Math.min(1000, Math.floor(kept / 4));
    leaf.replace(
      `${leaf.text.slice(0, kept - keptTail)}\n[… ${cut} characters cut …]\n${leaf.text.slice(leaf.text.length - keptTail)}`,
    );
  }
}

const isText = (value: Json): value is string => typeof value === "string";

const isBranch = (value: Json): value is Branch => typeof value === "object" && value !== null;

function longest(value: Json, replace: (text: string) => void): Leaf | undefined {
  if (isText(value)) {
    return { text: value, replace };
  }

  if (!isBranch(value)) {
    return undefined;
  }

  const leaves = Array.isArray(value)
    ? value.map((inner, index) =>
        longest(inner, (text) => {
          value[index] = text;
        }),
      )
    : Object.entries(value).map(([key, inner]) =>
        longest(inner, (text) => {
          value[key] = text;
        }),
      );

  let best: Leaf | undefined;

  for (const found of leaves) {
    if (found && (!best || found.text.length > best.text.length)) {
      best = found;
    }
  }

  return best;
}
