#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { agent, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type {
  AgentContext,
  ContentBlock,
  McpServer,
  SetSessionConfigOptionRequest,
  PromptRequest,
  PromptResponse,
  SessionConfigOption,
  SessionNotification,
  StopReason,
} from "@agentclientprotocol/sdk";
import {
  startHub,
  clients,
  begin,
  dispatch,
  move,
  title,
  family,
  MODELS,
  EFFORTS,
  asked,
  open,
  stateDir as storeOf,
} from "@hex/hub";
import type { Handlers, Message, Settings, Turn as Said } from "@hex/hub";
import { z } from "zod";

import { server, tools } from "./channel.ts";
import { version } from "./package.json";
import { withT3, projectAt, linkTo, promptedBy, steering, appThreads } from "./t3code.ts";
import { follow, transcriptPath } from "./transcript.ts";

const STATE_DIR = process.env.T3_STATE_DIR ?? join(homedir(), ".claude", "channels", "hex", "t3");
const INBOX_DIR = join(STATE_DIR, "inbox");
const SOCKET = join(STATE_DIR, "acp.sock");
const PLACED_FILE = join(STATE_DIR, "placed.json");

// The provider instance T3 Code runs hex as, a key of providerInstances in its settings: https://github.com/pingdotgg/t3code/blob/8e6a7323050ea8d2891f745f7e624e84f9fd8d9a/packages/contracts/src/settings.ts#L1438
const PROVIDER_INSTANCE = process.env.T3_INSTANCE ?? "hex";
const HEX_DIR = process.env.HEX_DIR ?? process.cwd();
const HOME = homedir();
const SCRATCH = join(HOME, ".t3", "scratch");

const COMMANDS = [
  { name: "compact", description: "Summarize the conversation so far to free up context" },
];

type Turn = {
  client: AgentContext;
  reader?: ReturnType<typeof follow>;
  sent: Promise<unknown>;
  done: boolean;
  since: number;
  compaction?: string;
  resolve: (response: PromptResponse) => void;
  reject: (error: Error) => void;
};

const turns = new Map<string, Turn>();

// T3's provider check opens a session it never prompts, so an unprompted thread lasts only as long as its connection: https://github.com/pingdotgg/t3code/blob/8e6a7323050ea8d2891f745f7e624e84f9fd8d9a/packages/provider-acp-registry/src/server/probe.ts#L417-L438
type Unprompted = { cwd: string; settings: Settings; socket: Socket };

const opened = new Map<string, Unprompted>();

type Replay = { asked: string; replies: string[] };

const replays = new Map<string, Replay[]>();

const placed = new Set(
  existsSync(PLACED_FILE)
    ? z.array(z.string()).parse(JSON.parse(readFileSync(PLACED_FILE, "utf-8")))
    : [],
);

const t3ThreadIds = new Map<string, string>();

const mcpConfigs = new Map<string, string>();

mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 });

const T3_RECORDING_GRACE = Number(process.env.T3_RECORDING_MS) || 5 * 60_000;
const started = Date.now();
const kept = new Map<string, number>();
const closing = new Set<string>();
let recordsThisSave: ReturnType<typeof appThreads> | null = null;

function link(thread: string) {
  if (recordsThisSave === null) {
    queueMicrotask(() => {
      try {
        mirror(recordsThisSave);
      } catch (error) {
        process.stderr.write(`t3: couldn't match hex's threads to T3's: ${String(error)}\n`);
      } finally {
        recordsThisSave = null;
      }
    });

    try {
      recordsThisSave = appThreads();
    } catch (error) {
      recordsThisSave = undefined;
      throw error;
    }
  }

  const record = recordsThisSave?.get(thread);

  return record && !record.deleted ? linkTo(record.thread) : undefined;
}

