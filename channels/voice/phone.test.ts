import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { until } from "../../hub/until.ts";

const CALLER = "+15550001111";
const TWILIO_TOKEN = "twilio-secret";
const HOST = "voice.test";

const ClientEvent = z.object({
  type: z.string(),
  content: z.string().optional(),
  audio: z.string().optional(),
  event_id: z.unknown().optional(),
});

const Step = z.object({
  step: z.string(),
  content: z.string().optional(),
  meta: z.record(z.string(), z.string()).optional(),
  port: z.number().optional(),
  tools: z.number().optional(),
});

type EngineStep = z.infer<typeof Step>;

const ToolAnswer = z.object({ result: z.string().optional(), error: z.string().optional() });
const Calls = z.object({ live: z.string().optional() });

const CallRecord = z.looseObject({
  version: z.number().optional(),
  ended: z.string().optional(),
  turns: z.array(z.looseObject({ who: z.string(), text: z.string() })),
});

type Call = z.infer<typeof CallRecord>;

const TwilioMessage = z.looseObject({ event: z.string() });

type Session = { id?: string } | undefined;

type FromOpenAI =
  | { type: "session.output_audio.delta"; delta: string }
  | {
      type: "session.delegation.created";
      delegation: { id: string; target: "client" };
      offset_ms: number;
    }
  | {
      type: "session.input_transcript.delta" | "session.output_transcript.delta";
      delta: string;
      start_ms: number;
      end_ms: number;
    };

async function calls(base: string) {
  return Calls.parse(await fetch(`${base}/calls`).then((r) => r.json()));
}

async function record(base: string, path: string) {
  return CallRecord.parse(await fetch(`${base}/calls/${path}`).then((r) => r.json()));
}

function opened(socket: WebSocket) {
  return new Promise((resolve) => {
    socket.addEventListener("open", resolve, { once: true });
  });
}

