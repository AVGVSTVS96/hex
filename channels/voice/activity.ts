import { existsSync, mkdirSync, statSync, watch } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { toAcpNotifications } from "@agentclientprotocol/claude-agent-acp";
import type { SessionNotification, ToolCall } from "@agentclientprotocol/sdk";
import { running, open } from "@hex/hub";
import { z } from "zod";

export type Update = SessionNotification["update"];

export type Step = { line?: string; end?: "done" | "failed" };

export type Thread = { app: string; id: string; name: string; cwd?: string; state: string };

type Notify = Parameters<typeof toAcpNotifications>;

const claude = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const projects = () => join(claude(), "projects");

// SAFETY: a replay hands its updates back as its result and never calls on the client.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a replay needs no client, only one to pass
const client = {
  sessionUpdate: (_update: Parameters<Notify[4]["sessionUpdate"]>[0]) => Promise.resolve(),
} as Notify[4];

const logger = {
  // oxlint-disable-next-line eslint/no-empty-function -- a replay's own log lines aren't worth keeping
  log: () => {},
  error: (...args: unknown[]) => {
    process.stderr.write(`voice: activity: ${args.join(" ")}\n`);
  },
};

const ID = /^[\w-]+$/u;
const CHUNK = 1024 * 1024;

export type Kind =
  | "think"
  | "say"
  | "plan"
  | "run"
  | "read"
  | "edit"
  | "search"
  | "web"
  | "agent"
  | "tool";

export type State = "running" | "done" | "failed";

export type Did = {
  kind: Kind;
  text: string;
  id?: string;
  detail?: string;
  state?: State;
  result?: string;
  agent?: string;
};

export type Names = (id: string) => string | undefined;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// One of T3 Code's turn items: a provider's own record of one thing in its turn, as Codex keeps them.
export type Item = { id: string; type: string; status: string; payload: unknown };

const loose = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

const scalar = z.union([z.string(), z.number(), z.boolean()]);

const fieldLines = z.record(z.string(), z.unknown()).transform((fields) =>
  Object.entries(fields)
    .flatMap(([key, value]) => {
      const plainValue = scalar.safeParse(value);

      return plainValue.success && plainValue.data !== ""
        ? [`${key}: ${firstLine(String(plainValue.data)) ?? ""}`]
        : [];
    })
    .join("\n"),
);

const blockText = z.object({ type: z.literal("text"), text: z.string().catch("") });

const toolSaid = z
  .union([
    z.string(),
    z
      .array(z.unknown())
      .transform((blocks) =>
        blocks.flatMap((block) => blockText.safeParse(block).data?.text ?? []).join("\n"),
      ),
    fieldLines,
  ])
  .catch("");

const toolFields = z.object({
  file_path: loose(z.string()),
  notebook_path: loose(z.string()),
  command: loose(z.string()),
  description: loose(z.string()),
  pattern: loose(z.string()),
  path: loose(z.string()),
  query: loose(z.string()),
  url: loose(z.string()),
  prompt: loose(z.string()),
  subagent_type: loose(z.string()),
  skill: loose(z.string()),
  args: loose(z.string()),
  title: loose(z.string()),
  task: loose(z.string()),
  taskId: loose(z.string()),
  reason: loose(z.string()),
  threadId: loose(z.string()),
  message: loose(z.string()),
});

const toolInput = z
  .record(z.string(), z.unknown())
  .catch({})
  .transform((fields) => ({ ...toolFields.parse(fields), lines: fieldLines.parse(fields) }));

type ToolInput = z.output<typeof toolInput>;

const claudeCodeMeta = z
  .object({ claudeCode: loose(z.object({ toolName: loose(z.string()) })) })
  .catch({});

const itemPayload = z
  .object({
    startedAt: loose(z.string()),
    updatedAt: loose(z.string()),
    completedAt: loose(z.string()),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    exitCode: loose(z.number()),
    patterns: loose(z.array(z.string())),
    query: loose(z.string()),
    diffStr: loose(z.string()),
    fileName: loose(z.string()),
    toolName: loose(z.string()),
    text: loose(z.string()),
    title: loose(z.string()),
    prompt: loose(z.string()),
    childThreadId: loose(z.string()),
    failure: loose(z.object({ message: loose(z.string()) })),
  })
  .catch({});

type ItemPayload = z.output<typeof itemPayload>;

