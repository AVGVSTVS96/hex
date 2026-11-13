#!/usr/bin/env bun
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  realpathSync,
  chmodSync,
  copyFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, extname, sep } from "node:path";
import { deflateSync } from "node:zlib";

import {
  startHub,
  clients,
  begin,
  dispatch,
  move,
  preview,
  tappable,
  title,
  transcribe,
  typed,
  pictureOf,
  EFFORTS,
  MODELS,
  Ledger,
  open as openStore,
  sinceToday,
  stateDir,
  waits,
} from "@hex/hub";
import type { Call, Handlers, Message, Permission, Turn, Post } from "@hex/hub";
import { Bot, GrammyError, InputFile } from "grammy";
import type { Context } from "grammy";
import type {
  Chat,
  InlineKeyboardMarkup,
  InputMediaPhoto,
  InputMediaVideo,
  Message as Sent,
  MessageEntity,
  MessageOrigin,
  ReactionTypeEmoji,
  User,
} from "grammy/types";
import { z } from "zod";

import { HTML, Keeper } from "./board.ts";
import type { State } from "./board.ts";
import { server, tools } from "./channel.ts";

// grammY 1.46 predates Bot API 10.4's widgets: https://core.telegram.org/bots/api#sendwidget
type WidgetQuery = { id: string; from: User; chat?: Chat; message_id?: number; data: string };

declare module "grammy/types" {
  interface Update {
    widget_query?: WidgetQuery;
  }
}

type WidgetState = { chat_data?: string; public_data?: string };

type Widgets = {
  sendWidget: (
    args: WidgetState & {
      chat_id: string;
      message_thread_id?: number;
      html: string;
      caption: string;
      width?: number;
      height?: number;
      allow_queries: boolean;
      reply_markup?: InlineKeyboardMarkup;
    },
  ) => Promise<Sent>;
  editMessageWidgetData: (
    args: WidgetState & { chat_id: string; message_id: number },
  ) => Promise<true>;
  answerWidgetQuery: (args: { widget_query_id: string; data?: string }) => Promise<true>;
};

const STATE_DIR =
  process.env.TELEGRAM_STATE_DIR ?? join(homedir(), ".claude", "channels", "hex", "telegram");

const ACCESS_FILE = join(STATE_DIR, "access.json");
const ENV_FILE = join(STATE_DIR, ".env");
const INBOX_DIR = join(STATE_DIR, "inbox");
const KEPT_POLL_SHOTS_DIR = join(STATE_DIR, "shots");
const MAIN = process.env.HEX_MAIN_THREAD;

// oxlint-disable-next-line eslint/no-empty-function -- what Telegram refuses here (a chat action, a reaction, a button's look) changes nothing hex relies on
const ignore = () => {};

function readEnvFile(): string {
  try {
    chmodSync(ENV_FILE, 0o600);

    return readFileSync(ENV_FILE, "utf-8");
  } catch {
    return "";
  }
}

for (const line of readEnvFile().split("\n")) {
  const [, name, value] = /^(\w+)=(.*)$/u.exec(line) ?? [];

  if (name !== undefined && value !== undefined) {
    process.env[name] = value;
  }
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";

if (TOKEN === "") {
  process.stderr.write(`telegram hub: TELEGRAM_BOT_TOKEN required in ${ENV_FILE}\n`);
  process.exit(1);
}

process.on("unhandledRejection", (err) => {
  process.stderr.write(`telegram hub: unhandled rejection: ${String(err)}\n`);
});

process.on("uncaughtException", (err) => {
  process.stderr.write(`telegram hub: uncaught exception: ${String(err)}\n`);
});

const bot = new Bot(TOKEN);

// SAFETY: grammY's raw API sends any method by name, through the same transformers as every other call.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- grammY's types don't know the widget methods yet
const widgets: Widgets = bot.api.raw as never;

const accessFile = z.object({
  allowFrom: z.array(z.string()).default([]),
  ackReaction: z
    .string()
    .describe(
      "Emoji to react with on receipt. Empty string disables. Telegram only accepts its fixed whitelist.",
    )
    .optional(),
  replyToMode: z
    .enum(["off", "first", "all"])
    .describe(
      "Which chunks get Telegram's reply reference when reply_to is passed. Default: 'first'. 'off' = never thread.",
    )
    .optional(),
  textChunkLimit: z
    .number()
    .describe(
      "Max chars per outbound message before splitting. Default: Telegram's hard cap, 4096 (32768 for format 'markdown').",
    )
    .optional(),
  chunkMode: z
    .enum(["length", "newline"])
    .describe("Split on paragraph boundaries instead of hard char count.")
    .optional(),
});

type Access = z.infer<typeof accessFile>;

function loadAccess(): Access {
  try {
    return accessFile.parse(JSON.parse(readFileSync(ACCESS_FILE, "utf-8")));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      process.stderr.write(
        `telegram hub: ${ACCESS_FILE} is unreadable, so every sender is dropped: ${String(error)}\n`,
      );
    }

    return { allowFrom: [] };
  }
}

const MAX_CHUNK_LIMIT = 4096;
const MAX_RICH_LIMIT = 32_768;
const MAX_CAPTION = 1024;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const ALBUM_WAIT = 1000;

function assertSendable(f: string): void {
  let real;
  let stateReal: string;

  try {
    real = realpathSync(f);
    stateReal = realpathSync(STATE_DIR);
  } catch {
    return;
  }

  const inbox = join(stateReal, "inbox");

  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`);
  }

  if (basename(real) === ".env") {
    throw new Error(`refusing to send secrets: ${f}`);
  }
}

function chunk(text: string, limit: number, mode: "length" | "newline"): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const out: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    let cut = limit;

    if (mode === "newline") {
      const para = rest.lastIndexOf("\n\n", limit);
      const line = rest.lastIndexOf("\n", limit);
      const space = rest.lastIndexOf(" ", limit);
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit;
    }

    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/u, "");
  }

  if (rest) {
    out.push(rest);
  }

  return out;
}

function chunkClosingCodeBlocks(text: string, limit: number, mode: "length" | "newline"): string[] {
  const out: string[] = [];
  let open = "";

  for (const part of chunk(text, limit - 16, mode)) {
    let body = open ? `${open}\n${part}` : part;

    for (const line of part.split("\n")) {
      const fence = /^\s*```(\S*)/u.exec(line);

      if (fence) {
        open = open ? "" : `\`\`\`${fence[1] ?? ""}`;
      }
    }

    if (open) {
      body += "\n```";
    }

    out.push(body);
  }

  return out;
}

// Rich Markdown joins a paragraph's lines into one, as CommonMark does (https://spec.commonmark.org/0.31.2/#soft-line-breaks), but a chat reply's newline is a new line, so each line that runs on into the next ends in a hard break: two spaces.
function keepLines(markdown: string): string {
  let fence = "";

  return markdown
    .split("\n")
    .map((line, i, lines) => {
      const [, marker, after] = /^\s*(`{3,}|~{3,})(.*)$/u.exec(line) ?? [];

      if (fence) {
        if (marker?.startsWith(fence) === true && after?.trim() === "") {
          fence = "";
        }

        return line;
      }

      if (marker !== undefined) {
        fence = marker;

        return line;
      }

      const next = lines[i + 1];

      const runsOn =
        line.trim() !== "" &&
        !line.endsWith("\\") &&
        next !== undefined &&
        next.trim() !== "" &&
        !/^\s*([-*+]\s|\d+[.)]\s|#{1,6}(\s|$)|>|\||`{3}|~{3})/u.test(next);

      return runsOn ? `${line}  ` : line;
    })
    .join("\n");
}

type Outgoing = { text: string; card?: true };