async function phoneCall({ openaiHoldsEachStart = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "phone-"));
  const state = join(home, ".claude", "channels", "voice");
  mkdirSync(state, { recursive: true });
  const audio: string[] = [];
  let voice: Bun.ServerWebSocket<Session> | undefined;
  const starts: (() => void)[] = [];
  const closes: unknown[] = [];
  const told: { session: string; content: string | undefined }[] = [];
  let connected = 0;
  let sessions = 0;

  const openai = Bun.serve<Session>({
    port: 0,
    fetch: (request, server) =>
      server.upgrade(request, { data: undefined })
        ? undefined
        : new Response("no", { status: 400 }),
    websocket: {
      open: (socket) => {
        voice = socket;
        connected++;
      },
      close: () => void connected--,
      message(socket, raw) {
        const event = ClientEvent.parse(JSON.parse(String(raw)));

        const begin = () => {
          socket.data = { id: ++sessions === 1 ? "sess_phone" : `sess_phone_${sessions}` };
          socket.send(
            JSON.stringify({
              type: "session.started",
              session: { id: socket.data.id, expires_at: Date.now() / 1000 + 3600 },
            }),
          );
        };

        if (/^session\.(thinking|commentary)\.append$/u.test(event.type)) {
          told.push({ session: socket.data?.id ?? "", content: event.content });
          socket.send(JSON.stringify({ type: `${event.type}ed`, client_event_id: event.event_id }));
        }

        if (event.type === "session.start") {
          if (openaiHoldsEachStart) {
            starts.push(begin);
          } else {
            begin();
          }
        }

        if (event.type === "session.close") {
          closes.push(event.event_id);
        }

        if (event.type === "session.input_audio.append" && event.audio !== undefined) {
          audio.push(event.audio);
        }

        if (event.type === "session.close") {
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

  const placed: string[] = [];

  const twilio = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = z.string().parse((await request.formData()).get("Url"));
      const token = /\/twilio\/([\w-]+)\/twiml$/u.exec(url)?.[1];

      if (token === undefined) {
        throw new Error(`hex placed a call with no TwiML token: ${url}`);
      }

      placed.push(token);

      return Response.json({ sid: `CA${placed.length}` }, { status: 201 });
    },
  });

  writeFileSync(
    join(state, ".env"),
    [
      `OPENAI_API_KEY=test`,
      `OPENAI_BASE_URL=http://127.0.0.1:${openai.port}/v1`,
      `VOICE_PORT=0`,
      `TWILIO_ACCOUNT_SID=AC1`,
      `TWILIO_AUTH_TOKEN=${TWILIO_TOKEN}`,
      `TWILIO_NUMBER=+15550002222`,
      `CALLER_NUMBER=${CALLER}`,
      `VOICE_PUBLIC_URL=${HOST}`,
      `TWILIO_BASE_URL=http://127.0.0.1:${twilio.port}`,
    ].join("\n"),
  );

  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(VOICE|TWILIO|OPENAI|CALLER|HEX)_/u.test(key)),
  );

  const hex = join(home, "hex", "state");
  mkdirSync(hex, { recursive: true });

  const engineWhoseRenewalWaitsForAStdinLine = `import { serve, tool } from ${JSON.stringify(join(import.meta.dir, "server.ts"))}
const step = (step, more = {}) => console.log(JSON.stringify({ step, ...more }))
const lines = console[Symbol.asyncIterator]()
const server = serve({
  deliver: (content, meta) => step('deliver', { content, meta }),
  keep: () => step('keep'),
  renew: () => step('renew'),
  renewal: async () => (step('renewal'), await lines.next()),
  session: () => 'brain',
}, ${JSON.stringify(hex)})
const tools = Bun.serve({ port: 0, fetch: async request => {
  const { name, args } = await request.json()
  return tool(name, args).then(result => Response.json({ result }), error => Response.json({ error: error.message }))
} })
step('listening', { port: server.port, tools: tools.port })`;

  const plugin = Bun.spawn(["bun", "-e", engineWhoseRenewalWaitsForAStdinLine], {
    env: { ...env, HOME: home },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });

  const steps: EngineStep[] = [];

  const { promise: port, resolve: listening } = Promise.withResolvers<{
    port: number;
    tools: number;
  }>();

  void (async () => {
    let buffer = "";

    for await (const chunk of plugin.stdout) {
      buffer += new TextDecoder().decode(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const step of lines.map((line) => Step.parse(JSON.parse(line)))) {
        if (step.step === "listening" && step.port !== undefined && step.tools !== undefined) {
          listening({ port: step.port, tools: step.tools });
        } else {
          steps.push(step);
        }
      }
    }
  })();

  const exited = plugin.exited.then((code) => {
    throw new Error(`the engine exited (${code}) before it listened`);
  });

  let listened: { port: number; tools: number };

  try {
    listened = await Promise.race([port, exited]);
  } catch (error) {
    await openai.stop(true);
    await twilio.stop(true);
    rmSync(home, { recursive: true, force: true });
    throw error;
  }

  const fromOpenAI = (event: FromOpenAI) => {
    if (voice === undefined) {
      throw new Error("OpenAI's stand-in has no session open");
    }

    voice.send(JSON.stringify(event));
  };

  const base = `http://127.0.0.1:${listened.port}`;

  return {
    base,
    audio,
    steps,
    closes,
    told,
    placed,
    firstPlaced: () => {
      const [token] = placed;

      if (token === undefined) {
        throw new Error("hex placed no call");
      }

      return token;
    },
    tool: async (name: string, args: Record<string, string | boolean> = {}) =>
      ToolAnswer.parse(
        await fetch(`http://127.0.0.1:${listened.tools}`, {
          method: "POST",
          body: JSON.stringify({ name, args }),
        }).then((r) => r.json()),
      ),
    connected: () => connected,
    starting: () => until(() => starts.length),
    start: () => {
      for (const begin of starts.splice(0)) {
        begin();
      }
    },
    renewed: async () => {
      await plugin.stdin.write("renewed\n");
      await plugin.stdin.flush();
    },
    speak: (delta: string) => {
      fromOpenAI({ type: "session.output_audio.delta", delta });
    },
    delegate: (id: string, offset_ms: number) => {
      fromOpenAI({
        type: "session.delegation.created",
        delegation: { id, target: "client" },
        offset_ms,
      });
    },
    say: (who: "you" | "voice", delta: string, start_ms: number) => {
      fromOpenAI({
        type: who === "you" ? "session.input_transcript.delta" : "session.output_transcript.delta",
        delta,
        start_ms,
        end_ms: start_ms + 300,
      });
    },
    [Symbol.asyncDispose]: async () => {
      plugin.kill();
      await plugin.exited;
      await openai.stop(true);
      await twilio.stop(true);
      rmSync(home, { recursive: true, force: true });
    },
  };
}

