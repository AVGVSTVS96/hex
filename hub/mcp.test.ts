import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

import { dispatch, endpoint, local, tool, toolList } from "./mcp.ts";
import { open } from "./store.ts";
import { until } from "./until.ts";

test("a message's time reaches the session on the owner's clock, with its offset", () => {
  expect(local({ chat_id: "1", ts: "2026-10-20T06:31:05.123Z" }, "America/Los_Angeles")).toEqual({
    chat_id: "1",
    ts: "2026-10-19T23:31:05-07:00",
  });
  expect(local({ ts: "2026-01-15T20:00:00Z" }, "America/Los_Angeles").ts).toBe(
    "2026-01-15T12:00:00-08:00",
  );
});

test("meta without a time or a zone it can read passes through as it is", () => {
  expect(local({ chat_id: "1" }, "UTC")).toEqual({ chat_id: "1" });
  expect(local({ ts: "soon" }, "UTC")).toEqual({ ts: "soon" });
  expect(local({ ts: "2026-10-20T06:31:05Z" }, "Bogus/Zone")).toEqual({
    ts: "2026-10-20T06:31:05Z",
  });
});

const SERVER = {
  title: "Telegram",
  instructions: "",
  tools: [
    tool({
      name: "fetch_messages",
      description: "Read.",
      input: z.object({}),
      annotations: { readOnlyHint: true },
    }),
    tool({
      name: "canvas",
      description: "Read or write.",
      input: z.object({ text: z.string().optional() }),
      reads: (args) => args.text === undefined,
    }),
    tool({ name: "reply", description: "Send.", input: z.object({ text: z.string() }) }),
  ],
};

const TOKEN = "secret";

type Answer = { result: { content: { text: string }[]; isError?: true } };

// A channel whose reply tool answers when the test says, counting how often it ran. A call made with
// gaveUp is one the session stops waiting on, as Claude Code does at its timeout.
function channel(fails = false, store = open(mkdtempSync(join(tmpdir(), "operations-")))) {
  let ran = 0;
  const waiting: (() => void)[] = [];

  const serve = endpoint(
    "telegram",
    "chat",
    TOKEN,
    SERVER,
    {
      call: async () => {
        ran++;
        await new Promise<void>((resolve) => waiting.push(resolve));

        if (fails) {
          throw new Error("Telegram said no");
        }
        return "sent (id: 5389)";
      },
      permission: () => {},
      open: () => {},
      close: () => {},
    },
    store,
  );

  let ids = 0;

  function call(
    args: object,
    gaveUp?: AbortController,
    name = "reply",
    identity: { toolUse?: string; session?: string; id?: string | number } = { toolUse: "report" },
  ): Promise<Answer> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: identity.id ?? ++ids,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        ...(identity.toolUse && { _meta: { "claudecode/toolUseId": identity.toolUse } }),
      },
    });

    const headers = {
      authorization: `Bearer ${TOKEN}`,
      "x-hex-channel": "chat",
      "x-hex-thread": "-100:7",
      ...(identity.session && { "mcp-session-id": identity.session }),
    };

    return serve(
      new Request("http://127.0.0.1/telegram", {
        method: "POST",
        headers,
        body,
        signal: gaveUp?.signal,
      }),
    ).then((response) => response.json() as Promise<Answer>);
  }

  // Resolves once n calls are waiting in the tool.
  const reached = (n = 1) => until(() => waiting.length >= n);

  // Answers every call underway, once at least one has reached the tool.
  async function answer() {
    await reached();
    await Bun.sleep(5);

    for (const resolve of waiting.splice(0)) {
      resolve();
    }
  }

  // Answers every call waiting in the tool right away, without letting anything else run first.
  const answerNow = () => {
    waiting.splice(0).forEach((resolve) => resolve());
  };

  return { ran: () => ran, call, answer, answerNow, reached, store, serve };
}

const text = (answer: Answer) => answer.result.content[0]!.text;

test("an operation shares its running result and keeps it after an aborted request and a restart", async () => {
  const { ran, call, answer, reached, store } = channel();
  const gaveUp = new AbortController();
  const first = call({ text: "report" }, gaveUp);
  await reached();
  gaveUp.abort();
  const again = call({ text: "report" });
  await answer();
  expect(text(await first)).toBe("sent (id: 5389)");
  expect(text(await again)).toBe("sent (id: 5389)");
  expect(text(await call({ text: "report" }))).toBe("sent (id: 5389)");
  expect(ran()).toBe(1);
  const restarted = channel(false, store);
  expect(text(await restarted.call({ text: "report" }))).toBe("sent (id: 5389)");
  expect(restarted.ran()).toBe(0);
});

