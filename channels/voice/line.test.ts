import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";

import { open } from "../../hub/store.ts";
import { until } from "../../hub/until.ts";

// A call on a line another client holds (a Discord voice channel), end to end against a stand-in
// for OpenAI's live API: the engine runs on its own with a hub that takes everything, and the test
// plays the client holding the line, through lines on the engine's stdin and stdout.
// hold: OpenAI never starts the session; refuse: it answers the start with an error; before readies
// hex's state before the engine starts.
async function lineCall({ hold = false, refuse = false, before = (_hex: string) => {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), "line-"));
  const state = join(home, ".claude", "channels", "voice");
  mkdirSync(state, { recursive: true });
  const heard: string[] = [];
  const started: any[] = [];
  let voice: Bun.ServerWebSocket<unknown> | undefined;
  const openai = Bun.serve({
    port: 0,
    fetch: (request, server) =>
      server.upgrade(request) ? undefined : new Response("no", { status: 400 }),
    websocket: {
      open: (socket) => {
        voice = socket;
      },
      message(socket, raw) {
        const event = JSON.parse(String(raw));
        if (event.type === "session.start") {
          started.push(event.session);
          if (refuse)
            socket.send(JSON.stringify({ type: "error", error: { message: "no capacity" } }));
          else if (!hold)
            socket.send(
              JSON.stringify({
                type: "session.started",
                session: { id: "sess_discord", expires_at: Date.now() / 1000 + 3600 },
              }),
            );
        }
        if (event.type === "session.input_audio.append") heard.push(event.audio);
        if (event.type === "session.thinking.append")
          socket.send(
            JSON.stringify({ type: "session.thinking.appended", client_event_id: event.event_id }),
          );
        if (event.type === "session.close")
          socket.send(
            JSON.stringify({
              type: "session.closed",
              reason: "close_requested",
              client_event_id: event.event_id,
            }),
          );
      },
    },
  });
  writeFileSync(
    join(state, ".env"),
    [
      `OPENAI_API_KEY=test`,
      `OPENAI_BASE_URL=http://127.0.0.1:${openai.port}/v1`,
      `VOICE_PORT=0`,
    ].join("\n"),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(VOICE|TWILIO|OPENAI|CALLER|HEX)_|^CLAUDE_CONFIG_DIR$/.test(key),
    ),
  );
  const hex = join(home, "hex", "state");
  mkdirSync(join(hex, "discord"), { recursive: true });
  before(hex);
  const engine = `import { serve, take, tool } from ${JSON.stringify(join(import.meta.dir, "server.ts"))}
import { clients } from ${JSON.stringify(join(import.meta.dir, "..", "..", "hub", "hub.ts"))}
const step = (step, more = {}) => console.log(JSON.stringify({ step, ...more }))
clients.set('discord', {
  hub: { register: () => {}, deliver: (thread, name, message) => step('delivered', { thread, name, message }) },
  place: async (name, where, about) => (step('placed', { name, where, about }), { thread: '9001', link: 'https://discord.com/channels/1/9001' }),
})
const server = serve({
  deliver: (content, meta) => step('deliver', { content, meta }),
  keep: () => step('keep'),
  renew: () => step('renew'),
  renewal: async () => {},
  session: () => 'brain',
}, ${JSON.stringify(hex)})
step('listening', { port: server.port })
const held = take('discord', 'They joined you in a Discord voice channel.', { play: audio => step('play', { audio }), end: () => step('end') })
for await (const line of console) {
  const [verb, audio] = line.split(' ')
  if (verb === 'hear') held.hear(audio)
  if (verb === 'hangup') held.hangUp()
  if (verb === 'send') tool('send', JSON.parse(line.slice(5))).then(text => step('sent', { text }), error => step('sent', { error: error.message }))
  if (verb === 'tool') tool(audio, JSON.parse(line.split(' ').slice(2).join(' '))).then(text => step('tool', { text }), error => step('tool', { error: error.message }))
}`;
  const plugin = Bun.spawn(["bun", "-e", engine], {
    env: { ...env, HOME: home },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const steps: any[] = [];
  let listening!: (port: number) => void;
  const port = new Promise<number>((resolve) => (listening = resolve));
  void (async () => {
    let buffer = "";
    for await (const chunk of plugin.stdout) {
      buffer += new TextDecoder().decode(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const step of lines.map((line) => JSON.parse(line))) {
        if (step.step === "listening") listening(step.port);
        else steps.push(step);
      }
    }
  })();
  const exited = plugin.exited.then((code) =>
    Promise.reject(new Error(`the engine exited (${code}) before it listened`)),
  );
  const listened = await Promise.race([port, exited]).catch((error) => {
    openai.stop(true);
    rmSync(home, { recursive: true, force: true });
    throw error;
  });
  const base = `http://127.0.0.1:${listened}`;
  return {
    base,
    heard,
    started,
    steps,
    tell: (line: string) => (plugin.stdin.write(`${line}\n`), plugin.stdin.flush()),
    speak: (audio: string) =>
      voice!.send(JSON.stringify({ type: "session.output_audio.delta", delta: audio })),
    [Symbol.asyncDispose]: async () => {
      plugin.kill();
      await plugin.exited;
      openai.stop(true);
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("a call on another client's line is held like a phone call: PCM both ways, the voice session told, a record of its own, and the line ended when the caller hangs up", async () => {
  await using call = await lineCall();
  const session = await until(() => call.started[0]);
  expect(session.audio.format).toEqual({ type: "audio/pcm", rate: 24000 });
  expect(session.input[0].content[0].text).toBe("They joined you in a Discord voice channel.");

  await until(() => call.steps.find((step) => step.step === "keep"));
  expect(call.steps.find((step) => step.step === "deliver").content).toStartWith("A call started.");
  call.tell("hear AAAA");
  await until(() => call.heard.length);
  expect(call.heard).toEqual(["AAAA"]);
  call.speak("BBBB");
  expect(await until(() => call.steps.find((step) => step.step === "play"))).toEqual({
    step: "play",
    audio: "BBBB",
  });
  expect((await fetch(`${call.base}/calls`).then((r) => r.json())).live).toBe("sess_discord");

  call.tell(
    `send ${JSON.stringify({ thread: "Anchors", about: "the anchors", text: "look into the anchors", app: "discord" })}`,
  );
  expect(await until(() => call.steps.find((step) => step.step === "sent"))).toEqual({
    step: "sent",
    text: "opened Anchors in discord, on the board as the-anchors",
  });
  expect(call.steps.find((step) => step.step === "placed")).toEqual({
    step: "placed",
    name: "Anchors",
    about: "From a call: the anchors",
  });
  expect(call.steps.find((step) => step.step === "delivered")).toEqual({
    step: "delivered",
    thread: "9001",
    name: "Anchors",
    message: {
      content: "look into the anchors",
      author: "prompt",
      meta: { user: "hex voice", voice_task: "sess_discord:the-anchors" },
    },
  });

  call.tell("hangup");
  await until(() => call.steps.find((step) => step.step === "end"));
  await until(() => call.steps.find((step) => step.step === "renew"));
  const record = await fetch(`${call.base}/calls/sess_discord`).then((r) => r.json());
  expect(record).toMatchObject({
    id: "sess_discord",
    from: "discord",
    end: "you",
    claude: "brain",
  });
}, 20_000);

test("a line hung up on before its session starts never becomes a call, and one OpenAI refuses ends its line and is reported once", async () => {
  {
    await using call = await lineCall({ hold: true });
    await until(() => call.started[0]);
    call.tell("hangup");
    await until(() => call.steps.find((step) => step.step === "end"));
    await Bun.sleep(200);
    expect((await fetch(`${call.base}/calls`).then((r) => r.json())).calls).toEqual([]);
    expect(call.steps.some((step) => step.step === "deliver" || step.step === "keep")).toBe(false);
  }
  await using call = await lineCall({ refuse: true });
  await until(() => call.steps.find((step) => step.step === "end"));
  await Bun.sleep(200);
  const told = call.steps.filter((step) => step.step === "deliver");
  expect(told).toHaveLength(1);
  expect(told[0].content).toBe(
    "A call from a Discord voice channel didn't happen: it never connected (OpenAI refused the discord session: no capacity).",
  );
  const [record] = (await fetch(`${call.base}/calls`).then((r) => r.json())).calls;
  expect(record).toMatchObject({ from: "discord", end: "no-connect" });
}, 20_000);

test("on a call, a note on a shown card reaches its thread and the call and leaves it open, and an answer says what it did", async () => {
  const relayed: any[] = [];
  const thread = "-1001234:5";
  let hub: ReturnType<typeof createServer> | undefined;
  await using call = await lineCall({
    before: (hex) => {
      mkdirSync(join(hex, "telegram"));
      const store = open(hex);
      store.keepThreads("telegram", { [thread]: { name: "desk", link: "https://t.me/c/1234/5" } });
      store.ask({
        app: "telegram",
        thread,
        message: 1,
        text: "Ship it?",
        options: ["Yes", "No"],
        at: "2026-11-01T00:00:00.000Z",
      });
      store.ask({
        app: "telegram",
        thread,
        message: 2,
        text: "Ship it now?",
        options: ["Go", "Wait"],
        at: "2026-11-01T00:00:00.000Z",
      });
      hub = createServer((socket) => {
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) =>
          relayed.push(
            ...chunk
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line)),
          ),
        );
      }).listen(join(hex, "telegram", "hub.sock"));
    },
  });
  try {
    await until(() => call.steps.find((step) => step.step === "keep"));
    const id = `telegram:${thread}:1`;
    call.tell(`tool ask ${JSON.stringify({ id })}`);
    await until(() => call.steps.find((step) => step.step === "tool"));
    const post = (verb: string, body?: object) =>
      fetch(`${call.base}/asks/${encodeURIComponent(id)}/${verb}`, {
        method: "POST",
        body: body && JSON.stringify(body),
      });

    const noted = await post("note", { text: "more context first" });
    expect(await noted.json()).toEqual({
      thread: `telegram:${thread}`,
      topic: "desk",
      settled: 0,
      missed: 0,
    });
    expect(await until(() => relayed[0])).toEqual({
      type: "inbound",
      thread,
      content: "(note written in the app) Ship it?: more context first",
      author: "owner",
      meta: { user: "hex app" },
    });
    await until(() =>
      call.steps.find(
        (step) =>
          step.step === "deliver" && step.content.startsWith("The caller wrote a note on the card"),
      ),
    );
    expect(call.steps.findLast((step) => step.step === "deliver").content).toBe(
      `The caller wrote a note on the card for ${id}: "more context first". It's sent to its thread, and the question stays open.`,
    );
    expect(relayed).toHaveLength(1);
    expect(
      (await fetch(`${call.base}/asks`).then((r) => r.json())).asks.map((ask: any) => ask.id),
    ).toContain(id);
    expect((await post("note", { text: " " })).status).toBe(400);

    const answered = await post("answer", { label: "Yes" });
    expect(await answered.json()).toEqual({
      thread: `telegram:${thread}`,
      topic: "desk",
      settled: 1,
      missed: 0,
    });
    const [card] = (await fetch(`${call.base}/activity`).then((r) => r.json())).asks;
    expect(card).toMatchObject({
      answer: "Yes",
      sent: { thread: `telegram:${thread}`, topic: "desk", settled: 1, missed: 0 },
    });

    const other = `telegram:${thread}:2`;
    call.tell(`tool ask ${JSON.stringify({ id: other })}`);
    await until(() => call.steps.filter((step) => step.step === "tool").length === 2);
    const dismissed = await fetch(`${call.base}/asks/${encodeURIComponent(other)}/dismiss`, {
      method: "POST",
    });
    expect(await dismissed.json()).toEqual({
      thread: `telegram:${thread}`,
      topic: "desk",
      settled: 1,
      missed: 0,
    });
    await until(() => relayed.length === 4);
    expect(relayed.slice(-2)).toEqual([
      {
        type: "inbound",
        thread,
        content: "(not needed, said in the app) Ship it now?",
        author: "owner",
        meta: { user: "hex app" },
      },
      { type: "settle", thread, message: 2, note: "✓ Not needed, said in the app" },
    ]);
    const cards = (await fetch(`${call.base}/activity`).then((r) => r.json())).asks;
    expect(cards.find((card: any) => card.ask.id === other)).toMatchObject({
      answer: "Not needed",
      sent: { settled: 1, missed: 0 },
    });
    expect(
      (await fetch(`${call.base}/asks/${encodeURIComponent(other)}/undo`, { method: "POST" }))
        .status,
    ).toBe(204);
    const undone = (await fetch(`${call.base}/activity`).then((r) => r.json())).asks.find(
      (card: any) => card.ask.id === other,
    );
    expect(undone.answer).toBeUndefined();
    await until(() =>
      call.steps.find(
        (step) => step.step === "deliver" && step.content.startsWith("The caller took back"),
      ),
    );
    expect(
      (await fetch(`${call.base}/asks/${encodeURIComponent(id)}/note`, { method: "POST" })).status,
    ).toBe(400);
  } finally {
    hub?.close();
  }
}, 20_000);

test("on a call, running answers from every thread hex has at work, not only what the call started", async () => {
  await using call = await lineCall({
    before: (hex) => {
      mkdirSync(join(hex, "telegram"));
      open(hex).keepThreads("telegram", {
        "-1001234:7": { name: "desk", session: "77777777-desk" },
      });
      const sessions = join(hex, "..", "..", ".claude", "sessions");
      mkdirSync(sessions, { recursive: true });
      writeFileSync(
        join(sessions, "77777777.json"),
        JSON.stringify({
          pid: process.pid,
          sessionId: "77777777-desk",
          status: "busy",
          startedAt: Date.now(),
        }),
      );
    },
  });
  await until(() => call.steps.find((step) => step.step === "keep"));
  call.tell("tool running {}");
  const { text } = await until(() => call.steps.find((step) => step.step === "tool"));
  expect(text).toStartWith("Everything hex is running, 1 thread working:");
  expect(text).toContain("\n- desk (Telegram), working for 1 minute");
}, 20_000);
