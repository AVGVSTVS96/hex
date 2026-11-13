import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import { clock } from "./clock.ts";
import type { Store } from "./store.ts";

export type ToolArguments = z.input<z.ZodObject>;

export type Tool<Name extends string = string, Input extends z.ZodObject = z.ZodObject> = {
  name: Name;
  description: string;
  input: Input;
  annotations?: { readOnlyHint?: boolean };
  reads?: (args: z.output<Input>) => boolean;
  _meta?: object;
};

export function tool<const Name extends string, Input extends z.ZodObject>(
  definition: Tool<Name, Input>,
): Tool<Name, Input> {
  return definition;
}

export function toolList(tools: readonly Tool[]) {
  return tools.map(({ input, reads: _reads, ...rest }) => {
    const { $schema: _schema, ...inputSchema } = z.toJSONSchema(input, { io: "input" });

    return { ...rest, inputSchema };
  });
}

export type Handlers<Tools extends readonly Tool[]> = {
  [Each in Tools[number] as Each["name"]]: (
    caller: string,
    args: z.output<Each["input"]>,
  ) => Promise<string>;
};

type AnyHandler = (caller: string, args: never) => Promise<string>;

export function dispatch<const Tools extends readonly Tool[]>(
  tools: Tools,
  handlers: NoInfer<Handlers<Tools>>,
): (caller: string, name: string, args: ToolArguments) => Promise<string> {
  const byName = new Map<string, Tool>(tools.map((each) => [each.name, each]));
  const run: Partial<Record<string, AnyHandler>> = handlers;

  return async (caller, name, args) => {
    const each = byName.get(name);
    const handler = run[name];

    if (each === undefined || handler === undefined) {
      throw new Error(`unknown tool: ${name}`);
    }

    const parsed = each.input.safeParse(args);

    if (!parsed.success) {
      throw new Error(z.prettifyError(parsed.error));
    }

    // SAFETY: handlers holds one handler per tool name, and this one takes what its tool's schema just parsed.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TypeScript can't tie a tool's handler to its schema once both are looked up by name
    return await handler(caller, parsed.data as never);
  };
}

export type ChannelServer = {
  title: string;
  instructions: string;
  tools: readonly Tool[];
  permission?: boolean;
};

export const PermissionRequest = z.object({
  request_id: z.string(),
  tool_name: z.string(),
  description: z.string(),
  input_preview: z.string(),
});

export type Permission = z.output<typeof PermissionRequest>;

export type Payload =
  | { type: "inbound"; content: string; meta: Record<string, string> }
  | { type: "permission"; request_id: string; behavior: string };

export type Line = { send: (payload: Payload) => void };

type Hooks = {
  call: (thread: string, tool: string, args: ToolArguments, beside?: string) => Promise<string>;
  permission: (thread: string, request: Permission) => void;
  open: (thread: string, line: Line) => void;
  close: (thread: string, line: Line) => void;
};

// The revisions whose standalone GET stream carries server notifications. Claude Code first probes `server/discover` for 2026-07-28, where it registers no channel ("no unsolicited notification path"), and falls back to `initialize` when that's declined. https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
const REVISIONS_WHOSE_GET_STREAM_CARRIES_NOTIFICATIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const encoder = new TextEncoder();
const NUDGE = 250;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Bun notices a disconnected request on the next event-loop tick.
const untilBunNoticesADisconnect = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

type Result = { content: { type: "text"; text: string }[]; isError?: true | undefined };

const failure = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// How far a session initialized here is from listening. Claude Code drops channel messages that come before it listens and says nothing when it starts, but it registers its channel handler in the same step as its tools/list_changed handler, so once its stream is open and it has listed the tools, it's told they changed, and the list that answers is the sign it listens. A session starting cold registers them a while after it lists the tools and drops what came before, so it's told again until it answers.
type Handshake =
  | { is: "initialized" }
  | { is: "listed" }
  | { is: "streaming"; nudge: () => void; open: () => void }
  | { is: "nudged"; open: () => void };

const Rpc = z.object({
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
});

type RpcId = string | number | null;

const Initialize = z.object({ protocolVersion: z.string() });

const ToolCall = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  _meta: z
    .object({ "claudecode/toolUseId": z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
});

type Answer =
  | Result
  | { tools: ReturnType<typeof toolList> }
  | {
      protocolVersion: string | undefined;
      capabilities: { tools: { listChanged: boolean }; experimental: object };
      serverInfo: { name: string; version: string };
      instructions: string;
    }
  | Record<string, never>;

