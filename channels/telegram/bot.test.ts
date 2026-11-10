import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clients, open } from "@hex/hub";
import { connect as connectSession, noClaude, until } from "@hex/hub/testing";
import * as grammy from "grammy";
import type { PollingOptions } from "grammy";
import type { Message, ReactionTypeEmoji, Update, User, UserFromGetMe } from "grammy/types";
import { z } from "zod";

const CHANNEL = "plugin:telegram@hex";
const OWNER = 2000;
const FORUM = -1_001_234;
const DESK = `${FORUM}:5`;
const owner = { id: OWNER, is_bot: false, first_name: "Victor", username: "victor" };

const hex: UserFromGetMe = {
  id: 1000,
  is_bot: true,
  first_name: "hex",
  username: "hex_bot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

const forum = { id: FORUM, type: "supergroup" as const, title: "hex", is_forum: true as const };
const TRANSCRIBER = "http://transcriber/v1/audio/transcriptions";

const Button = z.looseObject({ text: z.string() });

const apiPayload = z.looseObject({
  chat_id: z.union([z.string(), z.number()]).optional(),
  message_id: z.number().optional(),
  message_ids: z.array(z.number()).optional(),
  message_thread_id: z.number().optional(),
  user_id: z.number().optional(),
  file_id: z.string().optional(),
  name: z.string().optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  icon_custom_emoji_id: z.string().optional(),
  disable_notification: z.boolean().optional(),
  rich_message: z.looseObject({ markdown: z.string() }).optional(),
  reaction: z.array(z.looseObject({ emoji: z.string() })).optional(),
  reply_markup: z.looseObject({ inline_keyboard: z.array(z.array(Button)) }).optional(),
  reply_parameters: z.looseObject({}).optional(),
  commands: z.array(z.looseObject({ command: z.string() })).optional(),
  media: z
    .union([z.array(z.looseObject({ caption: z.string().optional() })), z.looseObject({})])
    .optional(),
});

type Payload = z.infer<typeof apiPayload>;

type Call = { method: string; payload: Payload; sent?: number };

const Line = z.looseObject({
  type: z.string(),
  content: z.string().optional(),
  meta: z.record(z.string(), z.string()).optional(),
});

const inboundLine = z.object({
  type: z.literal("inbound"),
  content: z.string(),
  meta: z.record(z.string(), z.string()),
});

type Inbound = z.infer<typeof inboundLine>;

const linesOf = (received: unknown[]) => z.array(Line).parse(received);

const inboundOf = (received: unknown[]): Inbound[] =>
  received.flatMap((line) => {
    const parsed = inboundLine.safeParse(line);

    return parsed.success ? [parsed.data] : [];
  });

const calls: Call[] = [];
const captionOnly = new Set<number>();

const slow = new Set<number>();
const landed: Payload[] = [];
let deliver: (update: Update) => Promise<void>;
let started: PollingOptions | undefined;
let nextMessage = 100;
let nextUpdate = 1;
let throttled = 0;

function sentMessage(call: Call) {
  call.sent = ++nextMessage;

  return {
    message_id: call.sent,
    date: 0,
    chat: { id: call.payload.chat_id },
    from: hex,
  };
}

function answer(call: Call): object | boolean {
  const { method, payload } = call;

  switch (method) {
    case "sendPoll": {
      const sent = sentMessage(call);

      return { ...sent, poll: { id: `poll-${sent.message_id}` } };
    }

    case "sendPhoto": {
      const sent = sentMessage(call);

      return { ...sent, photo: [{ file_id: `photo-${sent.message_id}` }] };
    }

    case "sendDocument": {
      const sent = sentMessage(call);

      return { ...sent, document: { file_id: `document-${sent.message_id}` } };
    }

    case "sendMediaGroup": {
      return Array.isArray(payload.media) ? payload.media.map(() => sentMessage(call)) : [];
    }

    case "forwardMessages": {
      return (payload.message_ids ?? []).map(() => ({ message_id: ++nextMessage }));
    }

    case "getForumTopicIconStickers": {
      return [
        { emoji: "🔥", custom_emoji_id: "111" },
        { emoji: "❤️", custom_emoji_id: "222" },
      ];
    }

    case "createForumTopic": {
      return { message_thread_id: 9, name: payload.name, icon_color: 0 };
    }

    case "getChat": {
      return forum;
    }

    case "getChatMember": {
      return { status: "creator", user: payload.user_id === OWNER ? owner : hex };
    }

    case "getFile": {
      return {
        file_id: payload.file_id,
        file_unique_id: payload.file_id,
        file_path: `photos/${payload.file_id}.jpg`,
      };
    }

    default: {
      return method.startsWith("send") || method.startsWith("forward") ? sentMessage(call) : true;
    }
  }
}

type FakeResponse =
  | { ok: true; result: object | boolean }
  | { ok: false; error_code: number; description: string; parameters?: { retry_after: number } };

// SAFETY: each fake response is what Telegram answers the method it fakes, or one of its errors.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fake of Telegram's response for every method at once
const telegramSays = (response: FakeResponse) => response as never;

class Bot extends grammy.Bot {
  constructor(token: string) {
    super(token, { botInfo: hex });
    this.api.config.use(async (_prev, method, raw) => {
      const payload = apiPayload.parse(raw);
      const call: Call = { method, payload };
      calls.push(call);

      if (method.startsWith("send") && throttled > 0 && throttled--) {
        return telegramSays({
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 0",
          parameters: { retry_after: 0 },
        });
      }

      const { message_id } = payload;

      if (
        method === "editMessageReplyMarkup" &&
        message_id !== undefined &&
        slow.delete(message_id)
      ) {
        await Bun.sleep(200);
      }

      if (method === "editMessageReplyMarkup") {
        landed.push(payload);
      }

      if (
        method.startsWith("editMessage") &&
        method !== "editMessageReplyMarkup" &&
        calls.some((c) => c.method === "sendPoll" && c.sent === message_id)
      ) {
        return telegramSays({
          ok: false,
          error_code: 400,
          description: `Bad Request: there is no ${method === "editMessageCaption" ? "caption" : "text"} in the message to edit`,
        });
      }

      if (method === "editMessageText" && message_id !== undefined && captionOnly.has(message_id)) {
        return telegramSays({
          ok: false,
          error_code: 400,
          description: "Bad Request: there is no text in the message to edit",
        });
      }

      return telegramSays({ ok: true, result: answer(call) });
    });
  }

  override async start(options?: PollingOptions) {
    started = options;
    deliver = (incoming) => this.handleUpdate(incoming);
    await options?.onStart?.(hex);
  }
}

void mock.module("grammy", () => ({ ...grammy, Bot }));

const state = mkdtempSync(join(tmpdir(), "telegram-"));

const SLOW_SETUP = 30_000;

const saved = () =>
  Object.fromEntries(
    open(state)
      .threads.list({ open: true })
      .map((thread) => [thread.thread, thread]),
  );

const outbox = mkdtempSync(join(tmpdir(), "telegram-outbox-"));

afterAll(() => {
  rmSync(state, { recursive: true, force: true });
  rmSync(outbox, { recursive: true, force: true });
});

type Session = Awaited<ReturnType<typeof connectSession>>;

let desk: Session;
let call: Session["call"];
let ask: Session["ask"];
let session: (payload: Record<string, string | number | boolean>) => void;

const received = () => linesOf(desk.received);

const called = (method: string, match: (payload: Payload) => boolean = () => true) =>
  until(() => calls.find((c) => c.method === method && match(c.payload))?.payload);

const idOf = (payload: Payload) => {
  const id = calls.find((c) => c.payload === payload)?.sent;

  if (id === undefined) {
    throw new Error("Telegram sent no message for that call");
  }

  return id;
};

const idIn = (result: { text?: string | undefined }) =>
  Number(/id: (\d+)/u.exec(result.text ?? "")?.[1]);

const inbound = (match: (line: Inbound) => boolean, lines: () => unknown[] = () => desk.received) =>
  until(() => inboundOf(lines()).find(match));

function message<Fields extends Partial<Message>>(fields: Fields) {
  return {
    message_id: ++nextMessage,
    date: 1_760_000_000,
    chat: forum,
    from: owner,
    message_thread_id: 5,
    is_topic_message: true,
    ...fields,
  };
}

async function update(fields: Omit<Update, "update_id">) {
  await deliver({ update_id: nextUpdate++, ...fields });
}

beforeAll(async () => {
  writeFileSync(join(state, "access.json"), JSON.stringify({ allowFrom: [String(OWNER)] }));
  open(state).threads.keep("telegram", {
    [DESK]: { name: "desk" },
    [String(OWNER)]: { name: "Victor" },
    [`${FORUM}:6`]: { name: "notes" },
    "stray-key": { name: "stray" },
  });
  Object.assign(process.env, {
    PATH: noClaude(),
    TELEGRAM_STATE_DIR: state,
    TELEGRAM_BOT_TOKEN: "token",
    HEX_LAUNCHER: "false",
    HEX_MAIN_THREAD: String(FORUM),
    TRANSCRIBE_URL: TRANSCRIBER,
    TRANSCRIBE_MODEL: "whisper",
  });

  const realFetch = globalThis.fetch;

  globalThis.fetch = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      const address = url instanceof Request ? url.url : String(url);

      if (address.startsWith("https://api.telegram.org/file/")) {
        return new Response("jpeg");
      }

      if (address !== TRANSCRIBER) {
        return await realFetch(url, init);
      }

      const form = init?.body;

      return Response.json({
        text:
          form instanceof FormData && form.get("model") === "whisper"
            ? " anchors ship friday "
            : "wrong model",
      });
    },
    { preconnect: realFetch.preconnect },
  );
  await import("./bot.ts");

  desk = await connectSession({
    stateDir: state,
    path: "/telegram",
    channel: CHANNEL,
    thread: DESK,
  });

  call = desk.call;
  ask = desk.ask;
  const hooks = connect(join(state, "hub.sock"));
  await new Promise((resolve) => {
    hooks.on("connect", resolve);
  });
  session = (payload) => {
    hooks.write(`${JSON.stringify(payload)}\n`);
  };
}, SLOW_SETUP);

