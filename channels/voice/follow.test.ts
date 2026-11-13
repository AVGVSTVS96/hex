import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { open } from "@hex/hub";
import { until } from "@hex/hub/testing";
import { z } from "zod";

const CALL = "sess_past";
const SESSION = "aaaaaaaa-general";
const OTHER = "bbbbbbbb-other";

const CallRecord = z.object({ tasks: z.array(z.object({ state: z.string() })) });
const Calls = z.object({ live: z.string().optional() });

async function engineResumingACallTask({ callStillLive = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "follow-"));
  const claude = join(home, "claude");
  const hex = join(home, "hex");
  const state = join(hex, "state");
  const calls = join(home, ".claude", "channels", "voice", "calls");
  const project = join(claude, "projects", hex.replaceAll(/[^a-zA-Z0-9]/gu, "-"));

  for (const dir of [calls, project, join(claude, "sessions"), join(state, "telegram")]) {
    mkdirSync(dir, { recursive: true });
  }

  open(state).threads.keep("telegram", {
    "-100123": { name: "General", session: SESSION },
    "-100123:7": { name: "Other", session: OTHER },
  });
  const started = new Date(Date.now() - 60 * 60_000).toISOString();

  const task = {
    id: "look-into-it",
    state: "running",
    text: "Look into it",
    to: "General",
    agent: "telegram:-100123",
    at: 1000,
  };

  writeFileSync(
    join(calls, `${CALL}.json`),
    JSON.stringify({
      id: CALL,
      started,
      ...(!callStillLive && { ended: started, end: "you" }),
      from: "app",
      turns: [],
      tasks: [task],
    }),
  );

  const threadTookTheTaskAndEndedItsTurn = [
    {
      type: "user",
      origin: { kind: "channel" },
      message: {
        role: "user",
        content: `<channel voice_task="${CALL}:look-into-it">look into it</channel>`,
      },
    },
    { type: "assistant", message: { id: "msg_1", content: [{ type: "text", text: "On it." }] } },
    { type: "system", subtype: "turn_duration" },
  ];

  writeFileSync(
    join(project, `${SESSION}.jsonl`),
    threadTookTheTaskAndEndedItsTurn.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
  );

  const status = (session: string, now: string) => {
    writeFileSync(
      join(claude, "sessions", `${session.slice(0, 8)}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: session,
        status: now,
        statusUpdatedAt: Date.now(),
      }),
    );
  };

  const stillWorkingOnWhatCameAfter = "busy";
  status(SESSION, stillWorkingOnWhatCameAfter);

  const engine = `import { serve } from ${JSON.stringify(join(import.meta.dir, "server.ts"))}
const server = serve({ deliver() {}, keep: async () => {}, renew() {}, session: () => undefined }, ${JSON.stringify(state)})
console.log(server.port)`;

  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(VOICE|TWILIO|OPENAI|OPENROUTER|CALLER|HEX)_/u.test(key),
    ),
  );

  const { promise: back, resolve: reconnect } = Promise.withResolvers<undefined>();

  const openai = Bun.serve({
    port: 0,
    fetch: async (request, server) => {
      await back;

      return server.upgrade(request) ? undefined : new Response("no", { status: 400 });
    },
    websocket: { message() {} },
  });

  writeFileSync(
    join(home, ".claude", "channels", "voice", ".env"),
    [
      "VOICE_PORT=0",
      ...(callStillLive
        ? ["OPENAI_API_KEY=test", `OPENAI_BASE_URL=http://127.0.0.1:${openai.port}/v1`]
        : []),
    ].join("\n"),
  );

  const plugin = Bun.spawn(["bun", "-e", engine], {
    env: { ...env, HOME: home, CLAUDE_CONFIG_DIR: claude },
    stdout: "pipe",
    stderr: "ignore",
  });

  const port = new TextDecoder().decode((await plugin.stdout.getReader().read()).value).trim();

  return {
    status,
    reconnect,
    live: async () =>
      Calls.parse(await fetch(`http://127.0.0.1:${port}/calls`).then((r) => r.json())).live,
    record: () => CallRecord.parse(JSON.parse(readFileSync(join(calls, `${CALL}.json`), "utf-8"))),
    otherThreadsTurnFlips: (n: number) => {
      status(OTHER, n % 2 === 1 ? "busy" : "idle");
    },
    [Symbol.asyncDispose]: async () => {
      plugin.kill();
      await plugin.exited;
      await openai.stop(true);
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("a task picked back up after a restart is done once its thread rests, and stays done however often the board changes after", async () => {
  await using engine = await engineResumingACallTask();
  await Bun.sleep(300);
  expect(engine.record().tasks.map((task) => task.state)).toEqual(["running"]);

  engine.status(SESSION, "idle");
  await until(() => engine.record().tasks.length === 2);

  for (let n = 1; n <= 6; n++) {
    engine.otherThreadsTurnFlips(n);
    await Bun.sleep(150);
  }

  expect(engine.record().tasks.map((task) => task.state)).toEqual(["running", "done"]);
});

test("a task that ends while a live call's connection comes back after a restart stays done once the call is picked back up", async () => {
  await using engine = await engineResumingACallTask({ callStillLive: true });
  await Bun.sleep(300);
  engine.status(SESSION, "idle");
  await until(() => engine.record().tasks.length === 2);
  engine.reconnect();

  while ((await engine.live()) !== CALL) {
    await Bun.sleep(50);
  }

  expect(engine.record().tasks.map((task) => task.state)).toEqual(["running", "done"]);
});
