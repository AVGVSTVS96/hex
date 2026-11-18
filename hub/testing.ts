import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { route } from "./listen.ts";
import type { ToolArguments } from "./mcp.ts";

export { ATTACH, fakeClaude, flags, noClaude } from "./claude.testing.ts";

export { until } from "./until.ts";

type RpcBody = { id?: number; method: string; params?: object };

const ToolCallReply = z.object({
  result: z.object({
    content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
    isError: z.literal(true).optional(),
  }),
});

const Notification = z.object({
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Claude Code's side of a session's channel to a hub, for tests: it initializes, opens the stream its messages arrive on, lists the tools, and lists them again when told they changed. deaf: how many tools/list_changed it drops, as a session starting cold does before it listens.
export type Session = ReturnType<typeof http>;

let ids = 0;
const streams: AbortController[] = [];
let listener: ReturnType<typeof Bun.serve> | undefined;

export function port() {
  listener ??= Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: route });

  return listener.port;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What a request nobody awaits failed with, kept for the wait it was sent for to throw (check). Once that wait is over, as when a test ends and its bot is stopped with the request still on its way, nothing checks, so it fails no test: left unhandled, Bun fails whichever test runs next.
export function unawaited() {
  let failed: Error | undefined;

  return {
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- whatever the request threw
    keep: (error: unknown) => {
      failed = error instanceof Error ? error : new Error(String(error));
    },
    check: () => {
      if (failed !== undefined) {
        throw failed;
      }
    },
  };
}

export function hangUpAll() {
  for (const stream of streams.splice(0)) {
    stream.abort();
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A client's bot.ts run in its own process the way serve.ts runs it, behind a listener on a free port, which the hub reads from HEX_PORT as it loads.
export async function service(bot: string, env: Record<string, string | undefined>) {
  const hub = JSON.stringify(join(import.meta.dir, "listen.ts"));

  const script = `const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: request => route(request) })
process.env.HEX_PORT = String(listener.port)
const { route } = await import(${hub})
console.log(listener.port)
await import(${JSON.stringify(bot)})`;

  const child = Bun.spawn(["bun", "-e", script], { env, stdout: "pipe", stderr: "ignore" });
  const reader = child.stdout.getReader();
  let out = "";

  while (!out.includes("\n")) {
    const { value, done } = await reader.read();

    if (done) {
      throw new Error(`${bot} exited before it listened`);
    }

    out += new TextDecoder().decode(value);
  }

  void (async () => {
    let chunk = await reader.read();

    while (!chunk.done) {
      chunk = await reader.read();
    }
  })();

  return { process: child, port: Number(out.split("\n")[0]) };
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// at: the port of a hub in another process; this process's own listener by default.
export function http({
  stateDir,
  path,
  channel,
  thread,
  extra = {},
  deaf = 0,
  at = port(),
}: {
  stateDir: string;
  path: string;
  channel: string;
  thread?: string | undefined;
  extra?: Record<string, string> | undefined;
  deaf?: number | undefined;
  at?: number | undefined;
}) {
  const url = `http://127.0.0.1:${at}${path}`;

  const headers = {
    ...(thread !== undefined &&
      thread !== "" && { "x-hex-channel": channel, "x-hex-thread": thread }),
    authorization: `Bearer ${readFileSync(join(stateDir, "token"), "utf-8")}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extra,
  };

  // oxlint-disable-next-line typescript/no-explicit-any -- tests read the hub's notifications as raw JSON, and each test's expect() checks them
  const received: any[] = [];
  const stream = new AbortController();
  streams.push(stream);
  let mcp = "";
  let lists = 0;
  const nudged = unawaited();
  let unheard = deaf;

  const post = (body: RpcBody) =>
    fetch(url, {
      method: "POST",
      headers: { ...headers, ...(mcp !== "" && { "mcp-session-id": mcp }) },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
    });

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A list counts once the hub has answered it, so whatever the list set off on its side is done.
  // oxlint-disable-next-line typescript/no-explicit-any -- tests read the hub's replies as raw JSON, and each test's expect() checks them
  const rpc = async (method: string, params: ToolArguments = {}): Promise<any> => {
    const reply: unknown = await (await post({ id: ++ids, method, params })).json();

    if (method === "tools/list") {
      lists++;
    }

    return reply;
  };

  return {
    received,
    listed: () => {
      nudged.check();

      return lists;
    },
    post,
    rpc,
    initialize: async () => {
      const response = await post({
        id: ++ids,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      });

      mcp = response.headers.get("mcp-session-id") ?? "";

      return mcp;
    },
    open: async (adopted?: string) => {
      if (adopted !== undefined && adopted !== "") {
        mcp = adopted;
      }

      const response = await fetch(url, {
        headers: { ...headers, "mcp-session-id": mcp },
        signal: stream.signal,
      });

      void listenUntilClosed(response, received, () => {
        if (unheard > 0) {
          unheard--;
        } else {
          rpc("tools/list").catch(nudged.keep);
        }
      });

      return response;
    },
    close: () => {
      stream.abort();
    },
    // oxlint-disable-next-line anti-slop/no-object-parameters -- channel tests pass their own argument shapes, which the hub parses
    call: async (tool: string, args: object = {}, toolUseId: string = crypto.randomUUID()) =>
      ToolCallReply.parse(
        await rpc("tools/call", {
          name: tool,
          arguments: args,
          _meta: { "claudecode/toolUseId": toolUseId },
        }),
      ).result,
    // oxlint-disable-next-line anti-slop/no-object-parameters -- channel tests build their own permission requests
    ask: (request: object) =>
      post({ method: "notifications/claude/channel/permission_request", params: request }),
  };
}

export async function connect(options: Parameters<typeof http>[0]) {
  const line = http(options);
  await line.initialize();
  await line.open();
  await line.rpc("tools/list");

  while (line.listed() < 2) {
    await Bun.sleep(10);
  }

  await Bun.sleep(10);

  return {
    ...line,
    // oxlint-disable-next-line anti-slop/no-object-parameters -- channel tests pass their own argument shapes, which the hub parses
    call: async (tool: string, args: object = {}) => {
      const { content, isError } = await line.call(tool, args);
      const text = content[0]?.text ?? "";

      return isError === true ? { error: text.replace(`${tool} failed: `, "") } : { text };
    },
  };
}

function listenUntilClosed(response: Response, received: unknown[], changed: () => void) {
  return listen(response, received, changed).catch((): void => undefined);
}

async function listen(response: Response, received: unknown[], changed: () => void) {
  let buffer = "";

  if (!response.body) {
    return;
  }

  for await (const chunk of response.body) {
    buffer += new TextDecoder().decode(chunk);

    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const data = buffer
        .slice(0, end)
        .split("\n")
        .find((line) => line.startsWith("data: "));

      buffer = buffer.slice(end + 2);

      if (data === undefined) {
        continue;
      }

      const { method, params } = Notification.parse(JSON.parse(data.slice(6)));

      if (method === "notifications/tools/list_changed") {
        changed();
      } else {
        received.push({
          type: method === "notifications/claude/channel" ? "inbound" : "permission",
          ...params,
        });
      }
    }
  }
}