function mirror(records: typeof recordsThisSave) {
  const links = new Map(
    open(storeOf(STATE_DIR))
      .threads({ app: "t3" })
      .map((row) => [row.thread, row.link]),
  );

  const linked = (thread: string) => (links.get(thread) ?? "") !== "";
  const threads = hub.threads();

  if (
    !records ||
    !threads.some((thread) => linked(thread) && records.get(thread)?.deleted === false)
  ) {
    return;
  }

  for (const thread of threads) {
    const record = records.get(thread);

    if (record && !record.deleted) {
      kept.delete(thread);
      const name = record.title === "" ? hub.name(thread) : record.title;

      if (name !== undefined) {
        hub.rename(thread, name);
      }
    } else if (
      (record !== undefined || !linked(thread)) &&
      !turns.has(thread) &&
      !closing.has(thread) &&
      Date.now() - (kept.get(thread) ?? started) > T3_RECORDING_GRACE
    ) {
      closing.add(thread);
      kept.delete(thread);
      void close(thread);
    }
  }
}

async function close(thread: string) {
  try {
    await hub.retire(thread);
  } catch (error) {
    process.stderr.write(`t3: couldn't close ${thread}: ${String(error)}\n`);
  } finally {
    closing.delete(thread);
  }
}

const handlers: Handlers<typeof tools> = {
  new_thread: async (thread, args) => {
    const name = title(args.title);
    const cwd = hub.cwd(thread);

    const there = await begin(args.app, name, args.prompt, {
      about: args.about,
      ...(args.channel !== undefined && { where: args.channel }),
      ...(cwd !== undefined && { cwd }),
    });

    return `started thread "${name}" in ${args.app}: ${there.link}`;
  },
  handoff: async (thread, args) => {
    const leaveThisThreadInT3 = true;

    const there = await move(
      hub,
      thread,
      args.to,
      title(args.title),
      args.channel,
      leaveThisThreadInT3,
    );

    return `a copy of this conversation continues in ${args.to}: ${there}. You stay here.`;
  },
};

const hub = startHub({
  stateDir: STATE_DIR,
  channel: process.env.T3_CHANNEL ?? "plugin:t3@hex",
  server,
  link,
  call: dispatch(tools, handlers),
  state: (thread, busy, background) => {
    const turn = turns.get(thread);

    if (!turn) {
      return;
    }

    turn.done = !busy && !background;
    const session = hub.session(thread);

    if (busy && session !== undefined && !turn.reader) {
      turn.reader = reader(thread, session, turn, turn.since);
    }

    turn.reader?.settle();
  },
  failed: (thread, reason) => {
    const turn = turns.get(thread);
    turns.delete(thread);
    turn?.reader?.close();
    turn?.reject(
      RequestError.internalError(undefined, `hex couldn't start this thread's session: ${reason}`),
    );
  },
  args: (thread) => {
    const config = mcpConfigs.get(thread);

    return config === undefined ? [] : ["--mcp-config", config];
  },
  hexDir: HEX_DIR,
  ...(process.env.HEX_LAUNCHER !== undefined && { launcher: process.env.HEX_LAUNCHER }),
});

type McpConfig =
  | { command: string; args: string[]; env: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers: Record<string, string> };

function remember(thread: string, list: McpServer[] = []) {
  const entries = list.flatMap((mcp): [string, McpConfig][] => {
    if (!("type" in mcp)) {
      return [[mcp.name, { command: mcp.command, args: mcp.args, env: pairs(mcp.env) }]];
    }

    if (mcp.type === "acp") {
      return [];
    }

    return [[mcp.name, { type: mcp.type, url: mcp.url, headers: pairs(mcp.headers) }]];
  });

  if (entries.length > 0) {
    mcpConfigs.set(thread, JSON.stringify({ mcpServers: Object.fromEntries(entries) }));
  } else {
    mcpConfigs.delete(thread);
  }
}

function pairs(list: { name: string; value: string }[]) {
  return Object.fromEntries(list.map(({ name, value }) => [name, value]));
}

function reader(thread: string, session: string, turn: Turn, since?: number) {
  const cwd = hub.cwd(thread) ?? HEX_DIR;

  return follow({
    path: transcriptPath(cwd, session),
    sessionId: thread,
    cwd,
    since,
    done: () => turn.done,
    end: (error) => {
      finish(thread, "end_turn", error);
    },
    emit: (notification) => {
      send(turn, notification);
    },
  });
}

function send(turn: Turn, notification: SessionNotification) {
  turn.sent = turn.sent.then(() =>
    Promise.allSettled([turn.client.notify("session/update", notification)]),
  );
}

