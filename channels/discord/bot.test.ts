import { afterAll, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as discord from "discord.js";
import { z } from "zod";

import { clients } from "../../hub/hub.ts";
import type { Hub } from "../../hub/hub.ts";
import { open } from "../../hub/store.ts";
import { connect, noClaude } from "../../hub/testing.ts";
import { until } from "../../hub/until.ts";

const {
  ButtonStyle,
  ChannelType,
  Collection,
  ComponentType,
  MessageFlags,
  MessageFlagsBitField,
  MessageType,
  SnowflakeUtil,
} = discord;

const TRANSCRIBER = "http://transcriber/v1/audio/transcriptions";
const BOT = "1000";
const OWNER = "2000";
const GUILD = "3000";
const at = (minute: number) => new Date(Date.UTC(2026, 9, 5, 12, minute));
const snowflake = (minute: number) => SnowflakeUtil.generate({ timestamp: at(minute) }).toString();

type Component = {
  type: number;
  label?: string;
  custom_id?: string;
  style?: number;
  disabled?: boolean;
  min_values?: number;
  max_values?: number;
  options?: { label: string; value: string; default?: boolean }[];
};

type Row = { type: number; components: Component[] };

type Built = { toJSON: () => Row };

type Sent = {
  content?: string;
  flags?: number;
  files?: string[];
  attachments?: never[];
  components?: Built[];
};

type Done = {
  send?: Sent;
  in?: string;
  edit?: string;
  options?: Sent;
  create?: string;
  message?: string;
  appliedTags?: string[];
  react?: string;
  on?: string;
  pin?: string;
  unpin?: string;
  unreact?: string;
  forward?: string;
  to?: string;
  delete?: string;
  get?: string;
  query?: string;
};

type Author = {
  id: string;
  username: string;
  bot?: boolean;
  partial?: boolean;
  displayName?: string;
  displayAvatarURL?: () => string;
};

type FakeAttachment = { id: string; name: string; url: string; contentType: string; size: number };

type FakePoll = {
  question: { text: string };
  answers: discord.Collection<number, { text: string }>;
  allowMultiselect?: boolean;
};

type FakeMessage = {
  id: string;
  content: string;
  createdAt: Date;
  author: Author;
  channel: FakeChannel;
  channelId: string;
  flags: discord.MessageFlagsBitField;
  attachments: discord.Collection<string, FakeAttachment>;
  messageSnapshots: discord.Collection<string, object>;
  components: Row[];
  stickers: discord.Collection<string, { name: string; url: string }>;
  poll: FakePoll | null;
  thread: FakeChannel | null;
  reactions: {
    cache: discord.Collection<string, { me: boolean; users: { remove: () => Promise<unknown> } }>;
  };
  react: (emoji: string) => Promise<unknown>;
  pin: () => Promise<unknown>;
  unpin: () => Promise<unknown>;
  edit: (options: Sent) => Promise<FakeMessage>;
  forward: (to: string) => Promise<{ id: string }>;
  delete: () => Promise<void>;
  type?: discord.MessageType;
  reference?: { messageId: string };
  fetchReference?: () => Promise<FakeMessage>;
  inGuild?: () => boolean;
  mentions?: { has: () => boolean };
  startThread?: () => Promise<FakeChannel>;
};

type HookPost = {
  content: string;
  threadId: string;
  username: string;
  avatarURL: string;
  allowedMentions: { parse: never[] };
};

type Query = { limit: number; before?: string; after?: string };

type FakeChannel = {
  id: string;
  name: string;
  type: discord.ChannelType;
  guildId: string | undefined;
  visible: boolean;
  archived: boolean;
  archiveTimestamp?: number;
  parent: FakeChannel | null;
  parentId?: string;
  messageCount?: number;
  lastMessageId?: string;
  ownerId?: string;
  availableTags?: { id: string; name: string }[];
  guild?: { members: { me: { displayName: string } } };
  setArchived?: () => Promise<void>;
  fetchWebhooks?: () => Promise<discord.Collection<string, object>>;
  createWebhook?: (options: { name: string }) => Promise<object>;
  isThread: () => boolean;
  isThreadOnly: () => boolean;
  isDMBased: () => boolean;
  permissionsFor: () => { has: () => boolean };
  sendTyping: () => Promise<void>;
  send: (input: string | Sent) => Promise<FakeMessage>;
  fetchStarterMessage: () => Promise<FakeMessage>;
  posted: FakeMessage[];
  messages: {
    fetch: (
      query: string | Query,
    ) => Promise<FakeMessage | discord.Collection<string, FakeMessage>>;
    edit: (message: string, options: Sent) => Promise<FakeMessage | undefined>;
  };
  threads: {
    create: (options: {
      name: string;
      message?: { content: string };
      appliedTags?: string[];
    }) => Promise<FakeChannel>;
    fetchActive: () => Promise<{ threads: discord.Collection<string, FakeChannel> }>;
    fetchArchived: (options?: {
      before?: number;
      limit?: number;
    }) => Promise<{ threads: discord.Collection<string, FakeChannel>; hasMore: boolean }>;
  };
};

const channels = new Map<string, FakeChannel>();
const handlers = new Map<string, (...args: unknown[]) => void>();
const owner: Author = { id: OWNER, username: "bassim", bot: false, partial: false };
const bot: Author = { id: BOT, username: "hex", bot: true };
const done: Done[] = [];
let found: object = {};
let sent = 0;
let opened = 0;
let logins = 0;

function emit(event: string, ...args: unknown[]) {
  const handler = handlers.get(event);

  if (!handler) {
    throw new Error(`the bot doesn't listen for ${event}`);
  }

  handler(...args);
}

function nth<T>(items: T[], index: number): T {
  const item = items[index < 0 ? items.length + index : index];

  if (item === undefined) {
    throw new Error(`there's no item ${index}`);
  }

  return item;
}

function named(name: string): FakeChannel {
  const ch = [...channels.values()].find((each) => each.name === name);

  if (!ch) {
    throw new Error(`no channel named ${name}`);
  }

  return ch;
}

const lastPosted = (ch: FakeChannel) => nth(ch.posted, -1);

const newestFirst = (a: FakeMessage, b: FakeMessage) => Number(BigInt(b.id) - BigInt(a.id));

// A guild channel or thread whose messages the fake REST answers newest-first, as Discord does.
function channel(
  id: string,
  fields: Partial<FakeChannel> & Pick<FakeChannel, "name" | "type">,
): FakeChannel {
  const messages: FakeMessage[] = [];

  const ch: FakeChannel = {
    id,
    guildId: GUILD,
    visible: true,
    archived: false,
    parent: null,
    isThread: () =>
      ch.type === ChannelType.PublicThread || ch.type === ChannelType.AnnouncementThread,
    isThreadOnly: () => ch.type === ChannelType.GuildForum,
    isDMBased: () => ch.type === ChannelType.DM,
    permissionsFor: () => ({ has: () => ch.visible }),
    sendTyping: () => Promise.resolve(),
    send: (input: string | Sent) => {
      const options = typeof input === "string" ? { content: input } : input;
      done.push({ send: options, in: id });

      return Promise.resolve(
        say(ch, 59, options.content ?? "", {
          id: String(BigInt(snowflake(59)) + BigInt(++sent)),
          author: bot,
          components: options.components?.map((row) => row.toJSON()) ?? [],
        }),
      );
    },
    fetchStarterMessage: async () => {
      const { parent } = ch;

      if (!parent) {
        throw new Error(`${id} hangs off no channel`);
      }

      const holder = parent.isThreadOnly() ? ch : parent;

      return await message(holder, id);
    },
    posted: messages,
    messages: {
      fetch: async (query: string | Query) => {
        if (typeof query === "string") {
          return await message(ch, query);
        }

        const { limit, before, after } = query;

        const page =
          after === undefined
            ? messages
                .filter((m) => before === undefined || BigInt(m.id) < BigInt(before))
                .toSorted(newestFirst)
                .slice(0, limit)
            : messages
                .filter((m) => BigInt(m.id) > BigInt(after))
                .toSorted(newestFirst)
                .slice(-limit);

        return new Collection(page.map((m) => [m.id, m]));
      },
      edit: (edited: string, options: Sent) => {
        done.push({ edit: edited, options });

        return Promise.resolve(messages.find((m) => m.id === edited));
      },
    },
    threads: {
      create: ({ name, message: starter, appliedTags }) => {
        done.push({
          create: name,
          in: id,
          ...(starter && { message: starter.content }),
          ...(appliedTags && { appliedTags }),
        });

        return Promise.resolve(
          channel(String(9000 + ++opened), {
            name,
            type: ChannelType.PublicThread,
            parent: ch,
            parentId: id,
          }),
        );
      },
      fetchActive: () =>
        Promise.resolve({
          threads: new Collection([...channels].filter(([, c]) => c.parent === ch && !c.archived)),
        }),
      // Newest-archived first, as Discord lists them, two to a page so a test can reach the second.
      fetchArchived: ({ before, limit = 50 } = {}) => {
        const shelf = [...channels.values()]
          .filter(
            (c) =>
              c.parent === ch &&
              c.archived &&
              (before === undefined || (c.archiveTimestamp ?? 0) < before),
          )
          .toSorted((a, b) => (b.archiveTimestamp ?? 0) - (a.archiveTimestamp ?? 0));

        const page = shelf.slice(0, Math.min(limit, 2));

        return Promise.resolve({
          threads: new Collection(page.map((c) => [c.id, c])),
          hasMore: shelf.length > page.length,
        });
      },
    },
    ...fields,
  };

  channels.set(id, ch);

  return ch;
}

function message(ch: FakeChannel, id: string): Promise<FakeMessage> {
  const kept = ch.posted.find((m) => m.id === id);

  return kept ? Promise.resolve(kept) : Promise.reject(new Error("Unknown Message"));
}

// A message whose Discord calls land in done; deleting it fires the gateway's messageDelete.
function say(
  where: FakeChannel,
  minute: number,
  content: string,
  fields: Partial<FakeMessage> = {},
): FakeMessage {
  const id = snowflake(minute);

  const posted: FakeMessage = {
    id,
    content,
    createdAt: at(minute),
    author: owner,
    channel: where,
    channelId: where.id,
    flags: new MessageFlagsBitField(),
    attachments: new Collection(),
    messageSnapshots: new Collection(),
    components: [],
    stickers: new Collection(),
    poll: null,
    thread: null,
    reactions: { cache: new Collection() },
    react: (emoji: string) => Promise.resolve(done.push({ react: emoji, on: posted.id })),
    pin: () => Promise.resolve(done.push({ pin: posted.id })),
    unpin: () => Promise.resolve(done.push({ unpin: posted.id })),
    edit: (options: Sent) => {
      done.push({ edit: posted.id, options });

      return Promise.resolve(posted);
    },
    forward: (to: string) => {
      done.push({ forward: posted.id, to });

      return Promise.resolve({ id: "7777" });
    },
    delete: () => {
      done.push({ delete: posted.id });
      emit("messageDelete", posted);

      return Promise.resolve();
    },
    ...fields,
  };

  where.posted.push(posted);
  where.lastMessageId = posted.id;

  return posted;
}

const openSource = channel("4000", { name: "open-source", type: ChannelType.GuildText });
const general = channel("4001", { name: "general", type: ChannelType.GuildText });
const hidden = channel("4002", { name: "hidden", type: ChannelType.GuildText, visible: false });
const dm = channel("4003", { name: "dm", type: ChannelType.DM, guildId: undefined });

const elsewhere = channel("4004", {
  name: "elsewhere",
  type: ChannelType.PublicThread,
  guildId: "9999",
});

const ci = say(openSource, 0, "flaky CI on the relay PR");

const ciThread = channel(ci.id, {
  name: "flaky CI",
  type: ChannelType.PublicThread,
  parent: openSource,
  messageCount: 2,
  lastMessageId: snowflake(3),
});

ci.thread = ciThread;

const docs = say(openSource, 1, "merged the docs fix");
const rebased = say(ciThread, 2, "rebased it");
const pushed = say(ciThread, 3, "rebased again\nand pushed");
const release = say(openSource, 4, "release tomorrow");

say(hidden, 5, "not for the bot");

const news = channel("4005", { name: "news", type: ChannelType.GuildAnnouncement });
const ideas = channel("4006", { name: "ideas", type: ChannelType.GuildForum });

const here = channel("5000", {
  name: "desk anchors",
  type: ChannelType.PublicThread,
  parent: general,
});

const live = (where: FakeChannel) => ({
  inGuild: () => true,
  channel: where,
  mentions: { has: () => false },
  react: () => Promise.resolve(),
});

class Client {
  user = {
    id: BOT,
    tag: "hex#0000",
    displayName: "hex",
    displayAvatarURL: () => "https://cdn/hex.png",
  };
  channels = {
    cache: channels,
    fetch: (id: string) => {
      const ch = channels.get(id);

      return ch
        ? Promise.resolve(ch)
        : Promise.reject(Object.assign(new Error("Unknown Channel"), { code: 10_003 }));
    },
  };
  guilds = {
    cache: new Collection([
      [
        GUILD,
        {
          id: GUILD,
          systemChannel: general,
          channels: {
            cache: channels,
            fetch: () =>
              Promise.resolve(
                new Collection(
                  [...channels].filter(([, ch]) => ch.guildId === GUILD && !ch.isThread()),
                ),
              ),
            fetchActiveThreads: () =>
              Promise.resolve({
                threads: new Collection(
                  [...channels].filter(
                    ([, ch]) => ch.guildId === GUILD && ch.isThread() && !ch.archived,
                  ),
                ),
              }),
          },
        },
      ],
    ]),
  };
  users = {
    fetch: (id: string) => Promise.resolve(id === OWNER ? owner : { id, username: "someone" }),
    createDM: (id: string) =>
      id === OWNER
        ? Promise.resolve(dm)
        : Promise.reject(new Error("Cannot send messages to this user")),
  };
  rest = {
    get: (route: string, { query }: { query: URLSearchParams }) => {
      done.push({ get: route, query: query.toString() });

      return Promise.resolve(found);
    },
  };
  on(event: string, handler: (...args: unknown[]) => void) {
    handlers.set(event, handler);

    return this;
  }
  once(event: string, handler: (...args: unknown[]) => void) {
    return this.on(event, handler);
  }
  login = () => {
    logins += 1;

    return logins === 1
      ? Promise.reject(new Error("getaddrinfo ETIMEOUT discord.com"))
      : Promise.resolve("token");
  };
}

void mock.module("discord.js", () => ({ ...discord, Client }));

const state = mkdtempSync(join(tmpdir(), "discord-"));

// Each open thread as the hub keeps it in hex.db, by its id.
const saved = () =>
  Object.fromEntries(
    open(state)
      .threads({ open: true })
      .map((thread) => [thread.thread, thread]),
  );

afterAll(() => {
  rmSync(state, { recursive: true, force: true });
});

const Inbound = z.object({
  type: z.literal("inbound"),
  content: z.string(),
  meta: z.record(z.string(), z.string()),
});

type Inbound = z.output<typeof Inbound>;

const Permission = z.object({
  type: z.literal("permission"),
  request_id: z.string(),
  behavior: z.string(),
});

const inbounds = (lines: unknown[]): Inbound[] =>
  lines.flatMap((line) => {
    const parsed = Inbound.safeParse(line);

    return parsed.success ? [parsed.data] : [];
  });

const inbound = (lines: unknown[], check: (line: Inbound) => boolean) =>
  until(() => inbounds(lines).find(check));

type Session = Awaited<ReturnType<typeof session>>;

let received: unknown[];
let call: Session["call"];
let send: Session["send"];
let ask: Session["ask"];

const realFetch = globalThis.fetch;

beforeAll(async () => {
  writeFileSync(join(state, "access.json"), JSON.stringify({ allowFrom: [OWNER] }));
  writeFileSync(join(state, "cursor.json"), JSON.stringify({ id: snowflake(60) }));
  open(state).keepThreads("discord", { "7777": { name: "deleted in Discord" } });
  Object.assign(process.env, {
    PATH: noClaude(),
    DISCORD_STATE_DIR: state,
    DISCORD_BOT_TOKEN: "token",
    HEX_LAUNCHER: "false",
    TRANSCRIBE_URL: TRANSCRIBER,
    TRANSCRIBE_MODEL: "whisper",
  });
  const fake = async (url: string | URL | Request, init?: RequestInit) => {
    if (url === "https://cdn.discord/voice-message.ogg") {
      return new Response("ogg");
    }

    if (url === "https://cdn.discord/shot.png") {
      return new Response("png bytes");
    }

    if (url !== TRANSCRIBER) {
      return await realFetch(url, init);
    }

    const model = init?.body instanceof FormData ? init.body.get("model") : null;

    return Response.json({ text: model === "whisper" ? " anchors ship friday " : "wrong model" });
  };

  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(fake, { preconnect: realFetch.preconnect }),
  );
  await import("./bot.ts");
  ({ received, call, send, ask } = await session(here.id));
});