async function dialIn(base: string, { start = true } = {}) {
  const form = new URLSearchParams({ From: CALLER, CallSid: "CA1" });

  const signature = createHmac("sha1", TWILIO_TOKEN)
    .update(
      `https://${HOST}/twilio/incoming${[...form.keys()]
        .toSorted()
        .map((key) => key + form.get(key))
        .join("")}`,
    )
    .digest("base64");

  const twiml = await fetch(`${base}/twilio/incoming`, {
    method: "POST",
    body: form,
    headers: { "x-twilio-signature": signature },
  }).then((r) => r.text());

  const token = /\/twilio\/([\w-]+)"/u.exec(twiml)?.[1];

  if (token === undefined) {
    throw new Error(`the TwiML names no stream: ${twiml}`);
  }

  const phone = new WebSocket(`${base.replace("http", "ws")}/twilio/${token}`);
  await opened(phone);

  if (start) {
    phone.send(JSON.stringify({ event: "start", start: { streamSid: "MZ1" } }));
  }

  return phone;
}

async function pickedUp(base: string, token: string) {
  await fetch(`${base}/twilio/${token}/twiml`, { method: "POST" });
  const phone = new WebSocket(`${base.replace("http", "ws")}/twilio/${token}`);
  await opened(phone);
  phone.send(JSON.stringify({ event: "start", start: { streamSid: "MZ2" } }));

  return phone;
}

async function live(base: string) {
  for (let i = 0; i < 100; i++) {
    const id = (await calls(base)).live;

    if (id !== undefined && id !== "") {
      return id;
    }

    await Bun.sleep(50);
  }

  throw new Error("the phone call never went live");
}

async function listen(
  base: string,
  id: string,
  version: number | undefined,
  done: (call: Call) => boolean,
) {
  for (let after = version; ;) {
    const call = await record(base, `${id}?after=${String(after)}`);

    if (done(call)) {
      return call;
    }

    after = call.version;
  }
}

test("a phone call's words reach the app as they're heard, and how it ended lands in its record", async () => {
  await using call = await phoneCall();
  const phone = await dialIn(call.base);
  const id = await live(call.base);
  expect(id).toBe("sess_phone");

  phone.send(JSON.stringify({ event: "media", media: { payload: "f39/fw==" } }));
  const first = CallRecord.extend({ version: z.number() }).parse(await record(call.base, id));
  expect(first).toMatchObject({ from: "phone-in", turns: [] });
  expect(first.version).toBeNumber();

  const waiting = record(call.base, `${id}?after=${String(first.version)}`);
  await Bun.sleep(100);
  call.say("you", "is the build ", 1000);
  const heard = await waiting;
  expect(heard.turns).toEqual([{ who: "you", at: 1000, text: "is the build" }]);
  expect(heard.version).toBeGreaterThan(first.version);

  call.say("you", "green?", 1300);
  call.say("voice", "One sec.", 2500);

  const later = await listen(call.base, id, heard.version, (now) =>
    now.turns.some((turn) => turn.who === "voice"),
  );

  expect(later.turns).toEqual([
    { who: "you", at: 1000, text: "is the build green?" },
    { who: "voice", at: 2500, text: "One sec." },
  ]);
  expect(await until(() => call.audio.length && call.audio)).toEqual(["f39/fw=="]);

  const ending = record(call.base, `${id}?after=${String(later.version)}`);
  phone.send(JSON.stringify({ event: "stop" }));
  const ended = await ending;
  expect(ended).toMatchObject({ id, from: "phone-in", end: "you" });
  expect(ended.ended).toBeString();
  expect(ended.version).toBeUndefined();
  expect(ended.turns).toHaveLength(2);
  expect((await calls(call.base)).live).toBeUndefined();
}, 20_000);

