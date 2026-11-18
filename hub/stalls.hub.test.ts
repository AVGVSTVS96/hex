import { expect, test } from "bun:test";

import {
  settled,
  heard,
  SESSION,
  message,
  hub,
  failures,
  start,
  bgStarts,
  launched,
  session,
} from "./hub.testing.ts";
import { until } from "./until.ts";

test("a turn that fails on the API is told in its chat once, carries on once another thread's turn goes through, and waits for its next message if that fails too", async () => {
  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  const stuck = await session("chat:7");
  await until(() => stuck.received.length);
  const limited = "API Error: Server is temporarily limiting requests (not your usage limit)";
  const failure = { failed: true, error: "rate_limit", said: limited };
  await stuck.send({ type: "state", thread: "chat:7", busy: false, ...failure });
  await stuck.send({ type: "state", thread: "chat:7", busy: false, ...failure });
  expect(failures).toEqual([["chat:7", `${limited}\nIt carries on once turns go through again.`]]);

  hub.open("chat:8", "OpenAI");
  await until(() => bgStarts().length === 2);
  const other = await session("chat:8", "1b2c3d4e-0000-4000-8000-000000000000");
  await other.send({ type: "state", thread: "chat:8", busy: true });
  expect(stuck.received).toHaveLength(1);
  await other.send({ type: "state", thread: "chat:8", busy: false });
  await until(() => stuck.received.length === 2);
  expect(heard(stuck.received)[1]?.content).toStartWith(
    "[hub] Your last turn here failed on the API",
  );

  await stuck.send({ type: "state", thread: "chat:7", busy: true });
  await stuck.send({ type: "state", thread: "chat:7", busy: false, ...failure });
  expect(failures[1]).toEqual(["chat:7", `${limited}\nIts next message starts it again.`]);
  await other.send({ type: "state", thread: "chat:8", busy: false });
  await settled();
  expect(stuck.received).toHaveLength(2);
});

test("a turn that fails on a login that stopped working carries on once a turn goes through again, with no new message", async () => {
  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  const stuck = await session("chat:7");
  await until(() => stuck.received.length);
  const expired = "Failed to authenticate: OAuth session expired";

  await stuck.send({
    type: "state",
    thread: "chat:7",
    busy: false,
    failed: true,
    error: "authentication_failed",
    said: expired,
  });
  expect(failures).toEqual([["chat:7", `${expired}\nIt carries on once turns go through again.`]]);

  hub.open("chat:8", "OpenAI");
  await until(() => bgStarts().length === 2);
  const other = await session("chat:8", "1b2c3d4e-0000-4000-8000-000000000000");
  await other.send({ type: "state", thread: "chat:8", busy: false });
  await until(() => stuck.received.length === 2);
  expect(heard(stuck.received)[1]?.content).toStartWith(
    "[hub] Your last turn here failed on the API",
  );
});

test("a turn that fails for good is told in its chat, and waits for its next message", async () => {
  await start();
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  const stuck = await session("chat:7");
  await until(() => stuck.received.length);
  await stuck.send({
    type: "state",
    thread: "chat:7",
    busy: false,
    failed: true,
    error: "invalid_request",
    said: "API Error: 400 prompt is too long",
  });
  expect(failures).toEqual([
    ["chat:7", "API Error: 400 prompt is too long\nIts next message starts it again."],
  ]);
  await stuck.send({ type: "state", thread: "chat:7", busy: false });
  await settled();
  expect(stuck.received).toHaveLength(1);
});

test("threads an outage stalled carry on one for each turn that goes through", async () => {
  await start();

  const stalled = [
    ["chat:7", SESSION],
    ["chat:9", "3d4e5f60-0000-4000-8000-000000000000"],
  ] as const;

  const lines = [];

  for (const [thread, id] of stalled) {
    hub.open(thread, thread);
    await until(() => bgStarts().length === lines.length + 1);
    const line = await session(thread, id);
    await line.send({ type: "state", thread, busy: false, failed: true, error: "overloaded" });
    lines.push(line);
  }

  const [first, second] = lines;
  hub.open("chat:8", "OpenAI");
  await until(() => bgStarts().length === 3);
  const other = await session("chat:8", "1b2c3d4e-0000-4000-8000-000000000000");
  await other.send({ type: "state", thread: "chat:8", busy: false });
  await until(() => first?.received.length === 1);
  await settled();
  expect(second?.received).toHaveLength(0);
  await other.send({ type: "state", thread: "chat:8", busy: false });
  await until(() => second?.received.length === 1);
  expect(first?.received).toHaveLength(1);
});