// A session bound to thread, connected once the hub has registered it. Its hooks go to hub.sock,
// which handles a line as it reads it, so a hook has taken effect once the hub closes its socket.
async function session(thread: string) {
  const line = await connect({
    stateDir: state,
    path: "/discord",
    channel: "plugin:discord@hex",
    thread,
  });

  const hook = async (payload: object) => {
    const socket = netConnect(join(state, "hub.sock"));
    socket.end(`${JSON.stringify(payload)}\n`);
    await new Promise((resolve) => socket.on("close", resolve));
  };

  await line.call("list_channels", {});

  const lines: unknown[] = line.received;

  return { received: lines, call: line.call, send: hook, ask: line.ask };
}

const book = () => ({
  pins: Object.fromEntries(
    open(state)
      .pins({ app: "discord" })
      .map((pin) => [pin.thread, pin]),
  ),
});

const question = (asked: string) =>
  open(state)
    .questions({ app: "discord" })
    .find((each) => each.message === asked);

const labels = (components: Built[] | undefined) =>
  components?.[0]?.toJSON().components.map((c) => c.label);

test("a message in a thread names the channel the thread is in", async () => {
  const message = { ...say(here, 6, "what we decided in open-source"), ...live(here) };
  emit("messageCreate", message);
  const first = await until(() => inbounds(received).at(0));
  expect(first.meta).toMatchObject({
    chat_id: here.id,
    message_id: message.id,
    channel: "general",
  });
});

