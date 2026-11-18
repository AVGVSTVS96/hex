import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  settled,
  heard,
  SESSION,
  message,
  EXITED,
  dir,
  hub,
  states,
  failures,
  time,
  fold,
  start,
  bgStarts,
  calls,
  launched,
  session,
  http,
  bound,
  job,
  slowLauncher,
  NEXT,
} from "./hub.testing.ts";
import { file } from "./store.ts";
import { until } from "./until.ts";

test("a session that connects before the command that started it has returned is still seen to pause", async () => {
  const needs = "Answer the permission prompt in the terminal to continue";
  await start({ launcher: slowLauncher(), reconnect: 50 });
  await hub.deliver("chat:7", "Desk anchors", message);
  await until(() => existsSync(join(dir, "start1")));
  bound("chat:7", SESSION, "job12345");
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ id: "job12345", sessionId: SESSION, pid: process.pid, startedAt: 1 }]),
  );
  const line = http("chat:7");
  await line.initialize();
  await line.open();
  await line.rpc("tools/list");
  await until(() => line.listed() === 2);
  expect(bgStarts()).toEqual([]);
  writeFileSync(join(dir, "go1"), "");
  await launched();
  await turning("chat:7", line);
  await pauses("job12345", needs);
  await until(() => failures.length);
  expect(failures).toEqual([
    [
      "chat:7",
      `its session stopped on a question only its terminal can answer ("${needs}"), so your message got no answer. Your next message starts it again.`,
    ],
  ]);
});

const REFUSED = "choose: retry on fallback model or edit prompt";

const FLAGGED =
  "the model's safety filter flagged your message as cyber, so it got no answer. Your next message starts this topic again from just before it, still on fable, with the flagged message left out: send what you need in other words.";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The session's transcript: a turn that went through, then one whose reply the model's safeguards refused, or with first, only the refused one.
function refused(first = false) {
  const project = join(dir, "projects", join(dir, "hex").replaceAll(/[^a-zA-Z0-9]/gu, "-"));
  mkdirSync(project, { recursive: true });

  const entries = [
    ...(first
      ? []
      : [
          { type: "user", uuid: "u1", parentUuid: null, message: { content: "drones?" } },
          { type: "assistant", uuid: "a1", parentUuid: "u1", message: { content: "Plenty." } },
        ]),
    {
      type: "user",
      uuid: "u2",
      parentUuid: first ? null : "a1",
      message: { content: '<channel source="telegram" key="telegram:1:5">jamming?</channel>' },
    },
    {
      type: "assistant",
      uuid: "a2",
      parentUuid: "u2",
      message: { content: [], stop_reason: "refusal", stop_details: { category: "cyber" } },
    },
  ];

  writeFileSync(
    join(project, `${SESSION}.jsonl`),
    entries.map((entry) => JSON.stringify(entry)).join("\n"),
  );
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Claude Code pausing the session on a dialog, as Claude lists it and its job record says.
function pauses(jobId = "job12345", needs = REFUSED) {
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ sessionId: SESSION, pid: EXITED, status: "waiting" }]),
  );

  return job(jobId, { state: "working", sessionId: SESSION, needs });
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A session that took the message and began its turn.
async function turning(thread: string, connected?: ReturnType<typeof http>) {
  const line = connected ?? (await session(thread));
  await until(() => line.received.length);
  file(dir).turns.turned(SESSION, true, "2026-01-01T00:00:00.000Z");
  fold(line.received);
  await line.send({ type: "state", thread, busy: true });

  return line;
}

const rewinds = () => calls().filter((each) => each[0] === "-p");

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A message for the paused session, which stops it; Claude still lists it until the hub's wait for its channel runs out, and then it starts again.
async function restarts(content: string) {
  await hub.deliver("chat:7", "Desk anchors", { ...message, content });
  await until(() => calls().some((each) => each[0] === "stop"));
  await settled();
  writeFileSync(
    join(dir, "agents"),
    JSON.stringify([{ sessionId: NEXT, pid: process.pid, status: "busy" }]),
  );
  await time.lapse(50);
  await until(() => bgStarts().length === 2);
}