function compaction(turn: Turn, thread: string, status: string, error?: string) {
  if (turn.compaction === undefined) {
    return;
  }

  send(turn, {
    sessionId: thread,
    update: {
      sessionUpdate: "compaction_update",
      compactionId: turn.compaction,
      status,
      ...(error !== undefined && { error }),
    },
  });
}

function cutShortWithNoStopHook(thread: string) {
  hub.turned(thread);
  finish(thread, "cancelled");
}

function finish(thread: string, stopReason: StopReason, error?: string) {
  const turn = turns.get(thread);

  if (!turn) {
    return;
  }

  turns.delete(thread);
  turn.reader?.close();

  if (turn.compaction !== undefined) {
    compaction(
      turn,
      thread,
      error === undefined ? (stopReason === "cancelled" ? "cancelled" : "completed") : "failed",
      error,
    );
  }

  void answer(turn, stopReason, error);
}

async function answer(turn: Turn, stopReason: StopReason, error?: string) {
  await turn.sent;

  if (error === undefined) {
    turn.resolve({ stopReason });
  } else {
    turn.reject(RequestError.internalError(undefined, error));
  }
}

function known(thread: string) {
  if (hub.name(thread) === undefined && !opened.has(thread)) {
    throw RequestError.resourceNotFound(thread);
  }

  return thread;
}

function nameKept(thread: string) {
  keep(known(thread));
  const name = hub.name(thread);

  if (name === undefined) {
    throw RequestError.resourceNotFound(thread);
  }

  return name;
}

function reopen(thread: string, cwd: string, socket: Socket) {
  const waiting = opened.get(thread);

  if (waiting) {
    waiting.socket = socket;
  } else if (hub.name(thread) === undefined) {
    opened.set(thread, { cwd, settings: {}, socket });
  }

  return thread;
}

function keep(thread: string) {
  const waiting = opened.get(thread);

  if (!waiting) {
    return;
  }

  opened.delete(thread);
  kept.set(thread, Date.now());
  const folder = projectFolderOf(waiting.cwd);
  hub.register(thread, basename(folder ?? HEX_DIR), folder);
  hub.configure(thread, waiting.settings);
}

function prompt(
  { sessionId: thread, prompt: blocks, _meta }: PromptRequest,
  client: AgentContext,
  signal: AbortSignal,
): Promise<PromptResponse> {
  const name = nameKept(thread);
  const replay = replays.get(thread)?.shift();

  if (replay && asked(render(blocks)) === replay.asked) {
    return replayed(thread, replay, client);
  }

  replays.delete(thread);

  if (turns.has(thread)) {
    throw RequestError.invalidRequest(undefined, "this thread is already working on a prompt");
  }

  const session = hub.session(thread);
  const compact = startsWithCompact(blocks);

  if (compact && session === undefined) {
    throw RequestError.invalidRequest(undefined, "this thread has nothing to compact yet");
  }

  return new Promise((resolve, reject) => {
    const turn = track(thread, client, signal, resolve, reject, Date.now(), compact);

    if (session !== undefined) {
      turn.reader = reader(thread, session, turn);
    }

    if (compact) {
      compaction(turn, thread, "in_progress");
      void hub.command(thread, "/compact");
    } else {
      hub.deliver(thread, name, message(thread, blocks, turn.since, _meta));
    }
  });
}

// T3 follows the user's text with its own context block, which a command doesn't take: https://github.com/pingdotgg/t3code/blob/8e6a7323050ea8d2891f745f7e624e84f9fd8d9a/packages/provider-acp/src/server/adapter.ts#L723-L727
function startsWithCompact(blocks: ContentBlock[]) {
  return blocks[0]?.type === "text" && blocks[0].text.trim() === "/compact";
}

function track(
  thread: string,
  client: AgentContext,
  signal: AbortSignal,
  resolve: Turn["resolve"],
  reject: Turn["reject"],
  since: number,
  compact = false,
) {
  const turn: Turn = {
    client,
    sent: Promise.resolve(),
    done: false,
    since,
    resolve,
    reject,
    ...(compact && { compaction: randomUUID() }),
  };

  turns.set(thread, turn);
  // T3 keeps each session's MCP token only in its running server, so a prompt T3 aborts leaves the session's T3 tools dead: https://github.com/pingdotgg/t3code/blob/8e6a7323050ea8d2891f745f7e624e84f9fd8d9a/apps/server/src/mcp/McpSessionRegistry.ts#L122-L135
  signal.addEventListener(
    "abort",
    () => {
      if (turns.get(thread) !== turn) {
        return;
      }

      cutShortWithNoStopHook(thread);
      void hub.stop(thread);
    },
    { once: true },
  );

  return turn;
}

