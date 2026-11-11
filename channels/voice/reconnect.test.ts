import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { open as store } from "@hex/hub";
import { until } from "@hex/hub/testing";
import { z } from "zod";

const ID = "sess_app";

const Relayed = z.looseObject({ type: z.string() });

const ClientEvent = z.object({
  type: z.string(),
  content: z.string().optional(),
  event_id: z.unknown().optional(),
  delegation_id: z.string().nullable().optional(),
});

const EngineLine = z.object({
  port: z.number().optional(),
  hub: z.string().optional(),
  content: z.string().optional(),
  meta: z.record(z.string(), z.string()).optional(),
  result: z.string().optional(),
  error: z.string().optional(),
});

type Line = z.infer<typeof EngineLine>;

const CallRecord = z.looseObject({
  ended: z.string().optional(),
  tasks: z.array(z.unknown()).optional(),
  moments: z.array(z.unknown()).optional(),
});

const JevAsk = z.object({
  state: z.object({ said: z.string(), asked: z.string().optional() }),
});

const Calls = z.object({ live: z.string().optional() });
const Media = z.object({ id: z.string(), kind: z.string() });

type AttachData = { id: string | undefined };

type FromOpenAI = {
  type: string;
  delta?: string;
  start_ms?: number;
  end_ms?: number;
  offset_ms?: number;
  delegation?: { id: string; target: "client" };
};

const withImage = (told: Line) => told.meta?.image_path !== undefined;