test("a turn the model's safeguards refuse is told once in its chat, and its next message starts the topic on its model from a copy of the conversation that ends before it, which takes only that message", async () => {
  await start({ reconnect: 50 });
  await hub.deliver("chat:7", "Desk anchors", { ...message, content: "jamming?" });
  await launched();
  hub.configure("chat:7", { model: "fable" });
  const line = await turning("chat:7");
  refused();
  await pauses();
  await until(() => failures.length);
  await job("job12345", { state: "working", sessionId: SESSION, needs: REFUSED });
  await settled();
  expect(failures).toEqual([["chat:7", FLAGGED]]);
  expect(states.at(-1)).toEqual(["chat:7", false]);
  expect(file(dir).turns.get(SESSION).ended).toBeDefined();

  await restarts("what bands do drones use?");
  expect(calls().find((each) => each[0] === "stop")).toEqual(["stop", SESSION.slice(0, 8)]);

  expect(rewinds()).toEqual([
    [
      "-p",
      "--resume",
      SESSION,
      "--fork-session",
      "--resume-session-at",
      "a1",
      "--strict-mcp-config",
      "--tools",
      "",
      "--output-format",
      "json",
      "--model",
      "fable",
    ],
  ]);

  expect(bgStarts()[1]).toContain("rewound-session");
  expect(bgStarts()[1]?.slice(bgStarts()[1]?.indexOf("--model"))).toContain("fable");
  const next = await session("chat:7", NEXT);
  await until(() => next.received.length);
  expect(heard(next.received).map(({ content }) => content)).toEqual(["what bands do drones use?"]);
  expect(line.received).toHaveLength(1);
  expect(failures.filter(([, why]) => why === FLAGGED)).toHaveLength(1);
});

test("a refused turn that was its conversation's first starts the topic in a new session, with no copy and nothing taken over", async () => {
  await start({ reconnect: 50 });
  await hub.deliver("chat:7", "Desk anchors", { ...message, content: "jamming?" });
  await launched();
  await turning("chat:7");
  refused(true);
  await pauses();
  await until(() => failures.length);
  await restarts("what bands do drones use?");
  expect(rewinds()).toEqual([]);
  expect(bgStarts()[1]).not.toContain("--resume");
  expect(bgStarts()[1]).not.toContain(SESSION);
});

test("a session paused on a question for its terminal, not a refusal, is told in plain words once, and its next message starts it again", async () => {
  const needs = "Answer the permission prompt in the terminal to continue";
  await start({ reconnect: 50 });
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  await turning("chat:7");
  await pauses("job12345", needs);
  await until(() => failures.length);
  expect(failures).toEqual([
    [
      "chat:7",
      `its session stopped on a question only its terminal can answer ("${needs}"), so your message got no answer. Your next message starts it again.`,
    ],
  ]);
  await restarts("again");
  expect(rewinds()).toEqual([]);
});

test("a session already paused on a refusal when the hub connects to it, its owner's message unanswered, has its chat told, by the job record under the session's short id", async () => {
  bound("chat:7");
  file(dir).messages.deliver({
    key: "telegram:1:5",
    to: "chat:7",
    from: "telegram",
    author: "owner",
    body: "jamming?",
    meta: {},
  });
  file(dir).turns.turned(SESSION, true, "2026-01-01T00:00:00.000Z");
  file(dir).messages.take("telegram:1:5", SESSION);
  writeFileSync(
    join(dir, "jobs", SESSION.slice(0, 8), "state.json"),
    JSON.stringify({ state: "working", sessionId: SESSION, needs: REFUSED }),
  );
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION, model: "fable" } },
    agents: [{ sessionId: SESSION, pid: EXITED, status: "waiting" }],
  });
  refused();
  const line = await session("chat:7");
  await until(() => failures.length);
  expect(failures).toEqual([["chat:7", FLAGGED]]);
  expect(line.received).toEqual([]);
  expect(bgStarts()).toEqual([]);
});

test("a turn Claude Code paused on a dialog isn't given to the thread's next session when the paused one ends", async () => {
  await start({ reconnect: 50 });
  await hub.deliver("chat:7", "Desk anchors", message);
  await launched();
  const line = await turning("chat:7");
  await pauses();
  await until(() => file(dir).turns.get(SESSION).ended);
  writeFileSync(join(dir, "agents"), "[]");
  line.close();
  await time.lapse(50);
  await settled();
  expect(file(dir).messages.untaken("chat:7")).toEqual([]);
  expect(bgStarts()).toHaveLength(1);
});