test("a reply says which message it answers, an edit comes back marked edited, and a forward carries what was forwarded", async () => {
  const arrived = (id: string, edited?: string) =>
    inbound(received, (line) => line.meta.message_id === id && line.meta.edited === edited);

  const asked = say(here, 7, "which anchors?");

  const reply = {
    ...say(here, 8, "the left ones"),
    ...live(here),
    type: MessageType.Reply,
    reference: { messageId: asked.id },
    fetchReference: () => Promise.resolve(asked),
  };

  emit("messageCreate", reply);
  expect((await arrived(reply.id)).meta).toMatchObject({
    reply_to_message_id: asked.id,
    reply_to_user: "bassim",
    reply_to_text: "which anchors?",
  });

  emit("messageUpdate", { ...reply, partial: false }, { ...reply, content: "the right ones" });
  const edit = await arrived(reply.id, "true");
  expect(edit.content).toBe("the right ones");
  expect(edit.meta.new_thread).toBeUndefined();

  const forward = {
    ...say(here, 9, ""),
    ...live(here),
    messageSnapshots: new Collection([
      [
        "1",
        {
          content: "ship it friday",
          flags: new MessageFlagsBitField(),
          attachments: new Collection(),
          stickers: new Collection(),
        },
      ],
    ]),
  };

  emit("messageCreate", forward);
  const forwarded = await arrived(forward.id);
  expect(forwarded.content).toBe("ship it friday");
  expect(forwarded.meta.forwarded).toBe("true");
});

test("a voice message arrives as its transcript, with the recording still listed", async () => {
  const recording = {
    id: "61",
    name: "voice-message.ogg",
    url: "https://cdn.discord/voice-message.ogg",
    contentType: "audio/ogg",
    size: 2048,
  };

  const voice = {
    ...say(here, 40, ""),
    ...live(here),
    flags: new MessageFlagsBitField(MessageFlags.IsVoiceMessage),
    attachments: new Collection<string, FakeAttachment>([[recording.id, recording]]),
  };

  emit("messageCreate", voice);

  const heard = await until(() =>
    inbounds(received).find((line) => line.meta.message_id === voice.id),
  );

  expect(heard).toMatchObject({
    content: "(voice message) anchors ship friday",
    meta: { attachments: "voice-message.ogg (audio/ogg, 2KB)" },
  });
});

test("fetch_messages reads a channel's top-level messages oldest-first, with each thread's replies, and pages back", async () => {
  const page = await call("fetch_messages", { channel: "#open-source", limit: 2 });
  expect(page.text).toBe(
    [
      `[${at(1).toISOString()}] bassim: merged the docs fix  (id: ${docs.id})`,
      `[${at(4).toISOString()}] bassim: release tomorrow  (id: ${release.id})`,
    ].join("\n"),
  );
  const older = await call("fetch_messages", { channel: openSource.id, before: docs.id });
  expect(older.text).toBe(
    `[${at(0).toISOString()}] bassim: flaky CI on the relay PR  (id: ${ci.id}, 2 replies, last reply ${at(3).toISOString()})`,
  );
});

test("fetch_messages drills into a thread by the id of the message it hangs off, and pages back through it", async () => {
  const thread = await call("fetch_messages", { thread: ci.id });
  expect(thread.text).toBe(
    [
      `[${at(2).toISOString()}] bassim: rebased it  (id: ${rebased.id})`,
      `[${at(3).toISOString()}] bassim: rebased again ⏎ and pushed  (id: ${pushed.id})`,
    ].join("\n"),
  );
  expect((await call("fetch_messages", { thread: ci.id, before: pushed.id })).text).toBe(
    `[${at(2).toISOString()}] bassim: rebased it  (id: ${rebased.id})`,
  );
});