const promptKey = z.string().optional();

function message(
  thread: string,
  blocks: ContentBlock[],
  since: number,
  meta: PromptRequest["_meta"],
): Message {
  const key = promptKey.safeParse(meta?.["hex/key"]).data;

  return {
    content: render(blocks),
    meta: { ts: new Date(since).toISOString() },
    ...(key !== undefined && { key }),
    author: promptedBy(
      thread,
      asked(blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")),
    ),
  };
}

type Rejoin = PromptRequest & { since: number };

async function rejoin(
  { sessionId: thread, prompt: blocks, since, _meta }: Rejoin,
  client: AgentContext,
  signal: AbortSignal,
): Promise<PromptResponse> {
  const name = nameKept(thread);
  const running = await hub.running(thread);

  if (turns.has(thread)) {
    throw RequestError.invalidRequest(undefined, "this thread is already working on a prompt");
  }

  const session = running?.sessionId ?? hub.session(thread);
  const working = running?.status === "busy";

  return await new Promise((resolve, reject) => {
    const turn = track(thread, client, signal, resolve, reject, since);

    if (session !== undefined) {
      turn.reader = reader(thread, session, turn, since);
    }

    const promptSeen = turn.reader?.asked() === true;
    const compactEndedWhileHexWasDown = !working && !promptSeen;

    if (!startsWithCompact(blocks)) {
      hub.deliver(thread, name, message(thread, blocks, since, _meta));
    } else if (compactEndedWhileHexWasDown) {
      finish(thread, "end_turn");

      return;
    }

    turn.done = promptSeen && !working;
    turn.reader?.settle();
  });
}

async function replayed(
  thread: string,
  { replies }: Replay,
  client: AgentContext,
): Promise<PromptResponse> {
  if ((replays.get(thread)?.length ?? 0) === 0) {
    replays.delete(thread);
  }

  for (const text of replies) {
    await client.notify("session/update", {
      sessionId: thread,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: randomUUID(),
        content: { type: "text", text },
      },
    });
  }

  return { stopReason: "end_turn" };
}

function options(thread: string): SessionConfigOption[] {
  const chosen = opened.get(thread)?.settings ?? hub.settings(thread);
  const defaults = settings();

  const fromSettings =
    defaults.model === undefined || defaults.model === "" ? defaults.model : family(defaults.model);

  const model = chosen.model ?? fromSettings ?? MODELS[0]?.value ?? "opus";

  const effort =
    chosen.effort ?? EFFORTS.find((each) => each.value === defaults.effortLevel)?.value ?? "medium";

  return [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: model,
      options: MODELS.map(({ value, name }) => ({ value, name })),
    },
    {
      type: "select",
      id: "effort",
      name: "Effort",
      category: "thought_level",
      currentValue: effort,
      options: EFFORTS,
    },
  ];
}

const hexSettings = z.object({ model: z.string().optional(), effortLevel: z.string().optional() });

function settings(): z.infer<typeof hexSettings> {
  try {
    return hexSettings.parse(
      JSON.parse(readFileSync(join(HEX_DIR, ".claude", "settings.json"), "utf-8")),
    );
  } catch {
    return {};
  }
}

function configure(thread: string, id: string, raw: SetSessionConfigOptionRequest["value"]) {
  if (id !== "model" && id !== "effort") {
    throw RequestError.invalidParams(undefined, `no option ${id}`);
  }

  const text = z.string().safeParse(raw);
  const fullIdT3KeptFromBeforeAliases = id === "model" && text.success;
  const value = fullIdT3KeptFromBeforeAliases ? family(text.data) : raw;
  const choice = (id === "model" ? MODELS : EFFORTS).find((each) => each.value === value);

  if (choice === undefined) {
    throw RequestError.invalidParams(undefined, `${id} can't be ${String(value)}`);
  }

  const waiting = opened.get(known(thread));

  if (waiting) {
    waiting.settings[id] = choice.value;
  } else {
    hub.configure(thread, { [id]: choice.value });
  }

  return { configOptions: options(thread) };
}