const toolOutputError = z.object({ error: z.unknown() });
const errorMessage = z.object({ message: z.unknown() });
const delegated = z.object({ childThreadId: z.string() });

const origin = loose(z.object({ kind: loose(z.string()) }).loose());

const transcriptLine = z
  .object({
    type: loose(z.string()),
    subtype: loose(z.string()),
    uuid: loose(z.string()),
    timestamp: loose(z.string()),
    sessionId: loose(z.string()),
    cwd: loose(z.string()),
    isApiErrorMessage: z.unknown().optional(),
    origin,
    message: loose(z.object({ id: loose(z.string()), content: z.unknown().optional() }).loose()),
    toolUseResult: z.unknown().optional(),
    attachment: loose(
      z
        .object({
          type: loose(z.string()),
          commandMode: loose(z.string()),
          origin,
          prompt: z.unknown().optional(),
        })
        .loose(),
    ),
  })
  .loose()
  .catch({});

export type TranscriptLine = z.output<typeof transcriptLine>;

const asyncLaunch = z.object({ isAsync: z.literal(true), agentId: z.string() });

const blockTextOnly = z.object({ text: z.string() });

const channelText = z
  .union([
    z.string(),
    z
      .array(z.unknown())
      .transform((blocks) =>
        blocks.map((block) => blockTextOnly.safeParse(block).data?.text ?? "").join(""),
      ),
  ])
  .catch("");

const SAYS_NOTHING_WORTH_READING =
  /^(Read|Edit|MultiEdit|Write|NotebookEdit|Agent|Task|ToolSearch|mcp__t3-code__(delegate_task|task_\w+|t3_thread_\w+))$/u;

const RUNNING = new Set(["pending", "running", "waiting"]);

const PAST = new Map([
  ["Reading", "Read"],
  ["Editing", "Edited"],
  ["Writing", "Wrote"],
  ["Searching", "Searched"],
  ["Running", "Ran"],
  ["Waiting", "Waited"],
  ["Using", "Used"],
  ["Listing", "Listed"],
  ["Looking", "Looked"],
]);

const READS = new Set(["cat", "sed", "head", "tail", "nl", "less", "bat"]);
const SEARCHES = new Set(["rg", "grep"]);
const LISTS = new Set(["ls", "fd", "find", "tree"]);
const SETUP = new Set(["cd", "pwd", "echo", "set", "export", "true"]);
const VALUED = new Set(["-g", "--glob", "-t", "--type", "-A", "-B", "-C", "-m", "--max-count"]);

const filled = (text: string | undefined) => text !== undefined && text !== "";

const nameIn = (names: Names | undefined, id: string | undefined) =>
  id === undefined ? undefined : names?.(id);

export function stepOf(update: Update, names?: Names): Did | undefined {
  switch (update.sessionUpdate) {
    case "tool_call": {
      const did = step(update, names);

      return did === undefined ? undefined : { ...did, id: update.toolCallId };
    }

    case "agent_message_chunk": {
      const text = update.content.type === "text" ? firstParagraph(update.content.text) : undefined;

      return text === undefined ? undefined : { kind: "say", text };
    }

    case "agent_thought_chunk": {
      const thought = update.content.type === "text" ? plain(update.content.text) : "";

      return { kind: "think", text: thought === "" ? "Thinking" : thought };
    }

    case "plan": {
      const text = update.entries.find((entry) => entry.status === "in_progress")?.content;

      return text !== undefined && text !== "" ? { kind: "plan", text } : undefined;
    }

    case "user_message_chunk":
    case "tool_call_update":
    case "plan_update":
    case "plan_removed":
    case "available_commands_update":
    case "current_mode_update":
    case "config_option_update":
    case "session_info_update":
    case "usage_update":
    case "notice":
    case "compaction_update":
    case "compaction_summary_chunk":
    case "subagent_update":
    case "session_message":
    case "session_message_chunk": {
      return undefined;
    }
  }
}

export function backOf(update: Update): Pick<Did, "state" | "result" | "agent"> | undefined {
  if (
    update.sessionUpdate !== "tool_call_update" ||
    (update.status !== "completed" && update.status !== "failed")
  ) {
    return undefined;
  }

  const tool = claudeCodeMeta.parse(update._meta).claudeCode?.toolName ?? "";
  const state = update.status === "failed" ? "failed" : "done";
  const text = toolSaid.parse(update.rawOutput);

  const agent =
    tool === "Agent" || tool === "Task"
      ? /agentId: (\w+)/u.exec(text)?.[1]
      : tool === "mcp__t3-code__delegate_task"
        ? childThreadOf(text)
        : undefined;

  const result =
    state === "failed" || !SAYS_NOTHING_WORTH_READING.test(tool) ? firstLines(text) : undefined;

  return {
    state,
    ...(result !== undefined && result !== "" && { result }),
    ...(agent !== undefined && agent !== "" && { agent }),
  };
}