test("sessions read only text channels and threads in the server the bot can see, never a DM", async () => {
  const refused = (id: string) =>
    `the bot can't read ${id}; list_channels shows the channels it can`;

  expect((await call("fetch_messages", { channel: "hidden" })).error).toBe(refused(hidden.id));
  expect((await call("fetch_messages", { channel: "nowhere" })).error).toBe(
    "no text or forum channel named #nowhere",
  );
  expect((await call("fetch_messages", { thread: "4003" })).error).toBe(refused("4003"));
  expect((await call("fetch_messages", { thread: elsewhere.id })).error).toBe(
    refused(elsewhere.id),
  );
});

test("list_channels names the text, announcement and forum channels the bot can read", async () => {
  expect((await call("list_channels", {})).text).toBe(
    `#open-source  (id: ${openSource.id})\n#general  (id: ${general.id})\n#news  (id: ${news.id})\n#ideas  (id: ${ideas.id}, forum)`,
  );
});

test("a reaction reaches a served thread with what it was on, a removal says so, and reactions elsewhere or by others are dropped", async () => {
  const msg = say(here, 10, "ship the anchors?");

  const partial = {
    id: msg.id,
    channelId: here.id,
    channel: here,
    partial: true,
    fetch: async () => msg,
  };

  const thumbs = { message: partial, emoji: { toString: () => "👍" } };
  emit("messageReactionAdd", thumbs, owner);
  const added = await inbound(received, (line) => line.meta.reaction_to_message_id === msg.id);
  expect(added.content).toBe("(reaction: 👍)");
  expect(added.meta).toMatchObject({
    chat_id: here.id,
    user: "bassim",
    reaction: "👍",
    reaction_to_user: "bassim",
    reaction_to_text: "ship the anchors?",
  });
  expect(added.meta.reaction_removed).toBeUndefined();

  emit("messageReactionRemove", thumbs, owner);
  const removed = await inbound(received, (line) => line.meta.reaction_removed === "true");
  expect(removed.content).toBe("(reaction removed: 👍)");

  const stranger = say(here, 11, "not mine");
  emit(
    "messageReactionAdd",
    { message: stranger, emoji: { toString: () => "🎉" } },
    { id: "8888", username: "someone", partial: false },
  );
  emit("messageReactionAdd", { message: rebased, emoji: { toString: () => "🎉" } }, owner);
  await Bun.sleep(100);
  expect(inbounds(received).some((line) => line.meta.reaction === "🎉")).toBe(false);
});

test("a reaction on the message a served thread hangs off reaches that thread", async () => {
  const ci2 = await session(ciThread.id);
  emit("messageReactionAdd", { message: ci, emoji: { toString: () => "<:ship:123>" } }, owner);
  expect(
    (await inbound(ci2.received, (line) => line.meta.reaction !== undefined)).meta,
  ).toMatchObject({
    chat_id: ciThread.id,
    reaction: "<:ship:123>",
    reaction_to_message_id: ci.id,
  });
});

test("a deleted message is reported with its text when known, but the bot's own delete_message is not echoed back", async () => {
  const typo = say(here, 12, "teh anchors");
  emit("messageDelete", typo);
  expect((await inbound(received, (line) => line.meta.deleted === "true")).meta).toMatchObject({
    message_id: typo.id,
    deleted_text: "teh anchors",
  });

  emit(
    "messageDeleteBulk",
    new Collection([
      ["1", { id: "1234", channelId: here.id, channel: here, partial: true, content: null }],
    ]),
  );
  const unknown = await inbound(received, (line) => line.meta.message_id === "1234");
  expect(unknown.content).toBe("(deleted a message)");
  expect(unknown.meta.deleted_text).toBeUndefined();

  const mine = say(here, 13, "wrong answer", { author: bot });
  expect((await call("delete_message", { message_id: mine.id })).text).toBe("deleted");
  expect(done).toContainEqual({ delete: mine.id });
  expect((await call("delete_message", { message_id: typo.id })).error).toBe(
    "the bot can only delete its own messages",
  );
  await Bun.sleep(100);
  expect(inbounds(received).some((line) => line.meta.message_id === mine.id)).toBe(false);
});

test("reply buttons go on the last chunk, and a tap locks them on the choice and comes back as its label", async () => {
  const sent = await call("reply", { text: "merge it?", buttons: ["Yes", "No"], silent: true });
  const posted = lastPosted(here);
  expect(sent.text).toBe(`sent (id: ${posted.id})`);
  expect(done.at(-1)?.send?.flags).toBe(discord.MessageFlags.SuppressNotifications);
  expect(nth(posted.components, 0).components.map((b) => [b.label, b.disabled])).toEqual([
    ["Yes", false],
    ["No", false],
  ]);

  let update: Sent | undefined;
  emit("interactionCreate", {
    isButton: () => true,
    user: owner,
    customId: "1",
    channelId: here.id,
    createdAt: at(14),
    message: posted,
    update: (options: Sent) => {
      update = options;

      return Promise.resolve();
    },
  });
  const tap = await inbound(received, (line) => line.meta.button === "true");
  expect(tap.content).toBe("No");
  expect(tap.meta).toMatchObject({
    chat_id: here.id,
    user: "bassim",
    button_message_id: posted.id,
  });
  expect(
    update?.components?.[0]?.toJSON().components.map((b) => [b.label, b.disabled, b.style]),
  ).toEqual([
    ["Yes", true, discord.ButtonStyle.Secondary],
    ["No", true, discord.ButtonStyle.Primary],
  ]);
});

test("react takes off only the bot's own reaction, and edit_message replaces the files instead of adding to them", async () => {
  const msg = say(here, 15, "pin me");
  msg.reactions.cache.set("👀", {
    me: true,
    users: { remove: async () => done.push({ unreact: msg.id }) },
  });
  expect((await call("react", { message_id: msg.id, emoji: "👀", remove: true })).text).toBe(
    "reaction removed",
  );
  expect(done).toContainEqual({ unreact: msg.id });
  expect((await call("react", { message_id: msg.id, emoji: "🙈", remove: true })).error).toBe(
    `the bot hasn't reacted 🙈 to that message`,
  );

  mkdirSync(join(state, "inbox"), { recursive: true });
  const file = join(state, "inbox", "chart.png");
  writeFileSync(file, "png");
  await call("edit_message", { message_id: msg.id, files: [file] });
  expect(done.at(-1)).toEqual({ edit: msg.id, options: { files: [file], attachments: [] } });
  await call("edit_message", { message_id: msg.id, text: "new caption" });
  expect(done.at(-1)).toEqual({ edit: msg.id, options: { content: "new caption" } });
});

test("forward sends a message from this thread into another thread by name or a channel", async () => {
  const msg = say(here, 16, "the left anchors");
  emit("threadUpdate", { name: ciThread.id }, ciThread);
  expect((await call("forward", { message_id: msg.id, thread: "flaky CI" })).text).toBe(
    "forwarded (id: 7777)",
  );
  expect(done.at(-1)).toEqual({ forward: msg.id, to: ciThread.id });
  await call("forward", { message_id: msg.id, channel: "news" });
  expect(done.at(-1)).toEqual({ forward: msg.id, to: news.id });
  expect((await call("forward", { message_id: msg.id })).error).toBe(
    "name a thread or channel to forward to",
  );
});