test("closing a thread list entry that isn't a topic forgets it, instead of failing", async () => {
  expect((await call("close_thread", { thread: "stray-key" })).text).toBe(
    'forgot "stray": it isn\'t a topic, so there was nothing to close in Telegram',
  );
  await until(() => !("stray-key" in saved()));
});

test("the bot asks Telegram for reactions, button taps and poll votes", () => {
  expect(started?.allowed_updates).toEqual([
    "message",
    "edited_message",
    "message_reaction",
    "callback_query",
    "poll_answer",
  ]);
});

test("a reaction reaches the thread of the message it is on, with that message's text and author", async () => {
  const sent = await call("reply", { text: "deploy is green" });
  const id = idIn(sent);

  const react = (old_reaction: ReactionTypeEmoji[], new_reaction: ReactionTypeEmoji[]) =>
    update({
      message_reaction: {
        chat: forum,
        message_id: id,
        user: owner,
        date: 1_760_000_000,
        old_reaction,
        new_reaction,
      },
    });

  const thumbs: ReactionTypeEmoji = { type: "emoji", emoji: "👍" };

  await react([], [thumbs]);
  expect(
    (
      await inbound(
        (line) => line.meta.reaction === "👍" && line.meta.reaction_removed === undefined,
      )
    ).meta,
  ).toMatchObject({
    reaction_to_message_id: String(id),
    reaction_to_user: "hex_bot",
    reaction_to_text: "deploy is green",
  });
  await react([thumbs], []);
  expect((await inbound((line) => line.meta.reaction_removed === "true")).content).toBe(
    "(reaction removed: 👍)",
  );
});

test("a reaction on a forum message the hub never saw is dropped, since Telegram names no topic", async () => {
  const before = received().length;
  await update({
    message_reaction: {
      chat: forum,
      message_id: 1,
      user: owner,
      date: 1_760_000_000,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "🔥" }],
    },
  });
  await Bun.sleep(100);
  expect(
    received()
      .slice(before)
      .filter((line) => line.type === "inbound"),
  ).toEqual([]);
});

test("buttons come back as a tap with the label, and the message keeps only the chosen one", async () => {
  const sent = await call("reply", { text: "Ship it?", buttons: ["Yes", "No"], silent: true });
  const id = idIn(sent);
  expect(await called("sendMessage", (p) => p.text === "Ship it?")).toMatchObject({
    disable_notification: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Yes", callback_data: "0" },
          { text: "No", callback_data: "1" },
        ],
      ],
    },
  });

  const markup = {
    inline_keyboard: [
      [
        { text: "Yes", callback_data: "0" },
        { text: "No", callback_data: "1" },
      ],
    ],
  };

  await update({
    callback_query: {
      id: "tap",
      from: owner,
      chat_instance: "x",
      data: "0",
      message: message({ message_id: id, from: hex, text: "Ship it?", reply_markup: markup }),
    },
  });
  expect(await called("answerCallbackQuery")).toMatchObject({ callback_query_id: "tap" });
  expect(await called("editMessageReplyMarkup", (p) => p.message_id === id)).toMatchObject({
    reply_markup: { inline_keyboard: [[{ text: "✓ Yes", disabled: {} }]] },
  });
  const tap = await inbound((line) => line.meta.button === "true");
  expect(tap.content).toBe("Yes");
  expect(tap.meta.button_message_id).toBe(String(id));
});