// Telegram never previews a link in a rich message, and sendRichMessage takes no link_preview_options (https://core.telegram.org/bots/api#inputrichmessage), so a link alone on its line goes out as its own plain message, where Telegram shows its card.
function withCards(markdown: string): Outgoing[] {
  const parts: Outgoing[] = [];
  let rich: string[] = [];
  let fence = "";

  const flush = () => {
    const text = rich.join("\n").trim();

    if (text !== "") {
      parts.push({ text });
    }

    rich = [];
  };

  for (const line of markdown.split("\n")) {
    const [, marker, after] = /^\s*(`{3,}|~{3,})(.*)$/u.exec(line) ?? [];

    const link =
      fence === "" && marker === undefined
        ? /^\s*<?(https?:\/\/[^\s<>]+?)>?\s*$/u.exec(line)?.[1]
        : undefined;

    if (link !== undefined) {
      flush();
      parts.push({ text: link, card: true });
      continue;
    }

    if (fence === "") {
      fence = marker ?? "";
    } else if (marker?.startsWith(fence) === true && after?.trim() === "") {
      fence = "";
    }

    rich.push(line);
  }

  flush();

  return parts;
}

// Telegram compresses these and shows them inline, up to its 10MB photo cap (https://core.telegram.org/bots/api#sendphoto); anything else, or bigger, goes as a document.
const PHOTO_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

function asPhoto(f: string): boolean {
  assertSendable(f);
  const { size } = statSync(f);

  if (size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`file too large: ${f} (${(size / 1024 / 1024).toFixed(1)}MB, max 50MB)`);
  }

  return PHOTO_EXTS.has(extname(f).toLowerCase()) && size <= MAX_PHOTO_BYTES;
}

function threadOf(ctx: Context): string {
  if (!ctx.chat) {
    throw new Error("an update with no chat has no thread");
  }

  const chat = String(ctx.chat.id);

  if (ctx.msg?.is_topic_message !== true) {
    return chat;
  }

  const topic = ctx.msg.message_thread_id;

  return ctx.chat.type === "private" ? (homeOf(topic) ?? chat) : `${chat}:${topic}`;
}

function target(thread: string) {
  const [chat_id = thread, topic = ""] = thread.split(":");

  return { chat_id, extra: topic ? { message_thread_id: Number(topic) } : {} };
}

function located(thread: string, ref: string) {
  const [, linkChat, linkMessage] = /t\.me\/c\/(\d+)\/(?:\d+\/)?(\d+)/u.exec(ref) ?? [];

  if (linkChat !== undefined) {
    return { chat_id: `-100${linkChat}`, message: Number(linkMessage) };
  }

  const [, keyChat, keyMessage] = /^(?:telegram:)?(-?\d+)(?::\d+)?:(\d+)$/u.exec(ref) ?? [];

  return keyChat === undefined
    ? { chat_id: target(thread).chat_id, message: Number(ref) }
    : { chat_id: keyChat, message: Number(keyMessage) };
}

function questionAt({ chat_id, message }: { chat_id: string; message: number }) {
  const here = ledger.questions.filter(
    (question) => question.thread === chat_id || question.thread.startsWith(`${chat_id}:`),
  );

  return (
    here.find((question) => String(question.message) === String(message)) ??
    here.find(
      (question) =>
        question.asker !== undefined &&
        waits(question) &&
        String(question.answer?.message) === String(message),
    )
  );
}

const topicNames = new Map<string, string>();

// Telegram shows widgets only in private chats, so a group topic's widgets go to a topic of its own in the owner's DM with hex, once topics are on for the bot in BotFather; what the owner says there reaches the group topic's session. https://core.telegram.org/bots/api#createforumtopic
const DM_TOPICS_FILE = join(STATE_DIR, "dm-topics.json");
const dmTopicsFile = z.record(z.string(), z.number());

const dmTopics = new Map(
  Object.entries(
    existsSync(DM_TOPICS_FILE)
      ? dmTopicsFile.parse(JSON.parse(readFileSync(DM_TOPICS_FILE, "utf-8")))
      : {},
  ),
);

function keepDmTopics(): void {
  writeFileSync(DM_TOPICS_FILE, `${JSON.stringify(Object.fromEntries(dmTopics), null, 2)}\n`);
}

function homeOf(topic: number | undefined): string | undefined {
  return [...dmTopics].find(([, each]) => each === topic)?.[0];
}

const makingDmTopics = new Map<string, Promise<number>>();

async function dmTopic(owner: string, thread: string): Promise<number | undefined> {
  if (!bot.botInfo.has_topics_enabled) {
    return undefined;
  }

  const known = dmTopics.get(thread);

  if (known !== undefined) {
    return known;
  }

  const name = (topicNames.get(thread) ?? hub.name(thread) ?? "Topic").slice(0, 128);

  const making =
    makingDmTopics.get(thread) ??
    bot.api.createForumTopic(owner, name).then(({ message_thread_id }) => {
      dmTopics.set(thread, message_thread_id);
      keepDmTopics();

      return message_thread_id;
    });

  makingDmTopics.set(thread, making);

  try {
    return await making;
  } finally {
    makingDmTopics.delete(thread);
  }
}

const ledger = new Ledger(STATE_DIR, "telegram");

const post: Post = {
  room: MAX_CHUNK_LIMIT,
  send: async (thread, text) => {
    const { chat_id, extra } = target(thread);
    const sent = await bot.api.sendRichMessage(chat_id, { markdown: keepLines(text) }, extra);

    said(thread, sent.message_id, text);

    return sent.message_id;
  },
  pin: (thread, message) => bot.api.pinChatMessage(target(thread).chat_id, Number(message)),
  unpin: async (thread, message) => {
    try {
      await bot.api.unpinChatMessage(target(thread).chat_id, Number(message));
    } catch (error) {
      if (!/message to unpin not found|message not found/u.test(String(error))) {
        throw error;
      }
    }
  },
  edit: async (thread, message, text) => {
    try {
      await paced(() =>
        bot.api.editMessageText(
          target(thread).chat_id,
          Number(message),
          { markdown: keepLines(text) },
          { link_preview_options: { is_disabled: true } },
        ),
      );
    } catch (error) {
      if (String(error).includes("message is not modified")) {
        return;
      }

      if (
        /message can't be edited|message to edit not found|no text in the message|bot was kicked|chat not found/u.test(
          String(error),
        )
      ) {
        return null;
      }

      throw error;
    }
  },
  link: (thread, message) => {
    const [chat = thread, topic] = thread.split(":");

    return chat.startsWith("-100")
      ? `https://t.me/c/${[chat.slice(4), topic, message].filter(Boolean).join("/")}`
      : undefined;
  },
};

function said(
  thread: string,
  id: number | undefined,
  text = "",
  meta: Record<string, string> = {},
): void {
  hub.sent(thread, {
    ...(id !== undefined && { key: `${target(thread).chat_id}:${id}` }),
    content: text,
    meta,
  });
}

function me(): string {
  return bot.botInfo.username;
}

function retire(thread: string): Promise<string> {
  return hub.retire(thread);
}

function nameOf(ctx: Context, thread: string): string {
  const created = ctx.msg?.reply_to_message?.forum_topic_created;

  if (created) {
    topicNames.set(thread, created.name);
  }

  return (
    topicNames.get(thread) ??
    (thread.includes(":")
      ? `topic ${thread.split(":")[1]}`
      : ctx.chat?.type === "private"
        ? "DM"
        : "main")
  );
}

async function download(file_id: string, uniqueId: string): Promise<string> {
  const file = await bot.api.getFile(file_id);

  if (file.file_path === undefined || file.file_path === "") {
    throw new Error("Telegram returned no file_path — file may have expired");
  }

  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`);

  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status}`);
  }

  const rawExt = file.file_path.includes(".") ? (file.file_path.split(".").pop() ?? "") : "bin";
  const ext = rawExt.replaceAll(/[^a-zA-Z0-9]/gu, "") || "bin";
  const id = uniqueId.replaceAll(/[^a-zA-Z0-9_-]/gu, "") || "dl";
  const path = join(INBOX_DIR, `${Date.now()}-${id}.${ext}`);
  mkdirSync(INBOX_DIR, { recursive: true });
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));

  return path;
}

const typing = new Map<string, ReturnType<typeof setInterval>>();
const forums = new Map<string, Promise<boolean>>();

// In a forum, General is topic 1: chat actions need that id to show inside it, while messages sent with it fail ("message thread not found"). https://core.telegram.org/bots/api#sendchataction
const GENERAL_TOPIC = 1;

async function typingTarget(thread: string) {
  const { chat_id, extra } = target(thread);

  if (thread.includes(":")) {
    return { chat_id, extra };
  }

  if (!forums.has(chat_id)) {
    forums.set(
      chat_id,
      bot.api.getChat(chat_id).then(
        (chat) => "is_forum" in chat && chat.is_forum === true,
        () => false,
      ),
    );
  }

  return {
    chat_id,
    extra: (await forums.get(chat_id)) === true ? { message_thread_id: GENERAL_TOPIC } : {},
  };
}

function sendTyping(thread: string): void {
  void typingTarget(thread)
    .then(({ chat_id, extra }) => bot.api.sendChatAction(chat_id, "typing", extra))
    .catch(ignore);
}

// Telegram shows "typing…" for about 5 seconds per chat action (https://core.telegram.org/bots/api#sendchataction), so it is sent again for as long as the thread's session is busy.
const RESEND_TYPING_EVERY = 4000;

function showTyping(thread: string, busy: boolean): void {
  process.stderr.write(`telegram hub: ${thread} ${busy ? "busy" : "idle"}\n`);
  clearInterval(typing.get(thread));
  typing.delete(thread);

  if (!busy) {
    return;
  }

  sendTyping(thread);
  typing.set(
    thread,
    setInterval(() => {
      sendTyping(thread);
    }, RESEND_TYPING_EVERY),
  );
}

const asking = new Map<string, Set<number>>();

async function ask(thread: string, request: Permission): Promise<void> {
  const { request_id, tool_name, description } = request;
  const { chat_id, extra } = target(thread);
  const text = `🔐 ${tool_name}: ${description}\n\n${preview(request)}`.slice(0, MAX_CHUNK_LIMIT);

  try {
    const sent = await bot.api.sendMessage(chat_id, text, {
      ...extra,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Allow", callback_data: `perm:allow:${request_id}` },
            { text: "Deny", callback_data: `perm:deny:${request_id}` },
          ],
        ],
      },
    });

    said(thread, sent.message_id, text, { permission: request_id });
    asking.set(thread, (asking.get(thread) ?? new Set()).add(sent.message_id));
  } catch (error) {
    process.stderr.write(
      `telegram hub: couldn't relay a permission prompt to ${thread}: ${String(error)}\n`,
    );
  }
}

function settle(thread: string, busy: boolean, background: boolean): void {
  showTyping(thread, busy);

  if (busy || background) {
    return;
  }

  const { chat_id } = target(thread);

  for (const id of asking.get(thread) ?? []) {
    void bot.api
      .editMessageReplyMarkup(chat_id, id, {
        reply_markup: { inline_keyboard: [[{ text: "No longer waiting", disabled: {} }]] },
      })
      .catch(ignore);
  }

  asking.delete(thread);
}

async function icons() {
  const stickers = await bot.api.getForumTopicIconStickers();

  return stickers.flatMap(({ emoji, custom_emoji_id }) =>
    emoji !== undefined && emoji !== "" && custom_emoji_id !== undefined && custom_emoji_id !== ""
      ? [{ emoji, custom_emoji_id }]
      : [],
  );
}

const withoutVariationSelector = (emoji: string) => emoji.replaceAll("️", "");

async function iconOf(emoji: string): Promise<string> {
  const all = await icons();

  const icon = all.find(
    (sticker) => withoutVariationSelector(sticker.emoji) === withoutVariationSelector(emoji.trim()),
  );

  if (!icon) {
    throw new Error(
      `Telegram has no topic icon ${emoji}; pick one of ${all.map((sticker) => sticker.emoji).join(" ")}`,
    );
  }

  return icon.custom_emoji_id;
}

