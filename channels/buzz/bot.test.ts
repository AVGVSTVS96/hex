import { afterAll, afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { open } from "@hex/hub";
import { ATTACH, connect as connectSession, service, until } from "@hex/hub/testing";
import { schnorr } from "@noble/curves/secp256k1.js";
import type { ServerWebSocket, Subprocess } from "bun";
import { matchFilter } from "nostr-tools/filter";
import type { Filter } from "nostr-tools/filter";
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from "nostr-tools/pure";
import type { Event } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { z } from "zod";

import { connectRelay } from "./relay.ts";

type Peer = { challenge: string; pubkey?: string; subs: Map<string, Filter[]> };

const eventSchema = z.object({
  id: z.string(),
  pubkey: z.string(),
  created_at: z.number(),
  kind: z.number(),
  tags: z.array(z.array(z.string())),
  content: z.string(),
  sig: z.string(),
});

const strings = z.array(z.string()).exactOptional();

const filterSchema = z.object({
  ids: strings,
  authors: strings,
  kinds: z.array(z.number()).exactOptional(),
  since: z.number().exactOptional(),
  until: z.number().exactOptional(),
  limit: z.number().exactOptional(),
  search: z.string().exactOptional(),
  "#d": strings,
  "#e": strings,
  "#h": strings,
  "#p": strings,
});

const clientFrame = z.union([
  z.tuple([z.literal("AUTH"), eventSchema]),
  z.tuple([z.literal("EVENT"), eventSchema]),
  z.tuple([z.literal("REQ"), z.string()], filterSchema),
  z.tuple([z.literal("CLOSE"), z.string()]),
]);

const channelWindow = z.object({
  kinds: z.array(z.number()),
  authors: z.array(z.string()).default([]),
  "#h": strings,
  until: z.number().exactOptional(),
  before_id: z.string().exactOptional(),
  limit: z.number().exactOptional(),
});

const isReply = (event: Event) => event.tags.some((t) => t[0] === "e" && t[3] === "reply");

function fakeRelay() {
  const events: Event[] = [];
  const frames: z.output<typeof clientFrame>[] = [];
  const peers = new Set<ServerWebSocket<Peer>>();
  const downloads: string[] = [];
  const online = new Map<string, string>();
  const relayKey = generateSecretKey();

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Buzz files a reaction or deletion under the channel of the event it names, h tag or not.
  function channelOf(event: Event | undefined): string | undefined {
    const target =
      event !== undefined && [5, 7].includes(event.kind)
        ? events.find((candidate) => candidate.id === event.tags.find((t) => t[0] === "e")?.[1])
        : undefined;

    return event?.tags.find((t) => t[0] === "h")?.[1] ?? channelOf(target);
  }

  function matches({ "#h": channels, ...filter }: Filter, event: Event) {
    return (
      matchFilter(filter, event) &&
      (channels === undefined || channels.includes(channelOf(event) ?? ""))
    );
  }

  function stored(filters: Filter[]) {
    return filters.flatMap((filter) =>
      events
        .filter(
          (event) =>
            matches(filter, event) &&
            ((filter.search ?? "") === "" ||
              event.content.toLowerCase().includes((filter.search ?? "").toLowerCase())),
        )
        .toSorted((a, b) => b.created_at - a.created_at)
        .slice(0, filter.limit),
    );
  }

  async function query(request: Request) {
    const body = await request.text();

    const auth = eventSchema.parse(
      JSON.parse(
        Buffer.from(
          (request.headers.get("authorization") ?? "").replace(/^Nostr /u, ""),
          "base64",
        ).toString(),
      ),
    );

    const tag = (name: string) => auth.tags.find((t) => t[0] === name)?.[1];

    const signedFor =
      tag("u") === request.url &&
      tag("method") === "POST" &&
      tag("payload") === createHash("sha256").update(body).digest("hex");

    const authTag = z
      .array(z.string())
      .parse(JSON.parse(request.headers.get("x-auth-tag") ?? "[]"));

    if (!verifyEvent(auth) || auth.kind !== 27_235 || !signedFor || authTag[1] !== owner) {
      return new Response("bad auth", { status: 401 });
    }

    const [filter] = z.tuple([channelWindow], z.unknown()).parse(JSON.parse(body));

    if (filter.kinds[0] === 20_001) {
      return Response.json(
        filter.authors.flatMap((author) => {
          const status = online.get(author);

          return status === undefined ? [] : [signed(relayKey, 20_001, status, [["p", author]])];
        }),
      );
    }

    const channel = filter["#h"]?.[0] ?? "";

    const rows = events
      .filter(
        (event) => matchFilter({ kinds: filter.kinds, "#h": [channel] }, event) && !isReply(event),
      )
      .toSorted((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
      .filter(
        (event) =>
          filter.before_id === undefined ||
          (filter.until !== undefined &&
            (event.created_at < filter.until ||
              (event.created_at === filter.until && event.id > filter.before_id))),
      )
      .slice(0, filter.limit);

    const summaries = rows.flatMap((row) => {
      const replies = events.filter((event) =>
        event.tags.some((t) => t[0] === "e" && t[1] === row.id),
      );

      const summary = {
        reply_count: replies.length,
        descendant_count: replies.length,
        last_reply_at: Math.max(...replies.map((reply) => reply.created_at)),
      };

      return replies.length > 0
        ? [
            signed(relayKey, 39_005, JSON.stringify(summary), [
              ["e", row.id],
              ["d", row.id],
              ["h", channel],
            ]),
          ]
        : [];
    });

    return Response.json([
      ...rows,
      ...summaries,
      signed(relayKey, 39_006, '{"has_more":false,"next_cursor":null}', [
        ["d", `${channel}:head`],
        ["h", channel],
      ]),
    ]);
  }

  const server = Bun.serve<Peer>({
    port: 0,
    fetch(request, bunServer) {
      if (new URL(request.url).pathname === "/query") {
        return query(request);
      }

      if (new URL(request.url).pathname.startsWith("/media/")) {
        downloads.push(request.headers.get("authorization") ?? "");

        return new Response("pixels");
      }

      return bunServer.upgrade(request, {
        data: { challenge: crypto.randomUUID(), subs: new Map() },
      })
        ? undefined
        : new Response("relay");
    },
    websocket: {
      open(ws) {
        peers.add(ws);
        ws.send(JSON.stringify(["AUTH", ws.data.challenge]));
      },
      close(ws) {
        peers.delete(ws);
      },
      message(ws, raw) {
        const frame = clientFrame.parse(JSON.parse(String(raw)));
        frames.push(frame);

        const reply = (...message: unknown[]) => {
          ws.send(JSON.stringify(message));
        };

        if (frame[0] === "AUTH") {
          const [, event] = frame;
          const tag = (name: string) => event.tags.find((t) => t[0] === name);

          const ok =
            verifyEvent(event) &&
            event.kind === 22_242 &&
            tag("challenge")?.[1] === ws.data.challenge &&
            tag("auth")?.[1] === owner;

          if (ok) {
            ws.data.pubkey = event.pubkey;
          }

          reply("OK", event.id, ok, ok ? "" : "auth-required: bad auth");

          return;
        }

        if (ws.data.pubkey === undefined) {
          reply("CLOSED", frame[1], "auth-required: authenticate first");

          return;
        }

        if (frame[0] === "REQ") {
          const [, id, ...filters] = frame;
          ws.data.subs.set(id, filters);

          for (const event of stored(filters)) {
            reply("EVENT", id, event);
          }

          reply("EOSE", id);

          return;
        }

        if (frame[0] === "CLOSE") {
          ws.data.subs.delete(frame[1]);

          return;
        }

        const [, event] = frame;
        reply("OK", event.id, verifyEvent(event), "");
        inject(event);
      },
    },
  });

  function inject(event: Event) {
    events.push(event);

    for (const peer of peers) {
      for (const [id, filters] of peer.data.subs) {
        if (filters.some((filter) => matches(filter, event))) {
          peer.send(JSON.stringify(["EVENT", id, event]));
        }
      }
    }
  }

  return {
    url: `ws://localhost:${server.port}`,
    events,
    frames,
    downloads,
    online,
    inject,
    drop: () => {
      for (const peer of peers) {
        peer.terminate();
      }
    },
    stop: () => server.stop(true),
  };
}

const ownerKey = generateSecretKey();
const owner = getPublicKey(ownerKey);
const authTag = ["auth", owner, "", "sig"];
const clientRelay = fakeRelay();

afterAll(() => clientRelay.stop());

function signed(
  key: Uint8Array,
  kind: number,
  content: string,
  tags: string[][] = [],
  at = Math.floor(Date.now() / 1000),
) {
  return finalizeEvent({ kind, content, tags, created_at: at }, key);
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

function nth<Item>(items: Item[], index: number): Item {
  const item = items.at(index);

  if (item === undefined) {
    throw new Error(`nothing at ${index} of ${items.length}`);
  }

  return item;
}

function captured(reply: { text?: string | undefined }, pattern: RegExp): string {
  const found = pattern.exec(reply.text ?? "")?.[1];

  if (found === undefined) {
    throw new Error(`${String(pattern)} is not in ${reply.text ?? "an error"}`);
  }

  return found;
}

const inboundLine = z.object({
  type: z.literal("inbound"),
  content: z.string(),
  meta: z.record(z.string(), z.string()),
});

const inbounds = (lines: unknown[]) =>
  lines.flatMap((line) => {
    const parsed = inboundLine.safeParse(line);

    return parsed.success ? [parsed.data] : [];
  });

type HubMessage = { type: string; thread: string; busy?: boolean; to?: string };

test("the relay connection authenticates with the auth tag before it asks for anything", async () => {
  const key = generateSecretKey();
  const client = connectRelay({ url: clientRelay.url, secretKey: key, authTag });
  const event = await client.publish({ kind: 9, content: "hi", tags: [["h", "c1"]] });

  const auth = nth(
    clientRelay.frames.flatMap((frame) =>
      frame[0] === "AUTH" && frame[1].pubkey === getPublicKey(key) ? [frame[1]] : [],
    ),
    0,
  );

  expect(auth.tags).toContainEqual(authTag);
  expect(auth.tags).toContainEqual(["relay", clientRelay.url]);
  expect(clientRelay.frames.findIndex((frame) => frame[1] === auth)).toBeLessThan(
    clientRelay.frames.findIndex((frame) => frame[0] === "EVENT" && frame[1].id === event.id),
  );
  expect(event.tags).toEqual([["h", "c1"], authTag]);
  expect(event.pubkey).toBe(getPublicKey(key));
  client.close();
});

test("a refused publish rejects with the relay's reason, and a query resolves at EOSE", async () => {
  const client = connectRelay({ url: clientRelay.url, secretKey: generateSecretKey(), authTag });
  const sent = await client.publish({ kind: 9, content: "find me", tags: [["h", "c2"]] });
  expect((await client.query([{ kinds: [9], "#h": ["c2"] }])).map((event) => event.id)).toEqual([
    sent.id,
  ]);
  client.close();
  // oxlint-disable-next-line typescript/await-thenable, typescript/no-confusing-void-expression -- bun types rejects matchers as void, but they return a promise
  await expect(client.publish({ kind: 9, content: "late", tags: [] })).rejects.toThrow("closed");
});

test("after a drop it reconnects, authenticates again, resubscribes from shortly before, and delivers each event once", async () => {
  const client = connectRelay({ url: clientRelay.url, secretKey: generateSecretKey(), authTag });
  const seen: string[] = [];
  const since = Math.floor(Date.now() / 1000);
  client.subscribe([{ kinds: [9], "#h": ["c3"], since }], (event) => {
    seen.push(event.content);
  });
  clientRelay.inject(signed(ownerKey, 9, "one", [["h", "c3"]]));
  await until(() => seen.length === 1);

  const reqs = () =>
    clientRelay.frames.flatMap((frame) =>
      frame[0] === "REQ" && frame[2]?.["#h"]?.[0] === "c3" ? [frame[2]] : [],
    );

  clientRelay.drop();
  clientRelay.inject(signed(ownerKey, 9, "two", [["h", "c3"]]));
  await until(() => seen.length === 2, 5000);
  expect(reqs().length).toBe(2);
  expect(nth(reqs(), 1).since).toBeGreaterThanOrEqual(since);
  expect(seen).toEqual(["one", "two"]);
  client.close();
});

const SESSION = "0a1b2c3d-0000-4000-8000-000000000000";

const running: {
  bot: Subprocess;
  relay: ReturnType<typeof fakeRelay>;
  sockets: Socket[];
  dir: string;
}[] = [];

afterEach(() => {
  for (const { bot, relay, sockets, dir } of running.splice(0)) {
    bot.kill(9);

    for (const socket of sockets) {
      socket.destroy();
    }

    void relay.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function startBot(
  prepare?: (setup: {
    state: string;
    relay: ReturnType<typeof fakeRelay>;
    channel: string;
    me: string;
    key: Uint8Array;
  }) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), "buzz-"));
  const state = join(dir, "state");
  mkdirSync(state);
  mkdirSync(join(dir, "hex"));
  mkdirSync(join(dir, "config", "jobs", "job12345"), { recursive: true });
  writeFileSync(
    join(dir, "claude"),
    `#!/bin/sh
jq -cn '$ARGS.positional' --args -- "$@" >> "${dir}/calls"
[ "$1 $2" = "agents --json" ] && { cat "${dir}/agents" 2>/dev/null || echo '[]'; }
[ "$1" = "--bg" ] && echo "backgrounded · job12345 · test"
${ATTACH}
exit 0
`,
  );
  chmodSync(join(dir, "claude"), 0o755);

  const relay = fakeRelay();
  const key = generateSecretKey();
  const me = getPublicKey(key);

  const sig = schnorr.sign(
    createHash("sha256").update(`nostr:agent-auth:${me}:`).digest(),
    ownerKey,
  );

  const auth = ["auth", owner, "", bytesToHex(sig)];
  writeFileSync(
    join(state, ".env"),
    `BUZZ_RELAY_URL=${relay.url}\nBUZZ_PRIVATE_KEY=${bytesToHex(key)}\nBUZZ_AUTH_TAG=${JSON.stringify(auth)}\n`,
  );
  writeFileSync(join(state, "access.json"), JSON.stringify({ panels: false }));

  const channel = crypto.randomUUID();
  const openSource = crypto.randomUUID();
  const secret = crypto.randomUUID();
  const dm = crypto.randomUUID();
  const forum = crypto.randomUUID();
  const host = generateSecretKey();
  relay.inject(signed(key, 0, JSON.stringify({ name: "Hex" })));
  relay.inject(signed(ownerKey, 0, JSON.stringify({ display_name: "Bassim" })));

  for (const id of [channel, openSource, dm, forum]) {
    relay.inject(
      signed(host, 39_002, "", [
        ["d", id],
        ["p", owner],
        ["p", me],
      ]),
    );
  }

  relay.inject(
    signed(host, 39_002, "", [
      ["d", secret],
      ["p", owner],
    ]),
  );
  relay.inject(
    signed(host, 39_000, "", [
      ["d", channel],
      ["name", "general"],
      ["t", "stream"],
    ]),
  );
  relay.inject(
    signed(host, 39_000, "", [
      ["d", openSource],
      ["name", "open-source"],
      ["t", "stream"],
    ]),
  );
  relay.inject(
    signed(host, 39_000, "", [
      ["d", secret],
      ["name", "secret"],
      ["t", "stream"],
    ]),
  );
  relay.inject(signed(host, 39_000, "", [["d", dm], ["name", "dm"], ["hidden"], ["t", "dm"]]));
  relay.inject(
    signed(host, 39_000, "", [
      ["d", forum],
      ["name", "ideas"],
      ["t", "forum"],
    ]),
  );
  prepare?.({ state, relay, channel, me, key });

  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(BUZZ_|HEX_|TELEGRAM_|DISCORD_)/u.test(name)),
  );

  const { process: bot, port } = await service(join(import.meta.dir, "bot.ts"), {
    ...env,
    BUZZ_STATE_DIR: state,
    HEX_DIR: join(dir, "hex"),
    CLAUDE_CONFIG_DIR: join(dir, "config"),
    PATH: `${dir}:${process.env.PATH}`,
  });

  const sockets: Socket[] = [];
  running.push({ bot, relay, sockets, dir });
  await until(() =>
    relay.frames.some((frame) => frame[0] === "REQ" && frame[2]?.["#h"]?.includes(dm) === true),
  );

  const published = (kind: number) =>
    relay.events.filter((event) => event.kind === kind && event.pubkey === me);

  const calls = (): string[][] =>
    existsSync(join(dir, "calls"))
      ? readFileSync(join(dir, "calls"), "utf-8")
          .split("\n")
          .slice(0, -1)
          .map((line) => z.array(z.string()).parse(JSON.parse(line)))
      : [];

  async function session(thread: string) {
    writeFileSync(
      join(dir, "config", "jobs", "job12345", "state.json"),
      JSON.stringify({ state: "working", sessionId: SESSION }),
    );

    const line = await connectSession({
      stateDir: state,
      path: "/buzz",
      channel: "plugin:buzz@hex",
      thread,
      at: port,
    });

    const socket = connect(join(state, "hub.sock"));
    sockets.push(socket);
    await once(socket, "connect");

    return {
      send: (message: HubMessage) => socket.write(`${JSON.stringify(message)}\n`),
      inbound: (count: number) =>
        until(() => {
          const lines = inbounds(line.received);

          return lines.length >= count ? lines : undefined;
        }),
      call: line.call,
    };
  }

  return {
    me,
    key,
    auth,
    state,
    channel,
    openSource,
    secret,
    dm,
    forum,
    relay,
    published,
    calls,
    launches: () => calls().filter((args) => args[0] === "--bg"),
    conversation: () => {
      const file = join(
        dir,
        "config",
        "projects",
        join(dir, "hex").replaceAll(/[^a-zA-Z0-9]/gu, "-"),
        `${SESSION}.jsonl`,
      );

      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, '{"type":"user","message":{"content":"desk anchors are loose"}}\n');
      writeFileSync(
        join(dir, "agents"),
        JSON.stringify([{ sessionId: SESSION, pid: 4_194_305, status: "busy" }]),
      );

      return () => readFileSync(file, "utf-8");
    },
    session,
    say: (
      content: string,
      tags: string[][] = [],
      from = ownerKey,
      where = channel,
      at?: number,
      kind = 9,
    ) => {
      const event = signed(from, kind, content, [["h", where], ...tags], at);
      relay.inject(event);

      return event;
    },
  };
}

async function threadStarted(bot: Awaited<ReturnType<typeof startBot>>) {
  const root = bot.say("@Hex desk anchors are loose", [["p", bot.me]]);
  await until(() => bot.launches()[0]);
  const session = await bot.session(root.id);
  await session.inbound(1);

  return { root, session };
}

test("Hex goes online, and a tag in a channel starts a thread on that message, named by its first word", async () => {
  const bot = await startBot();
  expect((await until(() => bot.published(20_001)[0])).content).toBe("online");
  const root = bot.say("@Hex desk anchors are loose", [["p", bot.me]]);
  const args = await until(() => bot.launches()[0]);
  expect(args.slice(0, 5)).toEqual(["--bg", "--channels", "plugin:buzz@hex", "--name", "desk"]);
  const inbound = nth(await (await bot.session(root.id)).inbound(1), 0);
  expect(inbound.content).toBe("desk anchors are loose");
  expect(inbound.meta).toMatchObject({
    chat_id: root.id,
    message_id: root.id,
    user: "Bassim",
    user_id: owner,
    channel: "general",
    new_thread: "true",
  });
  const ack = await until(() => bot.published(7).find((event) => event.content === "👀"));
  expect(ack.tags).toEqual([["e", root.id], bot.auth]);
});

test("in a thread Hex runs no tag is needed, and other messages, strangers and its own are ignored", async () => {
  const bot = await startBot();
  const { root, session } = await threadStarted(bot);
  const inThread = [["e", root.id, "", "reply"]];
  bot.say("lunch anyone?");
  bot.say("@Hex let me in", [["p", bot.me]], generateSecretKey());
  bot.say("@Hex sneaking in", inThread, generateSecretKey());
  bot.say("my own words", inThread, bot.key);
  bot.say("the left one mostly", inThread);
  const inbound = await session.inbound(2);
  expect(inbound.map((line) => line.content)).toEqual([
    "desk anchors are loose",
    "the left one mostly",
  ]);
  expect(nth(inbound, 1).meta.new_thread).toBeUndefined();
  expect(bot.launches().length).toBe(1);
});

test("a direct message reaches the DM's own thread without a tag", async () => {
  const bot = await startBot();
  const sent = bot.say("are you there?", [], ownerKey, bot.dm);
  const args = await until(() => bot.launches()[0]);
  expect(args[args.indexOf("--name") + 1]).toBe("Bassim");
  const inbound = nth(await (await bot.session(bot.dm)).inbound(1), 0);
  expect(inbound.content).toBe("are you there?");
  expect(inbound.meta).toMatchObject({ chat_id: bot.dm, message_id: sent.id });
  expect(inbound.meta.new_thread).toBeUndefined();
});

test("a reply to one message in a thread says which, with its text; one to the thread head says nothing", async () => {
  const bot = await startBot();
  const { root, session } = await threadStarted(bot);
  const shelf = bot.say("the shelf too", [["e", root.id, "", "reply"]]);
  bot.say("both of them", [
    ["e", root.id, "", "root"],
    ["e", shelf.id, "", "reply"],
  ]);
  const inbound = await session.inbound(3);
  expect(nth(inbound, 1).meta.reply_to_message_id).toBeUndefined();
  expect(nth(inbound, 2).meta).toMatchObject({
    reply_to_message_id: shelf.id,
    reply_to_user: "Bassim",
    reply_to_text: "the shelf too",
  });
});

test("an edit reaches the thread as the edited message's new text", async () => {
  const bot = await startBot();
  const { root, session } = await threadStarted(bot);
  const typo = bot.say("the lfet one", [["e", root.id, "", "reply"]]);
  await session.inbound(2);
  bot.relay.inject(
    signed(ownerKey, 40_003, "the left one", [
      ["h", bot.channel],
      ["e", typo.id],
    ]),
  );
  const inbound = await session.inbound(3);
  expect(nth(inbound, 2).content).toBe("the left one");
  expect(nth(inbound, 2).meta).toMatchObject({ message_id: typo.id, edited: "true" });
  expect(nth(inbound, 2).meta.new_thread).toBeUndefined();
});

test("a bare tag on the owner's own message brings Hex into its thread with those words as the message", async () => {
  const bot = await startBot();
  const post = bot.say("gpt-live-1 can i use custom voices");
  bot.say("@Hex", [
    ["e", post.id, "", "reply"],
    ["p", bot.me],
  ]);
  const args = await until(() => bot.launches()[0]);
  expect(args[args.indexOf("--name") + 1]).toBe("gpt-live-1");
  const inbound = nth(await (await bot.session(post.id)).inbound(1), 0);
  expect(inbound.content).toBe("gpt-live-1 can i use custom voices");
  expect(inbound.meta).toMatchObject({
    chat_id: post.id,
    new_thread: "true",
    reply_to_message_id: post.id,
    reply_to_user: "Bassim",
    reply_to_text: "gpt-live-1 can i use custom voices",
  });
});

test("a bare tag on someone else's message keeps their words in reply_to_text only", async () => {
  const bot = await startBot();
  const post = bot.say("anyone tried custom voices?", [], generateSecretKey());
  bot.say("@Hex", [
    ["e", post.id, "", "reply"],
    ["p", bot.me],
  ]);
  const inbound = nth(await (await bot.session(post.id)).inbound(1), 0);
  expect(inbound.content).toBe("(tagged you)");
  expect(inbound.meta).toMatchObject({
    reply_to_message_id: post.id,
    reply_to_text: "anyone tried custom voices?",
  });
});

test("a reaction on a message in Hex's thread reaches it, and so does taking it back; one elsewhere doesn't", async () => {
  const bot = await startBot();
  const { session } = await threadStarted(bot);
  const sent = captured(await session.call("reply", { text: "on it" }), /id: (\w+)/u);
  bot.relay.inject(signed(ownerKey, 7, "👍", [["e", bot.say("lunch anyone?").id]]));
  const like = signed(ownerKey, 7, "👍", [["e", sent]]);
  bot.relay.inject(like);
  bot.relay.inject(signed(ownerKey, 5, "", [["e", like.id]]));
  const lines = await session.inbound(3);
  const added = nth(lines, 1);
  const removed = nth(lines, 2);
  expect(added.content).toBe("(reaction: 👍)");
  expect(added.meta).toMatchObject({
    reaction: "👍",
    reaction_to_message_id: sent,
    reaction_to_user: "me",
    reaction_to_text: "on it",
    user: "Bassim",
    channel: "general",
  });
  expect(removed.content).toBe("(reaction removed: 👍)");
  expect(removed.meta).toMatchObject({
    reaction: "👍",
    reaction_removed: "true",
    reaction_to_message_id: sent,
    reaction_to_text: "on it",
  });
  await Bun.sleep(300);
  expect((await session.inbound(3)).length).toBe(3);
});

test("a deleted message reaches its thread with what it said", async () => {
  const bot = await startBot();
  const { root, session } = await threadStarted(bot);
  const typo = bot.say("the lfet one", [["e", root.id, "", "reply"]]);
  await session.inbound(2);
  bot.relay.inject(
    signed(ownerKey, 5, "", [
      ["h", bot.channel],
      ["e", typo.id],
    ]),
  );
  const inbound = await session.inbound(3);
  expect(nth(inbound, 2).content).toBe("(deleted a message)");
  expect(nth(inbound, 2).meta).toMatchObject({
    deleted: "true",
    message_id: typo.id,
    deleted_text: "the lfet one",
    chat_id: root.id,
  });
});

test("after a restart Hex picks up what was sent while it was down, in order, and nothing twice", async () => {
  const t = Math.floor(Date.now() / 1000) - 100;
  let root!: Event;

  const bot = await startBot(({ state, relay, channel, me }) => {
    const at = (offset: number, content: string, tags: string[][]) => {
      const event = signed(ownerKey, 9, content, [["h", channel], ...tags], t + offset);
      relay.inject(event);

      return event;
    };

    root = at(0, "@Hex desk anchors are loose", [["p", me]]);
    open(join(dirname(state), "hex", "state")).threads.keep("buzz", {
      [root.id]: { name: "Anchors" },
    });
    writeFileSync(join(state, "cursor.json"), JSON.stringify({ at: t, ids: [root.id] }));
    at(9, "three", [["e", root.id, "", "reply"]]);
    at(0, "one", [["e", root.id, "", "reply"]]);
    at(5, "two", [["e", root.id, "", "reply"]]);
  });

  const session = await bot.session(root.id);
  expect((await session.inbound(3)).map((line) => line.content)).toEqual(["one", "two", "three"]);
  await Bun.sleep(300);
  expect((await session.inbound(3)).length).toBe(3);
});

test("reply posts into the thread with NIP-10 markers, a p tag for the owner and the auth tag", async () => {
  const bot = await startBot();
  const { root, session } = await threadStarted(bot);
  const later = bot.say("and the shelf", [["e", root.id, "", "reply"]]);
  await session.inbound(2);

  const sentBy = (reply: { text?: string | undefined }) => {
    const id = captured(reply, /^sent \(id: ([0-9a-f]{64})\)$/u);

    return nth(
      bot.relay.events.filter((event) => event.id === id),
      0,
    );
  };

  const direct = sentBy(await session.call("reply", { text: "on it" }));
  expect(direct).toMatchObject({
    kind: 9,
    content: "on it",
    tags: [["h", bot.channel], ["e", root.id, "", "reply"], ["p", owner], bot.auth],
  });
  const nested = sentBy(await session.call("reply", { text: "that one too", reply_to: later.id }));
  expect(nested.tags).toEqual([
    ["h", bot.channel],
    ["e", root.id, "", "root"],
    ["e", later.id, "", "reply"],
    ["p", owner],
    bot.auth,
  ]);
});

test("an edit keeps the message's attachments, since Desktop shows the edit's in their place", async () => {
  const bot = await startBot();
  const { root, session } = await threadStarted(bot);
  const url = `http://localhost/media/${"a".repeat(64)}.png`;
  const imeta = ["imeta", `url ${url}`, "m image/png", `x ${"a".repeat(64)}`, "size 10"];

  const original = bot.say(
    `here it is\n![image](${url})`,
    [["e", root.id, "", "reply"], imeta],
    bot.key,
  );

  const result = await session.call("edit_message", {
    message_id: original.id,
    text: "here it is, fixed",
  });

  const editId = captured(result, /^edited \(id: (\w+)\)$/u);
  const edit = bot.relay.events.find((event) => event.id === editId);

  expect(edit).toMatchObject({
    kind: 40_003,
    content: `here it is, fixed\n![image](${url})`,
    tags: [["h", bot.channel], ["e", original.id], imeta, bot.auth],
  });
});

test("a busy thread shows typing, and going idle takes back the acks", async () => {
  const bot = await startBot();
  const { root, session } = await threadStarted(bot);
  await until(() => bot.published(7).find((event) => event.content === "💬"));
  session.send({ type: "state", thread: root.id, busy: false });

  const acks = bot
    .published(7)
    .map((event) => event.id)
    .toSorted();

  await until(() => bot.published(5).length === acks.length);
  expect(
    bot
      .published(5)
      .map((event) => event.tags[0]?.[1] ?? "")
      .toSorted(),
  ).toEqual(acks);
  const before = bot.published(20_002).length;
  session.send({ type: "state", thread: root.id, busy: true });
  const typing = await until(() => bot.published(20_002)[before]);
  expect(typing.content).toBe("");
  expect(typing.tags).toEqual([["h", bot.channel], ["e", root.id, "", "reply"], bot.auth]);
});

test("!cancel from the owner interrupts the thread's turn and leaves its session running", async () => {
  const bot = await startBot();
  const { root, session } = await threadStarted(bot);
  const transcript = bot.conversation();
  session.send({ type: "state", thread: root.id, busy: true });
  bot.say("!cancel", [
    ["e", root.id, "", "reply"],
    ["p", bot.me],
  ]);
  await until(() => transcript().includes("[Request interrupted by user"));
  expect(bot.calls().some((args) => args[0] === "stop")).toBe(false);
  expect((await session.inbound(1)).length).toBe(1);
});

test("!shutdown from the owner takes Hex offline, and nothing reaches it after", async () => {
  const bot = await startBot();
  bot.say("!shutdown", [["p", bot.me]]);
  expect(
    (await until(() => bot.published(20_001).find((event) => event.content === "offline"))).content,
  ).toBe("offline");
  bot.say("@Hex still there?", [["p", bot.me]]);
  await Bun.sleep(300);
  expect(bot.launches()).toEqual([]);
  expect(bot.published(7)).toEqual([]);
});

test("new_thread opens a thread in Buzz with its about line under the title, starts its session with the prompt, and links to it", async () => {
  const bot = await startBot();
  const { session } = await threadStarted(bot);

  const result = await session.call("new_thread", {
    title: "Anchors",
    prompt: "find better anchors",
    about: "From #general",
  });

  const root = await until(() =>
    bot.published(9).find((event) => event.content === "**Anchors**\nFrom #general"),
  );

  expect(root.tags).toEqual([["h", bot.channel], ["p", owner], bot.auth]);
  expect(result.text).toBe(
    `started thread "Anchors": buzz://message?channel=${bot.channel}&id=${root.id}`,
  );
  const args = await until(() => bot.launches()[1]);
  expect(args[args.indexOf("--name") + 1]).toBe("Anchors");
  expect(args.at(-1)).toBe("find better anchors");
});

test("a mirror backfills the new thread with the chat, the owner's lines quoted under their name", async () => {
  const bot = await startBot();
  const { root, session } = await threadStarted(bot);
  const store = open(join(bot.state, "..", "hex", "state"));
  store.messages.deliver(
    {
      key: "telegram:1",
      to: root.id,
      from: "telegram",
      author: "owner",
      body: "how full is\nyour context?",
    },
    SESSION,
  );
  store.messages.deliver(
    { key: "telegram:2", to: root.id, from: "telegram", author: "hex", body: "Roomy." },
    SESSION,
  );
  session.send({ type: "mirror", thread: root.id, to: "buzz" });
  const head = await until(() => bot.published(9).find((event) => event.content === "**desk**"));

  const posts = await until(() => {
    const replies = bot
      .published(9)
      .filter((event) => event.tags.some(([tag, id]) => tag === "e" && id === head.id));

    return replies.at(-1)?.content === "Roomy." ? replies.slice(-2) : undefined;
  });

  expect(posts.map((event) => event.content)).toEqual([
    "> **Bassim**\n> how full is\n> your context?",
    "Roomy.",
  ]);
  expect(nth(posts, 0).tags).toEqual([
    ["h", bot.channel],
    ["e", head.id, "", "reply"],
    ["p", owner],
    bot.auth,
  ]);
});

test("reply with buttons lists them numbered and reacts with each keycap; the first tap arrives as a button, the other keycaps come off, later taps are ignored", async () => {
  const bot = await startBot();
  const { session } = await threadStarted(bot);
  expect(
    (
      await session.call("reply", {
        text: "pick one",
        buttons: Array.from({ length: 11 }, (_, i) => `${i}`),
      })
    ).error,
  ).toBe("at most 10 buttons");

  const id = captured(
    await session.call("reply", { text: "Ship it?", buttons: ["Yes", "No"] }),
    /id: (\w+)/u,
  );

  expect(bot.relay.events.find((event) => event.id === id)?.content).toBe(
    "Ship it?\n\n1️⃣ Yes\n2️⃣ No",
  );
  const keycaps = bot.published(7).filter((event) => event.tags[0]?.[1] === id);
  expect(keycaps.map((event) => event.content)).toEqual(["1️⃣", "2️⃣"]);
  bot.relay.inject(signed(ownerKey, 7, "2\u20E3", [["e", id]]));
  const tapped = nth(await session.inbound(2), 1);
  expect(tapped.content).toBe("No");
  expect(tapped.meta).toMatchObject({
    button: "true",
    button_message_id: id,
    user: "Bassim",
    channel: "general",
  });
  expect(
    await until(() => bot.published(5).find((event) => event.tags[0]?.[1] === nth(keycaps, 0).id)),
  ).toBeTruthy();
  expect(bot.published(5).some((event) => event.tags[0]?.[1] === nth(keycaps, 1).id)).toBe(false);
  bot.relay.inject(signed(ownerKey, 7, "1️⃣", [["e", id]]));
  bot.relay.inject(signed(ownerKey, 7, "👍", [["e", id]]));
  const inbound = await session.inbound(3);
  expect(nth(inbound, 2).content).toBe("(reaction: 👍)");
  await Bun.sleep(300);
  expect((await session.inbound(3)).length).toBe(3);
});

test("a tap on buttons sent before a restart still arrives as a button", async () => {
  const at = Math.floor(Date.now() / 1000) - 100;
  let question!: Event;
  let yes!: Event;

  const bot = await startBot(({ state, relay, channel, me, key }) => {
    const root = signed(
      ownerKey,
      9,
      "@Hex ship it?",
      [
        ["h", channel],
        ["p", me],
      ],
      at,
    );

    question = signed(
      key,
      9,
      "Ship it?\n\n1️⃣ Yes\n2️⃣ No",
      [
        ["h", channel],
        ["e", root.id, "", "reply"],
      ],
      at,
    );
    yes = signed(key, 7, "1️⃣", [["e", question.id]], at);
    const no = signed(key, 7, "2️⃣", [["e", question.id]], at);

    for (const event of [root, question, yes, no]) {
      relay.inject(event);
    }

    open(join(dirname(state), "hex", "state")).threads.keep("buzz", {
      [root.id]: { name: "Ship it" },
    });
    writeFileSync(
      join(state, "buttons.json"),
      JSON.stringify({
        [question.id]: {
          thread: root.id,
          choices: [
            { label: "Yes", reaction: yes.id },
            { label: "No", reaction: no.id },
          ],
        },
      }),
    );
  });

  bot.relay.inject(signed(ownerKey, 7, "2️⃣", [["e", question.id]]));
  const tapped = nth(await (await bot.session(question.tags[1]?.[1] ?? "")).inbound(1), 0);
  expect(tapped).toMatchObject({
    content: "No",
    meta: { button: "true", button_message_id: question.id },
  });
  expect(
    await until(() => bot.published(5).find((event) => event.tags[0]?.[1] === yes.id)),
  ).toBeTruthy();
});

test("rename_thread renames a thread Hex opened in Buzz too, by editing its first message", async () => {
  const bot = await startBot();
  const { session } = await threadStarted(bot);
  await session.call("rename_thread", { title: "Loose" });
  expect(bot.published(40_003)).toEqual([]);
  await session.call("new_thread", {
    title: "Anchors",
    prompt: "find better anchors",
    about: "",
  });
  const root = await until(() => bot.published(9).find((event) => event.content === "**Anchors**"));
  const opened = await bot.session(root.id);
  expect((await opened.call("rename_thread", { title: "Mounts" })).text).toBe(
    'renamed to "Mounts", and its first message in Buzz now says so',
  );
  expect(bot.published(40_003).map((event) => [event.content, event.tags])).toEqual([
    ["**Mounts**", [["h", bot.channel], ["e", root.id], bot.auth]],
  ]);
});

test("delete_message and react with remove take back what Hex posted, and nothing of anyone else's", async () => {
  const bot = await startBot();
  const { root, session } = await threadStarted(bot);
  const sent = captured(await session.call("reply", { text: "on it" }), /id: (\w+)/u);
  await session.call("react", { message_id: root.id, emoji: "✅" });

  const check = nth(
    bot.published(7).filter((event) => event.content === "✅"),
    0,
  );

  expect(
    (await session.call("react", { message_id: root.id, emoji: "✅", remove: true })).text,
  ).toBe("reaction removed");
  expect(
    (await session.call("react", { message_id: root.id, emoji: "🎉", remove: true })).error,
  ).toBe("the bot hasn't reacted 🎉 to that message");
  expect((await session.call("delete_message", { message_id: sent })).text).toBe("deleted");
  expect((await session.call("delete_message", { message_id: root.id })).error).toBe(
    "only the bot's own messages can be deleted",
  );

  const deletions = bot
    .published(5)
    .map((event) => event.tags)
    .filter((tags) => tags.some((t) => t[1] === check.id || t[1] === sent));

  expect(deletions).toEqual([
    [["e", check.id], bot.auth],
    [["h", bot.channel], ["e", sent], bot.auth],
  ]);
});

test("canvas reads the channel's canvas and saves new revisions ahead of the one it read", async () => {
  const bot = await startBot();
  const { session } = await threadStarted(bot);
  expect((await session.call("canvas", {})).text).toBe("(this channel has no canvas yet)");
  const first = captured(await session.call("canvas", { text: "# Plan" }), /revision: (\w+)/u);
  expect((await session.call("canvas", {})).text).toBe(`# Plan\n\n(revision: ${first})`);
  await session.call("canvas", { text: "# Plan\n- anchors", revision: first });
  const v1 = nth(bot.published(40_100), 0);
  const v2 = nth(bot.published(40_100), 1);
  expect(v1.tags).toEqual([["h", bot.channel], bot.auth]);
  expect(v2.tags).toEqual([["h", bot.channel], ["expected-revision", first], bot.auth]);
  expect(v2.created_at).toBeGreaterThan(v1.created_at);
  expect((await session.call("canvas", { channel: "open-source" })).text).toBe(
    "(this channel has no canvas yet)",
  );
  expect((await session.call("canvas", { channel: "secret" })).error).toBe(
    "Hex is in no channel named #secret",
  );
});

test("presence says whether the owner is online, away or offline", async () => {
  const bot = await startBot();
  const { session } = await threadStarted(bot);
  bot.relay.online.set(owner, "away");
  expect((await session.call("presence", {})).text).toBe("Bassim: away");
  bot.relay.online.delete(owner);
  expect((await session.call("presence", {})).text).toBe("Bassim: offline");
});

test("download_attachment saves a message's files to the inbox, fetched with Blossom auth", async () => {
  const bot = await startBot();
  const { root, session } = await threadStarted(bot);
  const url = `${bot.relay.url.replace(/^ws/u, "http")}/media/${"b".repeat(64)}.png`;

  const sent = bot.say("a picture", [
    ["e", root.id, "", "reply"],
    ["imeta", `url ${url}`, "m image/png", "size 6", "filename desk.png"],
  ]);

  const result = await session.call("download_attachment", { message_id: sent.id });
  const path = captured(result, /^ {2}(\S+) {2}\(desk\.png, image\/png, 0KB\)$/mu);
  expect(readFileSync(path, "utf-8")).toBe("pixels");
  // oxlint-disable-next-line typescript/no-unsafe-argument -- bun types its asymmetric matchers as any
  expect(bot.relay.downloads).toEqual([expect.stringMatching(/^Nostr /u)]);
});

function seedOpenSource(bot: Awaited<ReturnType<typeof startBot>>) {
  const t = Math.floor(Date.now() / 1000) - 100;

  const at = (offset: number, content: string, tags: string[][] = []) =>
    bot.say(content, tags, ownerKey, bot.openSource, t + offset);

  const ci = at(0, "flaky CI on the relay PR");
  const docs = at(1, "merged the docs fix");
  const rebased = at(2, "rebased it", [["e", ci.id, "", "reply"]]);
  const pushed = at(3, "rebased again\nand pushed", [["e", ci.id, "", "reply"]]);
  const release = at(4, "release tomorrow");

  return { t, ci, docs, rebased, pushed, release };
}

test("fetch_messages reads a channel's top-level messages oldest-first, with each thread's replies, and pages back", async () => {
  const bot = await startBot();
  const { session } = await threadStarted(bot);
  const { t, ci, docs, release } = seedOpenSource(bot);
  const page = await session.call("fetch_messages", { channel: "#open-source", limit: 2 });
  expect(page.text).toBe(
    [
      `[${iso(t + 1)}] Bassim: merged the docs fix  (id: ${docs.id})`,
      `[${iso(t + 4)}] Bassim: release tomorrow  (id: ${release.id})`,
    ].join("\n"),
  );
  const older = await session.call("fetch_messages", { channel: bot.openSource, before: docs.id });
  expect(older.text).toBe(
    `[${iso(t)}] Bassim: flaky CI on the relay PR  (id: ${ci.id}, 2 replies, last reply ${iso(t + 3)})`,
  );
});

test("fetch_messages drills into any thread in a channel by its message id, and pages back through it", async () => {
  const bot = await startBot();
  const { session } = await threadStarted(bot);
  const { t, ci, rebased, pushed } = seedOpenSource(bot);
  const thread = await session.call("fetch_messages", { thread: ci.id });
  expect(thread.text).toBe(
    [
      `[${iso(t)}] Bassim: flaky CI on the relay PR  (id: ${ci.id})`,
      `[${iso(t + 2)}] Bassim: rebased it  (id: ${rebased.id})`,
      `[${iso(t + 3)}] Bassim: rebased again ⏎ and pushed  (id: ${pushed.id})`,
    ].join("\n"),
  );
  const back = await session.call("fetch_messages", { thread: ci.id, before: pushed.id, limit: 1 });
  expect(back.text).toBe(`[${iso(t + 2)}] Bassim: rebased it  (id: ${rebased.id})`);
});

test("sessions read only channels Hex is in, and no direct message but their own", async () => {
  const bot = await startBot();
  const { session } = await threadStarted(bot);
  const hidden = bot.say("secret plans", [], ownerKey, bot.secret);
  bot.say("just between us", [], ownerKey, bot.dm);
  expect((await session.call("fetch_messages", { channel: "secret" })).error).toBe(
    "Hex is in no channel named #secret",
  );
  expect((await session.call("fetch_messages", { channel: bot.secret })).error).toBe(
    `Hex is in no channel named #${bot.secret}`,
  );
  expect((await session.call("fetch_messages", { thread: hidden.id })).error).toBe(
    "Hex isn't in that channel; list_channels shows the ones it is in",
  );
  expect((await session.call("fetch_messages", { channel: bot.dm })).error).toBe(
    "that is a direct message with someone else",
  );
  expect(
    (await session.call("search_messages", { query: "secret", channel: "secret" })).error,
  ).toBe("Hex is in no channel named #secret");
  const own = await bot.session(bot.dm);
  expect((await own.call("fetch_messages", { channel: bot.dm })).text).toContain(
    "Bassim: just between us",
  );
});

test("search_messages finds words in Hex's channels, naming each hit's channel and thread, and nothing it can't read", async () => {
  const bot = await startBot();
  const { root, session } = await threadStarted(bot);
  const { ci } = seedOpenSource(bot);
  const reply = bot.say("the flaky test is back", [["e", root.id, "", "reply"]]);
  bot.say("flaky secrets", [], ownerKey, bot.secret);
  bot.say("flaky in private", [], ownerKey, bot.dm);
  const hits = ((await session.call("search_messages", { query: "FLAKY" })).text ?? "").split("\n");
  // oxlint-disable-next-line typescript/no-unsafe-argument -- bun types its asymmetric matchers as any
  expect(hits).toEqual([
    expect.stringMatching(
      new RegExp(
        `Bassim: the flaky test is back  \\(id: ${reply.id}, in #general, thread ${root.id}\\)$`,
        "u",
      ),
    ),
    expect.stringMatching(
      new RegExp(`Bassim: flaky CI on the relay PR  \\(id: ${ci.id}, in #open-source\\)$`, "u"),
    ),
  ]);
  const scoped = await session.call("search_messages", { query: "flaky", channel: "open-source" });
  expect(scoped.text).toContain(ci.id);
  expect(scoped.text).not.toContain(reply.id);
});

test("a forum post that tags Hex is its own thread: comments on it reach the session, edits and deletes too, and replies post as comments", async () => {
  const bot = await startBot();

  const posted = (content: string, tags: string[][] = []) =>
    bot.say(content, tags, ownerKey, bot.forum, undefined, 45_001);

  const comment = (content: string, tags: string[][] = []) =>
    bot.say(content, tags, ownerKey, bot.forum, undefined, 45_003);

  posted("nobody asked hex here");
  const post = posted("@Hex should we ship the relay PR", [["p", bot.me]]);
  const args = await until(() => bot.launches()[0]);
  expect(args[args.indexOf("--name") + 1]).toBe("should");
  const session = await bot.session(post.id);
  const first = comment("the CI is green now", [["e", post.id, "", "reply"]]);
  bot.relay.inject(
    signed(ownerKey, 40_003, "the CI is finally green", [
      ["h", bot.forum],
      ["e", first.id],
    ]),
  );
  bot.relay.inject(
    signed(ownerKey, 5, "", [
      ["h", bot.forum],
      ["e", first.id],
    ]),
  );
  const inbound = await session.inbound(4);
  expect(inbound.map((line) => line.content)).toEqual([
    "should we ship the relay PR",
    "the CI is green now",
    "the CI is finally green",
    "(deleted a message)",
  ]);
  expect(nth(inbound, 0).meta).toMatchObject({
    chat_id: post.id,
    message_id: post.id,
    channel: "ideas",
    new_thread: "true",
  });
  expect(nth(inbound, 2).meta).toMatchObject({ message_id: first.id, edited: "true" });
  expect(nth(inbound, 3).meta).toMatchObject({
    deleted: "true",
    message_id: first.id,
    deleted_text: "the CI is finally green",
  });
  const sent = captured(await session.call("reply", { text: "ship it" }), /id: (\w+)/u);
  expect(bot.relay.events.find((event) => event.id === sent)).toMatchObject({
    kind: 45_003,
    tags: [["h", bot.forum], ["e", post.id, "", "reply"], ["p", owner], bot.auth],
  });
  await session.call("new_thread", {
    title: "Notes",
    prompt: "draft them",
    about: "",
    channel: "ideas",
  });
  expect(
    await until(() => bot.relay.events.find((event) => event.content === "**Notes**")),
  ).toMatchObject({ kind: 45_001, tags: [["h", bot.forum], ["p", owner], bot.auth] });
  await until(() => bot.launches().length === 2);
});

test("list_channels names the channels Hex is in, and marks direct messages", async () => {
  const bot = await startBot();
  const { session } = await threadStarted(bot);
  const lines = ((await session.call("list_channels", {})).text ?? "").split("\n").toSorted();
  expect(lines).toEqual(
    [
      `#general  (id: ${bot.channel})`,
      `#open-source  (id: ${bot.openSource})`,
      `dm  (id: ${bot.dm}, direct message)`,
      `#ideas  (id: ${bot.forum})`,
    ].toSorted(),
  );
});

test("create_channel makes a channel Hex owns, adds the owner, and new_thread can open threads in it", async () => {
  const bot = await startBot();
  const { session } = await threadStarted(bot);

  const reply = await session.call("create_channel", {
    name: "#research",
    about: "papers",
    type: "forum",
  });

  const created = reply.text;
  const id = captured(reply, /id: ([\w-]+)/u);
  expect(created).toBe(`created #research (id: ${id}); new_thread can open threads in it`);
  expect(nth(bot.published(9007), 0).tags).toEqual([
    ["h", id],
    ["name", "research"],
    ["visibility", "open"],
    ["channel_type", "forum"],
    ["about", "papers"],
    bot.auth,
  ]);
  expect(nth(bot.published(9000), 0).tags).toEqual([["h", id], ["p", owner], bot.auth]);
  expect((await session.call("list_channels", {})).text).toContain(`#research  (id: ${id})`);
  await session.call("new_thread", {
    title: "Reading",
    prompt: "gather them",
    about: "",
    channel: "research",
  });
  expect(
    await until(() => bot.relay.events.find((event) => event.content === "**Reading**")),
  ).toMatchObject({ kind: 45_001, tags: [["h", id], ["p", owner], bot.auth] });
});

test("the channel of every thread is kept in channels.json for the voice app: threads it starts, threads it joins, and threads it already had", async () => {
  let known!: Event;

  const bot = await startBot(({ state, relay, channel }) => {
    known = signed(
      ownerKey,
      9,
      "an old thread",
      [["h", channel]],
      Math.floor(Date.now() / 1000) - 3600,
    );
    relay.inject(known);
    open(join(dirname(state), "hex", "state")).threads.keep("buzz", {
      [known.id]: { name: "Old" },
      [crypto.randomUUID()]: { name: "bassim" },
    });
  });

  const channels = () =>
    z
      .record(z.string(), z.string())
      .parse(
        JSON.parse(
          existsSync(join(bot.state, "channels.json"))
            ? readFileSync(join(bot.state, "channels.json"), "utf-8")
            : "{}",
        ),
      );

  await until(() => channels()[known.id] === bot.channel);
  const { root, session } = await threadStarted(bot);
  await until(() => channels()[root.id] === bot.channel);
  await session.call("new_thread", {
    title: "Anchors",
    prompt: "find better anchors",
    about: "",
  });

  const opened = await until(() =>
    bot.published(9).find((event) => event.content === "**Anchors**"),
  );

  await until(() => channels()[opened.id] === bot.channel);
  expect(Object.keys(channels()).toSorted()).toEqual([known.id, root.id, opened.id].toSorted());
});