test("a permission prompt asks in its own topic, and the owner's tap answers the session instead of reaching it as a message", async () => {
  void ask({
    request_id: "abcde",
    tool_name: "Bash",
    description: "Delete the build folder",
    input_preview: '{"command":"rm -rf build","description":"Delete the build folder"}',
  });
  const prompt = await called("sendMessage", (p) => p.text?.startsWith("🔐") === true);

  const markup = {
    inline_keyboard: [
      [
        { text: "Allow", callback_data: "perm:allow:abcde" },
        { text: "Deny", callback_data: "perm:deny:abcde" },
      ],
    ],
  };

  expect(prompt).toMatchObject({
    chat_id: String(FORUM),
    message_thread_id: 5,
    text: "🔐 Bash: Delete the build folder\n\ncommand: rm -rf build",
    reply_markup: markup,
  });
  const id = idOf(prompt);

  const tap = (from: User) =>
    update({
      callback_query: {
        id: "perm",
        from,
        chat_instance: "x",
        data: "perm:deny:abcde",
        message: message({
          message_id: id,
          from: hex,
          text: prompt.text ?? "",
          reply_markup: markup,
        }),
      },
    });

  await tap({ id: 3000, is_bot: false, first_name: "Someone" });
  await Bun.sleep(100);
  expect(received().find((line) => line.type === "permission")).toBeUndefined();

  const before = received().length;
  await tap(owner);
  expect(await until(() => received().find((line) => line.type === "permission"))).toEqual({
    type: "permission",
    request_id: "abcde",
    behavior: "deny",
  });
  expect(await called("editMessageReplyMarkup", (p) => p.message_id === id)).toMatchObject({
    reply_markup: { inline_keyboard: [[{ text: "✓ Deny", disabled: {} }]] },
  });
  await Bun.sleep(100);
  expect(
    received()
      .slice(before)
      .filter((line) => line.type === "inbound"),
  ).toEqual([]);
});

test("a prompt still open when the turn ends, answered in the session itself, stops offering its buttons", async () => {
  void ask({
    request_id: "fghij",
    tool_name: "Write",
    description: "Write notes.md",
    input_preview: '{"file_path":"/tmp/notes.md","content":"hi"}',
  });
  const prompt = await called("sendMessage", (p) => p.text?.startsWith("🔐 Write") === true);
  expect(prompt.text).toBe("🔐 Write: Write notes.md\n\nfile_path: /tmp/notes.md\ncontent: hi");
  const id = idOf(prompt);
  session({ type: "state", thread: DESK, busy: true });
  session({ type: "state", thread: DESK, busy: false });
  expect(await called("editMessageReplyMarkup", (p) => p.message_id === id)).toMatchObject({
    reply_markup: { inline_keyboard: [[{ text: "No longer waiting", disabled: {} }]] },
  });
});

test("forward sends a message into another topic, found by its name", async () => {
  expect((await call("forward", { message_id: "7", thread: "notes" })).text).toMatch(
    /^forwarded to "notes"/u,
  );
  expect(await called("forwardMessage")).toMatchObject({
    chat_id: String(FORUM),
    from_chat_id: String(FORUM),
    message_id: 7,
    message_thread_id: 6,
  });
});

test("a poll goes out with named votes, and each vote comes back as the chosen options", async () => {
  const sent = await call("poll", {
    question: "Lunch?",
    options: ["tacos", "pho", "salad"],
    multiple: true,
  });

  const id = idIn(sent);
  expect(await called("sendPoll")).toMatchObject({
    question: "Lunch?",
    options: [{ text: "tacos" }, { text: "pho" }, { text: "salad" }],
    is_anonymous: false,
    allows_multiple_answers: true,
  });
  await update({
    poll_answer: {
      poll_id: `poll-${id}`,
      user: owner,
      option_ids: [0, 2],
      option_persistent_ids: [],
    },
  });
  const vote = await inbound((line) => line.meta.vote !== undefined);
  expect(vote.content).toBe("(vote: tacos; salad)");
  expect(vote.meta).toMatchObject({
    vote: "tacos; salad",
    poll_message_id: String(id),
    poll: "Lunch?",
  });
  await update({
    poll_answer: { poll_id: `poll-${id}`, user: owner, option_ids: [], option_persistent_ids: [] },
  });
  expect((await inbound((line) => line.meta.vote_removed === "true")).content).toBe(
    "(vote removed)",
  );
});

test("edit_message changes a file's caption when it has no text, and replaces the file itself", async () => {
  captionOnly.add(42);
  await call("edit_message", { message_id: "42", text: "new caption" });
  expect(await called("editMessageCaption")).toMatchObject({
    message_id: 42,
    caption: "new caption",
  });
  const file = join(outbox, `chart-${Date.now()}.png`);
  writeFileSync(file, "png");
  await call("edit_message", { message_id: "43", file });
  expect((await called("editMessageMedia")).media).toMatchObject({ type: "photo" });
});