test("the message a thread was started from is found in the channel it hangs off", async () => {
  const shot = say(general, 17, "explain this screenshot", { id: "5001" });

  const started = channel(shot.id, {
    name: "screenshot",
    type: ChannelType.PublicThread,
    parent: general,
  });

  const s = await session(started.id);
  await s.call("react", { message_id: shot.id, emoji: "👀" });
  expect(done.at(-1)).toEqual({ react: "👀", on: shot.id });
  expect((await s.call("download_attachment", { message_id: shot.id })).text).toBe(
    "message has no attachments",
  );
});

test("a thread the owner opens on his message starts from that message, kept in hex.db, and keeps the name he gave it", async () => {
  const asked = say(general, 18, "audit the hex workers", live(general));
  emit("messageCreate", { ...asked });

  const thread = channel(asked.id, {
    name: "audit hex workers, keep on track",
    type: ChannelType.PublicThread,
    parent: general,
    ownerId: OWNER,
  });

  asked.thread = thread;
  const s = await session(thread.id);

  const starter = {
    ...say(thread, 19, ""),
    ...live(thread),
    type: MessageType.ThreadStarterMessage,
    fetchReference: () => Promise.resolve(asked),
  };

  emit("messageCreate", starter);
  const then = { ...say(thread, 19, "and keep them on track"), ...live(thread) };
  emit("messageCreate", then);
  await inbound(s.received, (line) => line.meta.message_id === then.id);

  const heard = () =>
    inbounds(s.received).map((line) => [line.content, line.meta.message_id, line.meta.new_thread]);

  expect(heard()).toEqual([
    ["audit the hex workers", asked.id, undefined],
    ["and keep them on track", then.id, undefined],
  ]);
  expect(open(state).message(`discord:${asked.id}`)).toMatchObject({
    to: thread.id,
    body: "audit the hex workers",
    meta: { ts: at(18).toISOString() },
  });

  emit(
    "messageUpdate",
    { ...asked, partial: false },
    { ...asked, content: "audit every hex worker" },
  );
  await inbound(s.received, (line) => line.meta.edited === "true");
  expect(heard().at(-1)).toEqual(["audit every hex worker", asked.id, undefined]);
});

test("a thread someone else opens on the owner's message stays theirs: his edit to it reaches no session", async () => {
  const someone = { id: "8888", username: "someone", bot: false };
  const asked = say(general, 20, "thinking out loud", live(general));

  const thread = channel(asked.id, {
    name: "their thread",
    type: ChannelType.PublicThread,
    parent: general,
    ownerId: someone.id,
  });

  asked.thread = thread;
  emit("messageCreate", {
    ...say(thread, 21, "", { author: someone }),
    ...live(thread),
    type: MessageType.ThreadStarterMessage,
    fetchReference: () => Promise.resolve(asked),
  });
  emit(
    "messageUpdate",
    { ...asked, partial: false },
    { ...asked, content: "thinking out loud, edited" },
  );
  const then = { ...say(here, 28, "back to work"), ...live(here) };
  emit("messageCreate", then);
  await inbound(received, (line) => line.meta.message_id === then.id);
  expect(open(state).untaken(thread.id)).toEqual([]);
});

test("search_messages searches the whole server and says where each match is", async () => {
  found = {
    total_results: 2,
    messages: [
      [
        {
          id: "11",
          channel_id: openSource.id,
          content: "relay flake again",
          timestamp: at(20).toISOString(),
          author: { id: OWNER, username: "bassim" },
          attachments: [],
        },
      ],
      [
        {
          id: "12",
          channel_id: ciThread.id,
          content: "relay fixed",
          timestamp: at(21).toISOString(),
          author: { id: BOT, username: "hex" },
          attachments: [{}],
        },
      ],
    ],
    threads: [{ id: ciThread.id, name: "flaky CI" }],
  };
  expect((await call("search_messages", { query: "relay", channel: "open-source" })).text).toBe(
    [
      "2 found, newest first",
      `[${at(20).toISOString()}] bassim: relay flake again  (id: 11, in #open-source)`,
      `[${at(21).toISOString()}] me: relay fixed  (id: 12, in thread ${ciThread.id} "flaky CI" +1att)`,
    ].join("\n"),
  );
  expect(done.at(-1)).toEqual({
    get: `/guilds/${GUILD}/messages/search`,
    query: `content=relay&limit=25&channel_id=${openSource.id}`,
  });

  found = { message: "Index not yet available. Try again later", code: 110_000, retry_after: 2 };
  expect((await call("search_messages", { query: "relay" })).text).toBe(
    "Discord is still indexing this server's messages; search again in 2s",
  );
});

test("stickers and polls arrive described, and a new forum post carries its title instead of asking for a rename", async () => {
  const sticker = {
    ...say(here, 22, ""),
    ...live(here),
    stickers: new Collection([
      ["1", { name: "wave", url: "https://media.discordapp.net/stickers/1.png" }],
    ]),
  };

  emit("messageCreate", sticker);
  const waved = await inbound(received, (line) => line.meta.message_id === sticker.id);
  expect(waved.content).toBe("(sticker)");
  expect(waved.meta.stickers).toBe("wave (https://media.discordapp.net/stickers/1.png)");

  const poll = {
    ...say(here, 23, ""),
    ...live(here),
    poll: {
      question: { text: "Lunch?" },
      answers: new Collection([
        [1, { text: "Tacos" }],
        [2, { text: "Ramen" }],
      ]),
      allowMultiselect: false,
    },
  };

  emit("messageCreate", poll);
  const asked = await inbound(received, (line) => line.meta.message_id === poll.id);
  expect(asked.content).toBe("(poll)");
  expect(asked.meta).toMatchObject({ poll: "Lunch?", poll_options: "Tacos; Ramen" });
  expect(asked.meta.poll_multiple).toBeUndefined();

  const thread = channel("6000", {
    name: "Dark mode",
    type: ChannelType.PublicThread,
    parent: ideas,
    setArchived: () => Promise.resolve(),
  });

  const s = await session(thread.id);
  const post = { ...say(thread, 24, "it hurts my eyes", { id: thread.id }), ...live(thread) };
  emit("messageCreate", post);
  const opened = await inbound(s.received, (line) => line.meta.message_id === thread.id);
  expect(opened.meta).toMatchObject({ channel: "ideas", post_title: "Dark mode" });
  expect(opened.meta.new_thread).toBeUndefined();
});

test("a tag in an announcement channel starts a thread like in a text channel", async () => {
  const thread = channel("7000", {
    name: "launch post",
    type: ChannelType.AnnouncementThread,
    parent: news,
    ownerId: BOT,
  });

  const s = await session(thread.id);

  const tag = {
    ...say(news, 25, "<@1000> launch post review"),
    inGuild: () => true,
    channel: news,
    mentions: { has: () => true },
    react: () => Promise.resolve(),
    startThread: async () => thread,
    id: thread.id,
  };

  emit("messageCreate", tag);
  const opened = await inbound(s.received, (line) => line.meta.message_id === thread.id);
  expect(opened.content).toBe("launch post review");
  expect(opened.meta).toMatchObject({ channel: "news", new_thread: "true" });
});