async function place(name: string, _where?: string, about?: string) {
  if (MAIN === undefined || MAIN === "") {
    throw new Error("topics need HEX_MAIN_THREAD, the group they open in");
  }

  const { chat_id } = target(MAIN);

  const icon = await icons()
    .then((all) => all[Math.floor(Math.random() * all.length)]?.custom_emoji_id)
    .catch(ignore);

  const topic = await bot.api.createForumTopic(
    chat_id,
    name,
    icon === undefined ? {} : { icon_custom_emoji_id: icon },
  );

  const thread = `${chat_id}:${topic.message_thread_id}`;
  topicNames.set(thread, name);

  if (about !== undefined && about !== "") {
    said(
      thread,
      (await bot.api.sendMessage(chat_id, about, { message_thread_id: topic.message_thread_id }))
        .message_id,
      about,
    );
  }

  return {
    thread,
    link: `https://t.me/c/${chat_id.replace(/^-100/u, "")}/${topic.message_thread_id}`,
  };
}

// A backfill is more messages than Telegram lets a bot send in a minute, so each waits out the limit Telegram names. https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this
async function paced<T>(send: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await send();
    } catch (error) {
      const wait =
        error instanceof GrammyError && error.error_code === 429
          ? error.parameters.retry_after
          : undefined;

      if (wait === undefined) {
        throw error;
      }

      await Bun.sleep(wait * 1000);
    }
  }
}

const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v"]);

const ALBUM_MAX = 10;

function signed(owner: string, words: string) {
  return {
    text: words === "" ? owner : `${owner}\n${words}`,
    entities: [
      { type: "bold" as const, offset: 0, length: owner.length },
      ...(words === ""
        ? []
        : [{ type: "blockquote" as const, offset: owner.length + 1, length: words.length }]),
    ],
  };
}

// The owner's photos and clips as Telegram shows them: albums of up to ten photos and videos, the first under the caption, and anything else (a photo over 10MB) as a document, since an album takes documents only with documents. https://core.telegram.org/bots/api#sendmediagroup
async function postMedia(
  thread: string,
  files: string[],
  caption: { text: string; entities: MessageEntity[] } | undefined,
) {
  const { chat_id, extra } = target(thread);
  const opts = { ...extra, disable_notification: true };

  const shown = files.flatMap((file): (InputMediaPhoto | InputMediaVideo)[] => {
    const media = new InputFile(file);

    return asPhoto(file)
      ? [{ type: "photo", media }]
      : VIDEO_EXTS.has(extname(file).toLowerCase())
        ? [{ type: "video", media, supports_streaming: true }]
        : [];
  });

  const documents = files.filter(
    (file) => !asPhoto(file) && !VIDEO_EXTS.has(extname(file).toLowerCase()),
  );

  let first = caption && { caption: caption.text, caption_entities: caption.entities };

  for (let i = 0; i < shown.length; i += ALBUM_MAX) {
    const items = shown.slice(i, i + ALBUM_MAX);
    const [head] = items;
    const lead = first;
    const more = { ...opts, ...lead };

    if (items.length === 1 && head) {
      await paced<unknown>(() =>
        head.type === "photo"
          ? bot.api.sendPhoto(chat_id, head.media, more)
          : bot.api.sendVideo(chat_id, head.media, { ...more, supports_streaming: true }),
      );
    } else if (head) {
      await paced(() =>
        bot.api.sendMediaGroup(chat_id, [{ ...head, ...lead }, ...items.slice(1)], opts),
      );
    }

    first = undefined;
  }

  for (const file of documents) {
    const more = { ...opts, ...first };
    await paced(() => bot.api.sendDocument(chat_id, new InputFile(file), more));
    first = undefined;
  }
}

async function backfill(thread: string, turns: Turn[]) {
  const { chat_id, extra } = target(thread);

  const owner = (await bot.api.getChatMember(chat_id, Number(loadAccess().allowFrom[0]))).user
    .first_name;

  const opts = { ...extra, disable_notification: true };

  for (const { from, text, media = [] } of turns) {
    const files =
      from === "me"
        ? media.flatMap(({ file }) => (file !== undefined && existsSync(file) ? [file] : []))
        : [];

    const words =
      files.length > 0 ? typed(text, media.filter(({ id }) => !pictureOf(id)).length) : text;

    const captioned = files.length > 0 && owner.length + 1 + words.length <= MAX_CAPTION;

    const parts = captioned
      ? []
      : from === "me"
        ? chunk(words, MAX_CHUNK_LIMIT - owner.length - 1, "newline")
        : chunkClosingCodeBlocks(words, MAX_RICH_LIMIT, "newline");

    for (const part of parts) {
      const { text: quoted, entities } = signed(owner, part);
      await paced<unknown>(() =>
        from === "me"
          ? bot.api.sendMessage(chat_id, quoted, { ...opts, entities })
          : bot.api.sendRichMessage(chat_id, { markdown: keepLines(part) }, opts),
      );
    }

    await postMedia(thread, files, captioned ? signed(owner, words) : undefined);
  }
}

function stateOf({
  chat_data,
  public_data,
}: {
  chat_data?: string | undefined;
  public_data?: string | undefined;
}) {
  return {
    ...(chat_data !== undefined && { chat_data }),
    ...(public_data !== undefined && { public_data }),
  };
}

function at(caller: string, name: string | undefined) {
  const thread = name === undefined || name === "" ? caller : hub.find(name);

  return { thread, ...target(thread) };
}