function advertiseOnceAnswered(client: AgentContext, sessionId: string) {
  setImmediate(() => {
    void Promise.allSettled([
      client.notify("session/update", {
        sessionId,
        update: { sessionUpdate: "available_commands_update", availableCommands: COMMANDS },
      }),
    ]);
  });
}

// ACP's session/cancel can't say whether T3 is steering or stopping (https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation), so T3's records of a steering_restart tell: https://github.com/pingdotgg/t3code/blob/8e6a7323050ea8d2891f745f7e624e84f9fd8d9a/apps/server/src/orchestration-v2/Orchestrator.ts#L5430-L5452
function cancel(thread: string) {
  const turn = turns.get(thread);

  if (!turn) {
    return;
  }

  if (steering(thread)) {
    finish(thread, "cancelled");

    return;
  }

  interruptEvenWhileSteering(thread);
}

function interruptEvenWhileSteering(thread: string) {
  const turn = turns.get(thread);
  void hub.interrupt(thread).finally(() => {
    if (turns.get(thread) === turn) {
      cutShortWithNoStopHook(thread);
    }
  });
}

function render(blocks: ContentBlock[]) {
  return blocks.map((block) => rendered(block)).join("\n\n");
}

function rendered(block: ContentBlock): string {
  switch (block.type) {
    case "text": {
      return block.text;
    }

    case "resource_link": {
      return `[${block.name}](${path(block.uri)})`;
    }

    case "resource": {
      if ("text" in block.resource) {
        return `<file path="${path(block.resource.uri)}">\n${block.resource.text}\n</file>`;
      }

      return `[file: ${save(block.resource.blob, block.resource.mimeType)}] (from ${path(block.resource.uri)})`;
    }

    case "image":
    case "audio": {
      return `[${block.type}: ${save(block.data, block.mimeType)}]`;
    }
  }
}

function path(uri: string) {
  return uri.startsWith("file://") ? fileURLToPath(uri) : uri;
}

function save(base64: string, mimeType?: string | null) {
  const extension = mimeType?.split("/")[1]?.replace(/\W.*/u, "") ?? "";
  const file = join(INBOX_DIR, `${randomUUID()}.${extension === "" ? "bin" : extension}`);

  writeFileSync(file, Buffer.from(base64, "base64"), { mode: 0o600 });

  return file;
}

function real(folder: string) {
  try {
    return realpathSync(folder);
  } catch {
    return folder.replace(/\/+$/u, "");
  }
}

function projectFolderOf(cwd: string): string | undefined {
  const folder = `${real(cwd)}/`.replace(/^\/\/$/u, "/");

  if (
    `${real(HOME)}/`.startsWith(folder) ||
    folder === `${real(HEX_DIR)}/` ||
    folder.startsWith(`${real(SCRATCH)}/`)
  ) {
    return;
  }

  return cwd;
}

const imported = z.object({ threadId: z.string() });

async function place(name: string, _where?: string, _about?: string, cwd?: string) {
  const root = cwd ?? HEX_DIR;
  const projectId = projectAt(root);

  if (projectId === undefined) {
    throw new Error(`T3 Code has no project for ${root}`);
  }

  const thread = randomUUID();

  const { threadId } = imported.parse(
    await withT3((call) =>
      call("server.importAcpRegistrySession", {
        instanceId: PROVIDER_INSTANCE,
        projectId,
        sessionId: thread,
        title: name,
      }),
    ),
  );

  kept.set(thread, Date.now());
  hub.register(thread, name, cwd);
  placed.add(thread);
  writeFileSync(
    PLACED_FILE,
    JSON.stringify([...placed].filter((each) => hub.name(each) !== undefined)),
  );
  t3ThreadIds.set(thread, threadId);

  return { thread, link: linkTo(threadId) };
}