test("markdown goes out as Telegram's own rich markdown, and a code block cut between chunks stays a code block", async () => {
  await call("reply", { text: "look:\n```\n┌─┐\n└─┘\n```", format: "markdown" });
  expect(await called("sendRichMessage")).toMatchObject({
    rich_message: { markdown: "look:\n```\n┌─┐\n└─┘\n```" },
    message_thread_id: 5,
  });
  writeFileSync(
    join(state, "access.json"),
    JSON.stringify({ allowFrom: [String(OWNER)], textChunkLimit: 40 }),
  );
  await call("reply", { text: `\`\`\`ts\n${"const a = 1\n".repeat(5)}\`\`\``, format: "markdown" });
  writeFileSync(join(state, "access.json"), JSON.stringify({ allowFrom: [String(OWNER)] }));

  const parts = calls
    .filter((c) => c.method === "sendRichMessage")
    .slice(1)
    .flatMap((c) => c.payload.rich_message?.markdown ?? []);

  expect(parts.length).toBeGreaterThan(1);

  for (const part of parts) {
    expect((part.match(/```/gu) ?? []).length % 2).toBe(0);
  }
});

test("a link alone on its line in markdown goes out as plain text, so Telegram shows its preview card", async () => {
  const link = "https://example.com/card/1";
  await call("reply", {
    text: `**Card**\n${link}\n\nsee [docs](https://example.com/docs)\n\`\`\`\nhttps://example.com/in-code\n\`\`\``,
    format: "markdown",
  });
  const plain = await called("sendMessage", (p) => p.text === link);
  expect(plain.message_thread_id).toBe(5);
  expect(
    (
      await called(
        "sendRichMessage",
        (p) => p.rich_message?.markdown.startsWith("**Card**") === true,
      )
    ).rich_message?.markdown,
  ).toBe("**Card**");
  expect(
    (await called("sendRichMessage", (p) => p.rich_message?.markdown.startsWith("see") === true))
      .rich_message?.markdown,
  ).toContain("https://example.com/in-code");
});

test("a newline in markdown stays a new line, where Telegram would join it into the paragraph, and code blocks go as written", async () => {
  const text = [
    "**Status**",
    "• one",
    "• two",
    "ends in a break\\",
    "next",
    "",
    "- a list",
    "- runs on",
    "## Heading",
    "under it",
    "> quoted",
    "",
    "```",
    "code",
    "as is",
    "```",
    "after",
  ].join("\n");

  await call("reply", { text, format: "markdown" });
  expect(
    (
      await called(
        "sendRichMessage",
        (p) => p.rich_message?.markdown.startsWith("**Status**") === true,
      )
    ).rich_message?.markdown,
  ).toBe(
    [
      "**Status**  ",
      "• one  ",
      "• two  ",
      "ends in a break\\",
      "next",
      "",
      "- a list",
      "- runs on",
      "## Heading  ",
      "under it",
      "> quoted",
      "",
      "```",
      "code",
      "as is",
      "```",
      "after",
    ].join("\n"),
  );

  await call("edit_message", {
    message_id: "44",
    text: "Done:\n• shipped\n~~~\ntildes\n```\nstill code\n~~~\nafter\nend",
    format: "markdown",
  });
  expect((await called("editMessageText", (p) => p.message_id === 44)).rich_message).toEqual({
    markdown: "Done:  \n• shipped\n~~~\ntildes\n```\nstill code\n~~~\nafter  \nend",
  });

  await clients
    .get("telegram")
    ?.backfill?.(`${FORUM}:9`, [{ from: "hex", text: "Backfilled:\n• kept" }]);
  expect(
    (
      await called(
        "sendRichMessage",
        (p) => p.rich_message?.markdown.startsWith("Backfilled") === true,
      )
    ).rich_message,
  ).toEqual({ markdown: "Backfilled:  \n• kept" });
});

test("files go without an empty message, short text rides as the caption, and a photo over 10MB goes as a document", async () => {
  const small = join(outbox, `small-${Date.now()}.jpg`);
  const big = join(outbox, `big-${Date.now()}.jpg`);
  writeFileSync(small, "jpg");
  writeFileSync(big, Buffer.alloc(11 * 1024 * 1024));
  const before = calls.length;
  await call("reply", { text: "two shots", files: [small, big] });
  const sent = calls.slice(before);
  expect(sent.map((c) => c.method)).toEqual(["sendPhoto", "sendDocument"]);
  expect(sent[0]?.payload.caption).toBe("two shots");
  expect(sent[1]?.payload.caption).toBeUndefined();
});

test("new_thread opens a topic with a random icon and only the prompt, forwarding nothing; rename_thread renames it and changes its icon", async () => {
  const asked = message({ text: "open a topic for the desk anchors" });
  await update({ message: asked });
  await inbound((line) => line.meta.message_id === String(asked.message_id));
  session({ type: "state", thread: DESK, busy: true });
  await until(() => calls.find((c) => c.method === "sendChatAction"));
  await call("reply", { text: "on it" });
  expect(
    (
      await call("new_thread", {
        title: "Desk",
        prompt: "research desk anchors",
        about: "From desk: the anchors",
      })
    ).text,
  ).toMatch(/^started thread "Desk" in telegram/u);
  expect((await called("createForumTopic")).icon_custom_emoji_id).toMatch(/^(111|222)$/u);
  expect(calls.find((c) => c.method === "forwardMessages")).toBeUndefined();
  session({ type: "state", thread: DESK, busy: false });

  await call("rename_thread", { title: "Anchors", icon: "❤" });
  expect(await called("editForumTopic")).toMatchObject({
    message_thread_id: 5,
    name: "Anchors",
    icon_custom_emoji_id: "222",
  });
  expect((await call("rename_thread", { title: "Desk anchors" })).error).toBe(
    'title must be one word, got "Desk anchors"',
  );
  expect((await call("rename_thread", { icon: "🦄" })).error).toBe(
    "Telegram has no topic icon 🦄; pick one of 🔥 ❤️",
  );
});

const photo = (id: string) => [
  { file_id: `${id}-small`, file_unique_id: `${id}-small`, width: 90, height: 90 },
  { file_id: id, file_unique_id: id, width: 900, height: 900 },
];

test("an album arrives as one message with every photo and the caption, the photos' paths in meta only, where a sender typing one can't forge it", async () => {
  const first = message({ media_group_id: "g1", photo: photo("one"), caption: "the anchors" });
  await update({ message: first });
  await update({ message: message({ media_group_id: "g1", photo: photo("two") }) });
  const album = await inbound((line) => line.meta.message_id === String(first.message_id));
  expect(album.content).toBe("the anchors");
  expect(
    (album.meta.image_path ?? "").split("; ").map((path) => path.replace(/.*\d-/u, "")),
  ).toEqual(["one.jpg", "two.jpg"]);
});

test("a voice message arrives as its transcript, with the recording still attached", async () => {
  const voice = { file_id: "v1", file_unique_id: "v1", duration: 3, mime_type: "audio/ogg" };
  const plain = message({ voice });
  const captioned = message({ voice, caption: "for the desk" });
  await update({ message: plain });
  await update({ message: captioned });
  expect(await inbound((line) => line.meta.message_id === String(plain.message_id))).toMatchObject({
    content: "(voice message) anchors ship friday",
    meta: { attachment_kind: "voice", attachment_file_id: "v1" },
  });
  expect(
    (await inbound((line) => line.meta.message_id === String(captioned.message_id))).content,
  ).toBe("for the desk\n\n(voice message) anchors ship friday");
});

test("a reply to a message in another topic keeps the quote and what the hub knows of it", async () => {
  const sent = await call("reply", { text: "anchors ship friday", thread: "notes" });
  const id = idIn(sent);

  const reply = message({
    text: "still true?",
    external_reply: {
      origin: { type: "user", date: 0, sender_user: hex },
      chat: forum,
      message_id: id,
    },
    quote: { text: "friday", position: 0 },
  });

  await update({ message: reply });
  expect(
    (await inbound((line) => line.meta.message_id === String(reply.message_id))).meta,
  ).toMatchObject({
    reply_to_message_id: String(id),
    reply_to_user: "hex_bot",
    reply_to_text: "anchors ship friday",
    reply_to_quote: "friday",
  });
});

test("the got-it reaction lands on each message when access.json sets one", async () => {
  writeFileSync(
    join(state, "access.json"),
    JSON.stringify({ allowFrom: [String(OWNER)], ackReaction: "👀" }),
  );
  const seen = message({ text: "ping" });
  await update({ message: seen });
  expect(await called("setMessageReaction", (p) => p.message_id === seen.message_id)).toMatchObject(
    { reaction: [{ type: "emoji", emoji: "👀" }] },
  );
  writeFileSync(join(state, "access.json"), JSON.stringify({ allowFrom: [String(OWNER)] }));
});

test("a message no session has read shows it waits, until a session takes it", async () => {
  const waiting = message({ text: "anyone there?", message_thread_id: 6 });
  await update({ message: waiting });
  expect(
    await called("setMessageReaction", (p) => p.message_id === waiting.message_id),
  ).toMatchObject({ reaction: [{ type: "emoji", emoji: "😴" }] });

  const notes = await connectSession({
    stateDir: state,
    path: "/telegram",
    channel: CHANNEL,
    thread: `${FORUM}:6`,
  });

  const handed = await inbound(
    (line) => line.meta.message_id === String(waiting.message_id),
    () => notes.received,
  );

  open(state).messages.take(handed.meta.key ?? "", "notes-session");
  expect(
    await called(
      "setMessageReaction",
      (p) => p.message_id === waiting.message_id && p.reaction?.length === 0,
    ),
  ).toBeTruthy();
  notes.close();

  const marks = () =>
    calls.filter(
      (c) => c.method === "setMessageReaction" && c.payload.message_id === waiting.message_id,
    ).length;

  const before = marks();
  await update({
    edited_message: { ...waiting, text: "anyone there at all?", edit_date: 1_760_000_100 },
  });
  await until(() =>
    calls.some((c) => c.method === "sendChatAction" && c.payload.message_thread_id === 6),
  );
  expect(marks()).toBe(before);
});

const reactionsOn = (id: number) =>
  calls.flatMap((c) =>
    c.method === "setMessageReaction" && c.payload.message_id === id
      ? [(c.payload.reaction ?? []).map((r) => r.emoji).join("")]
      : [],
  );

test("a session's own reaction stays once the message it took stops waiting, and the ack comes back on the other", async () => {
  writeFileSync(
    join(state, "access.json"),
    JSON.stringify({ allowFrom: [String(OWNER)], ackReaction: "👀" }),
  );
  const reacted = message({ text: "first", message_thread_id: 7 });
  const plain = message({ text: "second", message_thread_id: 7 });
  await update({ message: reacted });
  await update({ message: plain });

  await until(
    () =>
      reactionsOn(reacted.message_id).includes("😴") &&
      reactionsOn(plain.message_id).includes("😴"),
  );

  const topic = await connectSession({
    stateDir: state,
    path: "/telegram",
    channel: CHANNEL,
    thread: `${FORUM}:7`,
  });

  const first = await inbound(
    (line) => line.meta.message_id === String(reacted.message_id),
    () => topic.received,
  );

  const second = await inbound(
    (line) => line.meta.message_id === String(plain.message_id),
    () => topic.received,
  );

  await topic.call("react", { message_id: String(reacted.message_id), emoji: "🔥" });
  open(state).messages.take(first.meta.key ?? "", "topic-session");
  open(state).messages.take(second.meta.key ?? "", "topic-session");
  await until(
    () =>
      reactionsOn(plain.message_id).at(-1) === "👀" && reactionsOn(plain.message_id).length === 3,
  );
  expect(reactionsOn(plain.message_id)).toEqual(["👀", "😴", "👀"]);
  expect(reactionsOn(reacted.message_id)).toEqual(["👀", "😴", "🔥"]);
  topic.close();
  writeFileSync(join(state, "access.json"), JSON.stringify({ allowFrom: [String(OWNER)] }));
});

test("a DM is its own thread: it reaches the DM session, not the group, and replies go back to the DM", async () => {
  const dm = await connectSession({
    stateDir: state,
    path: "/telegram",
    channel: CHANNEL,
    thread: String(OWNER),
  });

  const forwards = calls.filter((c) => c.method === "forwardMessage").length;

  await update({
    message: {
      message_id: ++nextMessage,
      date: 1_760_000_000,
      chat: { id: OWNER, type: "private", first_name: "Victor" },
      from: owner,
      text: "quick one",
    },
  });

  const got = await inbound(
    (line) => line.content === "quick one",
    () => dm.received,
  );

  expect(got.meta.chat_id).toBe(String(OWNER));
  expect(calls.filter((c) => c.method === "forwardMessage").length).toBe(forwards);

  await dm.call("reply", { text: "on it, from the DM" });
  expect(await called("sendMessage", (p) => p.text === "on it, from the DM")).toMatchObject({
    chat_id: String(OWNER),
  });
  dm.close();
});

const ledger = () => ({
  pins: Object.fromEntries(
    open(state)
      .pins.list({ app: "telegram" })
      .map((pin) => [pin.thread, pin]),
  ),
});

const asked = (id: number) => {
  const question = open(state).questions.get("telegram", DESK, id);

  if (!question) {
    throw new Error(`no question at ${id}`);
  }

  return question;
};

test("a question with buttons goes in the ledger, and a tap there answers it", async () => {
  const sent = await call("reply", { text: "Deploy now?", buttons: ["Deploy", "Wait"] });
  const id = idIn(sent);
  expect(asked(id)).toMatchObject({
    thread: DESK,
    message: id,
    text: "Deploy now?",
    options: ["Deploy", "Wait"],
  });

  const markup = {
    inline_keyboard: [
      [
        { text: "Deploy", callback_data: "0" },
        { text: "Wait", callback_data: "1" },
      ],
    ],
  };

  await update({
    callback_query: {
      id: "deploy",
      from: owner,
      chat_instance: "x",
      data: "1",
      message: message({ message_id: id, from: hex, text: "Deploy now?", reply_markup: markup }),
    },
  });
  expect(await until(() => asked(id).answer)).toMatchObject({ label: "Wait", via: "telegram" });
});

test("a question answered in the app reaches its thread like a tap, says so on its buttons, and can be taken back", async () => {
  const sent = await call("reply", { text: "Which color?", buttons: ["Mint", "Coral"] });
  const id = idIn(sent);
  session({ type: "answer", thread: DESK, message: id, label: "Coral", via: "app" });
  expect(await called("editMessageReplyMarkup", (p) => p.message_id === id)).toMatchObject({
    reply_markup: { inline_keyboard: [[{ text: "✓ Answered in the app: Coral", disabled: {} }]] },
  });
  const tap = await inbound((line) => line.meta.button_message_id === String(id));
  expect(tap.content).toBe("Coral");
  expect(tap.meta).toMatchObject({ button: "true", user: "hex app", answered_in: "in the app" });
  expect(asked(id).answer).toMatchObject({ label: "Coral", via: "app" });

  session({ type: "reopen", thread: DESK, message: id, via: "app" });
  expect(
    await called(
      "editMessageReplyMarkup",
      (p) => p.message_id === id && p.reply_markup?.inline_keyboard[0]?.length === 2,
    ),
  ).toMatchObject({
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Mint", callback_data: "0" },
          { text: "Coral", callback_data: "1" },
        ],
      ],
    },
  });
  expect((await inbound((line) => line.meta.took_back === "Coral")).content).toBe(
    "(took back: Coral)",
  );
  expect(asked(id).answer).toBeUndefined();
});