const handlers: Handlers<typeof tools> = {
  reply: async (caller, args) => {
    const { thread, chat_id, extra } = at(caller, args.thread);
    const access = loadAccess();
    const text = tappable(args.text ?? "");
    const quoted = args.reply_to === undefined ? undefined : located(thread, args.reply_to);
    const quotes = quoted && questionAt(quoted);

    const quoting =
      quotes === undefined || quoted === undefined
        ? undefined
        : { question: quotes, message: quoted.message };

    const quote = quoted && {
      reply_parameters: {
        message_id: quoted.message,
        ...(quoted.chat_id !== chat_id && { chat_id: quoted.chat_id }),
      },
    };

    const files = args.files ?? [];
    const buttons = args.buttons ?? [];
    const markdown = args.format === "markdown";
    const parseMode = args.format === "markdownv2" ? { parse_mode: "MarkdownV2" as const } : {};

    if (text === "" && files.length === 0) {
      throw new Error("reply needs text or files");
    }

    if (buttons.length > 0 && text === "") {
      throw new Error("buttons need text to go with them");
    }

    const photos = files.map(asPhoto);
    const caption = files.length > 0 && !markdown && text.length <= MAX_CAPTION ? text : "";
    const cap = markdown ? MAX_RICH_LIMIT : MAX_CHUNK_LIMIT;
    const limit = Math.max(1, Math.min(access.textChunkLimit ?? cap, cap));
    const replyMode = access.replyToMode ?? "first";

    const mode = access.chunkMode ?? "length";

    const chunks: Outgoing[] =
      text === "" || caption !== ""
        ? []
        : markdown
          ? withCards(text).flatMap((part) =>
              part.card
                ? [part]
                : chunkClosingCodeBlocks(part.text, limit, mode).map((t) => ({ text: t })),
            )
          : chunk(text, limit, mode).map((t) => ({ text: t }));

    const silent = args.silent === true ? { disable_notification: true } : {};
    const keyboard = buttons.length > 0 ? { reply_markup: buttonsOf(buttons) } : {};
    const sentIds: number[] = [];
    const filed: number[] = [];
    let asked: number | undefined;

    try {
      for (const [i, { text: part, card }] of chunks.entries()) {
        const last = i === chunks.length - 1;
        const shouldReplyTo = replyMode !== "off" && (replyMode === "all" || i === 0);

        const opts = {
          ...extra,
          ...(shouldReplyTo && quote),
          ...silent,
          ...(last && keyboard),
        };

        const sent =
          markdown && card !== true
            ? await bot.api.sendRichMessage(chat_id, { markdown: keepLines(part) }, opts)
            : await bot.api.sendMessage(chat_id, part, { ...opts, ...parseMode });

        said(thread, sent.message_id, part);
        sentIds.push(sent.message_id);

        if (buttons.length > 0 && last) {
          asked = sent.message_id;
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      said(
        thread,
        undefined,
        chunks
          .slice(sentIds.length)
          .map((c) => c.text)
          .join("\n"),
        {
          failed: msg,
        },
      );
      throw new Error(
        `reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`,
        { cause: error },
      );
    }

    for (const [i, file] of files.entries()) {
      const input = new InputFile(file);
      const captioned = i === 0 && caption !== "";

      const opts = {
        ...extra,
        ...(replyMode !== "off" && quote),
        ...silent,
        ...(captioned && { caption, ...parseMode, ...keyboard }),
      };

      const sent =
        photos[i] === true
          ? await bot.api.sendPhoto(chat_id, input, opts)
          : await bot.api.sendDocument(chat_id, input, opts);

      const largest = "photo" in sent ? sent.photo.at(-1) : undefined;

      const held =
        "photo" in sent
          ? {
              attachment_kind: "photo",
              attachment_file_id: largest?.file_id ?? "",
              ...(largest && { attachment_dimensions: `${largest.width}x${largest.height}` }),
            }
          : {
              attachment_kind: "document",
              attachment_file_id: sent.document.file_id,
              ...(sent.document.mime_type !== undefined && {
                attachment_mime: sent.document.mime_type,
              }),
            };

      said(thread, sent.message_id, captioned ? caption : `(file: ${basename(file)})`, {
        file: basename(file),
        ...held,
      });
      sentIds.push(sent.message_id);
      filed.push(sent.message_id);

      if (buttons.length > 0 && captioned) {
        asked = sent.message_id;
      }
    }

    const last = sentIds.at(-1);

    if (asked !== undefined) {
      ledger.ask(thread, asked, text, buttons, { attached: filed });
    } else if (text !== "" && last !== undefined) {
      ledger.said(thread, last, text, quoting);
    }

    return sentIds.length === 1
      ? `sent (id: ${sentIds[0]})`
      : `sent ${sentIds.length} parts (ids: ${sentIds.join(", ")})`;
  },

  react: async (caller, args) => {
    const { chat_id, message } = located(caller, args.message_id);

    // SAFETY: Telegram checks the emoji against its whitelist and refuses any other, as the tool's description warns.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only Telegram knows its whitelist
    const emoji = args.emoji as ReactionTypeEmoji["emoji"];

    await react(chat_id, message, args.remove === true ? [] : [{ type: "emoji", emoji }]);

    return args.remove === true ? "reaction removed" : "reacted";
  },

  edit_message: async (caller, args) => {
    const thread = caller;
    const { chat_id } = target(thread);
    const where = located(thread, args.message_id);
    const id = where.message;
    const question = questionAt(where);
    const home = question?.thread ?? (where.chat_id === chat_id ? thread : where.chat_id);
    const text = args.text === undefined ? undefined : tappable(args.text);
    const { file } = args;
    const changes = text !== undefined || (file !== undefined && file !== "");
    const state = stateOf(args);

    if (Object.keys(state).length > 0) {
      try {
        await paced(() =>
          widgets.editMessageWidgetData({ chat_id: where.chat_id, message_id: id, ...state }),
        );
      } catch (error) {
        if (!String(error).includes("message is not modified")) {
          throw error;
        }
      }

      if (!changes && args.settled !== true) {
        return `changed the widget's state (id: ${id})`;
      }
    }

    if (home === thread && Number(ledger.pin(thread)?.message) === id && changes) {
      if ((file !== undefined && file !== "") || text === undefined) {
        throw new Error("a status post is text: send the file in its own message");
      }

      await ledger.rewrite(thread, post, text, id);
      said(thread, undefined, text, { edited: "true", message_id: String(id) });

      return `edited the status post's note (id: ${id}); hex keeps the questions and tasks under it current`;
    }

    const parseMode = args.format === "markdownv2" ? { parse_mode: "MarkdownV2" as const } : {};

    if (question?.poll !== undefined && changes) {
      if (args.settled !== true) {
        throw new Error(
          "a poll's own text can't be edited: reply with what changed, or settle it with settled: true",
        );
      }

      if (question.answer) {
        return `the poll is already answered (${question.answer.label}), so it stays as it is; its own text can't be edited, so reply with what changed`;
      }

      await settleQuestion(home, id, "✓ Settled");

      return `settled the poll (id: ${id}); its own text can't be edited, so reply with what changed`;
    }

    // A Telegram edit takes a message's buttons off unless it sends them again (https://core.telegram.org/bots/api#editmessagetext), and a question stays open until it's settled.
    const buttonsStay =
      question !== undefined &&
      question.options.length > 0 &&
      question.poll === undefined &&
      !question.answer &&
      !question.settled &&
      args.settled !== true;

    const keep = buttonsStay ? { reply_markup: buttonsOf(question.options) } : {};

    if (file !== undefined && file !== "") {
      const caption = text === undefined ? {} : { caption: text, ...parseMode };
      await bot.api.editMessageMedia(
        where.chat_id,
        id,
        { type: asPhoto(file) ? "photo" : "document", media: new InputFile(file), ...caption },
        keep,
      );
    } else if (text !== undefined) {
      try {
        await (args.format === "markdown"
          ? bot.api.editMessageText(where.chat_id, id, { markdown: keepLines(text) }, keep)
          : bot.api.editMessageText(where.chat_id, id, text, { ...parseMode, ...keep }));
      } catch (error) {
        if (!String(error).includes("no text in the message")) {
          throw error;
        }

        if (args.format === "markdown") {
          throw new Error(
            "a file's caption can't take format 'markdown'; use 'text' or 'markdownv2'",
            { cause: error },
          );
        }

        await bot.api.editMessageCaption(where.chat_id, id, {
          caption: text,
          ...parseMode,
          ...keep,
        });
      }
    } else if (args.settled !== true) {
      throw new Error("edit_message needs text, a file, a widget's state, or settled");
    }

    if (text !== undefined) {
      said(home, undefined, text, { edited: "true", message_id: String(id) });
      ledger.edited(home, id, text);
    }

    if (
      args.settled === true &&
      !(await settleQuestion(home, Number(question?.message ?? id), "✓ Settled"))
    ) {
      return `${changes ? "edited, but " : ""}no question waits on message ${id}, so nothing was settled`;
    }

    return `${args.settled === true ? "settled" : "edited"} (id: ${id})`;
  },

  delete_message: async (caller, args) => {
    const id = Number(args.message_id);
    await bot.api.deleteMessage(target(caller).chat_id, id);
    await ledger.deleted(caller, id);

    return `deleted (id: ${id})`;
  },

  pin: async (caller, args) => {
    if (args.unpin === true) {
      const was = await ledger.unpin(
        caller,
        post,
        args.message_id === undefined ? undefined : Number(args.message_id),
      );

      return was === undefined
        ? "this thread has no status post"
        : `unpinned the status post (id: ${was})`;
    }

    if (args.note === undefined) {
      throw new Error("pin takes the status post's note, or unpin: true");
    }

    return `posted and pinned the status post (id: ${await ledger.post(caller, tappable(args.note), post)}); hex keeps the questions and tasks under it current`;
  },

  forward: async (caller, args) => {
    const { thread, chat_id, extra } = at(caller, args.thread);
    const id = Number(args.message_id);
    const from = target(caller).chat_id;
    const sent = await bot.api.forwardMessage(chat_id, from, id, extra);
    said(thread, sent.message_id, hub.said(`${from}:${id}`)?.body ?? "(forwarded)", {
      forwarded: "true",
    });

    return `forwarded to "${topicNames.get(thread) ?? hub.name(thread) ?? thread}" (id: ${sent.message_id})`;
  },

  poll: async (caller, args) => {
    const { chat_id, extra } = target(caller);
    const { question, options } = args;
    const shots = (args.files ?? []).map((file) => realpathSync(file));

    if (shots.length > 0 && shots.length !== options.length) {
      throw new Error(
        `files are one screenshot per option: ${shots.length} for ${options.length} options`,
      );
    }

    for (const shot of shots) {
      if (!asPhoto(shot)) {
        throw new Error(`a screenshot is a photo under 10MB: ${shot}`);
      }
    }

    const album =
      shots.length > 0
        ? await bot.api.sendMediaGroup(
            chat_id,
            shots.map((shot, i) => ({
              type: "photo" as const,
              media: new InputFile(shot),
              caption: options[i] ?? "",
            })),
            extra,
          )
        : [];

    for (const [i, sent] of album.entries()) {
      said(caller, sent.message_id, options[i] ?? "", { file: basename(shots[i] ?? "") });
    }

    const sent = await bot.api.sendPoll(chat_id, question, options, {
      ...extra,
      ...(album[0] !== undefined && { reply_parameters: { message_id: album[0].message_id } }),
      is_anonymous: false,
      allows_multiple_answers: args.multiple === true,
    });

    said(caller, sent.message_id, question, { poll: options.join(" / ") });

    const kept = join(KEPT_POLL_SHOTS_DIR, String(sent.message_id));

    if (shots.length > 0) {
      mkdirSync(kept, { recursive: true });
    }

    const keep = shots.map((shot, i) => {
      const copy = join(kept, `${i}${extname(shot)}`);
      copyFileSync(shot, copy);

      return copy;
    });

    ledger.ask(caller, sent.message_id, question, options, {
      poll: sent.poll.id,
      ...(keep.length > 0 && { shots: keep }),
    });

    return `sent poll (id: ${sent.message_id})`;
  },

  widget: async (caller, args) => {
    const html = readFileSync(args.file, "utf-8");
    const { chat_id, extra } = target(caller);

    const widget = {
      html,
      caption: args.caption,
      allow_queries: true,
      ...stateOf(args),
      ...(args.width !== undefined && { width: args.width }),
      ...(args.height !== undefined && { height: args.height }),
    };

    const send = async (to: string, more: Partial<Parameters<Widgets["sendWidget"]>[0]>) => {
      try {
        return await paced(() => widgets.sendWidget({ chat_id: to, ...more, ...widget }));
      } catch (error) {
        if (!String(error).includes("WIDGET_TOO_LARGE")) {
          throw error;
        }

        throw new Error(
          `the widget is ${Buffer.byteLength(html)} bytes, ${deflateSync(html, { level: 9 }).length} compressed with zlib level 9; Telegram takes at most 32768 and 4096`,
          { cause: error },
        );
      }
    };

    const inDmTopic = async (owner: string) => {
      try {
        const topic = await dmTopic(owner, caller);

        if (topic === undefined) {
          return;
        }

        try {
          return { sent: await send(owner, { message_thread_id: topic }), topic };
        } catch (error) {
          if (!String(error).includes("thread not found")) {
            throw error;
          }

          dmTopics.delete(caller);
          keepDmTopics();
          const again = await dmTopic(owner, caller);

          return again === undefined
            ? undefined
            : { sent: await send(owner, { message_thread_id: again }), topic: again };
        }
      } catch (error) {
        process.stderr.write(
          `telegram hub: ${caller}'s widget goes to the plain DM, since its DM topic failed: ${String(error)}\n`,
        );
      }
    };

    let to = chat_id;
    let sent: Sent;
    let home: number | undefined;

    try {
      sent = await send(chat_id, extra);
    } catch (error) {
      const owner = loadAccess().allowFrom[0];

      if (!String(error).includes("WIDGET_NOT_ALLOWED") || owner === undefined) {
        throw error;
      }

      to = owner;
      const placed = extra.message_thread_id === undefined ? undefined : await inDmTopic(owner);

      if (placed === undefined) {
        const back = extra.message_thread_id === undefined ? undefined : post.link(caller, "");
        sent = await send(owner, {
          ...(back !== undefined && {
            reply_markup: { inline_keyboard: [[{ text: hub.name(caller) ?? "Topic", url: back }]] },
          }),
        });
      } else {
        ({ sent, topic: home } = placed);
      }
    }

    hub.sent(caller, {
      key: `${to}:${sent.message_id}`,
      content: args.caption,
      meta: { widget: basename(args.file) },
    });

    return to === chat_id
      ? `sent widget (id: ${sent.message_id})`
      : home === undefined
        ? `sent widget to the owner's DM (id: telegram:${to}:${sent.message_id}), since Telegram shows widgets only in private chats for now; its requests still come here`
        : `sent widget to this topic's own topic in the owner's DM (id: telegram:${to}:${sent.message_id}, topic: https://t.me/${me()}/${home}), since Telegram shows widgets only in private chats; its requests, and what he says in that DM topic, come here`;
  },

  rename_thread: async (caller, args) => {
    const { chat_id, extra } = target(caller);
    const topic = extra.message_thread_id;

    if (topic === undefined || topic === 0) {
      throw new Error("only topics can be renamed");
    }

    const name = args.title === undefined ? "" : title(args.title);
    const icon = args.icon === undefined ? "" : await iconOf(args.icon);

    if (name === "" && icon === "") {
      throw new Error("rename_thread needs a title or an icon");
    }

    await bot.api.editForumTopic(chat_id, topic, {
      ...(name !== "" && { name }),
      ...(icon !== "" && { icon_custom_emoji_id: icon }),
    });

    if (name !== "") {
      topicNames.set(caller, name);
      hub.rename(caller, name);
    }

    return [name !== "" && `renamed to "${name}"`, icon !== "" && `icon set to ${args.icon}`]
      .filter(Boolean)
      .join(", ");
  },

  set_model: (caller, args) => {
    const { thread } = at(caller, args.thread);

    const chosen = {
      model: MODELS.find(({ value }) => value === args.model),
      effort: EFFORTS.find(({ value }) => value === args.effort),
    };

    if (!chosen.model && !chosen.effort) {
      throw new Error(
        `set_model takes a model (${MODELS.map(({ value }) => value).join(", ")}) or an effort (${EFFORTS.map(({ value }) => value).join(", ")})`,
      );
    }

    hub.configure(thread, {
      ...(chosen.model && { model: chosen.model.value }),
      ...(chosen.effort && { effort: chosen.effort.value }),
    });

    return Promise.resolve(
      `${[chosen.model?.name, chosen.effort && `${chosen.effort.name} effort`].filter(Boolean).join(", ")}, from this thread's next message`,
    );
  },

  download_attachment: async (_caller, args) => await download(args.file_id, args.file_id),

  close_thread: async (caller, args) => {
    const { thread, chat_id, extra } = at(caller, args.thread);
    const topic = extra.message_thread_id;

    if (topic === undefined || topic === 0) {
      if (thread === MAIN) {
        throw new Error("only topics can be closed");
      }

      const name = hub.name(thread) ?? thread;
      void retire(thread);

      return `forgot "${name}": it isn't a topic, so there was nothing to close in Telegram`;
    }

    void retire(thread);

    try {
      await bot.api.closeForumTopic(chat_id, topic);
    } catch (error) {
      if (!gone(String(error))) {
        throw error;
      }
    }

    return `closed "${topicNames.get(thread) ?? thread}"; its session stops once it's idle`;
  },

  new_thread: async (_caller, args) => {
    const name = title(args.title);
    const app = args.app ?? "telegram";
    const { about } = args;

    if (app !== "telegram") {
      const opened = await begin(app, name, args.prompt, {
        about,
        ...(args.channel !== undefined && { where: args.channel }),
      });

      return `started thread "${name}" in ${app}: ${opened.link}`;
    }

    const opened = await place(name, undefined, about);
    hub.open(opened.thread, name, args.prompt);

    return `started thread "${name}" in telegram: ${opened.link}`;
  },

  handoff: async (caller, args) => {
    const { chat_id, extra } = target(caller);
    const { to } = args;

    const name =
      args.title === undefined ? (topicNames.get(caller) ?? title("")) : title(args.title);

    const link = await move(hub, caller, to, name, args.channel);

    if (caller === MAIN) {
      await bot.api.sendMessage(chat_id, `Continued in ${to}: ${link}`, extra);

      return `a copy of this conversation continues in ${to}: ${link}. You stay here.`;
    }

    await bot.api.sendMessage(chat_id, `Moved to ${to}: ${link}`, extra);

    if (extra.message_thread_id !== undefined) {
      await bot.api.closeForumTopic(chat_id, extra.message_thread_id);
    }

    return `moving to ${to}: ${link}. Your session stops here once this turn ends and resumes there.`;
  },
};

const call = dispatch(tools, handlers);

function gone(error: string): boolean {
  return /message thread not found|TOPIC_ID_INVALID/u.test(error);
}

const threadArgument = z.object({ thread: z.string().optional() });

// The Bot API has no update for a deleted topic (https://core.telegram.org/bots/api#update); the first send into one is how it shows.
const callOrForget: Call = async (caller, tool, args) => {
  try {
    return await call(caller, tool, args);
  } catch (error) {
    const { thread } = at(caller, threadArgument.safeParse(args).data?.thread);

    if (thread === MAIN || !thread.includes(":") || !gone(String(error))) {
      throw error;
    }

    process.stderr.write(`telegram hub: topic ${thread} was deleted, forgetting it\n`);
    void retire(thread);
    throw new Error(`this topic was deleted in Telegram, so it's gone from the thread list now`, {
      cause: error,
    });
  }
};

const ANSWERED_IN = new Map([
  ["app", "in the app"],
  ["call", "on a call"],
]);

function only(text: string) {
  return { inline_keyboard: [[{ text, disabled: {} }]] };
}

function buttonsOf(options: string[]) {
  return {
    inline_keyboard: [options.map((label, i) => ({ text: label, callback_data: String(i) }))],
  };
}

// oxlint-disable-next-line unicorn/no-array-method-this-argument -- Ledger.find is the ledger's own lookup, not Array#find
const questionOf = (thread: string, message: number) => ledger.find(thread, message);

const drawing = new Map<string, Promise<void>>();

async function redraw(thread: string, message: number): Promise<void> {
  try {
    const question = questionOf(thread, message);

    if (question === undefined || question.options.length === 0) {
      return;
    }

    const { chat_id } = target(thread);

    if (question.poll === undefined) {
      await bot.api.editMessageReplyMarkup(chat_id, message, {
        reply_markup: question.answer
          ? only(answeredText(question.answer))
          : question.settled
            ? only(question.settled.note)
            : buttonsOf(question.options),
      });

      return;
    }

    if (question.settled || (question.answer && question.answer.via !== "telegram")) {
      // A poll can't take a vote from the bot (https://core.telegram.org/bots/api#stoppoll), so one answered elsewhere closes, and stays closed.
      await bot.api.stopPoll(chat_id, message);
    }
  } catch (error) {
    process.stderr.write(
      `telegram hub: couldn't draw the buttons on ${thread} ${message}: ${String(error)}\n`,
    );
  }
}

function drawInTurn(thread: string, message: number): Promise<void> {
  const key = `${thread}:${message}`;
  const drawn = (drawing.get(key) ?? Promise.resolve()).then(() => redraw(thread, message));

  drawing.set(key, drawn);
  void drawn.then(() => drawing.get(key) === drawn && drawing.delete(key));

  return drawn;
}

const answeredText = ({ label, via }: { label: string; via: string }) => {
  const where = ANSWERED_IN.get(via);

  return where === undefined ? `✓ ${label}` : `✓ Answered ${where}: ${label}`;
};

async function answerQuestion(thread: string, message: number, label: string, via: string) {
  const question = questionOf(thread, message);

  if (!question || question.answer) {
    return;
  }

  const { chat_id } = target(thread);

  const answered = hub.deliver(
    thread,
    topicNames.get(thread) ?? hub.name(thread) ?? thread,
    {
      author: "owner",
      content: question.poll === undefined ? label : `(vote: ${label})`,
      meta: {
        chat_id,
        user: `hex ${via}`,
        ts: new Date().toISOString(),
        ...(question.poll === undefined
          ? { button: "true", button_message_id: String(message) }
          : { vote: label, poll_message_id: String(message), poll: question.text }),
        answered_in: ANSWERED_IN.get(via) ?? via,
      },
    },
    () => ledger.answered(thread, message, label, via),
  );

  if (answered) {
    await drawInTurn(thread, message);
  }
}

async function settleQuestion(thread: string, message: number, note: string): Promise<boolean> {
  const question = questionOf(thread, message);

  if (!question || !waits(question)) {
    return false;
  }

  ledger.settled(thread, message, note);
  await drawInTurn(thread, message);

  return true;
}

async function reopenQuestion(thread: string, message: number, via: string) {
  const question = questionOf(thread, message);

  if (!question || !(question.answer || question.settled)) {
    return;
  }

  const { chat_id } = target(thread);
  const taken = question.answer?.label;

  const reopened =
    taken === undefined
      ? ledger.reopened(thread, message)
      : hub.deliver(
          thread,
          topicNames.get(thread) ?? hub.name(thread) ?? thread,
          {
            author: "owner",
            content: `(took back: ${taken})`,
            meta: {
              chat_id,
              user: `hex ${via}`,
              ts: new Date().toISOString(),
              took_back: taken,
              [question.poll === undefined ? "button_message_id" : "poll_message_id"]:
                String(message),
            },
          },
          () => ledger.reopened(thread, message),
        );

  if (reopened) {
    await drawInTurn(thread, message);
  }
}

const ASLEEP: ReactionTypeEmoji = { type: "emoji", emoji: "😴" };

function waiting(message: Message, still: boolean): void {
  const { chat_id = "", message_id = "", edited = "" } = message.meta;

  if (
    chat_id === "" ||
    message_id === "" ||
    edited !== "" ||
    (!still && !asleep.has(`${chat_id}:${message_id}`))
  ) {
    return;
  }

  const ack = acked();

  void react(
    chat_id,
    Number(message_id),
    still ? [ASLEEP] : ack,
    !still && ack.length > 0 ? [] : undefined,
  ).catch(ignore);
}

function acked(): ReactionTypeEmoji[] {
  const { ackReaction = "" } = loadAccess();

  if (ackReaction === "") {
    return [];
  }

  // SAFETY: Telegram checks the emoji against its whitelist and refuses any other, which access.json's ackReaction warns of.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only Telegram knows its whitelist
  return [{ type: "emoji", emoji: ackReaction as ReactionTypeEmoji["emoji"] }];
}

// Telegram may apply two reactions sent at once in either order (https://core.telegram.org/bots/api#setmessagereaction), so each message's go one at a time.
const reacting = new Map<string, Promise<void>>();

const asleep = new Set<string>();

function react(
  chat_id: string,
  message_id: number,
  reaction: ReactionTypeEmoji[],
  otherwise?: ReactionTypeEmoji[],
): Promise<void> {
  const key = `${chat_id}:${message_id}`;

  if (reaction.length === 1 && reaction[0] === ASLEEP) {
    asleep.add(key);
  } else {
    asleep.delete(key);
  }

  const set = async (to: ReactionTypeEmoji[]) => {
    await steady(() => paced(() => bot.api.setMessageReaction(chat_id, message_id, to)));
  };

  const afterTheLast = async () => {
    await reacting.get(key)?.catch(ignore);

    try {
      await set(reaction);
    } catch (error) {
      if (otherwise === undefined) {
        throw error;
      }

      await set(otherwise);
    }
  };

  const done = afterTheLast();

  reacting.set(key, done);

  const settled = () => {
    if (reacting.get(key) === done) {
      reacting.delete(key);
    }
  };

  void done.then(settled).catch(settled);

  return done;
}

async function steady<T>(send: () => Promise<T>, tries = 3): Promise<T> {
  for (let tried = 1; ; tried++) {
    try {
      return await send();
    } catch (error) {
      if (tried === tries || (error instanceof GrammyError && error.error_code < 500)) {
        throw error;
      }

      await Bun.sleep(1000 * tried);
    }
  }
}

let polling: string | undefined;

const hub = startHub({
  stateDir: STATE_DIR,
  channel: "plugin:telegram@hex",
  server,
  link: (thread) =>
    thread.startsWith("-100")
      ? `https://t.me/c/${thread.slice(4).replace(":", "/")}${thread.includes(":") ? "" : "/1"}`
      : /^\d+(:\d+)?$/u.test(thread) && polling !== undefined && polling !== ""
        ? `https://t.me/${polling}`
        : undefined,
  ...(MAIN !== undefined && { main: MAIN }),
  general: true,
  journal: sinceToday,
  ...(process.env.HEX_DIR !== undefined && { hexDir: process.env.HEX_DIR }),
  ...(process.env.HEX_LAUNCHER !== undefined && { launcher: process.env.HEX_LAUNCHER }),
  ...(process.env.HEX_NAME !== undefined && { mainName: process.env.HEX_NAME }),
  call: callOrForget,
  state: settle,
  fresh: (thread) => !thread.startsWith("-"),
  permission: (thread, request) => {
    void ask(thread, request);
  },
  questions: {
    answer: (thread, message, label, via) => {
      void answerQuestion(thread, Number(message), label, via);
    },
    settle: (thread, message, note) => {
      void settleQuestion(thread, Number(message), note);
    },
    reopen: (thread, message, via) => {
      void reopenQuestion(thread, Number(message), via);
    },
  },
  failed: (thread, reason) => {
    const { chat_id, extra } = target(thread);
    void bot.api
      .sendMessage(chat_id, `Couldn't start this topic's session: ${reason}`, extra)
      .catch(ignore);
  },
  waits: (_, message, still) => {
    waiting(message, still);
  },
});

// Each getUpdates confirms to Telegram every update before its offset, so it waits until hex.db has them on disk: https://core.telegram.org/bots/api#getupdates
bot.api.config.use(async (previous, method, payload, signal) => {
  if (method === "getUpdates") {
    await hub.synced();
  }

  return await previous(method, payload, signal);
});

const downloads = new Map<string, Promise<string>>();

const file = (id: string) => {
  const kept = downloads.get(id) ?? download(id, id);

  downloads.set(id, kept);
  kept.catch(() => downloads.delete(id));

  return kept;
};

let deaf = false;

const deafen = async () => {
  deaf = true;
  await bot.stop();
};

clients.set("telegram", { hub, place, backfill, file, deafen });

bot.on(["message:forum_topic_created", "message:forum_topic_edited"], (ctx) => {
  if (ctx.chat.type === "private") {
    return;
  }

  const name = ctx.message.forum_topic_created?.name ?? ctx.message.forum_topic_edited?.name ?? "";

  if (name === "") {
    return;
  }

  topicNames.set(threadOf(ctx), name);
  hub.rename(threadOf(ctx), name);
});

bot.on("message:text", async (ctx) => {
  if (allowed(ctx.from) && (await slash(threadOf(ctx), ctx.message.text))) {
    return;
  }

  await handleInbound(ctx, ctx.message.text, undefined);
});

async function slash(thread: string, text: string): Promise<boolean> {
  const [, command = "", to = "", rest = ""] =
    /^\/([a-z][\w:-]*)(?:@(\w+))?(?:\s+([\s\S]*))?$/iu.exec(text) ?? [];

  const name = command.toLowerCase();

  if (
    name === "" ||
    (to !== "" && to.toLowerCase() !== me().toLowerCase()) ||
    hub.name(thread) === undefined
  ) {
    return false;
  }

  const { chat_id, extra } = target(thread);
  const answer = (reply: string) => bot.api.sendMessage(chat_id, reply, extra).then(() => true);

  if (name === "board" && board !== undefined) {
    await board.again();

    return thread.startsWith("-") ? await answer("Your board is at the bottom of your DM.") : true;
  }

  if (name === "model" || name === "effort") {
    const choices = name === "model" ? MODELS : EFFORTS;
    const choice = choices.find(({ value }) => value === rest.trim().toLowerCase());

    if (!choice) {
      return await answer(`/${name} takes one of: ${choices.map(({ value }) => value).join(", ")}`);
    }

    hub.configure(thread, { [name]: choice.value });

    return await answer(
      `${name === "model" ? "Model" : "Effort"}: ${choice.name}, from this thread's next message.`,
    );
  }

  const commandWouldRestartThisDmAndLoseItsConversation = !thread.startsWith("-");

  if (name === "start" || commandWouldRestartThisDmAndLoseItsConversation) {
    return false;
  }

  if (typing.has(thread)) {
    return await answer(`This thread is working; send /${name} again once it's done.`);
  }

  void hub.command(thread, `/${name}${rest ? ` ${rest}` : ""}`);

  return await answer(`Running /${name} in this thread's session.`);
}

bot.on("edited_message", async (ctx) => {
  const { text = ctx.editedMessage.caption ?? "" } = ctx.editedMessage;

  if (text) {
    await handleInbound(ctx, text, undefined);
  }
});

bot.on("message:location", async (ctx) => {
  const { location, venue } = ctx.message;
  const point = `${location.latitude}, ${location.longitude}`;
  await handleInbound(
    ctx,
    venue ? `(venue: ${venue.title}, ${venue.address}, at ${point})` : `(location: ${point})`,
    undefined,
  );
});

bot.on("message:contact", async (ctx) => {
  const { first_name, last_name, phone_number } = ctx.message.contact;
  await handleInbound(
    ctx,
    `(contact: ${[first_name, last_name].filter(Boolean).join(" ")}, ${phone_number})`,
    undefined,
  );
});

bot.on("message:photo", async (ctx) => {
  const caption = ctx.message.caption ?? "(photo)";

  const downloadOnceTheSenderIsAllowed = async () => {
    // The largest size is last. https://core.telegram.org/bots/api#message
    const largest = ctx.message.photo.at(-1);

    if (!largest) {
      return;
    }

    try {
      return await download(largest.file_id, largest.file_unique_id);
    } catch (error) {
      process.stderr.write(`telegram hub: photo download failed: ${String(error)}\n`);
    }
  };

  await handleInbound(ctx, caption, downloadOnceTheSenderIsAllowed);
});

bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  const name = safeName(doc.file_name);
  const text = ctx.message.caption ?? `(document: ${name ?? "file"})`;
  await handleInbound(ctx, text, undefined, {
    kind: "document",
    file_id: doc.file_id,
    size: doc.file_size,
    mime: doc.mime_type,
    name,
  });
});