test("the caller talking over the voice clears what Twilio hasn't played yet, but not the words it's answering, however late they come", async () => {
  await using call = await phoneCall();
  const phone = await dialIn(call.base);
  const id = await live(call.base);
  const heard: z.infer<typeof TwilioMessage>[] = [];
  phone.addEventListener("message", ({ data }) => {
    heard.push(TwilioMessage.parse(JSON.parse(String(data))));
  });
  const clears = () => heard.filter((message) => message.event === "clear");

  const recorded = (text: string) =>
    listen(call.base, id, 0, (now) => now.turns.some((turn) => turn.text.includes(text)));

  call.speak("AAAA");
  call.speak("BBBB");
  await until(() => heard.filter((message) => message.event === "mark").length === 2);
  expect(heard.map((message) => message.event)).toEqual(["media", "mark", "media", "mark"]);
  expect(heard[0]).toEqual({ event: "media", streamSid: "MZ1", media: { payload: "AAAA" } });
  call.say("voice", "The build is green, ", 500);
  call.say("you", "is the build green?", 100);
  await recorded("is the build green?");
  expect(clears()).toEqual([]);

  call.say("you", "Mm-hmm. ", 800);
  call.say("you", " ", 900);
  call.say("you", "Yeah, okay.", 950);
  await recorded("Yeah, okay.");
  expect(clears(), "listening while it talks, or a fragment with no words, clears nothing").toEqual(
    [],
  );

  call.say("you", "wait, ", 1000);
  await until(() => clears().length);
  expect(clears()).toEqual([{ event: "clear", streamSid: "MZ1" }]);

  for (let i = 0; i < 2; i++) {
    phone.send(JSON.stringify({ event: "mark", streamSid: "MZ1", mark: { name: "voice" } }));
  }

  await Bun.sleep(100);
  call.say("you", "stop.", 1300);
  await recorded("stop.");
  expect(
    clears(),
    "Twilio handed back every mark the clear dropped, so with nothing left unplayed more words clear nothing",
  ).toHaveLength(1);
}, 20_000);

test("hex never rings while a call is live, and a call it placed that picks up once one is live, as a voicemail can, is let go", async () => {
  await using call = await phoneCall();
  expect((await call.tool("phone", { why: "a reminder" })).result).toStartWith("ringing");
  await dialIn(call.base);
  const id = await live(call.base);
  await call.renewed();
  expect((await call.tool("phone", { why: "another reminder" })).error).toContain("a call is live");
  expect(call.placed).toHaveLength(1);

  const voicemail = await pickedUp(call.base, call.firstPlaced());
  await new Promise((resolve) => {
    voicemail.addEventListener("close", resolve, { once: true });
  });

  const missed = await until(() =>
    call.steps.find(
      (step) => step.step === "deliver" && step.content?.startsWith("Your phone call") === true,
    ),
  );

  expect(missed.content).toContain("another call was live");
  expect((await calls(call.base)).live).toBe(id);
}, 20_000);

test("Call my phone moves the live call: the phone rings past the live call, and once it picks up the old call ends as moved", async () => {
  await using call = await phoneCall();
  await dialIn(call.base);
  const id = await live(call.base);
  await call.renewed();
  const moving = await fetch(`${call.base}/phone`, { method: "POST" });
  expect(await moving.text()).toStartWith(`ringing ${CALLER}`);

  const { version } = await record(call.base, id);
  await pickedUp(call.base, call.firstPlaced());
  expect(await listen(call.base, id, version, (now) => now.ended !== undefined)).toMatchObject({
    end: "you",
    reason: "moved to a new call",
  });
  expect((await calls(call.base)).live).toBe("sess_phone_2");
}, 20_000);

test("phone moves the live call only with move, and only to the caller's own phone", async () => {
  await using call = await phoneCall();
  await dialIn(call.base);
  await live(call.base);
  await call.renewed();
  expect((await call.tool("phone", { move: true, to: "+15550003333" })).error).toContain(
    "only to the caller's own phone",
  );
  expect((await call.tool("phone", { why: "a reminder" })).error).toContain("a call is live");
  expect((await call.tool("phone", { move: true })).result).toStartWith(`ringing ${CALLER}`);
  expect(call.placed).toHaveLength(1);
}, 20_000);

test("while hex is on a call it placed to someone else, a call meant for the owner waits for it to end instead of going to them", async () => {
  await using call = await phoneCall();
  expect(
    (await call.tool("phone", { to: "+15550003333", why: "book a table" })).result,
  ).toStartWith("ringing");
  await pickedUp(call.base, call.firstPlaced());
  await live(call.base);
  await call.renewed();
  const { error } = await call.tool("phone", { why: "a reminder" });
  expect(error).toContain("a call to +15550003333 is live");
  expect(error).toContain("ring again once it ends");
  expect((await call.tool("phone", { move: true })).error).toContain("on a call to +15550003333");
  expect(call.placed).toHaveLength(1);
}, 20_000);