test("an answer taken back right away gets its buttons back, even when the answer's own edit lands late", async () => {
  const id = idIn(await call("reply", { text: "Which day?", buttons: ["Mon", "Tue"] }));

  slow.add(id);
  session({ type: "answer", thread: DESK, message: id, label: "Tue", via: "app" });
  await inbound((line) => line.meta.button_message_id === String(id) && line.content === "Tue");
  session({ type: "reopen", thread: DESK, message: id, via: "app" });
  await inbound((line) => line.meta.took_back === "Tue");
  await until(() => landed.filter((edit) => edit.message_id === id).length === 2);
  expect(landed.findLast((edit) => edit.message_id === id)?.reply_markup).toEqual({
    inline_keyboard: [
      [
        { text: "Mon", callback_data: "0" },
        { text: "Tue", callback_data: "1" },
      ],
    ],
  });
});

test("of two taps on one question only the first counts: the thread hears it once, and the later tap's buttons go back to it", async () => {
  const id = idIn(await call("reply", { text: "Ship tonight?", buttons: ["Ship", "Hold"] }));

  const markup = {
    inline_keyboard: [
      [
        { text: "Ship", callback_data: "0" },
        { text: "Hold", callback_data: "1" },
      ],
    ],
  };

  const tap = (callback: string, data: string) =>
    update({
      callback_query: {
        id: callback,
        from: owner,
        chat_instance: "x",
        data,
        message: message({
          message_id: id,
          from: hex,
          text: "Ship tonight?",
          reply_markup: markup,
        }),
      },
    });

  await Promise.all([tap("ship", "0"), tap("hold", "1")]);
  const label = asked(id).answer?.label ?? "";

  const shown = () =>
    calls.findLast((c) => c.method === "editMessageReplyMarkup" && c.payload.message_id === id)
      ?.payload.reply_markup?.inline_keyboard[0]?.[0]?.text;

  await until(() => shown() === `✓ ${label}`);
  await inbound((line) => line.meta.button_message_id === String(id));
  expect(
    inboundOf(desk.received)
      .filter((line) => line.meta.button_message_id === String(id))
      .map((line) => line.content),
  ).toEqual([label]);
  expect(
    open(state)
      .db.query(
        "select count(*) as n from messages where json_extract(meta, '$.button_message_id') = ?",
      )
      .get(String(id)),
  ).toEqual({ n: 1 });
});