async function backfill(thread: string, said: Said[]) {
  const chat: Replay[] = [];

  for (const { from, text } of said) {
    if (from === "me") {
      chat.push({ asked: text, replies: [] });
      continue;
    }

    let last = chat.at(-1);

    if (last === undefined) {
      last = { asked: "(hex started this thread)", replies: [] };
      chat.push(last);
    }

    last.replies.push(text);
  }

  const threadId = t3ThreadIds.get(thread);

  if (chat.length === 0 || threadId === undefined) {
    return;
  }

  const queue = [...chat];
  replays.set(thread, queue);
  await withT3(async (call) => {
    for (const [i, { asked: text }] of chat.entries()) {
      try {
        await call("orchestration.dispatchCommand", {
          type: "message.dispatch",
          commandId: randomUUID(),
          threadId,
          messageId: `message:hex:${randomUUID()}`,
          text,
          attachments: [],
          createdBy: "user",
          creationSource: "server",
          dispatchMode: { type: "queue_after_active" },
        });
      } catch (error) {
        queue.splice(queue.length - (chat.length - i));
        throw error;
      }
    }
  });
}

function serve(socket: Socket) {
  agent({ name: "hex" })
    .onRequest("initialize", () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: "hex", title: "hex", version },
      agentCapabilities: {
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
        loadSession: true,
        sessionCapabilities: { resume: {}, list: {} },
      },
      authMethods: [],
    }))
    .onRequest("session/new", ({ params, client }) => {
      const thread = reopen(randomUUID(), params.cwd, socket);
      remember(thread, params.mcpServers);
      advertiseOnceAnswered(client, thread);

      return { sessionId: thread, configOptions: options(thread) };
    })
    .onRequest("session/resume", ({ params, client }) => {
      remember(reopen(params.sessionId, params.cwd, socket), params.mcpServers);
      advertiseOnceAnswered(client, params.sessionId);

      return { configOptions: options(params.sessionId) };
    })
    .onRequest("session/list", ({ params }) => ({
      sessions: [...placed].flatMap((thread) => {
        const name = hub.name(thread);
        const cwd = hub.cwd(thread) ?? HEX_DIR;
        const wanted = params.cwd ?? "";

        return name === undefined || (wanted !== "" && cwd !== wanted)
          ? []
          : [{ sessionId: thread, cwd, title: name }];
      }),
    }))
    .onRequest("session/load", async ({ params, client }) => {
      remember(reopen(params.sessionId, params.cwd, socket), params.mcpServers);

      for (const [i, { from, text }] of hub.history(params.sessionId).entries()) {
        await client.notify("session/update", {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: from === "me" ? "user_message_chunk" : "agent_message_chunk",
            messageId: `${hub.session(params.sessionId)}:${i}`,
            content: { type: "text", text },
          },
        });
      }

      advertiseOnceAnswered(client, params.sessionId);

      return { configOptions: options(params.sessionId) };
    })
    .onRequest("session/set_config_option", ({ params }) =>
      configure(params.sessionId, params.configId, params.value),
    )
    .onRequest("session/prompt", ({ params, client, signal }) => prompt(params, client, signal))
    .onRequest(
      "_hex/rejoin",
      {
        // SAFETY: only acp.ts sends _hex/rejoin: the params of a session/prompt T3 sent, and since.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the SDK doesn't export its prompt schema to parse with
        parse: (params) => params as Rejoin,
      },
      ({ params, client, signal }) => rejoin(params, client, signal),
    )
    .onNotification("session/cancel", ({ params }) => {
      cancel(params.sessionId);
    })
    .connect(
      ndJsonStream(
        Writable.toWeb(socket),
        // SAFETY: Readable.toWeb returns the runtime's one ReadableStream, which @types/node declares apart from the DOM lib's.
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions typescript/no-unsafe-type-assertion -- the two declarations don't overlap, so tsc needs unknown between them
        Readable.toWeb(socket) as unknown as ReadableStream<Uint8Array>,
      ),
    );
  // oxlint-disable-next-line eslint/no-empty-function -- an error listener keeps a dropped T3 connection from crashing the hub; close cleans up after it
  socket.on("error", () => {});
  socket.on("close", () => {
    for (const [thread, waiting] of opened) {
      if (waiting.socket !== socket) {
        continue;
      }

      opened.delete(thread);
      mcpConfigs.delete(thread);
    }
  });
}

clients.set("t3", {
  hub,
  place,
  backfill,
  waits: true,
  stop: interruptEvenWhileSteering,
});

rmSync(SOCKET, { force: true });

createServer(serve).listen(SOCKET);