export function past(text: string) {
  const first = text.split(" ")[0] ?? "";
  const rest = text.slice(text.indexOf(" "));
  const done = PAST.get(first);

  return done !== undefined && done !== "" && text.includes(" ") ? `${done}${rest}` : text;
}

export function headline(update: Update): string | undefined {
  const did = stepOf(update);

  return did?.kind === "think" ? "Thinking" : did?.text;
}

export function itemStep(
  { id, type, status, payload }: Item,
  names?: Names,
): (Did & { at: string; end?: string }) | undefined {
  const item = itemPayload.parse(payload);
  const did = itemDid(type, item, names);

  if (!did) {
    return undefined;
  }

  const tool = !["think", "say", "plan"].includes(did.kind);

  const state: State =
    did.state ?? (status === "completed" ? "done" : RUNNING.has(status) ? "running" : "failed");

  return {
    ...did,
    ...(tool && state !== "running" && { text: past(did.text) }),
    id,
    at: item.startedAt ?? item.updatedAt ?? "",
    ...(tool &&
      state !== "running" &&
      item.completedAt !== undefined &&
      item.completedAt !== "" && { end: item.completedAt }),
    ...(tool && { state }),
  };
}

function itemDid(type: string, item: ItemPayload, names: Names | undefined): Did | undefined {
  switch (type) {
    case "command_execution": {
      const command = withoutCodexShellWrap(z.string().catch("").parse(item.input).trim());

      return {
        kind: "run",
        text: commandWords(command),
        ...clipped({
          detail: command,
          result: firstLines(z.string().catch("").parse(item.output)),
        }),
        ...(item.exitCode !== undefined && item.exitCode !== 0 && { state: "failed" }),
      };
    }

    case "web_search": {
      const patterns = [
        ...new Set<string>(item.patterns ?? (filled(item.query) ? [item.query ?? ""] : [])),
      ];

      const [, what, page] =
        patterns
          .map((pattern) => /^'(.+)' in (https?:\/\/\S+)$/u.exec(pattern))
          .find((match) => match !== null) ?? [];

      const [first] = patterns;

      const text =
        what !== undefined && page !== undefined
          ? `Looking for ${what} on ${host(page)}`
          : first !== undefined && /^https?:\/\//u.test(first)
            ? `Reading ${host(first)}`
            : first !== undefined && first !== ""
              ? `Searching the web for ${first}`
              : "Searching the web";

      return { kind: "web", text, ...clipped({ detail: patterns.join("\n") }) };
    }

    case "file_change": {
      const diff = (item.diffStr ?? "").split("\n");
      const added = diff.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
      const removed = diff.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;

      return {
        kind: "edit",
        text: `Editing ${basename(item.fileName ?? "a file")}`,
        ...clipped({
          detail: item.fileName === undefined ? undefined : tilde(item.fileName),
          result: `+${added} −${removed}`,
        }),
      };
    }

    case "dynamic_tool": {
      const name = item.toolName ?? "";

      const [, server, tool] =
        /^mcp__(.+?)__(.+)$/u.exec(name) ?? /^([^.]+)\.(.+)$/u.exec(name) ?? [];

      const input = toolInput.parse(item.input ?? {});
      const mcp = server !== undefined && tool !== undefined;

      const did: Did | undefined = mcp
        ? called(server, tool, input, names)
        : name === "Read"
          ? {
              kind: "read",
              text: `Reading ${basename(input.file_path ?? "a file")}`,
              ...clipped({
                detail: input.file_path === undefined ? undefined : tilde(input.file_path),
              }),
            }
          : name === "ToolSearch" || name === ""
            ? undefined
            : { kind: "tool", text: name, ...clipped({ detail: input.lines }) };

      const quiet =
        name === "Read" || SAYS_NOTHING_WORTH_READING.test(mcp ? `mcp__${server}__${tool}` : name);

      const error = toolOutputError.safeParse(item.output).data?.error;
      const failed = error !== undefined && error !== null && error !== "";

      const result = failed
        ? toolSaid.parse(errorMessage.safeParse(error).data?.message ?? error)
        : quiet
          ? ""
          : toolSaid.parse(item.output);

      return (
        did && {
          ...did,
          ...clipped({ result: firstLines(result) }),
          ...(failed && { state: "failed" }),
        }
      );
    }

    case "reasoning": {
      const thought = plain((item.text ?? "").replace(/^\*\*(.+?)\*\*\s*/u, "$1. "));

      return { kind: "think", text: thought === "" ? "Thinking" : thought };
    }

    case "assistant_message": {
      const text = firstParagraph(item.text ?? "");

      return text === undefined ? undefined : { kind: "say", text };
    }

    case "subagent": {
      return {
        kind: "agent",
        text: `Handed off ${item.title ?? "a task"}`,
        ...clipped({ detail: firstLine(item.prompt ?? "") }),
        ...(item.childThreadId !== undefined &&
          item.childThreadId !== "" && { agent: item.childThreadId }),
      };
    }

    case "error": {
      return {
        kind: "tool",
        text: item.title ?? "Something failed",
        state: "failed",
        ...clipped({ result: firstLines(item.failure?.message ?? "") }),
      };
    }

    default: {
      return undefined;
    }
  }
}