test("a settled question loses its buttons without reaching its thread, and an edit keeps a question open with its buttons until it says it settled", async () => {
  const first = idIn(await call("reply", { text: "Buy the domain?", buttons: ["Buy", "Skip"] }));

  const before = received().length;
  session({ type: "settle", thread: DESK, message: first, note: "Settled: bought on Oct 12" });
  expect(await called("editMessageReplyMarkup", (p) => p.message_id === first)).toMatchObject({
    reply_markup: { inline_keyboard: [[{ text: "Settled: bought on Oct 12", disabled: {} }]] },
  });
  expect(await until(() => asked(first).settled)).toMatchObject({
    note: "Settled: bought on Oct 12",
  });
  expect(
    received()
      .slice(before)
      .filter((line) => line.type === "inbound"),
  ).toEqual([]);

  const second = idIn(await call("reply", { text: "Rename it?", buttons: ["Yes", "No"] }));

  await call("edit_message", { message_id: String(second), text: "Rename it? It reads better." });
  expect(await called("editMessageText", (p) => p.message_id === second)).toMatchObject({
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Yes", callback_data: "0" },
          { text: "No", callback_data: "1" },
        ],
      ],
    },
  });
  expect(asked(second).settled).toBeUndefined();
  await call("edit_message", {
    message_id: String(second),
    text: "Renamed, as you said in the call.",
    settled: true,
  });
  expect(
    await called(
      "editMessageText",
      (p) => p.message_id === second && p.text === "Renamed, as you said in the call.",
    ),
  ).not.toHaveProperty("reply_markup");
  expect(await called("editMessageReplyMarkup", (p) => p.message_id === second)).toMatchObject({
    reply_markup: { inline_keyboard: [[{ text: "✓ Settled", disabled: {} }]] },
  });
  expect(asked(second).settled).toMatchObject({ note: "✓ Settled" });

  const third = idIn(await call("reply", { text: "Keep the old name?", buttons: ["Yes", "No"] }));

  await call("edit_message", { message_id: String(third), settled: true });
  expect(await called("editMessageReplyMarkup", (p) => p.message_id === third)).toMatchObject({
    reply_markup: { inline_keyboard: [[{ text: "✓ Settled", disabled: {} }]] },
  });
  expect(asked(third)).toMatchObject({
    text: "Keep the old name?",
    settled: { note: "✓ Settled" },
  });
  expect((await call("edit_message", { message_id: String(third) })).error).toBe(
    "edit_message needs text, a file, or settled",
  );
});