test("a deliberate identical send uses a new operation id, while a reused id cannot change the call", async () => {
  const { ran, call, answer, serve } = channel();

  for (const toolUse of ["first", "second"]) {
    const sending = call({ text: "report" }, undefined, "reply", { toolUse });
    await answer();
    await sending;
  }

  expect(ran()).toBe(2);
  expect(
    text(await call({ text: "different" }, undefined, "reply", { toolUse: "first" })),
  ).toContain("different call");

  const listing = await serve(
    new Request("http://127.0.0.1/telegram", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" }),
    }),
  );

  expect((await listing.json()).result.tools).toEqual(toolList(SERVER.tools));
  const transport = { session: "standard-client", id: 7 };
  const first = call({ text: "standard MCP" }, undefined, "reply", transport);
  await answer();
  await first;
  expect(text(await call({ text: "standard MCP" }, undefined, "reply", transport))).toBe(
    "sent (id: 5389)",
  );
  expect(ran()).toBe(3);

  for (const _ of [1, 2]) {
    const noSession = call({ text: "sessionless" }, undefined, "reply", { id: 1 });
    await answer();
    await noSession;
  }

  expect(ran()).toBe(5);
});

test("an unfinished persisted operation is uncertain and is never sent again", async () => {
  const { store, call, ran } = channel();
  store.operation(
    "chat:-100:7",
    JSON.stringify(["tool", "report"]),
    JSON.stringify(["reply", { text: "report" }]),
  );
  expect(text(await call({ text: "report" }))).toContain("uncertain outcome");
  expect(ran()).toBe(0);
});

test("reads run every time, while a write retains its result including a failure", async () => {
  const { call, answer, reached, ran } = channel(true);

  for (const [name, args] of [
    ["fetch_messages", {}],
    ["canvas", {}],
    ["canvas", { text: "plan" }],
  ] as const) {
    const first = call(args, undefined, name);
    await reached();
    const again = call(args, undefined, name);
    await answer();
    await Promise.all([first, again]);
  }

  expect(ran()).toBe(5);
  expect((await call({ text: "plan" }, undefined, "canvas")).result.isError).toBe(true);
});

test("a call whose client left while the hub was too busy to read it doesn't run", async () => {
  const { ran, serve, answer } = channel();
  const hub = Bun.serve({ port: 0, fetch: serve });
  const left = join(mkdtempSync(join(tmpdir(), "mcp-")), "left");

  try {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "reply",
        arguments: { text: "report" },
        _meta: { "claudecode/toolUseId": "report" },
      },
    });

    const headers = {
      authorization: `Bearer ${TOKEN}`,
      "x-hex-channel": "chat",
      "x-hex-thread": "-100:7",
    };

    const client = `const gaveUp = new AbortController()
      fetch(${JSON.stringify(`http://127.0.0.1:${hub.port}/telegram`)}, { method: 'POST', headers: ${JSON.stringify(headers)}, body: ${JSON.stringify(body)}, signal: gaveUp.signal }).catch(() => {})
      await Bun.sleep(300)
      gaveUp.abort()
      await Bun.sleep(100)
      require('fs').writeFileSync(${JSON.stringify(left)}, '')`;

    Bun.spawn(["bun", "-e", client], { stdout: "ignore", stderr: "ignore" });

    for (const end = Date.now() + 20_000; !existsSync(left) && Date.now() < end;) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    expect(existsSync(left)).toBe(true);
    await Bun.sleep(200);
    expect(ran()).toBe(0);
    const heard = fetch(`http://127.0.0.1:${hub.port}/telegram`, { method: "POST", headers, body });
    await answer();
    expect(text((await (await heard).json()) as Answer)).toBe("sent (id: 5389)");
    expect(ran()).toBe(1);
  } finally {
    hub.stop(true);
  }
});

test("a call whose client left while the hub was too busy to send its answer counts as missed", async () => {
  const { ran, serve, answerNow, reached } = channel();
  const hub = Bun.serve({ port: 0, fetch: serve });
  const left = join(mkdtempSync(join(tmpdir(), "mcp-")), "left");
  const gave = `${left}-asked`;

  try {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "reply",
        arguments: { text: "report" },
        _meta: { "claudecode/toolUseId": "report" },
      },
    });

    const headers = {
      authorization: `Bearer ${TOKEN}`,
      "x-hex-channel": "chat",
      "x-hex-thread": "-100:7",
    };

    const client = `const fs = require('fs')
      const gaveUp = new AbortController()
      fetch(${JSON.stringify(`http://127.0.0.1:${hub.port}/telegram`)}, { method: 'POST', headers: ${JSON.stringify(headers)}, body: ${JSON.stringify(body)}, signal: gaveUp.signal }).catch(() => {})
      while (!fs.existsSync(${JSON.stringify(gave)})) await Bun.sleep(10)
      gaveUp.abort()
      await Bun.sleep(100)
      fs.writeFileSync(${JSON.stringify(left)}, '')`;

    Bun.spawn(["bun", "-e", client], { stdout: "ignore", stderr: "ignore" });
    await reached();
    writeFileSync(gave, "");

    for (const end = Date.now() + 20_000; !existsSync(left) && Date.now() < end;) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    expect(existsSync(left)).toBe(true);
    answerNow();
    await Bun.sleep(200);
    const again = fetch(`http://127.0.0.1:${hub.port}/telegram`, { method: "POST", headers, body });
    expect(text((await (await again).json()) as Answer)).toBe("sent (id: 5389)");
    expect(ran()).toBe(1);
  } finally {
    hub.stop(true);
  }
});