function step(
  { title, kind, rawInput, locations, _meta }: ToolCall,
  names: Names | undefined,
): Did | undefined {
  const input = toolInput.parse(rawInput ?? {});
  const tool = claudeCodeMeta.parse(_meta).claudeCode?.toolName ?? title;
  const file = locations?.[0]?.path ?? input.file_path ?? input.notebook_path;

  switch (kind) {
    case "execute": {
      return {
        kind: "run",
        text: filled(input.description)
          ? (input.description ?? "")
          : `Running ${firstLine(input.command ?? title) ?? ""}`,
        ...clipped({ detail: input.command }),
      };
    }

    case "read": {
      return {
        kind: "read",
        text: filled(file) ? `Reading ${basename(file ?? "")}` : title,
        ...clipped({ detail: filled(file) ? tilde(file ?? "") : file }),
      };
    }

    case "edit": {
      return {
        kind: "edit",
        text: `${tool === "Write" ? "Writing" : "Editing"} ${basename(file ?? title)}`,
        ...clipped({ detail: filled(file) ? tilde(file ?? "") : file }),
      };
    }

    case "search": {
      return {
        kind: "search",
        text: filled(input.pattern) ? `Searching for ${input.pattern ?? ""}` : title,
        ...clipped({
          detail: [input.pattern, filled(input.path) ? tilde(input.path ?? "") : input.path]
            .filter(filled)
            .join("\n"),
        }),
      };
    }

    case "fetch": {
      return {
        kind: "web",
        text: filled(input.query)
          ? `Searching the web for ${input.query ?? ""}`
          : filled(input.url)
            ? `Reading ${host(input.url ?? "")}`
            : title,
        ...clipped({ detail: input.query ?? input.url }),
      };
    }

    case "think": {
      return filled(input.description)
        ? {
            kind: "agent",
            text: `Started ${input.description ?? ""}`,
            ...clipped({
              detail: [input.subagent_type, firstLine(input.prompt ?? "")]
                .filter(filled)
                .join("\n"),
            }),
          }
        : undefined;
    }

    case "delete":
    case "move":
    case "switch_mode":
    case "other":
    case undefined: {
      break;
    }
  }

  const [, server, name] = /^mcp__(.+?)__(.+)$/u.exec(tool) ?? [];

  if (server !== undefined && name !== undefined) {
    return called(server, name, input, names);
  }

  if (filled(input.skill)) {
    return {
      kind: "tool",
      text: `Using the ${input.skill ?? ""} skill`,
      ...clipped({ detail: input.args }),
    };
  }

  return title === tool ? undefined : { kind: "tool", text: title };
}