test("another thread, or the DM, quotes and settles a question by its key, and a settle that finds none says so", async () => {
  const id = idIn(await call("reply", { text: "Ship the site?", buttons: ["Ship", "Wait"] }));

  const general = await connectSession({
    stateDir: state,
    path: "/telegram",
    channel: CHANNEL,
    thread: String(FORUM),
  });

  const dm = await connectSession({
    stateDir: state,
    path: "/telegram",
    channel: CHANNEL,
    thread: String(OWNER),
  });

  const reminder = idIn(
    await dm.call("reply", {
      text: "Still waiting: ship the site?",
      reply_to: `telegram:${FORUM}:${id}`,
    }),
  );

  expect(
    await called("sendMessage", (p) => p.text === "Still waiting: ship the site?"),
  ).toMatchObject({
    chat_id: String(OWNER),
    reply_parameters: { message_id: id, chat_id: String(FORUM) },
  });
  expect(open(state).questions.get("telegram", String(OWNER), reminder)).toBeNull();
  await general.call("reply", { text: "Ship the site, in Desk", reply_to: String(id) });
  expect(
    (await called("sendMessage", (p) => p.text === "Ship the site, in Desk")).reply_parameters,
  ).toEqual({ message_id: id });
  expect((await general.call("edit_message", { message_id: String(id), settled: true })).text).toBe(
    `settled (id: ${id})`,
  );
  expect(asked(id).settled).toMatchObject({ note: "✓ Settled" });
  expect(
    (await dm.call("edit_message", { message_id: `telegram:${FORUM}:${id}`, settled: true })).text,
  ).toBe(`no question waits on message ${id}, so nothing was settled`);
  general.close();
  dm.close();
});

test("a poll's screenshots go above it as one album, each captioned with its option, and its question keeps them", async () => {
  const one = join(outbox, `one-${Date.now()}.png`);
  const both = join(outbox, `both-${Date.now()}.png`);
  writeFileSync(one, "png");
  writeFileSync(both, "png");

  expect(
    (await call("poll", { question: "Buttons?", options: ["One", "Both"], files: [one] })).error,
  ).toContain("one screenshot per option");

  const before = calls.length;

  const id = idIn(
    await call("poll", { question: "Buttons?", options: ["One", "Both"], files: [one, both] }),
  );

  const [album, poll] = calls.slice(before);

  expect(album?.method).toBe("sendMediaGroup");
  expect(album?.payload.media).toMatchObject([{ caption: "One" }, { caption: "Both" }]);
  expect(poll?.payload.reply_parameters).toEqual({ message_id: id - 2 });

  const kept = asked(id).shots ?? [];

  expect(kept.map((shot) => readFileSync(shot, "utf-8"))).toEqual(["png", "png"]);
  expect(kept.some((shot) => shot.startsWith(outbox))).toBe(false);
});

test("edit_message settles a poll even with text, which a poll can't change, and without settled says so", async () => {
  const id = idIn(await call("poll", { question: "Ship it?", options: ["Yes", "No"] }));

  expect(
    (await call("edit_message", { message_id: String(id), text: "Ship it? Shipped." })).error,
  ).toContain("a poll's own text can't be edited");
  expect(asked(id).settled).toBeUndefined();
  expect(
    (
      await call("edit_message", {
        message_id: String(id),
        text: "Settled: shipped",
        settled: true,
      })
    ).text,
  ).toContain("settled the poll");
  expect(await called("stopPoll", (p) => p.message_id === id)).toBeTruthy();
  expect(asked(id).settled).toMatchObject({ note: "✓ Settled" });

  const voted = idIn(await call("poll", { question: "Ship it today?", options: ["Yes", "No"] }));

  await update({
    poll_answer: {
      poll_id: `poll-${voted}`,
      user: owner,
      option_ids: [1],
      option_persistent_ids: [],
    },
  });
  await until(() => asked(voted).answer);
  expect(
    (await call("edit_message", { message_id: String(voted), text: "Settled", settled: true }))
      .text,
  ).toContain("already answered (No)");
  expect(calls.some((c) => c.method === "stopPoll" && c.payload.message_id === voted)).toBe(false);
});

test("a poll answered in the app closes, and its vote reaches the thread", async () => {
  const id = idIn(await call("poll", { question: "Which take?", options: ["A", "B"] }));

  expect(asked(id)).toMatchObject({ options: ["A", "B"], poll: `poll-${id}` });
  session({ type: "answer", thread: DESK, message: id, label: "B", via: "call" });
  expect(await called("stopPoll", (p) => p.message_id === id)).toBeTruthy();
  expect(
    (
      await inbound(
        (line) => line.meta.poll_message_id === String(id) && line.meta.answered_in !== undefined,
      )
    ).meta,
  ).toMatchObject({ vote: "B", answered_in: "on a call", user: "hex call" });
});

test("a message edited before it is forwarded goes with its new text", async () => {
  const id = idIn(await call("reply", { text: "Status: drafting" }));
  await call("edit_message", { message_id: String(id), text: "Status: live" });

  const forwarded = idIn(await call("forward", { message_id: String(id), thread: "notes" }));

  expect(open(state).messages.get(`telegram:${FORUM}:${forwarded}`)?.body).toBe("Status: live");
});