async function hear(file_id: string, uniqueId: string): Promise<string | undefined> {
  try {
    return await transcribe(() => download(file_id, uniqueId));
  } catch (error) {
    process.stderr.write(`telegram hub: voice transcription failed: ${String(error)}\n`);
  }
}

bot.on("message:voice", async (ctx) => {
  const { voice, caption = "" } = ctx.message;
  const heard = allowed(ctx.from) ? await hear(voice.file_id, voice.file_unique_id) : undefined;

  const transcript =
    heard === undefined || heard === ""
      ? "(voice message that didn't transcribe: fetch it with download_attachment and run .hex/bin/transcribe on the file)"
      : `(voice message) ${heard}`;

  const text = caption ? `${caption}\n\n${transcript}` : transcript;
  await handleInbound(ctx, text, undefined, {
    kind: "voice",
    file_id: voice.file_id,
    size: voice.file_size,
    mime: voice.mime_type,
  });
});

bot.on("message:audio", async (ctx) => {
  const audio = ctx.message.audio;
  const name = safeName(audio.file_name);
  const text = ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? "audio"})`;
  await handleInbound(ctx, text, undefined, {
    kind: "audio",
    file_id: audio.file_id,
    size: audio.file_size,
    mime: audio.mime_type,
    name,
  });
});

bot.on("message:video", async (ctx) => {
  const video = ctx.message.video;
  const text = ctx.message.caption ?? "(video)";
  await handleInbound(ctx, text, undefined, {
    kind: "video",
    file_id: video.file_id,
    size: video.file_size,
    mime: video.mime_type,
    name: safeName(video.file_name),
  });
});

bot.on("message:video_note", async (ctx) => {
  const vn = ctx.message.video_note;
  await handleInbound(ctx, "(video note)", undefined, {
    kind: "video_note",
    file_id: vn.file_id,
    size: vn.file_size,
  });
});

bot.on("message:poll", async (ctx) => {
  const { question, options } = ctx.message.poll;
  await handleInbound(
    ctx,
    `(poll: ${question} [${options.map((option) => option.text).join(" / ")}])`,
    undefined,
  );
});

bot.on("message:dice", async (ctx) => {
  const { emoji, value } = ctx.message.dice;
  await handleInbound(ctx, `(dice ${emoji}: ${value})`, undefined);
});

bot.on("message:game", async (ctx) => {
  await handleInbound(ctx, `(game: ${ctx.message.game.title})`, undefined);
});

bot.on("message:sticker", async (ctx) => {
  const { sticker } = ctx.message;
  const emoji = sticker.emoji === undefined || sticker.emoji === "" ? "" : ` ${sticker.emoji}`;
  await handleInbound(ctx, `(sticker${emoji})`, undefined, {
    kind: "sticker",
    file_id: sticker.file_id,
    size: sticker.file_size,
  });
});

// Telegram only reports reactions to bots that are admins, and the update names neither the topic nor the text, so both come from the message hex.db kept. https://core.telegram.org/bots/api#messagereactionupdated
bot.on("message_reaction", (ctx) => {
  const { chat, message_id, user, date } = ctx.messageReaction;

  if (!allowed(user)) {
    return;
  }

  const found = hub.said(`${chat.id}:${message_id}`);
  const known = found && hub.name(found.to) !== undefined ? found : undefined;
  const thread = known?.to ?? plainThread(chat);

  if (thread === undefined) {
    return;
  }

  const { emojiAdded, emojiRemoved } = ctx.reactions();

  const meta = {
    chat_id: String(chat.id),
    user: user.username ?? String(user.id),
    user_id: String(user.id),
    ts: new Date(date * 1000).toISOString(),
    reaction_to_message_id: String(message_id),
    ...(known !== undefined && {
      reaction_to_user: known.author === "hex" ? me() : (known.meta?.user ?? known.author),
    }),
    ...(known?.body !== undefined && known.body !== "" && { reaction_to_text: known.body }),
  };

  const key = `${chat.id}:${message_id}:${ctx.update.update_id}`;

  for (const emoji of emojiAdded) {
    hub.deliver(thread, nameOf(ctx, thread), {
      author: "owner",
      key: `${key}+${emoji}`,
      content: `(reaction: ${emoji})`,
      meta: { ...meta, reaction: emoji },
    });
  }

  for (const emoji of emojiRemoved) {
    hub.deliver(thread, nameOf(ctx, thread), {
      author: "owner",
      key: `${key}-${emoji}`,
      content: `(reaction removed: ${emoji})`,
      meta: { ...meta, reaction: emoji, reaction_removed: "true" },
    });
  }
});

function plainThread(chat: Chat): string | undefined {
  return "is_forum" in chat && chat.is_forum === true ? undefined : String(chat.id);
}

bot.on("callback_query:data", async (ctx) => {
  await ctx.answerCallbackQuery().catch(ignore);
  const { data, message } = ctx.callbackQuery;

  const label =
    message && "reply_markup" in message
      ? message.reply_markup?.inline_keyboard
          .flat()
          .find((button) => "callback_data" in button && button.callback_data === data)?.text
      : undefined;

  if (!message || label === undefined || label === "" || !allowed(ctx.from)) {
    return;
  }

  const thread = threadOf(ctx);
  const [, verdict, requestId] = /^perm:(allow|deny):([a-km-z]{5})$/u.exec(data) ?? [];
  const question = verdict === undefined ? questionOf(thread, message.message_id) : undefined;

  if (!question) {
    try {
      await bot.api.editMessageReplyMarkup(message.chat.id, message.message_id, {
        reply_markup: { inline_keyboard: [[{ text: `✓ ${label}`, disabled: {} }]] },
      });
    } catch (error) {
      process.stderr.write(`telegram hub: couldn't mark the tapped button: ${String(error)}\n`);
    }
  }

  if (verdict !== undefined && requestId !== undefined) {
    asking.get(thread)?.delete(message.message_id);

    hub.answer(thread, requestId, verdict === "allow" ? "allow" : "deny");

    return;
  }

  hub.deliver(
    thread,
    nameOf(ctx, thread),
    {
      author: "owner",
      key: `tap:${ctx.callbackQuery.id}`,
      content: label,
      meta: {
        chat_id: String(message.chat.id),
        user: ctx.from.username ?? String(ctx.from.id),
        user_id: String(ctx.from.id),
        ts: new Date().toISOString(),
        button: "true",
        button_message_id: String(message.message_id),
      },
    },
    question && (() => ledger.answered(thread, message.message_id, label, "telegram")),
  );

  if (question) {
    await drawInTurn(thread, message.message_id);
  }
});