function called(server: string, tool: string, input: ToolInput, names: Names | undefined): Did {
  if (server === "t3-code") {
    switch (tool) {
      case "delegate_task": {
        return {
          kind: "agent",
          text: `Handed off ${input.title ?? "a task"}`,
          ...clipped({ detail: firstLine(input.task ?? "") }),
        };
      }

      case "task_status": {
        return { kind: "tool", text: `Checked on ${nameIn(names, input.taskId) ?? "an agent"}` };
      }

      case "task_cancel": {
        return {
          kind: "tool",
          text: `Stopped ${nameIn(names, input.taskId) ?? "an agent"}`,
          ...clipped({ detail: input.reason }),
        };
      }

      case "t3_thread_wait": {
        return { kind: "tool", text: "Waiting on agents" };
      }

      case "t3_thread_send": {
        return {
          kind: "tool",
          text: `Wrote to ${nameIn(names, input.threadId) ?? "a thread"}`,
          ...clipped({ detail: input.message }),
        };
      }

      case "t3_thread_read": {
        return { kind: "tool", text: `Read ${nameIn(names, input.threadId) ?? "a thread"}` };
      }

      default: {
        break;
      }
    }
  }

  const app = (server.split("_").at(-1) ?? "")
    .split("-")
    .map((word) => word.replace(/^./u, (letter) => letter.toUpperCase()))
    .join(" ");

  return {
    kind: "tool",
    text: `${app}: ${tool.replaceAll("_", " ")}`,
    ...clipped({ detail: input.lines }),
  };
}

const silent = (part: string[]) =>
  part.some((token, i) => /^1?>>?$/u.test(token) && part[i + 1] === "/dev/null");

const redirect = (arg = "") => /^\d*>>?$/u.test(arg);

const cut = (text: string, size: number) =>
  text.length > size ? `${text.slice(0, size - 1)}…` : text;