test("a status post is the session's note over lines hex keeps current from the thread's questions and tasks", async () => {
  const id = idIn(await call("pin", { note: "Site: example.com" }));

  const sent = await called(
    "sendRichMessage",
    (p) => p.rich_message?.markdown.startsWith("Site: example.com") === true,
  );

  expect(sent.rich_message?.markdown).toStartWith("Site: example.com\n\n**Waiting on you");
  expect(await called("pinChatMessage", (p) => p.message_id === id)).toBeTruthy();
  expect(ledger().pins[DESK]).toMatchObject({ message: id, note: "Site: example.com" });

  const edits = () =>
    calls
      .filter((c) => c.method === "editMessageText" && c.payload.message_id === id)
      .flatMap((c) => c.payload.rich_message?.markdown ?? []);

  await call("reply", { text: "Rename the site?", buttons: ["Yes", "No"] });
  await until(() =>
    /\n- \[Rename the site\?\]\(https:\/\/t\.me\/c\/\d+\/\d+\/\d+\)/u.test(edits().at(-1) ?? ""),
  );

  const count = edits().length;
  expect(
    (await call("edit_message", { message_id: String(id), text: "Site: example.org" })).text,
  ).toStartWith("edited the status post's note");
  expect(edits()).toHaveLength(count + 1);
  expect(edits().at(-1)).toStartWith("Site: example.org\n\n**Waiting on you**");
  expect(edits().at(-1)).toContain("[Rename the site?]");
  expect(ledger().pins[DESK]).toMatchObject({ message: id, note: "Site: example.org" });
  expect(
    (
      await call("edit_message", {
        message_id: String(id),
        text: "Site",
        file: join(state, "access.json"),
      })
    ).error,
  ).toBe("a status post is text: send the file in its own message");

  const next = idIn(await call("pin", { note: "Site: v2" }));
  expect(await called("unpinChatMessage", (p) => p.message_id === id)).toBeTruthy();
  expect(ledger().pins[DESK]).toMatchObject({ message: next, note: "Site: v2" });
  expect((await call("pin", { unpin: true })).text).toBe(`unpinned the status post (id: ${next})`);
  expect(ledger().pins[DESK]).toBeUndefined();
});

test("a thread's link is where Telegram opens it: a topic, General, or for a DM, the bot", () => {
  expect(saved()[DESK]?.link).toBe("https://t.me/c/1234/5");
  expect(saved()[String(OWNER)]).toMatchObject({ link: "https://t.me/hex_bot" });
});

test("a backfill quotes the owner under their name and posts hex as itself, silently, split to fit and waiting out the rate limit", async () => {
  const from = calls.length;
  throttled = 1;
  await clients.get("telegram")?.backfill?.(`${FORUM}:9`, [
    { from: "me", text: "how full is your context?" },
    { from: "hex", text: "**Roomy.**" },
    { from: "me", text: "a".repeat(5000) },
  ]);
  const sent = calls.slice(from).filter((c) => c.method.startsWith("send"));
  expect(
    sent.map((c) => [c.method, c.payload.message_thread_id, c.payload.disable_notification]),
  ).toEqual([
    ["sendMessage", 9, true],
    ["sendMessage", 9, true],
    ["sendRichMessage", 9, true],
    ["sendMessage", 9, true],
    ["sendMessage", 9, true],
  ]);
  expect(sent[1]?.payload).toMatchObject({
    text: "Victor\nhow full is your context?",
    entities: [
      { type: "bold", offset: 0, length: 6 },
      { type: "blockquote", offset: 7, length: 25 },
    ],
  });
  expect(sent[2]?.payload.rich_message).toEqual({ markdown: "**Roomy.**" });
  expect(sent.slice(3).map((c) => c.payload.text?.length)).toEqual([4096, 5000 - 4089 + 7]);
});

test("a backfill shows the owner's photos and clips themselves, an album under their name and words, and the line for one whose file is gone", async () => {
  const shot = join(outbox, `p-${Date.now()}.jpg`);
  const clip = join(outbox, `v-${Date.now()}.mp4`);
  writeFileSync(shot, "jpg");
  writeFileSync(clip, "mp4");
  const from = calls.length;
  await clients.get("telegram")?.backfill?.(`${FORUM}:9`, [
    { from: "me", text: "this one?\n(photo)", media: [{ id: "p", kind: "photo", file: shot }] },
    {
      from: "me",
      text: "(photo)\n(video 0:04, 1 still, no sound)",
      media: [
        { id: "p", kind: "photo", file: shot },
        { id: "v", kind: "video", file: clip },
      ],
    },
    {
      from: "me",
      text: "gone\n(photo)",
      media: [{ id: "q", kind: "photo", file: `${shot}.gone` }],
    },
  ]);
  const sent = calls.slice(from).filter((c) => c.method.startsWith("send"));
  expect(
    sent.map((c) => [c.method, c.payload.message_thread_id, c.payload.disable_notification]),
  ).toEqual([
    ["sendPhoto", 9, true],
    ["sendMediaGroup", 9, true],
    ["sendMessage", 9, true],
  ]);
  expect(sent[0]?.payload).toMatchObject({
    caption: "Victor\nthis one?",
    caption_entities: [
      { type: "bold", offset: 0, length: 6 },
      { type: "blockquote", offset: 7, length: 9 },
    ],
  });
  expect(sent[1]?.payload.media).toMatchObject([
    {
      type: "photo",
      caption: "Victor",
      caption_entities: [{ type: "bold", offset: 0, length: 6 }],
    },
    { type: "video" },
  ]);
  expect(sent[2]?.payload.text).toBe("Victor\ngone\n(photo)");
});

test("/effort and /model set what the thread's next message starts with, and never reach its session, unlike a path", async () => {
  expect((await called("setMyCommands")).commands?.map((c) => c.command)).toEqual([
    "model",
    "effort",
  ]);
  const before = received().length;
  await update({ message: message({ text: "/tmp/cache is full" }) });
  await inbound((line) => line.content === "/tmp/cache is full");
  await update({ message: message({ text: "/model@other_bot opus" }) });
  await inbound((line) => line.content === "/model@other_bot opus");
  await update({ message: message({ text: "/Model@hex_bot gpt" }) });
  await called("sendMessage", (p) => p.text === "/model takes one of: opus, sonnet, haiku, fable");
  await update({ message: message({ text: "/effort high" }) });
  expect(
    await called("sendMessage", (p) => p.text === "Effort: High, from this thread's next message."),
  ).toMatchObject({ message_thread_id: 5 });
  expect(saved()[DESK]?.effort).toBe("high");
  expect(
    received()
      .slice(before)
      .filter((line) => line.type === "inbound")
      .map((line) => line.content),
  ).toEqual(["/tmp/cache is full", "/model@other_bot opus"]);
});

test("set_model sets what the thread's next message starts with, when the user tells hex", async () => {
  expect((await call("set_model", { model: "opus", effort: "xhigh" })).text).toBe(
    "Opus, Extra High effort, from this thread's next message",
  );
  expect(saved()[DESK]).toMatchObject({ model: "opus", effort: "xhigh" });
  await call("set_model", { effort: "low" });
  expect(saved()[DESK]).toMatchObject({ model: "opus", effort: "low" });
  expect((await call("set_model", {})).error).toMatch(
    /^set_model takes a model \(opus, sonnet, haiku, fable\)/u,
  );
  expect((await call("set_model", { model: "gpt" })).error).toMatch(
    /expected one of "opus"\|"sonnet"\|"haiku"\|"fable"/u,
  );
});