// A request waits at most 15 seconds for its answer, less than a session may take to start a turn, so hex answers at once: null when the session has it, a reason when not. The session answers by changing the widget's state. https://core.telegram.org/bots/widgets#requests-to-the-bot
const asks = (ctx: Context): ctx is Context & { update: { widget_query: WidgetQuery } } =>
  ctx.update.widget_query !== undefined;

bot.filter(asks).use(async (ctx) => {
  const { id, from, chat, message_id, data } = ctx.update.widget_query;
  const found = chat && message_id !== undefined ? hub.said(`${chat.id}:${message_id}`) : null;
  const thread = found?.to ?? (chat && plainThread(chat));

  const heard =
    allowed(from) &&
    chat !== undefined &&
    thread !== undefined &&
    hub.deliver(thread, hub.name(thread) ?? nameOf(ctx, thread), {
      author: "owner",
      key: `widget:${id}`,
      content: `(widget: ${data})`,
      meta: {
        chat_id: String(chat.id),
        user: from.username ?? String(from.id),
        user_id: String(from.id),
        ts: new Date().toISOString(),
        widget_request: data,
        widget_message_id:
          String(chat.id) === target(thread).chat_id
            ? String(message_id)
            : `telegram:${chat.id}:${message_id}`,
        ...(found?.body !== undefined && found.body !== "" && { widget_caption: found.body }),
      },
    });

  try {
    await widgets.answerWidgetQuery({
      widget_query_id: id,
      ...(!heard && { data: allowed(from) ? "hex couldn't take this request" : "not allowed" }),
    });
  } catch (error) {
    process.stderr.write(`telegram hub: couldn't answer a widget's request: ${String(error)}\n`);
  }
});