test("a vote on the bot's poll reaches its thread as the answer, a retracted vote says so, and other votes are dropped", async () => {
  const answers = new Collection([
    [1, { text: "Tacos" }],
    [2, { text: "Ramen" }],
  ]);

  const lunch = say(here, 26, "", { author: bot, poll: { question: { text: "Lunch?" }, answers } });

  const partial = {
    id: lunch.id,
    channelId: here.id,
    channel: here,
    partial: true,
    fetch: async () => lunch,
  };

  emit("messagePollVoteAdd", { id: 2, poll: { message: partial } }, OWNER);
  const voted = await inbound(received, (line) => line.meta.poll_message_id === lunch.id);
  expect(voted.content).toBe("(vote: Ramen)");
  expect(voted.meta).toMatchObject({
    chat_id: here.id,
    user: "bassim",
    vote: "Ramen",
    poll: "Lunch?",
  });
  expect(voted.meta.vote_removed).toBeUndefined();

  emit("messagePollVoteRemove", { id: 2, poll: { message: lunch } }, OWNER);
  expect((await inbound(received, (line) => line.meta.vote_removed === "true")).content).toBe(
    "(vote removed: Ramen)",
  );

  const theirs = say(here, 27, "", { poll: { question: { text: "Dinner?" }, answers } });
  emit("messagePollVoteAdd", { id: 1, poll: { message: theirs } }, OWNER);
  emit("messagePollVoteAdd", { id: 1, poll: { message: lunch } }, "8888");
  await Bun.sleep(100);
  expect(
    inbounds(received).some((line) => line.meta.poll === "Dinner?" || line.meta.vote === "Tacos"),
  ).toBe(false);
});

test("a DM is its own session named DM, a message reaches it while it works, and replies go back to the DM", async () => {
  const mine = await session(dm.id);
  await mine.send({ type: "state", thread: dm.id, busy: true });

  const message = {
    ...say(dm, 30, "quick one"),
    inGuild: () => false,
    channel: dm,
    mentions: { has: () => false },
    react: () => Promise.resolve(),
  };

  emit("messageCreate", message);

  const inbound = await until(() =>
    inbounds(mine.received).find((line) => line.content === "quick one"),
  );

  expect(inbound.meta.chat_id).toBe(dm.id);
  expect(inbound.meta.channel).toBeUndefined();
  await mine.call("reply", { text: "on it, from the DM" });
  expect(done).toContainEqual({
    send: expect.objectContaining({ content: "on it, from the DM" }),
    in: dm.id,
  });
  expect((await mine.call("close_thread", {})).error).toBe("a DM is not a thread");
});

test("closing a thread Discord no longer has forgets it, instead of failing on the missing channel", async () => {
  expect((await call("close_thread", { thread: "7777" })).text).toBe(
    'forgot "deleted in Discord": its Discord thread no longer exists',
  );
  await until(() => !("7777" in saved()));
});

test("once connected the bot leaves the id of its server in guild.json, so the voice app can link a thread, and registers its slash commands", async () => {
  let registered: any[] = [];
  emit("clientReady", {
    user: { tag: "hex#0000" },
    application: { commands: { set: async (commands: any[]) => (registered = commands) } },
  });
  expect(JSON.parse(readFileSync(join(state, "guild.json"), "utf-8"))).toEqual({ id: GUILD });
  await until(() => registered.length);
  expect(registered.map((command) => command.name)).toEqual(["model", "effort", "compact", "stop"]);
});

test("a first login that fails, as with no network at boot, is tried again", async () => {
  await until(() => logins >= 2);
});

test("a permission prompt asks in the thread with Allow and Deny, a tap answers it, and one still open when the turn ends stops asking", async () => {
  const prompt = (request_id: string) => ({
    request_id,
    tool_name: "Bash",
    description: "Run the tests",
    input_preview: JSON.stringify({ command: "bun test", description: "Run the tests" }),
  });

  await ask(prompt("abcde"));
  const asked = await until(() => here.posted.findLast((m) => m.content.startsWith("🔐")));
  expect(asked.content).toBe("🔐 **Bash**: Run the tests\n```\ncommand: bun test\n```");
  expect(nth(asked.components, 0).components.map((b) => [b.label, b.custom_id, b.style])).toEqual([
    ["Allow", "perm:allow:abcde", ButtonStyle.Success],
    ["Deny", "perm:deny:abcde", ButtonStyle.Danger],
  ]);

  let update: Sent | undefined;
  emit("interactionCreate", {
    isButton: () => true,
    user: owner,
    customId: "perm:allow:abcde",
    channelId: here.id,
    createdAt: at(41),
    message: asked,
    update: (options: Sent) => {
      update = options;

      return Promise.resolve();
    },
  });
  const permission = () =>
    received.flatMap((line) => {
      const parsed = Permission.safeParse(line);

      return parsed.success ? [parsed.data] : [];
    });

  expect(await until(() => permission().at(0))).toMatchObject({
    request_id: "abcde",
    behavior: "allow",
  });
  expect(
    update?.components?.[0]?.toJSON().components.map((b) => [b.label, b.disabled, b.style]),
  ).toEqual([
    ["Allow", true, ButtonStyle.Success],
    ["Deny", true, ButtonStyle.Secondary],
  ]);

  await ask(prompt("fghij"));

  const open = await until(() =>
    here.posted.findLast((m) => m.content.startsWith("🔐") && m !== asked),
  );

  await send({ type: "state", thread: here.id, busy: false, background: true });
  await Bun.sleep(100);
  expect(done.some((d) => d.edit === open.id)).toBe(false);
  await send({ type: "state", thread: here.id, busy: false });
  const moot = await until(() => done.find((d) => d.edit === open.id));
  expect(labels(moot.options?.components)).toEqual(["No longer waiting"]);
});

test("a question with buttons goes in the ledger: a tap answers it there, and one answered in hex's app closes its buttons, reaches the thread, and can be taken back", async () => {
  await call("reply", {
    text: "Which anchors?\nThe left ones are cheaper.",
    buttons: ["Left", "Right"],
  });
  const asked = lastPosted(here);
  expect(question(asked.id)).toMatchObject({
    thread: here.id,
    text: "Which anchors?\nThe left ones are cheaper.",
    options: ["Left", "Right"],
  });

  await send({ type: "answer", thread: here.id, message: asked.id, label: "Right", via: "app" });
  const answered = await inbound(received, (line) => line.meta.answered_in === "in the app");
  expect(answered).toMatchObject({
    content: "Right",
    meta: { user: "hex app", button: "true", button_message_id: asked.id },
  });
  expect(labels(done.findLast((d) => d.edit === asked.id)?.options?.components)).toEqual([
    "✓ Answered in the app: Right",
  ]);
  expect(question(asked.id)?.answer).toMatchObject({ label: "Right", via: "app" });

  await send({ type: "reopen", thread: here.id, message: asked.id, via: "app" });
  expect((await inbound(received, (line) => line.meta.took_back === "Right")).content).toBe(
    "(took back: Right)",
  );
  expect(labels(done.findLast((d) => d.edit === asked.id)?.options?.components)).toEqual([
    "Left",
    "Right",
  ]);

  emit("interactionCreate", {
    isButton: () => true,
    user: owner,
    customId: "0",
    channelId: here.id,
    createdAt: at(44),
    message: asked,
    update: () => Promise.resolve(),
  });
  await until(() => question(asked.id)?.answer?.via === "discord");

  await call("reply", { text: "Ship today?", buttons: ["Yes", "No"] });
  const later = lastPosted(here);
  await call("edit_message", { message_id: later.id, text: "Ship today, before five?" });
  expect(question(later.id)?.settled).toBeUndefined();
  await send({ type: "settle", thread: here.id, message: later.id, note: "Settled: shipped" });
  await until(() => question(later.id)?.settled);
  expect(labels(done.findLast((d) => d.edit === later.id)?.options?.components)).toEqual([
    "Settled: shipped",
  ]);

  await call("reply", { text: "Rename it?", buttons: ["Yes", "No"] });
  const renamed = lastPosted(here);
  await call("edit_message", {
    message_id: renamed.id,
    text: "Renamed, as you said in the call.",
    settled: true,
  });
  expect(question(renamed.id)?.settled).toMatchObject({ note: "✓ Settled" });
  expect(labels(done.findLast((d) => d.edit === renamed.id)?.options?.components)).toEqual([
    "✓ Settled",
  ]);

  await call("reply", { text: "Keep the old name?", buttons: ["Yes", "No"] });
  const kept = lastPosted(here);
  await call("edit_message", { message_id: kept.id, settled: true });
  expect(question(kept.id)).toMatchObject({
    text: "Keep the old name?",
    settled: { note: "✓ Settled" },
  });
  expect(labels(done.findLast((d) => d.edit === kept.id)?.options?.components)).toEqual([
    "✓ Settled",
  ]);
});