test("a stock MCP client lists the tools and replies without an operation id", async () => {
  const serve = endpoint(
    "telegram",
    "chat",
    TOKEN,
    SERVER,
    {
      call: async () => "read",
      permission: () => {},
      open: () => {},
      close: () => {},
    },
    open(mkdtempSync(join(tmpdir(), "operations-"))),
  );

  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    "X-Hex-Channel": "chat",
    "X-Hex-Thread": "topic",
  };

  const hub = Bun.serve({ port: 0, fetch: serve });
  const client = new Client({ name: "stock-mcp-client", version: "1" });

  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hub.port}/telegram`), {
        requestInit: { headers },
      }),
    );
    const listed: unknown = (await client.listTools()).tools;
    expect(listed).toEqual(toolList(SERVER.tools));

    const reply = await client.callTool({
      name: "reply",
      arguments: { text: "ordinary reply without an operation id" },
    });

    expect(reply).toMatchObject({ content: [{ type: "text", text: "read" }] });
  } finally {
    await client.close();
    hub.stop(true);
  }
});

test("a call whose arguments don't match its tool's schema fails with zod's message and never reaches the handler", async () => {
  const tools = [
    tool({ name: "reply", description: "Send.", input: z.object({ text: z.string() }) }),
  ] as const;

  let ran = 0;

  const call = dispatch(tools, {
    reply: async (_caller, { text }) => {
      ran++;
      return `sent ${text}`;
    },
  });

  const serve = endpoint(
    "telegram",
    "chat",
    TOKEN,
    { title: "Telegram", instructions: "", tools },
    {
      call: (thread, name, args) => call(thread, name, args),
      permission: () => {},
      open: () => {},
      close: () => {},
    },
    open(mkdtempSync(join(tmpdir(), "operations-"))),
  );

  const response = await serve(
    new Request("http://127.0.0.1/telegram", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-hex-channel": "chat",
        "x-hex-thread": "-100:7",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "reply", arguments: { text: 5 } },
      }),
    }),
  );

  const answer = (await response.json()) as Answer;

  expect(answer.result.isError).toBe(true);
  expect(text(answer)).toBe(
    `reply failed: ${z.prettifyError(z.object({ text: z.string() }).safeParse({ text: 5 }).error!)}`,
  );
  expect(text(answer)).toContain("expected string, received number");
  await expect(call("-100:7", "reply", {})).rejects.toThrow("expected string, received undefined");
  expect(ran).toBe(0);
  expect(await call("-100:7", "reply", { text: "hi" })).toBe("sent hi");
  expect(ran).toBe(1);
});

test("tools/list serves each tool's input as JSON Schema, descriptions, enums and required fields intact", async () => {
  const react = tool({
    name: "react",
    description: "React to a message.",
    input: z.object({
      message_id: z.string().describe("The message to react to."),
      emoji: z.enum(["👍", "👀"]).describe("Which reaction."),
      remove: z.boolean().optional().describe("Take the reaction off."),
    }),
    annotations: { readOnlyHint: false },
    reads: () => false,
  });

  const serve = endpoint(
    "telegram",
    "chat",
    TOKEN,
    { title: "Telegram", instructions: "", tools: [react] },
    {
      call: async () => "",
      permission: () => {},
      open: () => {},
      close: () => {},
    },
    open(mkdtempSync(join(tmpdir(), "operations-"))),
  );

  const listing = await serve(
    new Request("http://127.0.0.1/telegram", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );

  expect(((await listing.json()) as { result: { tools: unknown[] } }).result.tools).toEqual([
    {
      name: "react",
      description: "React to a message.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: "object",
        properties: {
          message_id: { type: "string", description: "The message to react to." },
          emoji: { type: "string", enum: ["👍", "👀"], description: "Which reaction." },
          remove: { type: "boolean", description: "Take the reaction off." },
        },
        required: ["message_id", "emoji"],
      },
    },
  ]);
});
