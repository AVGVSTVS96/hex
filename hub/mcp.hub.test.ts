import { expect, test } from "bun:test";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  settled,
  Initialized,
  Declined,
  SESSION,
  message,
  SERVER,
  dir,
  hub,
  prompts,
  time,
  listener,
  inbound,
  start,
  calls,
  launched,
  session,
  http,
} from "./hub.testing.ts";
import type { HubLine } from "./socket.ts";
import { until } from "./until.ts";

test("tool calls act on the calling session's own thread", async () => {
  await start();
  const { call } = await session("chat:9");
  expect(await call("reply", { text: "yo" })).toEqual({
    content: [{ type: "text", text: "reply in chat:9" }],
  });
});

test("a permission prompt reaches the client with its thread, and the answer goes back to that session alone", async () => {
  await start();
  const desk = await session("chat:9");
  const other = await session("chat:10");

  const request = {
    request_id: "abcde",
    tool_name: "Bash",
    description: "List files",
    input_preview: '{"command":"ls"}',
  };

  await desk.ask(request);
  const [thread, asked] = await until(() => prompts[0]);
  expect(thread).toBe("chat:9");
  expect(asked).toMatchObject(request);
  hub.answer("chat:9", "abcde", "allow");
  await until(() => desk.received.length);
  expect(desk.received).toEqual([{ type: "permission", request_id: "abcde", behavior: "allow" }]);
  expect(other.received).toEqual([]);
});

test("a new session's channel opens once it lists the tools again after hearing they changed, since Claude Code listens for both at once", async () => {
  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  writeFileSync(
    join(dir, "jobs", "job12345", "state.json"),
    JSON.stringify({ state: "working", sessionId: SESSION }),
  );
  const line = http("chat:7");

  const { result } = Initialized.parse(
    await line.rpc("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    }),
  );

  expect(result.capabilities.tools).toEqual({ listChanged: true });
  await line.initialize();
  await line.open();
  await settled();
  expect(line.received).toEqual([]);
  await line.rpc("tools/list");
  await until(() => line.listed() === 2);
  await until(() => line.received.length);
  expect(line.received).toEqual([inbound(message)]);
});

test("a session starting cold that drops the first tools/list_changed is told again until it lists the tools", async () => {
  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  const line = http("chat:7", {}, 2);
  await line.initialize();
  await line.open();
  await line.rpc("tools/list");
  await time.lapse(250);
  expect(line.listed()).toBe(1);
  expect(line.received).toEqual([]);
  await time.lapse(250);
  await until(() => line.received.length);
  expect(line.listed()).toBe(2);
  expect(line.received).toEqual([inbound(message)]);
});

test("a session that lists the tools before opening its stream hears they changed once the stream opens", async () => {
  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  const line = http("chat:7");
  await line.initialize();
  await line.rpc("tools/list");
  await line.open();
  await until(() => line.listed() === 2);
  await until(() => line.received.length);
  expect(line.received).toEqual([inbound(message)]);
});

test("a stream back from before the hub restarted carries on under its old id, without initializing again", async () => {
  await start();
  const line = http("chat:7");
  const response = await line.open(crypto.randomUUID());
  expect(response.status).toBe(200);
  await hub.deliver("chat:7", "Desk anchors", message);
  await until(() => line.received.length);
  expect(calls().some((each) => each[0] === "--bg")).toBe(false);
  expect(await line.call("reply", { text: "yo" })).toEqual({
    content: [{ type: "text", text: "reply in chat:7" }],
  });
});

test("the hub declines the newest protocol, whose sessions get no channel, and offers one that has it", async () => {
  await start();
  const line = http("chat:7");
  expect(Declined.parse(await line.rpc("server/discover")).error.code).toBe(-32_601);

  const { result } = Initialized.parse(
    await line.rpc("initialize", {
      protocolVersion: "2026-07-28",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    }),
  );

  expect(result.protocolVersion).toBe("2025-11-25");
  expect(result.capabilities.experimental).toEqual({
    "claude/channel": {},
    "claude/channel/permission": {},
  });
  expect(result.instructions).toBe(SERVER.instructions);
});

test("a request from a web page, or by a name other than localhost, is refused", async () => {
  await start();
  expect(
    (await http("chat:7", { origin: "https://example.com" }).post({ id: 1, method: "ping" }))
      .status,
  ).toBe(403);
  expect(
    (await http("chat:7", { host: "example.com" }).post({ id: 1, method: "ping" })).status,
  ).toBe(403);
  expect((await http("chat:7").post({ id: 1, method: "ping" })).status).toBe(200);
});

test("a request without the hub's token is refused, and the token is the owner's alone", async () => {
  await start();
  expect(
    (await http("chat:7", { authorization: "Bearer guess" }).post({ id: 1, method: "ping" }))
      .status,
  ).toBe(403);
  const { authorization: _, ...anonymous } = { authorization: "" };
  expect(
    (
      await fetch(`http://127.0.0.1:${listener.port}/telegram`, {
        method: "POST",
        headers: { "content-type": "application/json", ...anonymous },
        body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
      })
    ).status,
  ).toBe(403);
  expect(statSync(join(dir, "token")).mode % 0o1000).toBe(0o600);
  await hub.deliver("chat:7", "Desk anchors", message);
  const settings = (await launched()).at(-1) ?? "";
  expect(statSync(settings).mode % 0o1000).toBe(0o600);
});

test("a session with no thread, or another channel's, gets no messages and acts on no thread", async () => {
  await start();
  const unbound = http();
  await unbound.initialize();
  expect(await unbound.call("reply", { text: "yo" })).toEqual({
    content: [
      {
        type: "text",
        text: "reply failed: this session is not bound to a Telegram thread (HEX_THREAD is unset)",
      },
    ],
    isError: true,
  });

  const other = http(undefined, {
    "x-hex-channel": "plugin:discord@hex",
    "x-hex-thread": "chat:7",
  });

  await other.initialize();
  await other.open();
  await other.rpc("tools/list");
  await hub.deliver("chat:7", "Desk anchors", message);
  await settled();
  expect(other.received).toEqual([]);
});

test("an operation keeps its result across Stop events regardless of elapsed time", async () => {
  const waiting: (() => void)[] = [];
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    call: (_, name, toolArgs) =>
      new Promise((resolve) => {
        waiting.push(() => {
          resolve(`${name} ${String(toolArgs.text)}`);
        });
      }),
  });
  const line = await session("chat:7");

  const kept = async (text: string, stop: Partial<Extract<HubLine, { type: "state" }>>) => {
    const slow = line.call("reply", { text }, text);
    await until(() => waiting.length);
    await time.advance(150_000);
    waiting.shift()?.();
    await slow;
    await line.send({ type: "state", thread: "chat:7", busy: false, ...stop });
    const repeat = line.call("reply", { text }, text);

    const ran = await Promise.race([
      until(() => waiting.length).then(() => true),
      repeat.then(() => false),
    ]);

    if (ran) {
      waiting.shift()?.();
    }

    expect((await repeat).content[0]?.text).toBe(`reply ${text}`);

    return !ran;
  };

  expect(await kept("another session", { session: "ffffffff-0000-4000-8000-000000000000" })).toBe(
    true,
  );
  expect(await kept("background", { session: SESSION, background: true })).toBe(true);
  expect(await kept("failed", { session: SESSION, failed: true })).toBe(true);
  expect(await kept("no session", {})).toBe(true);
  expect(await kept("busy", { session: SESSION, busy: true })).toBe(true);
  expect(await kept("done", { session: SESSION })).toBe(true);
});