function commandWords(command: string) {
  const tokens =
    command.match(/'[^']*'|"(?:\\.|[^"\\])*"|&&|\|\||[;|\n]|\d*>>?|[^\s;|&'"<>]+/gu) ?? [];

  let current: string[] = [];
  const parts = [current];

  for (const token of tokens) {
    if (/^(&&|\|\||[;|\n])$/u.test(token)) {
      current = [];
      parts.push(current);
    } else {
      current.push(token.replace(/^(['"])([\s\S]*)\1$/u, "$2"));
    }
  }

  const [name, ...args] =
    parts.find((part) => {
      const [first] = part;

      return first !== undefined && !SETUP.has(first) && !silent(part);
    }) ?? [];

  if (name === undefined || name === "") {
    return `Running ${firstLine(command) ?? ""}`;
  }

  const out = args.findIndex((arg) => arg === ">" || arg === ">>");
  const into = out === -1 ? undefined : args[out + 1];

  const plainArgs = args.filter(
    (arg, i) =>
      !arg.startsWith("-") &&
      !redirect(arg) &&
      !redirect(args[i - 1]) &&
      !VALUED.has(args[i - 1] ?? ""),
  );

  if (filled(into) && (READS.has(name) || name === "tee")) {
    return `Writing ${basename(into ?? "")}`;
  }

  const last = plainArgs.at(-1);

  if (READS.has(name) && last !== undefined) {
    return `Reading ${basename(last)}`;
  }

  const place = plainArgs.find((arg) => arg !== ".");

  if (LISTS.has(name) || args.includes("--files")) {
    return `Listing ${filled(place) ? basename(place ?? "") : "files"}`;
  }

  const [term] = plainArgs;

  if (SEARCHES.has(name) && term !== undefined) {
    return `Searching for ${term}`;
  }

  return `Running ${name}${/^[a-z][a-z-]*$/u.test(args[0] ?? "") ? ` ${args[0] ?? ""}` : ""}`;
}

function clipped({ detail, result }: { detail?: string | undefined; result?: string | undefined }) {
  const shownDetail = detail?.trim() ?? "";
  const shownResult = result?.trim() ?? "";

  return {
    ...(shownDetail !== "" && { detail: cut(shownDetail, 240) }),
    ...(shownResult !== "" && { result: cut(shownResult, 400) }),
  };
}

function firstLines(text: string) {
  return text.trim().split("\n").slice(0, 6).join("\n");
}

function withoutCodexShellWrap(command: string) {
  const [, quote, inner] = /^(?:\S*\/)?(?:ba|z)?sh -l?c (["'])([\s\S]*)\1$/u.exec(command) ?? [];

  if (inner === undefined || inner === "") {
    return command;
  }

  return quote === '"' ? inner.replaceAll(/\\(["\\$`])/gu, "$1") : inner.replaceAll(`'"'"'`, `'`);
}

function host(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function tilde(path: string) {
  return path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path;
}

function childThreadOf(text: string): string | undefined {
  try {
    return delegated.safeParse(JSON.parse(text)).data?.childThreadId;
  } catch {
    return undefined;
  }
}

function plain(text: string) {
  return text
    .replaceAll(/\*\*|__|`/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

export function firstLine(text: string) {
  const line = unmark(
    (text.trim().split("\n")[0] ?? "").replace(/^(#+|[-*>]|\d+\.)\s+/u, ""),
  ).trim();

  return line === "" ? undefined : line.slice(0, 160);
}

export function firstParagraph(text: string) {
  const paragraph = text.trim().split(/\n\s*\n/u)[0] ?? "";

  const paragraphLines = paragraph
    .split("\n")
    .map((line) => line.trim().replace(/^(#+|[-*>]|\d+\.)\s+/u, ""));

  const joined = unmark(paragraphLines.join(" ")).trim();

  return joined === "" ? undefined : joined;
}

export function unmark(text: string) {
  return text.replaceAll(/\*\*|__|`/gu, "").replaceAll(/\[([^\]]+)\]\([^)]*\)/gu, "$1");
}

function contentOf(entry: TranscriptLine): { role: Notify[1]; content: Notify[0] } | undefined {
  const content = entry.message?.content;

  const role =
    entry.type === "assistant"
      ? "assistant"
      : entry.type === "user" && Array.isArray(content)
        ? "user"
        : undefined;

  if (role === undefined) {
    return undefined;
  }

  // SAFETY: Claude Code writes each turn's content as the API's own content blocks.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the blocks pass through to the ACP converter as written
  return { role, content: content as Notify[0] };
}

export function followTranscript(
  path: string,
  from: number | "end",
  onEntry: (entry: TranscriptLine, updates: () => Update[]) => void,
  after: Promise<unknown> = Promise.resolve(),
) {
  const tools: Notify[3] = {};
  const tasks: NonNullable<NonNullable<Notify[6]>["taskState"]> = new Map();
  let offset = from === "end" ? sizeOf(path) : from;
  let rest = Buffer.alloc(0);
  let closed = false;
  mkdirSync(dirname(path), { recursive: true });

  const watcher = watch(dirname(path), (_, file) => {
    if (file === basename(path)) {
      void read();
    }
  });

  let reading: Promise<unknown> = after;
  void read();

  function read() {
    const previous = reading;

    const next = (async () => {
      try {
        await previous;
        await more();
      } catch (error) {
        logger.error(`couldn't read ${path}: ${String(error)}`);
      }
    })();

    reading = next;

    return next;
  }

  async function more() {
    if (closed) {
      return;
    }

    let file: fs.FileHandle;

    try {
      file = await fs.open(path, "r");
    } catch {
      return;
    }

    try {
      // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- the closer sets closed while a read awaits
      for (const { size } = await file.stat(); offset < size && !closed;) {
        const chunk = Buffer.alloc(Math.min(size - offset, CHUNK));
        const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);

        if (bytesRead === 0) {
          return;
        }

        offset += bytesRead;
        const data = Buffer.concat([rest, chunk.subarray(0, bytesRead)]);
        const last = data.lastIndexOf(10);
        rest = data.subarray(last + 1);

        if (last !== -1) {
          for (const line of data.subarray(0, last).toString("utf-8").split("\n")) {
            if (!closed) {
              take(line);
            }
          }
        }
      }
    } finally {
      await file.close();
    }
  }

  function take(line: string) {
    let raw: unknown;

    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }

    const entry = transcriptLine.parse(raw);
    const turn = contentOf(entry);

    onEntry(entry, () =>
      turn
        ? toAcpNotifications(
            turn.content,
            turn.role,
            entry.sessionId ?? "",
            tools,
            client,
            logger,
            {
              registerHooks: false,
              replay: true,
              cwd: entry.cwd ?? "",
              taskState: tasks,
              ...(entry.message?.id !== undefined && { messageId: entry.message.id }),
              toolUseResult: entry.toolUseResult,
            },
          ).map((notification) => notification.update)
        : [],
    );
  }

  return async (readTheRestFirst = false): Promise<void> => {
    watcher.close();

    if (!readTheRestFirst) {
      closed = true;
    }

    await read();
    closed = true;
  };
}

export function followAgent(
  agent: string,
  session: string | undefined,
  onStep: (step: Step) => void,
): ReturnType<typeof followTranscript> | undefined {
  if (!ID.test(agent)) {
    return undefined;
  }

  const patterns = [
    ...(session !== undefined && ID.test(session)
      ? [`*/${session}/subagents/agent-${agent}.jsonl`]
      : []),
    `*/*/subagents/agent-${agent}.jsonl`,
  ];

  for (const pattern of patterns) {
    const [path] = new Bun.Glob(pattern).scanSync({ cwd: projects(), absolute: true });

    if (path !== undefined) {
      return followTranscript(path, 0, (_, updates) => {
        lines(updates(), onStep);
      });
    }
  }

  return undefined;
}

type Named = { app: string; thread: string; name: string; open?: boolean; project?: string };

export function generalOf<T extends Named>(
  threads: Iterable<T>,
  main = process.env.HEX_MAIN_THREAD,
) {
  const groups = [...threads].filter(
    ({ app, thread }) => app === "telegram" && /^-\d+$/u.test(thread),
  );

  return (
    groups.find(({ thread }) => thread === main) ?? groups.find((group) => group.open !== false)
  );
}

export function isDm({ app, thread }: Pick<Named, "app" | "thread">) {
  return app === "telegram" && !thread.includes(":") && !thread.startsWith("-");
}

export function holdsEveryProject(thread: Pick<Named, "app" | "thread">, general?: Named) {
  return (
    isDm(thread) ||
    (general !== undefined && thread.app === general.app && thread.thread === general.thread)
  );
}

export function projectOf(thread: Named, general?: Named) {
  return holdsEveryProject(thread, general)
    ? nameOf(thread, general)
    : (thread.project ?? thread.name);
}

export function nameOf({ app, thread, name }: Named, general?: Named) {
  return general !== undefined && app === general.app && thread === general.thread
    ? "General"
    : name;
}

export function findThread(state: string, wanted: string): Thread | undefined {
  const store = open(state);
  const key = store.threads.key(wanted);
  const general = generalOf(store.threads.list());
  const all = store.threads.list({ open: true }).filter(({ app }) => app !== "voice");
  const is = (name: string) => name.toLowerCase() === wanted.toLowerCase();

  const ways = [
    all.filter(({ thread }) => thread === key),
    all.filter((one) => is(one.name) || is(nameOf(one, general))),
  ];

  const matches = ways.find((way) => way.length > 0) ?? [];

  if (matches.length > 1) {
    throw new Error(
      `more than one hex thread goes by ${wanted}, in ${[...new Set(matches.map(({ app }) => app))].join(" and ")}: pass its app:key id, from hex threads --json`,
    );
  }

  const [found] = matches;

  return found === undefined
    ? undefined
    : {
        app: found.app,
        id: found.thread,
        name: nameOf(found, general),
        ...(found.cwd !== undefined && { cwd: found.cwd }),
        state,
      };
}

const nothingToStop = (_last?: boolean) => Promise.resolve();

export function followThread(
  thread: Thread,
  hexDir: string,
  tag: string,
  resumed: boolean,
  onStep: (step: Step) => void,
) {
  const agents = new Map<string, (last?: boolean) => Promise<void>>();
  let session: string | undefined;
  let stopSession = nothingToStop;
  let picked = false;
  let failed = false;
  let ended = false;
  const uuidsReadHereOrCopiedFromBefore = new Set<string>();
  let tookTheMessageAtBeforeWhichACopyKeepsOlderTimes: string | undefined;
  let turnEndAtTheLastLook: string | undefined;

  const project = join(projects(), (thread.cwd ?? hexDir).replaceAll(/[^a-zA-Z0-9]/gu, "-"));
  const transcript = (id: string) => join(project, `${id}.jsonl`);
  const store = open(thread.state);
  const taken = resumed ? store.messages.taker(thread.id, "voice_task", tag) : undefined;

  const took =
    taken !== undefined && ID.test(taken.by) && existsSync(transcript(taken.by))
      ? taken
      : undefined;

  const stopState = store.watch(() => {
    locate();
    endIfTheSessionDiedMidTurn();
  });

  locate();

  function locate() {
    const current = store.threads
      .list({ app: thread.app, open: true })
      .find(({ thread: id }) => id === thread.id)?.session;

    const next = session === undefined && took ? took.by : current;

    if (ended || next === undefined || next === "" || next === session || !ID.test(next)) {
      return;
    }

    const hexDbStillNamesTheSessionBeforeTheOneThatTookIt =
      took !== undefined &&
      session === took.by &&
      (store.messages.lastTaken(next) ?? took.at) < took.at;

    if (hexDbStillNamesTheSessionBeforeTheOneThatTookIt) {
      return;
    }

    const fresh = resumed || session !== undefined;
    const read = stopSession(true);
    session = next;
    turnEndAtTheLastLook = undefined;
    const stop = followTranscript(transcript(session), fresh ? 0 : "end", take, read);

    if (ended) {
      void stop();
    } else {
      stopSession = stop;
    }

    if (!ended && next !== current) {
      locate();
    }
  }

  function take(entry: TranscriptLine, updates: () => Update[]) {
    if (ended || uuidsReadHereOrCopiedFromBefore.has(entry.uuid ?? "")) {
      return;
    }

    if (filled(entry.uuid)) {
      uuidsReadHereOrCopiedFromBefore.add(entry.uuid ?? "");
    }

    const floor = tookTheMessageAtBeforeWhichACopyKeepsOlderTimes;

    if (filled(floor) && entry.timestamp !== undefined && entry.timestamp < (floor ?? "")) {
      return;
    }

    if (!picked) {
      const text = channelMessage(entry);

      picked =
        text !== undefined &&
        text !== "" &&
        text.slice(0, text.indexOf(">") + 1).includes(` voice_task="${tag}"`);

      if (picked) {
        tookTheMessageAtBeforeWhichACopyKeepsOlderTimes = entry.timestamp;
      }

      return;
    }

    const launched = asyncLaunch.safeParse(entry.toolUseResult).data?.agentId;

    if (
      launched !== undefined &&
      ID.test(launched) &&
      !agents.has(launched) &&
      session !== undefined
    ) {
      agents.set(
        launched,
        followTranscript(
          join(project, session, "subagents", `agent-${launched}.jsonl`),
          0,
          (_, agentUpdates) => {
            lines(agentUpdates(), onStep);
          },
        ),
      );
    }

    for (const back of agentsBack(entry)) {
      void agents.get(back)?.(true);
      agents.delete(back);
    }

    if (entry.type === "assistant") {
      failed = entry.isApiErrorMessage === true;
    }

    lines(updates(), onStep);

    if (entry.type === "system" && entry.subtype === "turn_duration" && agents.size === 0) {
      close();
      onStep({ end: failed ? "failed" : "done" });
    }
  }

  function endIfTheSessionDiedMidTurn() {
    if (ended || !picked || session === undefined) {
      return;
    }

    const end = store.turns.get(session).ended;

    if (end === turnEndAtTheLastLook) {
      return;
    }

    turnEndAtTheLastLook = end;

    if (end === undefined || end === "" || running(store, claude()).has(session)) {
      return;
    }

    const dead = session;

    void (async () => {
      await stopSession(true);

      if (ended || session !== dead) {
        return;
      }

      close();
      onStep({ end: "failed" });
    })();
  }

  function close() {
    ended = true;
    stopState();
    void stopSession();

    for (const stop of agents.values()) {
      void stop();
    }

    agents.clear();
  }

  return close;
}

function agentsBack(entry: TranscriptLine): string[] {
  const queued = entry.attachment?.type === "queued_command" ? entry.attachment : undefined;

  if (
    (queued ?? entry).origin?.kind !== "task-notification" &&
    queued?.commandMode !== "task-notification"
  ) {
    return [];
  }

  const notice = JSON.stringify(queued ? queued.prompt : entry.message?.content) ?? "";

  return notice.split("<task-notification>").flatMap((block) => {
    const status = block.indexOf("<status>");

    return status === -1
      ? []
      : [...block.slice(0, status).matchAll(/<task-id>([\w-]+)<\/task-id>/gu)].flatMap(
          (match) => match[1] ?? [],
        );
  });
}

function channelMessage(entry: TranscriptLine): string | undefined {
  const queued = entry.attachment?.type === "queued_command" ? entry.attachment : undefined;

  if (
    !(entry.type === "user" && entry.origin?.kind === "channel") &&
    queued?.origin?.kind !== "channel"
  ) {
    return undefined;
  }

  return channelText.parse(queued ? queued.prompt : entry.message?.content);
}

function lines(updates: Update[], onStep: (step: Step) => void) {
  for (const update of updates) {
    const line = headline(update);

    if (line !== undefined && line !== "") {
      onStep({ line });
    }
  }
}

export function sizeOf(path: string) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