async function appCall({ callStillGoingAtStart = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "reconnect-"));
  const voiceDir = join(home, ".claude", "channels", "voice");
  const state = join(home, "hex", "state");
  mkdirSync(join(voiceDir, "calls"), { recursive: true });
  mkdirSync(join(state, "telegram"), { recursive: true });
  store(state).threads.keep("telegram", {
    "-100123": { name: "General", session: "aaaaaaaa-general" },
  });
  const relayedToGeneral: z.infer<typeof Relayed>[] = [];

  const hub = Bun.listen({
    unix: join(state, "telegram", "hub.sock"),
    socket: {
      data: (_, data) => void relayedToGeneral.push(Relayed.parse(JSON.parse(String(data)))),
    },
  });

  const closes: string[] = [];
  const instructed: string[] = [];
  const thought: string[] = [];
  const handoffs: (string | null | undefined)[] = [];
  const judged: string[] = [];
  let voice: Bun.ServerWebSocket<AttachData> | undefined;
  let hold = callStillGoingAtStart;
  let acking = true;
  let confirmingAnswers = false;
  let held = false;
  let made = 0;
  let probes = 0;
  let credit = true;
  let attach: "open" | "refused" | "gone" = "open";
  const created: unknown[] = [];
  const waiting: (() => void)[] = [];

  const openai = Bun.serve<AttachData>({
    port: 0,
    async fetch(request, server) {
      if (new URL(request.url).pathname.endsWith("/embeddings")) {
        probes++;

        return credit
          ? Response.json({ data: [] })
          : Response.json(
              { error: { message: "You have no credits remaining.", code: "insufficient_quota" } },
              { status: 429 },
            );
      }

      if (new URL(request.url).pathname.endsWith("/systemone")) {
        const { said, asked } = JevAsk.parse(await request.json()).state;
        judged.push(said);
        const wants = asked === undefined ? /^ ?(mute|unmute)\b/iu : /don't do that/iu;

        return Response.json({
          answers: { wants: { type: "noul", noul: wants.test(said) ? 0.95 : 0.02 } },
        });
      }

      if (request.method === "POST") {
        created.push(await request.json());

        return Response.json(
          {
            session: {
              id: made++ || callStillGoingAtStart ? `${ID}-${made}` : ID,
              expires_at: Date.now() / 1000 + 3600,
            },
            transport: { sdp: "answer" },
          },
          { status: 201 },
        );
      }

      if (hold) {
        held = true;
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
        });
        held = false;
      }

      if (attach === "gone") {
        return Response.json({ error: { message: "No session found" } }, { status: 404 });
      }

      if (attach === "refused") {
        return new Response(null, { status: 503 });
      }

      return server.upgrade(request, {
        data: { id: new URL(request.url).pathname.split("/").at(-2) },
      })
        ? undefined
        : new Response("no", { status: 400 });
    },
    websocket: {
      open: (socket) => void (voice = socket),
      message(socket, raw) {
        const event = ClientEvent.parse(JSON.parse(String(raw)));

        if (event.type === "session.instructions.append" && event.content !== undefined) {
          instructed.push(event.content);
        }

        if (event.type.endsWith(".append")) {
          handoffs.push(event.delegation_id);
        }

        if (event.type === "session.thinking.append") {
          thought.push(event.content ?? "");
          socket.send(
            JSON.stringify({ type: "session.thinking.appended", client_event_id: event.event_id }),
          );
        }

        if (event.type === "session.commentary.append" && confirmingAnswers) {
          socket.send(
            JSON.stringify({
              type: "session.commentary.appended",
              client_event_id: event.event_id,
            }),
          );
        }

        if (event.type !== "session.close") {
          return;
        }

        closes.push(`${String(socket.data.id)} ${String(event.event_id)}`);

        if (acking) {
          socket.send(
            JSON.stringify({
              type: "session.closed",
              reason: "close_requested",
              client_event_id: event.event_id,
            }),
          );
        }
      },
    },
  });

  writeFileSync(
    join(voiceDir, ".env"),
    [
      "OPENAI_API_KEY=test",
      `OPENAI_BASE_URL=http://127.0.0.1:${openai.port}/v1`,
      "OPENROUTER_API_KEY=test",
      `OPENROUTER_BASE_URL=http://127.0.0.1:${openai.port}/v1`,
      "VOICE_PORT=0",
    ].join("\n"),
  );

  if (callStillGoingAtStart) {
    writeFileSync(
      join(voiceDir, "calls", `${ID}.json`),
      JSON.stringify({
        id: ID,
        started: new Date().toISOString(),
        from: "app",
        turns: [],
        tasks: [],
      }),
    );
  }

  const engine = `import { serve, tool } from ${JSON.stringify(join(import.meta.dir, "server.ts"))}
const server = serve({ deliver: (content, meta) => console.log(JSON.stringify({ hub: 'deliver', content, meta })), keep: async () => {}, renew: () => console.log(JSON.stringify({ hub: 'renew' })), session: () => 'brain', interrupt: async () => console.log(JSON.stringify({ hub: 'interrupt' })) }, ${JSON.stringify(state)})
console.log(JSON.stringify({ port: server.port }))
for await (const line of console) {
  const { name, args } = JSON.parse(line)
  tool(name, args).then(result => console.log(JSON.stringify({ result })), error => console.log(JSON.stringify({ error: error.message })))
}`;

  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(VOICE|TWILIO|OPENAI|OPENROUTER|CALLER|HEX)_/u.test(key),
    ),
  );

  const plugin = Bun.spawn(["bun", "-e", engine], {
    env: { ...env, HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude") },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });

  const answers: ((line: Line) => void)[] = [];
  const told: Line[] = [];
  const { promise: port, resolve: listening } = Promise.withResolvers<number>();
  void (async () => {
    let buffer = "";

    for await (const chunk of plugin.stdout) {
      buffer += new TextDecoder().decode(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines.map((text) => EngineLine.parse(JSON.parse(text)))) {
        if (line.port !== undefined) {
          listening(line.port);
        } else if (line.hub === undefined) {
          answers.shift()?.(line);
        } else {
          told.push(line);
        }
      }
    }
  })();

  const base = `http://127.0.0.1:${await port}`;

  const call = async () =>
    CallRecord.parse(await fetch(`${base}/calls/${ID}`).then((r) => r.json()));

  return {
    base,
    closes,
    instructed,
    thought,
    handoffs,
    judged,
    told,
    relayedToGeneral,
    call,
    live: async () => Calls.parse(await fetch(`${base}/calls`).then((r) => r.json())).live,
    tool: async (name: string, args: Record<string, string> = {}) => {
      const { promise: answer, resolve } = Promise.withResolvers<Line>();
      answers.push(resolve);
      await plugin.stdin.write(`${JSON.stringify({ name, args })}\n`);
      await plugin.stdin.flush();

      return await answer;
    },
    attached: () => until(() => voice),
    drop: async () => {
      hold = true;

      if (voice === undefined) {
        throw new Error("there's no connection to the call to drop");
      }

      voice.close();
      voice = undefined;
      await until(() => held);
    },
    cut: (to: typeof attach) => {
      attach = to;
      voice?.close();
      voice = undefined;
    },
    attachIs: (to: typeof attach) => void (attach = to),
    created,
    attaching: () => until(() => held),
    hold: () => void (hold = true),
    holdAcks: () => void (acking = false),
    acks: () => void (acking = true),
    confirmAnswers: () => void (confirmingAnswers = true),
    back: () => {
      hold = false;

      for (const resolve of waiting.splice(0)) {
        resolve();
      }
    },
    probes: () => probes,
    spend: () => void (credit = false),
    send: (event: FromOpenAI) => voice?.send(JSON.stringify(event)),
    hangUp: () =>
      fetch(`${base}/session`, { method: "DELETE", body: JSON.stringify({ sessionId: ID }) }),
    [Symbol.asyncDispose]: async () => {
      plugin.kill();
      await plugin.exited;
      await openai.stop(true);
      hub.stop(true);
      rmSync(home, { recursive: true, force: true });
    },
  };
}

type Engine = Awaited<ReturnType<typeof appCall>>;

async function started(engine: Engine) {
  expect(
    (
      await fetch(`${engine.base}/session`, {
        method: "POST",
        body: JSON.stringify({ sdp: "offer", from: "app" }),
      })
    ).status,
  ).toBe(201);
  expect(await engine.live()).toBe(ID);
  await engine.attached();
}

async function ends(engine: Engine) {
  for (let tries = 0; (await engine.call()).ended === undefined; tries++) {
    expect(tries).toBeLessThan(100);
    await Bun.sleep(50);
  }

  return await engine.call();
}

test("hanging up while the connection to the call is coming back ends the call once it is back", async () => {
  await using engine = await appCall();
  await started(engine);
  await engine.drop();
  expect((await engine.hangUp()).status).toBe(204);
  expect(engine.closes).toEqual([]);
  engine.back();
  expect(await ends(engine)).toMatchObject({ end: "you" });
  await Bun.sleep(200);
  expect(engine.closes).toEqual([`${ID} close-you-app`]);
}, 20_000);

test("hanging up a new call before its connection has opened ends it once open", async () => {
  await using engine = await appCall();
  engine.hold();
  expect(
    (
      await fetch(`${engine.base}/session`, {
        method: "POST",
        body: JSON.stringify({ sdp: "offer", from: "app" }),
      })
    ).status,
  ).toBe(201);
  await engine.attaching();
  expect((await engine.hangUp()).status).toBe(204);
  engine.back();
  expect(await ends(engine)).toMatchObject({ end: "you" });
  await Bun.sleep(200);
  expect(engine.closes).toEqual([`${ID} close-you-app`]);
}, 20_000);

test("a call hung up again or replaced before OpenAI says it closed gets a close each time, and ends by the first hang-up", async () => {
  await using engine = await appCall();
  await started(engine);
  engine.holdAcks();
  expect(await engine.tool("hang_up")).toEqual({ result: "hanging up" });
  await until(() => engine.closes.length);
  expect((await engine.hangUp()).status).toBe(204);
  expect(
    (
      await fetch(`${engine.base}/session`, {
        method: "POST",
        body: JSON.stringify({ sdp: "offer", from: "app" }),
      })
    ).status,
  ).toBe(201);
  expect(await engine.call()).toMatchObject({ end: "hex", reason: "close_requested" });
  await until(() => engine.closes.length >= 3);
  await Bun.sleep(200);
  expect(engine.closes.map((close) => close.replace(/_\d+$/u, ""))).toEqual([
    `${ID} close_hex`,
    `${ID} close-you-app`,
    `${ID} close-you-moved`,
  ]);
}, 20_000);

test("a hang-up sent on a connection that drops before OpenAI says it closed goes out again once the connection is back", async () => {
  await using engine = await appCall();
  await started(engine);
  engine.holdAcks();
  expect((await engine.hangUp()).status).toBe(204);
  await until(() => engine.closes.length);
  engine.acks();
  await engine.drop();
  engine.back();
  expect(await ends(engine)).toMatchObject({ end: "you", reason: "close_requested" });
  expect(engine.closes).toEqual([`${ID} close-you-app`, `${ID} close-you-app`]);
}, 20_000);

test("a call hung up while its connection comes back and then replaced is closed on the reattach that opens late, too", async () => {
  await using engine = await appCall();
  await started(engine);
  await engine.drop();
  expect((await engine.hangUp()).status).toBe(204);
  expect(
    (
      await fetch(`${engine.base}/session`, {
        method: "POST",
        body: JSON.stringify({ sdp: "offer", from: "app" }),
      })
    ).status,
  ).toBe(201);
  expect(await engine.call()).toMatchObject({ end: "you", reason: "close_requested" });
  engine.back();
  await until(() => engine.closes.length >= 2);
  await Bun.sleep(200);
  expect(engine.closes).toEqual([`${ID} close-you-app`, `${ID} close-you-app`]);
}, 20_000);

test("OpenAI closing a call on a later hang-up's close still records the first hang-up", async () => {
  await using engine = await appCall();
  await started(engine);
  engine.holdAcks();
  expect(await engine.tool("hang_up")).toEqual({ result: "hanging up" });
  await until(() => engine.closes.length);
  engine.acks();
  expect((await engine.hangUp()).status).toBe(204);
  expect(await ends(engine)).toMatchObject({ end: "hex", reason: "close_requested" });
}, 20_000);

test("a call a new one replaces before its connection opened is still closed", async () => {
  await using engine = await appCall();
  engine.hold();

  const start = () =>
    fetch(`${engine.base}/session`, {
      method: "POST",
      body: JSON.stringify({ sdp: "offer", from: "app" }),
    });

  expect((await start()).status).toBe(201);
  await engine.attaching();
  expect((await start()).status).toBe(201);
  engine.back();
  await until(() => engine.closes.length);
  await Bun.sleep(200);
  expect(engine.closes).toEqual([`${ID} close-you-moved`]);
  expect(await engine.call()).toMatchObject({ end: "you", reason: "moved to a new call" });
}, 20_000);

test("a hung-up call a new one replaces before its connection opened ends as hung up", async () => {
  await using engine = await appCall();
  engine.hold();

  const start = () =>
    fetch(`${engine.base}/session`, {
      method: "POST",
      body: JSON.stringify({ sdp: "offer", from: "app" }),
    });

  expect((await start()).status).toBe(201);
  await engine.attaching();
  expect((await engine.hangUp()).status).toBe(204);
  expect((await start()).status).toBe(201);
  engine.back();
  await until(() => engine.closes.length);
  await Bun.sleep(200);
  expect(engine.closes).toEqual([`${ID} close-you-app`]);
  expect(await engine.call()).toMatchObject({ end: "you", reason: "close_requested" });
}, 20_000);

test("hanging up a call the engine is attaching back to after a restart ends it once attached, from the app or from hex", async () => {
  const ways = [
    { hangUp: (engine: Engine) => engine.hangUp(), end: "you", close: "close-you-app" },
    { hangUp: (engine: Engine) => engine.tool("hang_up"), end: "hex", close: "close_hex_" },
  ];

  for (const { hangUp, end, close } of ways) {
    await using engine = await appCall({ callStillGoingAtStart: true });
    await engine.attaching();
    await hangUp(engine);
    expect(await engine.call()).toMatchObject({ end, reason: "close_requested" });
    expect(engine.closes).toEqual([]);
    expect(
      await engine.tool("task", { id: "after", state: "done", text: "Named after the call" }),
    ).toEqual({ result: "that call has ended, so only its record changed" });
    engine.back();
    await until(() => engine.closes.length);
    await Bun.sleep(200);
    expect(engine.closes).toHaveLength(1);
    expect(engine.closes[0]).toStartWith(`${ID} ${close}`);
    await until(() => engine.told.length >= 2);
    expect(engine.told.map(({ hub, meta }) => meta?.ended ?? hub)).toEqual([end, "renew"]);
  }
}, 30_000);

test("a call a new one replaces while the engine attaches back to it after a restart ends then, and is closed once attached", async () => {
  await using engine = await appCall({ callStillGoingAtStart: true });
  await engine.attaching();
  expect(
    (
      await fetch(`${engine.base}/session`, {
        method: "POST",
        body: JSON.stringify({ sdp: "offer", from: "app" }),
      })
    ).status,
  ).toBe(201);
  expect(await engine.call()).toMatchObject({ end: "you", reason: "moved to a new call" });
  engine.back();
  await until(() => engine.closes.length);
  await Bun.sleep(200);
  expect(engine.closes).toEqual([`${ID} close-you-moved`]);
  expect(await engine.live()).toBe(`${ID}-1`);
  await until(() => engine.told.length >= 3);
  expect(
    engine.told.map(({ hub, meta }) =>
      meta?.ended === undefined
        ? meta?.call === undefined
          ? hub
          : `${meta.call} told`
        : `${String(meta.call)} ended`,
    ),
  ).toEqual([`${ID} ended`, "renew", `${ID}-1 told`]);
}, 20_000);

test("work sent while the connection to the call is coming back still goes out and is followed", async () => {
  await using engine = await appCall();
  await started(engine);
  await engine.drop();

  const { result } = await engine.tool("send", {
    thread: "General",
    about: "Look into it",
    text: "look into it",
  });

  expect(result).toBe(
    "sent to General, on the board as look-into-it, but the voice may not have heard of it; the work went out, so it needn't be sent again",
  );
  await until(() => engine.relayedToGeneral.length);
  expect(engine.relayedToGeneral).toMatchObject([
    {
      type: "inbound",
      thread: "-100123",
      content: "look into it",
      meta: { voice_task: `${ID}:look-into-it` },
    },
  ]);
  expect((await engine.call()).tasks).toMatchObject([
    { id: "look-into-it", state: "running", to: "General" },
  ]);
}, 20_000);

test("a say the voice never confirms gives the voice session an answer instead of holding its turn", async () => {
  await using engine = await appCall();
  await started(engine);
  const asked = Date.now();
  const { error } = await engine.tool("say", { delegation_id: "d1", text: "CI is green." });
  expect(error).toBe("the voice didn't confirm it within 10s, so it may not have it");
  expect(Date.now() - asked).toBeLessThan(12_000);
  expect((await engine.tool("note", { text: "still here" })).result).toBe("noted");
}, 20_000);

test("a handoff id hex copied wrong reaches the voice as the handoff it nearly matches, or as none, since the voice rejects an unknown one", async () => {
  await using engine = await appCall();
  await started(engine);
  engine.send({
    type: "session.delegation.created",
    delegation: { id: "item_EijjJ5AQL1Cl5XBQPFHez", target: "client" },
    offset_ms: 1500,
  });
  await Bun.sleep(100);
  const sent = engine.handoffs.length;
  await engine.tool("note", { delegation_id: "item_EijjAQL1Cl5XBQPFHez", text: "Looking." });
  await engine.tool("note", { delegation_id: 'item_EijjJ5AQL1Cl5XBQPFHez">', text: "Still." });
  await engine.tool("note", { delegation_id: "none", text: "Aside." });
  expect(engine.handoffs.slice(sent)).toEqual([
    "item_EijjJ5AQL1Cl5XBQPFHez",
    "item_EijjJ5AQL1Cl5XBQPFHez",
    null,
  ]);
}, 20_000);

test("an answer waits for the voice to take up what the caller said after the handoff, so those words still get handed off", async () => {
  await using engine = await appCall();
  await started(engine);
  engine.send({
    type: "session.delegation.created",
    delegation: { id: "d1", target: "client" },
    offset_ms: 1500,
  });
  await until(() => engine.told.some((line) => line.meta?.delegation_id === "d1"));
  engine.send({
    type: "session.input_transcript.delta",
    delta: "and tell the other thread too",
    start_ms: 9000,
    end_ms: 9300,
  });
  await Bun.sleep(100);
  const sent = engine.handoffs.length;
  void engine.tool("say", { delegation_id: "d1", text: "The build is green." });
  await Bun.sleep(1000);
  expect(engine.handoffs.length).toBe(sent);
  engine.send({
    type: "session.output_transcript.delta",
    delta: "Checking.",
    start_ms: 10_000,
    end_ms: 10_300,
  });
  await until(() => engine.handoffs.length > sent);
  expect(engine.handoffs.at(-1)).toBe("d1");
}, 20_000);

test("an answer goes once the caller has been quiet a while, even when the voice never takes up their newest words", async () => {
  await using engine = await appCall();
  await started(engine);
  engine.confirmAnswers();
  engine.send({
    type: "session.input_transcript.delta",
    delta: "hold on, the door",
    start_ms: 9000,
    end_ms: 9300,
  });
  await Bun.sleep(100);
  const sent = engine.handoffs.length;
  const asked = Date.now();
  await engine.tool("say", { delegation_id: "d1", text: "The build is green." });
  expect(engine.handoffs.length).toBe(sent + 1);
  expect(Date.now() - asked).toBeGreaterThan(2500);
  expect(Date.now() - asked).toBeLessThan(5000);
}, 20_000);

test("the same answer sent twice in a row reaches the voice once", async () => {
  await using engine = await appCall();
  await started(engine);
  engine.confirmAnswers();
  const sent = engine.handoffs.length;
  expect((await engine.tool("say", { delegation_id: "d1", text: "CI is green." })).result).toBe(
    "said",
  );
  expect((await engine.tool("say", { delegation_id: "d1", text: "CI is green." })).result).toBe(
    "said already: the voice has this answer, so it isn't sent twice",
  );
  expect(engine.handoffs.length).toBe(sent + 1);
}, 20_000);

test("a task change reaches the voice as background, since it reads a bare one aloud", async () => {
  await using engine = await appCall();
  await started(engine);
  await engine.tool("task", { id: "build", state: "running", text: "the build" });
  expect(engine.thought.at(-1)).toBe(
    "Background for you to know, not a result and not for the caller: say none of it unless the caller asks about it. Task update:\n- build running: the build",
  );
}, 20_000);

test("a photo sent during the call shows in its transcript, reaches hex to look at, and has the voice hand off", async () => {
  await using engine = await appCall();

  const png = await fetch(`${engine.base}/media`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: "png bytes",
  });

  expect(png.status).toBe(201);
  const { id, kind } = Media.parse(await png.json());
  expect(kind).toBe("photo");
  expect(await fetch(`${engine.base}/media/${id}`).then((r) => r.text())).toBe("png bytes");
  expect(
    (
      await fetch(`${engine.base}/media`, {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: "pdf",
      })
    ).status,
  ).toBe(415);
  expect(
    (
      await fetch(`${engine.base}/calls/${ID}/media`, {
        method: "POST",
        body: JSON.stringify({ media: id }),
      })
    ).status,
  ).toBe(409);
  await started(engine);
  expect(
    (
      await fetch(`${engine.base}/calls/${ID}/media`, {
        method: "POST",
        body: JSON.stringify({ media: "nothing" }),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await fetch(`${engine.base}/calls/${ID}/media`, {
        method: "POST",
        body: JSON.stringify({ media: id }),
      })
    ).status,
  ).toBe(204);
  const anyTime: unknown = expect.any(Number);
  expect((await engine.call()).moments).toEqual([
    { at: anyTime, kind: "photo", text: "", media: id },
  ]);

  await until(() => engine.told.find(withImage));

  const savedAsTheMedia: unknown = expect.stringMatching(new RegExp(`${id}\\.png$`, "u"));
  expect(engine.told.find(withImage)).toMatchObject({
    content: "The caller sent this from the app: (photo)",
    meta: { call: ID, image_path: savedAsTheMedia },
  });
  await until(() => engine.instructed.length);
  expect(engine.instructed[0]).toContain("<|SpawnThinking|>");

  const second = Media.parse(
    await fetch(`${engine.base}/media`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: "more png bytes",
    }).then((r) => r.json()),
  );

  expect(
    (
      await fetch(`${engine.base}/calls/${ID}/media`, {
        method: "POST",
        body: JSON.stringify({ media: [id, second.id] }),
      })
    ).status,
  ).toBe(204);
  expect((await engine.call()).moments?.slice(1)).toEqual([
    { at: anyTime, kind: "photo", text: "", media: id },
    { at: anyTime, kind: "photo", text: "", media: second.id },
  ]);
  await until(() => engine.told.filter(withImage).length === 2);
  expect(engine.told.filter(withImage)[1]?.content).toBe(
    "The caller sent this from the app: (photo) (photo)",
  );
  await until(() => engine.instructed.length === 2);
  expect(engine.instructed[1]).toContain("just sent 2 photos");
}, 20_000);

const SILENCE = Buffer.alloc(4800).toString("base64");
const SPEECH = Buffer.alloc(4800, 0x10).toString("base64");

function stream(engine: Engine, audio: () => string) {
  const timer = setInterval(() => {
    engine.send({ type: "session.output_audio.delta", delta: audio() });
  }, 100);

  return {
    [Symbol.dispose]: () => {
      clearInterval(timer);
    },
  };
}

test("hex hangs up a moment after the voice goes quiet, though its audio streams silence the whole call", async () => {
  await using engine = await appCall();
  await started(engine);
  let talking = true;
  using _audio = stream(engine, () => (talking ? SPEECH : SILENCE));
  const asked = Date.now();
  const hungUp = engine.tool("hang_up");
  await Bun.sleep(1500);
  talking = false;
  expect(await hungUp).toEqual({ result: "hanging up" });
  expect(Date.now() - asked).toBeGreaterThanOrEqual(3400);
  expect(Date.now() - asked).toBeLessThan(5000);
}, 20_000);

test("a handoff the caller keeps talking past waits for their pause and carries all of it", async () => {
  await using engine = await appCall();
  await started(engine);

  const words = (who: "you" | "voice", delta: string, start_ms: number) => {
    engine.send({
      type: `session.${who === "you" ? "input" : "output"}_transcript.delta`,
      delta,
      start_ms,
      end_ms: start_ms + 300,
    });
  };

  const handoffs = () => engine.told.filter((told) => told.meta?.delegation_id === "d1");
  words("you", "who's on Opus right now", 1000);
  engine.send({
    type: "session.delegation.created",
    delegation: { id: "d1", target: "client" },
    offset_ms: 1500,
  });
  words("voice", "Checking.", 1600);
  await Bun.sleep(500);
  words("you", " hold on, I mean orchestrators", 2000);
  await Bun.sleep(500);
  expect(handoffs()).toEqual([]);
  await until(() => handoffs().length);
  expect(handoffs()[0]?.content).toContain("I mean orchestrators");
}, 20_000);

test("the phone's audio blinking tells the voice nothing, and a pause that holds tells it once each way", async () => {
  await using engine = await appCall();
  await started(engine);

  const moment = (kind: string) =>
    fetch(`${engine.base}/calls/${ID}/moments`, { method: "POST", body: JSON.stringify({ kind }) });

  for (let i = 0; i < 4; i++) {
    await moment("paused");
    await moment("resumed");
  }

  await Bun.sleep(2000);
  expect(engine.instructed).toEqual([]);
  await moment("paused");
  await moment("resumed");
  await moment("paused");
  await until(() => engine.instructed.length);
  await moment("resumed");
  await until(() => engine.instructed.length === 2);
  await Bun.sleep(2000);
  expect(engine.instructed.map((text) => text.split(":")[0])).toEqual([
    "The caller's phone took over their audio, a phone call or Siri",
    "The caller can hear you and talk again. Carry on where you were, without greeting them again",
  ]);
  expect(
    (await engine.call()).moments?.map((each) => z.object({ kind: z.string() }).parse(each).kind),
  ).toEqual(["paused", "resumed"]);
}, 20_000);

test("a call that spends the last of OpenAI's credit warns hex once, before the next call fails", async () => {
  await using engine = await appCall();
  await until(() => engine.probes());
  await started(engine);
  engine.spend();
  expect((await engine.hangUp()).status).toBe(204);
  await until(() => engine.probes() >= 2);
  const warned = () => engine.told.filter((told) => told.meta?.credit === "out");
  await until(() => warned().length);
  expect(warned()[0]?.content).toContain("no credit left");
  await fetch(`${engine.base}/session`, {
    method: "POST",
    body: JSON.stringify({ sdp: "offer", from: "app" }),
  });
  const second = await until(() => engine.live());
  await fetch(`${engine.base}/session`, {
    method: "DELETE",
    body: JSON.stringify({ sessionId: second }),
  });
  await until(() => engine.probes() >= 3);
  await Bun.sleep(200);
  expect(warned()).toHaveLength(1);
}, 20_000);

test("saying mute yourself mutes the voice through Jev: hex's answers wait, silently, until the caller unmutes it", async () => {
  await using engine = await appCall();
  await started(engine);
  engine.send({
    type: "session.input_transcript.delta",
    delta: "Mute yourself",
    start_ms: 1000,
    end_ms: 1600,
  });
  await until(() => engine.instructed.find((line) => line.startsWith("The caller muted you")));
  expect((await engine.tool("say", { delegation_id: "d1", text: "CI is green." })).result).toBe(
    "the caller muted the voice: it says this once they unmute it",
  );
  expect(engine.thought.at(-1)).toBe("Say this once the caller unmutes you: CI is green.");
  engine.send({
    type: "session.input_transcript.delta",
    delta: "Unmute",
    start_ms: 9000,
    end_ms: 9400,
  });
  await until(() => engine.thought.find((line) => line.startsWith("The caller unmuted you")));
  expect(engine.judged).toEqual(["Mute yourself", "Unmute"]);
  expect((await engine.call()).moments).toMatchObject([
    { kind: "muted", text: "You muted hex" },
    { kind: "say", text: "CI is green." },
    { kind: "unmuted", text: "You unmuted hex" },
  ]);
}, 20_000);

test("calling off a handoff hex is working on stops its turn at once, then hands it the caller's words", async () => {
  await using engine = await appCall();
  await started(engine);

  const words = (who: "you" | "voice", delta: string, start_ms: number) => {
    engine.send({
      type: `session.${who === "you" ? "input" : "output"}_transcript.delta`,
      delta,
      start_ms,
      end_ms: start_ms + 300,
    });
  };

  words("you", "Start a new topic for Brim", 1000);
  engine.send({
    type: "session.delegation.created",
    delegation: { id: "d1", target: "client" },
    offset_ms: 1500,
  });
  words("voice", "Starting it.", 1600);
  await until(() => engine.told.find((told) => told.meta?.delegation_id === "d1"));
  words("you", "Oh, I already did. You don't do that", 6000);
  const stopped = await until(() => engine.told.find((told) => told.meta?.stopped === "true"));
  expect(engine.told.map((told) => told.hub).slice(-2)).toEqual(["interrupt", "deliver"]);
  expect(stopped.meta?.delegation_id).toBe("d1");
  expect(stopped.content).toContain("You don't do that");
  expect((await engine.call()).moments).toMatchObject([{ kind: "stopped" }]);
}, 20_000);

test("the app's data channel hears only what the app uses, so an error the engine's commands cause never reaches it", async () => {
  await using engine = await appCall();
  await started(engine);
  expect(engine.created[0]).toMatchObject({
    session: {
      client: {
        data_channel: {
          allowed_server_events: [
            { type: "session.started" },
            { type: "session.input_transcript.delta" },
            { type: "session.output_transcript.delta" },
            { type: "session.input_audio.muted" },
            { type: "session.input_audio.unmuted" },
            { type: "session.closed" },
          ],
        },
      },
    },
  });
});

test("an app call whose connection stays down past every retry goes on, and the engine comes back to it once it can", async () => {
  await using engine = await appCall();
  await started(engine);
  engine.cut("refused");
  await Bun.sleep(17_000);
  expect(await engine.live()).toBe(ID);
  expect((await engine.call()).ended).toBeUndefined();
  expect(engine.closes).toEqual([]);
  engine.attachIs("open");
  await engine.attached();
  await engine.hangUp();
  expect(await ends(engine)).toMatchObject({ end: "you" });
  expect(engine.closes).toEqual([`${ID} close-you-app`]);
}, 40_000);

const Created = z.object({
  session: z.object({
    input: z.array(
      z.object({ role: z.string(), content: z.array(z.object({ text: z.string() })) }),
    ),
  }),
});

const Turns = z.object({ turns: z.array(z.object({ who: z.string(), at: z.number() })) });

async function heard(engine: Engine, count: number) {
  for (let tries = 0; ; tries++) {
    const { turns } = Turns.parse(await engine.call());

    if (turns.length === count) {
      return turns;
    }

    expect(tries).toBeLessThan(100);
    await Bun.sleep(50);
  }
}

async function carryOn(engine: Engine, continues = ID) {
  return await fetch(`${engine.base}/session`, {
    method: "POST",
    body: JSON.stringify({ sdp: "offer", from: "app", continues }),
  });
}

async function waitsToCarryOn(engine: Engine) {
  engine.cut("gone");
  await Bun.sleep(2000);
  expect(await engine.live()).toBe(ID);
  expect((await engine.call()).ended).toBeUndefined();
}

test("an app call whose session OpenAI ends carries on in the one the app opens next: same call, the call so far, one clock", async () => {
  await using engine = await appCall();
  await started(engine);
  engine.send({
    type: "session.input_transcript.delta",
    delta: "is the build green?",
    start_ms: 1000,
  });
  engine.send({ type: "session.output_transcript.delta", delta: "It is.", start_ms: 2000 });
  await heard(engine, 2);
  await waitsToCarryOn(engine);
  engine.attachIs("open");

  const response = await carryOn(engine);
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ session: { id: ID } });

  const opening = Created.parse(engine.created[1]).session.input.map(({ role, content }) => [
    role,
    content[0]?.text,
  ]);

  expect(opening.slice(0, 2)).toEqual([
    ["user", "is the build green?"],
    ["assistant", "It is."],
  ]);
  expect(opening[2]?.[0]).toBe("developer");
  expect(opening[2]?.[1]).toContain("you're back");

  await engine.attached();
  engine.send({ type: "session.input_transcript.delta", delta: "and the tests?", start_ms: 100 });
  const turns = await heard(engine, 3);
  expect(turns[2]?.at).toBeGreaterThan(2000);
  expect((await engine.call()).moments).toMatchObject([{ kind: "reconnected" }]);
  expect(engine.told.some((told) => told.meta?.carried === "connection_lost")).toBe(true);

  await engine.hangUp();
  expect(await ends(engine)).toMatchObject({ end: "you" });
  expect(engine.closes).toEqual([`${ID}-2 close-you-app`]);
}, 40_000);