bot.on("poll_answer", (ctx) => {
  const { poll_id, user, option_ids } = ctx.pollAnswer;
  const question = ledger.byPoll(poll_id);

  if (!allowed(user) || !question) {
    return;
  }

  const vote = option_ids.map((i) => question.options[i]).join("; ");
  hub.deliver(
    question.thread,
    nameOf(ctx, question.thread),
    {
      author: "owner",
      key: `poll:${poll_id}:${ctx.update.update_id}`,
      content: vote ? `(vote: ${vote})` : "(vote removed)",
      meta: {
        chat_id: target(question.thread).chat_id,
        user: user.username ?? String(user.id),
        user_id: String(user.id),
        ts: new Date().toISOString(),
        ...(vote ? { vote } : { vote_removed: "true" }),
        poll_message_id: String(question.message),
        poll: question.text,
      },
    },
    () => {
      if (vote) {
        ledger.answered(question.thread, question.message, vote, "telegram", true);
      } else {
        ledger.reopened(question.thread, question.message);
      }

      return true;
    },
  );
});

function allowed<U extends { id: number }>(user: U | undefined): user is U {
  return user !== undefined && loadAccess().allowFrom.includes(String(user.id));
}

type AttachmentMeta = {
  kind: string;
  file_id: string;
  size?: number | undefined;
  mime?: string | undefined;
  name?: string | undefined;
};

const CHARS_THAT_BREAK_OUT_OF_A_CHANNEL_TAG = /[<>[\]\r\n;]/gu;

function safeName(s: string | undefined): string | undefined {
  return s?.replaceAll(CHARS_THAT_BREAK_OUT_OF_A_CHANNEL_TAG, "_");
}

function linked(text: string, entities: MessageEntity[] = []): string {
  let out = text;

  for (const entity of entities.toReversed()) {
    if (entity.type === "text_link") {
      out = `${out.slice(0, entity.offset)}[${out.slice(entity.offset, entity.offset + entity.length)}](${entity.url})${out.slice(entity.offset + entity.length)}`;
    }
  }

  return out;
}

function senderOf(origin: MessageOrigin): string {
  switch (origin.type) {
    case "user": {
      return (
        origin.sender_user.username ??
        [origin.sender_user.first_name, origin.sender_user.last_name].filter(Boolean).join(" ")
      );
    }

    case "hidden_user": {
      return origin.sender_user_name;
    }

    case "chat": {
      return origin.sender_chat.title ?? String(origin.sender_chat.id);
    }

    case "channel": {
      return origin.chat.title;
    }
  }
}

const REPLY_FILE_KINDS = [
  "animation",
  "document",
  "video",
  "audio",
  "voice",
  "video_note",
  "sticker",
] as const;