test("buttons with multiple come as a menu, and a pick of several comes back as their labels and locks the menu on them", async () => {
  await call("reply", { text: "Which files?", buttons: ["a.ts", "b.ts", "c.ts"], multiple: true });
  const asked = lastPosted(here);
  const select = nth(nth(asked.components, 0).components, 0);
  expect(select).toMatchObject({
    type: ComponentType.StringSelect,
    custom_id: "menu",
    min_values: 1,
    max_values: 3,
  });
  expect(question(asked.id)).toMatchObject({ options: ["a.ts", "b.ts", "c.ts"], multiple: true });

  let update: Sent | undefined;
  emit("interactionCreate", {
    isButton: () => false,
    isStringSelectMenu: () => true,
    user: owner,
    values: ["0", "2"],
    component: { options: select.options },
    channelId: here.id,
    createdAt: at(45),
    message: asked,
    update: (options: Sent) => {
      update = options;

      return Promise.resolve();
    },
  });
  const pick = await inbound(received, (line) => line.meta.button_message_id === asked.id);
  expect(pick.content).toBe("a.ts; c.ts");
  const locked = update?.components?.[0]?.toJSON().components[0];
  expect(locked?.disabled).toBe(true);
  expect(locked?.options?.filter((o) => o.default === true).map((o) => o.label)).toEqual([
    "a.ts",
    "c.ts",
  ]);
});

test("an image arrives already downloaded, as image_path, next to its listing", async () => {
  const shot = {
    id: "62",
    name: "shot.png",
    url: "https://cdn.discord/shot.png",
    contentType: "image/png",
    size: 1024,
  };

  const message = {
    ...say(here, 46, "what is this?"),
    ...live(here),
    attachments: new Collection<string, FakeAttachment>([[shot.id, shot]]),
  };

  emit("messageCreate", message);
  const arrived = await inbound(received, (line) => line.meta.message_id === message.id);
  expect(arrived.meta.image_path).toMatch(/inbox\/\d+-62\.png$/);
  expect(readFileSync(arrived.meta.image_path ?? "", "utf-8")).toBe("png bytes");
  expect(arrived.meta.attachments).toBe("shot.png (image/png, 1KB)");
});

test("new_thread opens with its about line and forwards nothing from the thread that opened it", async () => {
  const desk = channel("5100", { name: "desk", type: ChannelType.PublicThread, parent: general });
  const s = await session(desk.id);
  say(desk, 31, "earlier chatter");
  say(desk, 32, "old answer", { author: bot });
  say(desk, 33, "spin off the anchors work");
  say(desk, 34, "on it", { author: bot });
  await s.send({ type: "state", thread: desk.id, busy: true });

  const result = await s.call("new_thread", {
    title: "Anchors",
    prompt: "work on the anchors",
    about: "Spun off from desk",
  });

  await s.send({ type: "state", thread: desk.id, busy: false });
  const thread = [...channels.values()].find((ch) => ch.name === "Anchors")!;
  await session(thread.id);
  expect(result.text).toBe(
    `started thread "Anchors": https://discord.com/channels/${GUILD}/${thread.id}`,
  );
  expect(done.find((d) => d.create === "Anchors")).toEqual({ create: "Anchors", in: general.id });
  expect(nth(thread.posted, 0).content).toBe("Spun off from desk");
  expect(done.filter((d) => d.forward !== undefined && d.to === thread.id)).toEqual([]);
});

test("new_thread in a forum opens a post with its tags, and fetch_messages lists a forum's posts", async () => {
  ideas.availableTags = [
    { id: "t1", name: "Bug" },
    { id: "t2", name: "Idea" },
  ];
  await call("new_thread", {
    title: "Glare",
    prompt: "look into the glare",
    about: "Glare on the desk",
    channel: "ideas",
    tags: ["idea"],
  });
  expect(done.find((d) => d.create === "Glare")).toEqual({
    create: "Glare",
    in: ideas.id,
    message: "Glare on the desk",
    appliedTags: ["t2"],
  });
  expect(
    (
      await call("new_thread", {
        title: "Nope",
        prompt: "x",
        about: "x",
        channel: "ideas",
        tags: ["urgent"],
      })
    ).error,
  ).toBe("#ideas has the tags Bug, Idea");
  const post = [...channels.values()].find((ch) => ch.name === "Glare")!;
  await session(post.id);
  expect((await call("fetch_messages", { channel: "ideas" })).text).toContain(
    `Glare  (post ${post.id}, 0 replies)`,
  );
});

test("new_thread with another app opens the thread there through the hub", async () => {
  const opened: any[] = [];
  clients.set("buzz", {
    hub: { open: (...args: any[]) => opened.push(args) } as any,
    place: async (name, where, about) => (
      opened.push(["place", name, where, about]),
      { thread: "b1", link: "buzz://b1" }
    ),
  });
  expect(
    (
      await call("new_thread", {
        title: "Relay",
        prompt: "fix the relay",
        about: "From Discord",
        app: "buzz",
      })
    ).text,
  ).toBe('started thread "Relay" in buzz: buzz://b1');
  expect(opened).toEqual([
    ["place", "Relay", undefined, "From Discord"],
    ["b1", "Relay", "fix the relay", undefined],
  ]);
  clients.delete("buzz");
  expect(
    (await call("new_thread", { title: "Relay", prompt: "x", about: "x", app: "buzz" })).error,
  ).toBe("buzz isn't connected; threads open in discord");
});