test("hanging up while the call waits to carry on ends it at once, and it can't be carried on after", async () => {
  await using engine = await appCall();
  await started(engine);
  await waitsToCarryOn(engine);
  await engine.hangUp();
  expect(await ends(engine)).toMatchObject({ end: "you" });
  expect(engine.closes).toEqual([]);
  expect((await carryOn(engine)).status).toBe(410);
  expect(engine.created).toHaveLength(1);
}, 40_000);

test("after a restart, the engine keeps coming back to a call it can't attach to yet, and closes it out once OpenAI says it's gone", async () => {
  for (const after of ["open", "gone"] as const) {
    await using engine = await appCall({ callStillGoingAtStart: true });
    await engine.attaching();
    engine.attachIs("refused");
    engine.back();
    await Bun.sleep(4000);
    expect((await engine.call()).ended).toBeUndefined();
    engine.attachIs(after);

    if (after === "open") {
      await engine.attached();
      expect(await engine.live()).toBe(ID);
      expect((await engine.call()).ended).toBeUndefined();
    } else {
      expect(await ends(engine)).toMatchObject({
        reason: "hex's service restarted and the call was gone",
      });
      expect(engine.closes).toEqual([]);
    }
  }
}, 40_000);

test("hex's hang-up holds off when the caller speaks after it was asked for", async () => {
  await using engine = await appCall();
  await started(engine);
  const hungUp = engine.tool("hang_up");
  await Bun.sleep(500);
  engine.send({
    type: "session.input_transcript.delta",
    delta: "wait, one more thing",
    start_ms: 9000,
  });
  expect((await hungUp).result).toStartWith(
    'not hung up: the caller spoke after you asked to ("wait, one more thing")',
  );
  expect(engine.closes).toEqual([]);
  expect(await engine.tool("hang_up")).toEqual({ result: "hanging up" });
}, 20_000);