test("notes sent while a placed call rings reach that call when it connects, and never one the caller started meanwhile", async () => {
  await using call = await phoneCall();
  await call.tool("phone", { why: "a reminder" });
  expect((await call.tool("note", { text: "for the call hex placed" })).result).toContain(
    "still ringing",
  );
  await dialIn(call.base);
  await live(call.base);
  await call.renewed();
  expect((await call.tool("note", { text: "for this call" })).result).toBe("noted");
  expect(call.told).toEqual([{ session: "sess_phone", content: "for this call" }]);
}, 20_000);

test("notes sent while a placed call rings reach the voice once it picks up", async () => {
  await using call = await phoneCall();
  await call.tool("phone", { why: "a reminder" });
  await call.tool("note", { text: "the build is green" });
  await pickedUp(call.base, call.firstPlaced());
  expect(await until(() => call.told[0])).toEqual({
    session: "sess_phone",
    content: "the build is green",
  });
}, 20_000);

test("a call's words reach the voice session only once the last call's renew is through, in order, and its end lets the session renew", async () => {
  await using call = await phoneCall();
  const phone = await dialIn(call.base);
  await live(call.base);
  await until(() => call.steps.find((step) => step.step === "renewal"));
  call.delegate("d1", 900);
  await Bun.sleep(50);
  call.say("you", "is the build green?", 1000);
  await Bun.sleep(200);
  expect(call.steps.map((step) => step.step)).toEqual(["renewal"]);
  await call.renewed();
  await until(() => call.steps.filter((step) => step.step === "deliver").length === 2);
  const [, keep, started, handoff] = call.steps;
  expect(keep?.step).toBe("keep");
  expect(started?.content).toStartWith("A call started.");

  const naming: unknown = expect.stringContaining("is the build green?");
  expect(handoff).toMatchObject({ content: naming, meta: { delegation_id: "d1" } });
  phone.send(JSON.stringify({ event: "stop" }));
  await until(() => call.steps.at(-1)?.step === "renew");
  expect(call.steps.at(-2)?.content).toStartWith("The call ended");
  expect((await record(call.base, "sess_phone")).claude).toBe("brain");
}, 20_000);

test("the app ends only the call it names: a stale screen closing its old call leaves the live one going", async () => {
  await using call = await phoneCall();
  await dialIn(call.base);
  const id = await live(call.base);

  const end = (body?: Record<string, string>) =>
    fetch(`${call.base}/session`, {
      method: "DELETE",
      body: body === undefined ? null : JSON.stringify(body),
    });

  expect((await end()).status).toBe(400);
  expect((await end({ sessionId: "sess_old" })).status).toBe(204);
  await Bun.sleep(200);
  expect((await calls(call.base)).live).toBe(id);

  const ending = record(call.base, `${id}?after=0`);
  expect((await end({ sessionId: id })).status).toBe(204);
  expect(
    await listen(call.base, id, (await ending).version, (now) => now.ended !== undefined),
  ).toMatchObject({ end: "you" });
}, 20_000);

test("a caller who hangs up before the voice session starts leaves no call behind: the session is let go, never taken as live", async () => {
  await using call = await phoneCall({ openaiHoldsEachStart: true });
  const phone = await dialIn(call.base);
  await call.starting();
  phone.close();
  await Bun.sleep(200);
  call.start();
  await Bun.sleep(300);
  expect((await calls(call.base)).live).toBeUndefined();
  expect(call.connected()).toBe(0);
  expect(
    call.steps.some(
      (step) => step.step === "deliver" && step.content?.startsWith("A call started") === true,
    ),
  ).toBe(false);
  expect(
    call.steps.some(
      (step) =>
        step.step === "deliver" &&
        step.content !== undefined &&
        /didn't happen/u.test(step.content),
    ),
  ).toBe(false);
}, 20_000);

test("a handoff no words follow still reaches the voice session, once, a moment later", async () => {
  await using call = await phoneCall();
  await dialIn(call.base);
  await live(call.base);
  await call.renewed();
  call.say("you", "is the build green?", 500);
  await Bun.sleep(100);
  call.delegate("d1", 900);
  const handoffs = () => call.steps.filter((step) => step.meta?.delegation_id === "d1");
  await until(() => handoffs().length, 6000);
  expect(handoffs()[0]?.content).toContain("is the build green?");
  call.say("voice", "One sec.", 1200);
  await Bun.sleep(300);
  expect(handoffs()).toHaveLength(1);
}, 20_000);