test("slash commands set a thread's model and effort, and answer only the owner in a thread with a session", async () => {
  const desk = channels.get("5100")!;
  const replies: any[] = [];

  const command = (commandName: string, value?: string, user = owner, channelId = desk.id) => {
    emit("interactionCreate", {
      isButton: () => false,
      isStringSelectMenu: () => false,
      isChatInputCommand: () => true,
      commandName,
      user,
      channelId,
      options: { getString: () => value },
      reply: async (options: any) => replies.push(options),
    });
  };

  command("model", "opus");
  command("effort", "max");
  command("stop", undefined, owner, general.id);
  command("stop", undefined, { id: "8888", username: "someone", partial: false });
  await until(() => replies.length === 4);
  await send({ type: "state", thread: here.id, busy: true });
  command("compact", undefined, owner, here.id);
  await until(() => replies.length === 5);
  await send({ type: "state", thread: here.id, busy: false });
  expect(replies.map((reply) => reply.content)).toEqual([
    "Model: Opus, from this thread's next message.",
    "Effort: Max, from this thread's next message.",
    "This channel has no session: use it in one of hex's threads or the DM.",
    "hex only answers its owner.",
    "This thread is working; compact it once it's done.",
  ]);
  expect(replies.every((reply) => reply.flags === MessageFlags.Ephemeral)).toBe(true);
  expect(saved()[desk.id]).toMatchObject({ model: "opus", effort: "max" });
});

test("a backfill posts each line through one webhook of the channel, as the owner or the bot, split to fit", async () => {
  const hooked: HookPost[] = [];

  const hook = {
    owner: { id: BOT },
    token: "secret",
    send: (options: HookPost) => {
      hooked.push(options);

      return Promise.resolve();
    },
  };

  const created: string[] = [];

  const repo = channel("4100", {
    name: "repo",
    type: ChannelType.GuildText,
    fetchWebhooks: () =>
      Promise.resolve(
        new Collection<string, object>(
          created.length > 0 ? [["h1", hook]] : [["h0", { owner: { id: "42" }, token: "theirs" }]],
        ),
      ),
    createWebhook: ({ name }) => {
      created.push(name);

      return Promise.resolve(hook);
    },
  });

  const thread = channel("4101", {
    name: "Context check",
    type: ChannelType.PublicThread,
    parent: repo,
    guild: { members: { me: { displayName: "hex" } } },
  });

  Object.assign(owner, { displayName: "Bassim", displayAvatarURL: () => "https://cdn/owner.png" });
  const backfill = clients.get("discord")?.backfill;

  if (!backfill) {
    throw new Error("the Discord client has no backfill");
  }

  await backfill(thread.id, [
    { from: "me", text: "how full is your context?" },
    { from: "hex", text: `${"a".repeat(1990)}\n\n${"b".repeat(100)}` },
  ]);
  await backfill(thread.id, [{ from: "me", text: "@everyone thanks" }]);
  expect(created).toEqual(["hex"]);

  const me = {
    username: "Bassim",
    avatarURL: "https://cdn/owner.png",
    threadId: thread.id,
    allowedMentions: { parse: [] },
  };

  const hex = {
    username: "hex",
    avatarURL: "https://cdn/hex.png",
    threadId: thread.id,
    allowedMentions: { parse: [] },
  };

  expect(hooked.map(({ content, ...rest }) => rest)).toEqual([me, hex, hex, me]);
  expect(hooked.every(({ content }) => content.length <= 2000)).toBe(true);
  expect(hooked.map(({ content }) => content.replaceAll(/\s/g, "")).join("")).toBe(
    `howfullisyourcontext?${"a".repeat(1990)}${"b".repeat(100)}@everyonethanks`,
  );
});

test("back online, the bot reads what was said while it was away, archived threads too (past the first page), oldest first, as if live, and each message reaches its session once", async () => {
  const someone = { id: "8888", username: "someone", bot: false };
  const away = { inGuild: () => true, mentions: { has: () => false }, react: async () => {} };
  const first = say(here, 61, "did the anchors ship?", away);

  const tag = say(general, 62, "<@1000> anchors", {
    ...away,
    mentions: { has: () => true },
    startThread: async () => tagged,
  });

  const tagged = channel(tag.id, {
    name: "anchors",
    type: ChannelType.PublicThread,
    parent: general,
    ownerId: BOT,
  });

  const opening = await session(tagged.id);
  const mine = await session(dm.id);
  const theirs = say(here, 63, "not for hex", { ...away, author: someone });
  say(here, 64, "shipped", { ...away, author: bot });
  const direct = say(dm, 65, "and the desk?", { ...away, inGuild: () => false });
  say(hidden, 66, "still not for the bot", away);

  const shelved = channel(snowflake(50), {
    name: "old plans",
    type: ChannelType.PublicThread,
    parent: general,
    archived: true,
    archiveTimestamp: at(69).getTime(),
    setArchived: () => Promise.resolve(),
  });

  for (const minute of [70, 71]) {
    channel(snowflake(minute - 20), {
      name: `shelved at ${minute}`,
      type: ChannelType.PublicThread,
      parent: general,
      archived: true,
      archiveTimestamp: at(minute).getTime(),
    });
  }

  const reopened = await session(shelved.id);
  const revived = say(shelved, 68, "back to the old plan", away);

  emit("shardReady", 0);
  emit("messageCreate", first);
  const then = { ...say(here, 67, "one more thing"), ...live(here) };
  emit("messageCreate", then);

  const opened = await inbound(opening.received, (line) => line.meta.message_id === tag.id);
  expect(opened).toMatchObject({
    content: "anchors",
    meta: { channel: "general", new_thread: "true" },
  });
  expect((await inbound(mine.received, (line) => line.meta.message_id === direct.id)).content).toBe(
    "and the desk?",
  );
  expect(
    (await inbound(reopened.received, (line) => line.meta.message_id === revived.id)).content,
  ).toBe("back to the old plan");
  await inbound(received, (line) => line.meta.message_id === then.id);
  const late = new Set([first.id, theirs.id, then.id]);
  expect(
    inbounds(received)
      .filter((line) => late.has(line.meta.message_id ?? ""))
      .map((line) => line.content),
  ).toEqual(["did the anchors ship?", "one more thing"]);
  expect(JSON.parse(readFileSync(join(state, "cursor.json"), "utf-8"))).toEqual({ id: revived.id });
});

test("a status post is the session's note over lines hex keeps current from the thread's questions and tasks", async () => {
  await call("pin", { note: "Site: example.com" });
  const post = lastPosted(here);
  expect(post.content).toBe("Site: example.com");
  expect(done).toContainEqual({ pin: post.id });
  expect(book().pins[here.id]).toMatchObject({ message: post.id, note: "Site: example.com" });

  const edits = () => done.filter((d) => d.edit === post.id).map((d) => d.options?.content ?? "");

  await call("reply", { text: "Rename the site?", buttons: ["Yes", "No"] });
  await until(() => /\n- \[?Rename the site\?/.test(edits().at(-1) ?? ""));

  const count = edits().length;
  expect(
    (await call("edit_message", { message_id: post.id, text: "Site: example.org" })).text,
  ).toStartWith("edited the status post's note");
  expect(edits()).toHaveLength(count + 1);
  expect(edits().at(-1)).toStartWith("Site: example.org\n\n**Waiting on you**");
  expect(book().pins[here.id]).toMatchObject({ message: post.id, note: "Site: example.org" });

  await call("pin", { note: "Site: v2" });
  const next = lastPosted(here);
  expect(done).toContainEqual({ unpin: post.id });
  expect(book().pins[here.id]).toMatchObject({ message: next.id, note: "Site: v2" });
  await call("pin", { unpin: true });
  expect(book().pins[here.id]).toBeUndefined();
});