function result(id: RpcId, value: Answer) {
  return Response.json({ jsonrpc: "2.0", id, result: value });
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A session hex runs beside a thread says its own id here: it speaks in the thread's chat, and is neither its inbound line nor its permission relay.
function besideOf(request: Request) {
  const session = request.headers.get("x-hex-beside");

  return session === null || session === "" ? undefined : session;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A channel over MCP's Streamable HTTP transport, for sessions whose plugin's .mcp.json points here with their binding and the hub's token in headers. Every session id is taken as it comes, so a session that connected before the hub restarted carries on where it was without initializing again.
export function endpoint(
  name: string,
  channel: string,
  token: string,
  server: ChannelServer,
  hooks: Hooks,
  store: Store,
  zone = () => Temporal.Now.timeZoneId(),
) {
  const starting = new Map<string, Handshake>();

  function threadOf(request: Request) {
    const thread =
      request.headers.get("x-hex-channel") === channel ? request.headers.get("x-hex-thread") : null;

    return thread === null || thread === "" ? undefined : thread;
  }

  const active = new Map<string, Promise<Result>>();
  const tools = new Map<string, Tool>(server.tools.map((each) => [each.name, each]));
  const list = toolList(server.tools);

  const reads = (toolName: string, args: ToolArguments) => {
    const each = tools.get(toolName);

    if (each?.annotations?.readOnlyHint === true) {
      return true;
    }

    const parsed = each?.input.safeParse(args);

    return parsed?.success === true && each?.reads?.(parsed.data) === true;
  };

  async function once(
    thread: string | undefined,
    toolName: string,
    args: ToolArguments,
    gone: AbortSignal,
    id: string,
    beside?: string,
  ): Promise<Result> {
    if (gone.aborted) {
      return failure(`${toolName} didn't run: you stopped waiting before the hub read it`);
    }

    if (reads(toolName, args) || thread === undefined) {
      return await call(thread, toolName, args, beside);
    }

    const scope = `${channel}:${thread}`;
    const key = JSON.stringify([scope, id]);
    const value = [toolName, args];
    const kept = store.operations.begin(scope, id, JSON.stringify(value));

    if (!isDeepStrictEqual(JSON.parse(kept.input), value)) {
      return failure(`${toolName} didn't run: identity ${id} already identifies a different call`);
    }

    if (!kept.fresh) {
      if (kept.result !== null) {
        return Kept.parse(JSON.parse(kept.result));
      }

      return await (active.get(key) ??
        failure(
          `${toolName} operation ${id} has an uncertain outcome after an interruption. Reconcile its effect before starting another operation.`,
        ));
    }

    const answer = call(thread, toolName, args, beside)
      .then((answered) => {
        store.operations.finish(scope, id, JSON.stringify(answered));

        return answered;
      })
      .finally(() => {
        active.delete(key);
      });

    active.set(key, answer);

    return await answer;
  }

  async function call(
    thread: string | undefined,
    toolName: string,
    args: ToolArguments,
    beside?: string,
  ): Promise<Result> {
    try {
      if (thread === undefined) {
        throw new Error(
          `this session is not bound to a ${server.title} thread (HEX_THREAD is unset)`,
        );
      }

      return {
        content: [{ type: "text", text: await hooks.call(thread, toolName, args, beside) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `${toolName} failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }

  function listed(session: string | null) {
    if (session === null || session === "") {
      return;
    }

    const step = starting.get(session);

    if (step?.is === "initialized") {
      starting.set(session, { is: "listed" });
    }

    if (step?.is === "streaming") {
      starting.set(session, { is: "nudged", open: step.open });
      step.nudge();
    }

    if (step?.is === "nudged") {
      starting.delete(session);
      step.open();
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Bun starts a response's body only once it sends it, so writes wait for that.
  function stream(thread: string | undefined, session: string | null) {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let line: Line | undefined;
    let keepAlive: ReturnType<typeof setInterval> | undefined;
    const untilBunSendsTheBody = [": open\n\n"];

    const write = (text: string) => {
      if (!controller) {
        untilBunSendsTheBody.push(text);

        return;
      }

      try {
        controller.enqueue(encoder.encode(text));
      } catch {
        gone();
      }
    };

    const event = (
      message: ReturnType<typeof notification> | { method: "notifications/tools/list_changed" },
    ) => {
      write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", ...message })}\n\n`);
    };

    function gone() {
      clearInterval(keepAlive);

      if (session !== null && session !== "") {
        starting.delete(session);
      }

      if (thread !== undefined && line) {
        hooks.close(thread, line);
      }

      line = undefined;
    }

    const body = new ReadableStream<Uint8Array>({
      start(started) {
        controller = started;

        for (const text of untilBunSendsTheBody.splice(0)) {
          write(text);
        }
      },
      cancel: gone,
    });

    if (thread !== undefined) {
      line = {
        send: (payload) => {
          event(notification(payload, zone()));
        },
      };
      keepAlive = setInterval(write, 15_000, ": keepalive\n\n");

      const open = () => {
        if (line) {
          hooks.open(thread, line);
        }
      };

      const handshaking = session === null || session === "" ? undefined : session;

      const nudge = () => {
        event({ method: "notifications/tools/list_changed" });
        clock.setTimeout(() => {
          if (line && handshaking !== undefined && starting.get(handshaking)?.is === "nudged") {
            nudge();
          }
        }, NUDGE);
      };

      const step = handshaking === undefined ? undefined : starting.get(handshaking);

      if (handshaking === undefined || !step) {
        open();
      } else if (step.is === "listed") {
        starting.set(handshaking, { is: "nudged", open });
        nudge();
      } else {
        starting.set(handshaking, { is: "streaming", nudge, open });
      }
    }

    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        ...(session !== null && session !== "" && { "mcp-session-id": session }),
      },
    });
  }

  const handle = async (request: Request): Promise<Response> => {
    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // The token comes as Authorization: Claude Code then takes a refusal as a failed connection, where with any other header it marks the server as needing a login for 15 minutes.
    if (
      request.headers.has("origin") ||
      !["127.0.0.1", "localhost"].includes(new URL(request.url).hostname) ||
      request.headers.get("authorization") !== `Bearer ${token}`
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    const thread = threadOf(request);
    const beside = besideOf(request);
    const session = request.headers.get("mcp-session-id");

    if (request.method === "GET") {
      return stream(beside === undefined ? thread : undefined, session);
    }

    if (request.method === "DELETE") {
      return new Response(null, { status: 204 });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    let message: unknown;

    try {
      message = await request.json();
    } catch {
      return Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32_700, message: "Parse error" } },
        { status: 400 },
      );
    }

    const rpc = Rpc.safeParse(message);
    const { id, method, params } = rpc.success ? rpc.data : {};

    if (id === undefined || method === undefined || method === "") {
      const asked = PermissionRequest.safeParse(params);

      if (
        method === "notifications/claude/channel/permission_request" &&
        thread !== undefined &&
        beside === undefined &&
        asked.success
      ) {
        hooks.permission(thread, asked.data);
      }

      return new Response(null, { status: 202 });
    }

    if (method === "initialize") {
      const opened = crypto.randomUUID();

      if (beside === undefined) {
        starting.set(opened, { is: "initialized" });
      }

      const capabilities = {
        tools: { listChanged: true },
        experimental: {
          "claude/channel": {},
          ...(server.permission === true && { "claude/channel/permission": {} }),
        },
      };

      const asked = Initialize.safeParse(params);

      const revision =
        asked.success &&
        REVISIONS_WHOSE_GET_STREAM_CARRIES_NOTIFICATIONS.includes(asked.data.protocolVersion)
          ? asked.data.protocolVersion
          : REVISIONS_WHOSE_GET_STREAM_CARRIES_NOTIFICATIONS[0];

      const response = result(id, {
        protocolVersion: revision,
        capabilities,
        serverInfo: { name, version: "1.0.0" },
        instructions: server.instructions,
      });

      response.headers.set("mcp-session-id", opened);

      return response;
    }

    if (method === "tools/list") {
      listed(session);

      return result(id, { tools: list });
    }

    if (method === "tools/call") {
      await untilBunNoticesADisconnect();
      const asked = ToolCall.safeParse(params);

      if (!asked.success) {
        return result(id, failure(`invalid tools/call: ${z.prettifyError(asked.error)}`));
      }

      const toolUse = asked.data._meta?.["claudecode/toolUseId"];

      const operation =
        toolUse !== undefined && toolUse !== ""
          ? JSON.stringify(["tool", toolUse])
          : session !== null && session !== ""
            ? JSON.stringify(["mcp", session, id])
            : crypto.randomUUID();

      return result(
        id,
        await once(
          thread,
          asked.data.name,
          asked.data.arguments ?? {},
          request.signal,
          operation,
          beside,
        ),
      );
    }

    if (method === "ping") {
      return result(id, {});
    }

    return Response.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32_601, message: `Method not found: ${method}` },
    });
  };

  return handle;
}

const Kept = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  isError: z.literal(true).optional(),
});

function notification(payload: Payload, zone: string) {
  if (payload.type === "inbound") {
    return {
      method: "notifications/claude/channel",
      params: { content: payload.content, meta: local(payload.meta, zone) },
    };
  }

  return {
    method: "notifications/claude/channel/permission",
    params: { request_id: payload.request_id, behavior: payload.behavior },
  };
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The apps stamp a message in UTC, and a session that reads 06:31Z writes it down as 6:31am, so the tag carries the owner's clock time with its offset instead.
export function local(meta: Record<string, string>, zone: string): typeof meta {
  const at = meta.ts === undefined || meta.ts === "" ? Number.NaN : Date.parse(meta.ts);

  if (Number.isNaN(at)) {
    return meta;
  }

  try {
    return {
      ...meta,
      ts: Temporal.Instant.fromEpochMilliseconds(at)
        .toZonedDateTimeISO(zone)
        .toString({ timeZoneName: "never", smallestUnit: "second" }),
    };
  } catch {
    return meta;
  }
}