// Inside a topic, every message that isn't a reply points at the topic's first message, the one that says the topic was created. A reply to a message in another topic or chat comes as external_reply, with no text. https://core.telegram.org/bots/api#message
async function replyMeta(msg: Context["msg"]): Promise<Record<string, string>> {
  const external = msg?.external_reply;
  const replied = external ? undefined : msg?.reply_to_message;
  const source = external ?? replied;

  if (!msg || !source || replied?.forum_topic_created) {
    return {};
  }

  const id = replied?.message_id ?? external?.message_id;

  const known =
    id === undefined ? undefined : hub.said(`${external?.chat?.id ?? msg.chat.id}:${id}`);

  const text = replied?.text ?? replied?.caption ?? "";

  const user = replied?.from
    ? (replied.from.username ?? String(replied.from.id))
    : external
      ? senderOf(external.origin)
      : "";

  const replyText = text
    ? linked(text, replied?.entities ?? replied?.caption_entities)
    : known?.body;

  const photo = source.photo?.at(-1);
  let imagePath = "";

  if (photo) {
    try {
      imagePath = await download(photo.file_id, photo.file_unique_id);
    } catch (error) {
      process.stderr.write(`telegram hub: replied-to photo download failed: ${String(error)}\n`);
    }
  }

  const kind = REPLY_FILE_KINDS.find((each) => source[each] !== undefined);
  const fileId = kind === undefined ? undefined : source[kind]?.file_id;

  return {
    ...(id !== undefined && { reply_to_message_id: String(id) }),
    ...(user !== "" && { reply_to_user: user }),
    ...(replyText !== undefined && replyText !== "" && { reply_to_text: replyText }),
    ...(msg.quote !== undefined && { reply_to_quote: msg.quote.text }),
    ...(imagePath !== "" && { reply_to_image_path: imagePath }),
    ...(kind !== undefined &&
      fileId !== undefined && {
        reply_to_attachment_kind: kind,
        reply_to_attachment_file_id: fileId,
      }),
  };
}

type Part = {
  ctx: Context;
  text: string;
  downloadImage?: (() => Promise<string | undefined>) | undefined;
  attachment?: AttachmentMeta | undefined;
};

const albums = new Map<string, { parts: Part[]; timer?: ReturnType<typeof setTimeout> }>();

async function handleInbound(
  ctx: Context,
  text: string,
  downloadImage: (() => Promise<string | undefined>) | undefined,
  attachment?: AttachmentMeta,
): Promise<void> {
  if (!allowed(ctx.from)) {
    return;
  }

  const part = { ctx, text, downloadImage, attachment };
  const group = ctx.message?.media_group_id ?? "";

  if (group === "") {
    await deliverInbound([part]);

    return;
  }

  const album = albums.get(group) ?? { parts: [] };
  albums.set(group, album);
  album.parts.push(part);
  clearTimeout(album.timer);
  // Telegram sends an album as one message per item, with no event once the last has arrived. https://core.telegram.org/bots/api#message (media_group_id)
  album.timer = setTimeout(() => {
    albums.delete(group);
    void deliverInbound(album.parts);
  }, ALBUM_WAIT);
}

function listed(name: string, values: (string | number | undefined)[]): Record<string, string> {
  return values.some((value) => value !== undefined)
    ? { [name]: values.map((value) => value ?? "").join("; ") }
    : {};
}

async function deliverInbound(parts: Part[]): Promise<void> {
  const [first] = parts;
  const from = first?.ctx.from;

  if (!first || !from) {
    return;
  }

  const access = loadAccess();
  const { ctx } = first;
  const { msg } = ctx;
  const thread = threadOf(ctx);
  const msgId = msg?.message_id;
  const chat_id = ctx.chat === undefined ? target(thread).chat_id : String(ctx.chat.id);
  const elsewhere = chat_id !== target(thread).chat_id;

  sendTyping(thread);

  if ((access.ackReaction ?? "") !== "" && msgId !== undefined && !ctx.editedMessage) {
    void react(chat_id, msgId, acked()).catch(ignore);
  }

  const downloaded = await Promise.all(parts.map(async (part) => await part.downloadImage?.()));

  const images = parts.flatMap((part, index) => {
    const path = downloaded[index];
    const largest = part.ctx.msg?.photo?.at(-1);

    return path === undefined || path === ""
      ? []
      : [{ path, dimensions: largest ? `${largest.width}x${largest.height}` : "" }];
  });

  const attachments = parts.flatMap((part) => part.attachment ?? []);
  const captioned = parts.find((part) => (part.ctx.msg?.caption ?? "") !== "") ?? first;

  const content =
    parts.length > 1 && captioned.ctx.msg?.caption === undefined
      ? `(album of ${parts.length})`
      : linked(captioned.text, captioned.ctx.msg?.entities ?? captioned.ctx.msg?.caption_entities);

  const user = from.username ?? String(from.id);

  const message: Message = {
    author: "owner",
    ...(msg !== undefined && {
      key: `${msg.chat.id}:${msg.message_id}${ctx.editedMessage ? `@${ctx.editedMessage.edit_date}` : ""}`,
    }),
    content,
    meta: {
      chat_id,
      ...(msgId !== undefined && {
        message_id: elsewhere ? `telegram:${chat_id}:${msgId}` : String(msgId),
      }),
      user,
      user_id: String(from.id),
      ts: new Date((msg?.date ?? 0) * 1000).toISOString(),
      ...(images.length > 0 && { image_path: images.map(({ path }) => path).join("; ") }),
      ...(images.some(({ dimensions }) => dimensions !== "") && {
        image_dimensions: images.map(({ dimensions }) => dimensions).join("; "),
      }),
      ...listed(
        "attachment_kind",
        attachments.map((a) => a.kind),
      ),
      ...listed(
        "attachment_file_id",
        attachments.map((a) => a.file_id),
      ),
      ...listed(
        "attachment_size",
        attachments.map((a) => a.size),
      ),
      ...listed(
        "attachment_mime",
        attachments.map((a) => a.mime),
      ),
      ...listed(
        "attachment_name",
        attachments.map((a) => a.name),
      ),
      ...(await replyMeta(msg)),
      ...(ctx.editedMessage && { edited: "true" }),
      ...(msg?.forward_origin && { forwarded_from: senderOf(msg.forward_origin) }),
    },
  };

  hub.deliver(thread, nameOf(ctx, thread), message);

  if (msgId !== undefined && !elsewhere) {
    const replyTo = message.meta.reply_to_message_id ?? "";

    ledger.heard(thread, msgId, content, replyTo === "" ? undefined : Number(replyTo));
  }
}

let keeping: (() => void) | undefined;
let boarding: Promise<void> | undefined;

const BOARD = "hex right now";

const board = (() => {
  const owner = loadAccess().allowFrom[0];

  if (owner === undefined) {
    return;
  }

  return new Keeper(openStore(stateDir(STATE_DIR)), join(STATE_DIR, "board.json"), {
    send: async (state: State) => {
      const sent = await paced(() =>
        widgets.sendWidget({
          chat_id: owner,
          html: readFileSync(HTML, "utf-8"),
          caption: BOARD,
          allow_queries: false,
          ...state,
        }),
      );

      await bot.api
        .pinChatMessage(owner, sent.message_id, { disable_notification: true })
        .catch(ignore);

      return sent.message_id;
    },
    edit: async (message, state) => {
      try {
        await paced(() =>
          widgets.editMessageWidgetData({ chat_id: owner, message_id: message, ...state }),
        );
      } catch (error) {
        const why = String(error);

        if (
          /message to edit not found|message not found|MESSAGE_ID_INVALID|chat not found|bot was blocked/u.test(
            why,
          )
        ) {
          return "gone";
        }

        if (!why.includes("message is not modified")) {
          throw error;
        }
      }

      return "shown";
    },
    remove: async (message) => {
      await bot.api.deleteMessage(owner, message);
    },
  });
})();

// grammY's default error handler stops the bot and rethrows, so any throw in a handler would stop polling for good. https://grammy.dev/guide/errors
const logInsteadOfStoppingThePolling: Parameters<typeof bot.catch>[0] = (error) => {
  process.stderr.write(`telegram hub: handler error (polling continues): ${String(error.error)}\n`);
};

bot.catch(logInsteadOfStoppingThePolling);

async function setCommandMenu() {
  try {
    await bot.api.setMyCommands([
      {
        command: "model",
        description: `This thread's model: ${MODELS.map(({ value }) => value).join(", ")}`,
      },
      {
        command: "effort",
        description: `This thread's effort: ${EFFORTS.map(({ value }) => value).join(", ")}`,
      },
      { command: "board", description: `A new "${BOARD}" board at the bottom of your DM` },
    ]);
  } catch (error) {
    process.stderr.write(`telegram hub: couldn't set the command menu: ${String(error)}\n`);
  }
}

// A single ETIMEDOUT, ECONNRESET or DNS failure rejects bot.start(), and without this loop the bot goes deaf. https://grammy.dev/guide/errors
let attempt = 0;

const onStart = (info: { username: string }) => {
  attempt = 0;
  process.stderr.write(`telegram hub: polling as @${info.username}\n`);
  polling = info.username;
  void setCommandMenu();
  hub.save();
  keeping ??= ledger.keep(post, (thread, error) => {
    process.stderr.write(
      `telegram hub: couldn't rewrite ${thread}'s status post: ${String(error)}\n`,
    );
  });
  boarding ??= board?.start().catch(ignore);
};

for (;;) {
  attempt++;

  try {
    await bot.start({
      allowed_updates: [
        "message",
        "edited_message",
        "message_reaction",
        "callback_query",
        "poll_answer",
        "widget_query",
      ],
      onStart,
    });
    break;
  } catch (error) {
    const is409 = error instanceof GrammyError && error.error_code === 409;
    const delay = Math.min(1000 * attempt, 15_000);
    process.stderr.write(
      `telegram hub: ${is409 ? "409 Conflict, another poller holds this token" : `polling error: ${String(error)}`}, retrying in ${delay / 1000}s\n`,
    );
    await Bun.sleep(delay);

    if (deaf) {
      break;
    }
  }
}
