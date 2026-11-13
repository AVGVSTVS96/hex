#!/usr/bin/env bun
import {
  copyFileSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  realpathSync,
  chmodSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";

import {
  startHub,
  dispatch,
  clients,
  begin,
  move,
  preview,
  tappable,
  title,
  transcribe,
  MODELS,
  EFFORTS,
  Ledger,
  waits,
} from "@hex/hub";
import type { Handlers, Message, Permission, Turn, MessageId, Post, Question } from "@hex/hub";
import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  MessageType,
  MessageFlags,
  PermissionFlagsBits,
  SnowflakeUtil,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ApplicationCommandOptionType,
  ComponentType,
  ApplicationIntegrationType,
  InteractionContextType,
  DiscordjsErrorCodes,
  RESTJSONErrorCodes,
  Routes,
  parseEmoji,
} from "discord.js";
import type {
  Message as DiscordMessage,
  PartialMessage,
  MessageReaction,
  PartialMessageReaction,
  User,
  PartialUser,
  ButtonInteraction,
  StringSelectMenuInteraction,
  ChatInputCommandInteraction,
  ChatInputApplicationCommandData,
  PollAnswer,
  PartialPollAnswer,
  Attachment,
  Collection,
  Channel,
  NewsChannel,
  ForumChannel,
  TextChannel,
  ThreadChannel,
  AnyThreadChannel,
  DMChannel,
  PartialDMChannel,
} from "discord.js";
import { z } from "zod";

import { server, tools } from "./channel.ts";
import { voiceCalls } from "./voice.ts";

const STATE_DIR =
  process.env.DISCORD_STATE_DIR ?? join(homedir(), ".claude", "channels", "hex", "discord");

const ACCESS_FILE = join(STATE_DIR, "access.json");
const GUILD_FILE = join(STATE_DIR, "guild.json");
const CURSOR_FILE = join(STATE_DIR, "cursor.json");
const ENV_FILE = join(STATE_DIR, ".env");
const INBOX_DIR = join(STATE_DIR, "inbox");
const SENT_DIR = join(STATE_DIR, "sent");
const MAX_CHUNK_LIMIT = 2000;

function readEnvFile(): string {
  try {
    chmodSync(ENV_FILE, 0o600);

    return readFileSync(ENV_FILE, "utf-8");
  } catch {
    return "";
  }
}

for (const line of readEnvFile().split("\n")) {
  const [, key, value] = /^(\w+)=(.*)$/u.exec(line) ?? [];

  if (key !== undefined && value !== undefined) {
    process.env[key] = value;
  }
}

const AccessFile = z.object({
  allowFrom: z.array(z.string()).default([]),
  ackReaction: z.string().optional(),
  replyToMode: z.enum(["off", "first", "all"]).optional(),
  textChunkLimit: z.number().optional(),
  chunkMode: z.enum(["length", "newline"]).optional(),
});

type Access = z.output<typeof AccessFile>;

const Coded = z.object({ code: z.union([z.string(), z.number()]) });

const codeOf = (cause: unknown) => Coded.safeParse(cause).data?.code;

const failed = (what: string) => (cause: unknown) =>
  void process.stderr.write(`discord hub: ${what}: ${String(cause)}\n`);

function loadAccess(): Access {
  try {
    return AccessFile.parse(JSON.parse(readFileSync(ACCESS_FILE, "utf-8")));
  } catch (error) {
    if (codeOf(error) !== "ENOENT") {
      process.stderr.write(
        `discord hub: ${ACCESS_FILE} is unreadable, so every sender is dropped: ${String(error)}\n`,
      );
    }

    return { allowFrom: [] };
  }
}

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const READ = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];

function refuseChannelStateAndSecrets(f: string): void {
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

function sendable(files: string[]): string[] {
  for (const f of files) {
    refuseChannelStateAndSecrets(f);
    const st = statSync(f);

    if (st.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`);
    }
  }

  if (files.length > 10) {
    throw new Error("Discord allows max 10 attachments per message");
  }

  return files;
}

const isText = (ch: Channel | null | undefined): ch is TextChannel | NewsChannel =>
  ch?.type === ChannelType.GuildText || ch?.type === ChannelType.GuildAnnouncement;

const isForum = (ch: Channel | null | undefined): ch is ForumChannel =>
  ch?.type === ChannelType.GuildForum;

const isPostable = (
  ch: Channel | null | undefined,
): ch is TextChannel | NewsChannel | ForumChannel => isText(ch) || isForum(ch);

type Conversation = ThreadChannel | DMChannel | PartialDMChannel;

const nameOf = (ch: Conversation) => (ch.isThread() ? ch.name : "DM");

function inThread(ch: Conversation): ThreadChannel {
  if (!ch.isThread()) {
    throw new Error("a DM is not a thread");
  }

  return ch;
}

async function messageIn(ch: Conversation, id: string): Promise<DiscordMessage> {
  const msg =
    ch.isThread() && id === ch.id ? await ch.fetchStarterMessage() : await ch.messages.fetch(id);

  if (!msg) {
    throw new Error(`no message ${id} in this thread`);
  }

  return msg;
}

const filled = (text: string | null | undefined): text is string =>
  text !== undefined && text !== null && text !== "";

const withoutMentions = (text: string) => text.replaceAll(/<@[!&]?\d+>/gu, "").trim();

const failure = (what: string) => failed(`${what} failed`);

const allowed = (user: string) => loadAccess().allowFrom.includes(user);

async function replyMeta(msg: DiscordMessage): Promise<Record<string, string>> {
  const repliedTo = msg.reference?.messageId;

  if (msg.type !== MessageType.Reply || !filled(repliedTo)) {
    return {};
  }

  const replied = await msg.fetchReference().catch(() => null);

  if (replied === null) {
    return { reply_to_message_id: repliedTo };
  }

  const atts = listed(replied.attachments);

  return {
    reply_to_message_id: replied.id,
    reply_to_user: replied.author.username,
    ...(replied.content !== "" && { reply_to_text: replied.content }),
    ...(atts.length > 0 && { reply_to_attachments: atts.join("; ") }),
  };
}

const Cursor = z.object({ id: z.string() });

function keepCursor(id: string) {
  writeFileSync(`${CURSOR_FILE}.tmp`, `${JSON.stringify({ id })}\n`);
  renameSync(`${CURSOR_FILE}.tmp`, CURSOR_FILE);

  return id;
}

function readCursor(): string {
  try {
    return Cursor.parse(JSON.parse(readFileSync(CURSOR_FILE, "utf-8"))).id;
  } catch {
    return keepCursor(SnowflakeUtil.generate().toString());
  }
}

type Listened = TextChannel | NewsChannel | AnyThreadChannel | DMChannel;

async function messagesAfter(ch: Listened, from: string): Promise<DiscordMessage[]> {
  const found: DiscordMessage[] = [];

  for (let since = from; ;) {
    const page = [...(await ch.messages.fetch({ after: since, limit: 100 })).values()];
    found.push(...page);

    if (page.length < 100) {
      return found;
    }

    for (const m of page) {
      if (BigInt(m.id) > BigInt(since)) {
        since = m.id;
      }
    }
  }
}

// Discord lists archived threads newest-archived first: https://docs.discord.com/developers/resources/channel#list-public-archived-threads
async function archivedSince(
  ch: TextChannel | NewsChannel | ForumChannel,
  from: string,
): Promise<AnyThreadChannel[]> {
  const since = SnowflakeUtil.timestampFrom(from);
  const found: AnyThreadChannel[] = [];

  for (let before: number | undefined; ;) {
    const page = await ch.threads.fetchArchived({
      ...(before !== undefined && { before }),
      limit: 100,
    });

    const threads = [...page.threads.values()];
    found.push(...threads);
    const oldest = Math.min(...threads.map((t) => t.archiveTimestamp ?? 0));

    if (!page.hasMore || threads.length === 0 || oldest < since) {
      return found;
    }

    before = oldest;
  }
}

const ANSWERED_IN = new Map([
  ["app", "in the app"],
  ["call", "on a call"],
]);

const answeredIn = (via: string) => ANSWERED_IN.get(via) ?? via;

const answeredText = ({ label, via }: { label: string; via: string }) =>
  `✓ Answered ${answeredIn(via)}: ${label}`;

function controls({ options, multiple, answer, settled }: Question) {
  if (settled) {
    return only(settled.note);
  }

  if (!answer) {
    return choices(options, multiple === true);
  }

  if (answer.via !== "discord") {
    return only(answeredText(answer));
  }

  return multiple === true
    ? menu(options, answer.label.split("; "))
    : buttons(options, options.indexOf(answer.label));
}

const oneRow = (content: string) => content.replaceAll(/[\r\n]+/gu, " ⏎ ");

const isPoll = (question: Question) => question.poll !== undefined && question.poll !== "";

const latestActivity = (post: ThreadChannel) =>
  SnowflakeUtil.timestampFrom(post.lastMessageId ?? post.id);

type ToolInput<Name extends (typeof tools)[number]["name"]> = Parameters<
  Handlers<typeof tools>[Name]
>[1];

const SearchResult = z.union([
  z.object({
    total_results: z.number(),
    messages: z.array(
      z.array(
        z.object({
          id: z.string(),
          channel_id: z.string(),
          timestamp: z.string(),
          content: z.string(),
          author: z.object({ id: z.string(), username: z.string() }),
          attachments: z.array(z.unknown()),
        }),
      ),
    ),
    threads: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
  }),
  z.object({ retry_after: z.number().optional() }),
]);

const BUTTONS_PER_ROW = 5;

function buttons(labels: string[], chosen?: number): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  for (let start = 0; start < labels.length; start += BUTTONS_PER_ROW) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        labels.slice(start, start + BUTTONS_PER_ROW).map((label, offset) => {
          const i = start + offset;

          return new ButtonBuilder()
            .setCustomId(String(i))
            .setLabel(label)
            .setStyle(i === chosen ? ButtonStyle.Primary : ButtonStyle.Secondary)
            .setDisabled(chosen !== undefined);
        }),
      ),
    );
  }

  return rows;
}

function menu(labels: string[], picked?: string[]): ActionRowBuilder<StringSelectMenuBuilder>[] {
  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("menu")
        .setPlaceholder(picked === undefined ? "Pick any" : picked.join(", ").slice(0, 150))
        .setMinValues(1)
        .setMaxValues(labels.length)
        .setDisabled(picked !== undefined)
        .addOptions(
          labels.map((label, i) => ({
            label,
            value: String(i),
            default: picked?.includes(label) === true,
          })),
        ),
    ),
  ];
}

function choices(labels: string[], multiple: boolean) {
  return multiple ? menu(labels) : buttons(labels);
}

function only(text: string): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("done")
        .setLabel(text.slice(0, 80))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
    ),
  ];
}

const VERDICTS = [
  ["allow", "Allow", ButtonStyle.Success],
  ["deny", "Deny", ButtonStyle.Danger],
] as const;

function verdicts(request: string, chosen?: string): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      VERDICTS.map(([verdict, label, style]) =>
        new ButtonBuilder()
          .setCustomId(`perm:${verdict}:${request}`)
          .setLabel(label)
          .setStyle(
            chosen !== undefined && chosen !== "" && chosen !== verdict
              ? ButtonStyle.Secondary
              : style,
          )
          .setDisabled(chosen !== undefined),
      ),
    ),
  ];
}

function block(text: string, limit: number): string {
  const body = text.replaceAll("```", "`​``");

  return `\`\`\`\n${body.length > limit ? `${body.slice(0, limit - 1)}…` : body}\n\`\`\``;
}

const COMMANDS: ChatInputApplicationCommandData[] = [
  {
    name: "model",
    description: "Switch this thread's model; its next message starts with it",
    options: [
      {
        type: ApplicationCommandOptionType.String as const,
        name: "model",
        description: "Model",
        required: true,
        choices: MODELS.map(({ value, name }) => ({ name, value })),
      },
    ],
  },
  {
    name: "effort",
    description: "Set this thread's effort; its next message starts with it",
    options: [
      {
        type: ApplicationCommandOptionType.String as const,
        name: "effort",
        description: "Effort",
        required: true,
        choices: EFFORTS.map(({ value, name }) => ({ name, value })),
      },
    ],
  },
  { name: "compact", description: "Compact this thread's conversation to free up context" },
  { name: "stop", description: "Stop this thread's session; its next message resumes it" },
].map((command) => ({
  ...command,
  contexts: [InteractionContextType.Guild, InteractionContextType.BotDM],
  integrationTypes: [ApplicationIntegrationType.GuildInstall],
}));

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

  if (rest !== "") {
    out.push(rest);
  }

  return out;
}

// A code block cut across two messages renders broken in both, so each chunk closes the fence it opened and the next reopens it: https://support.discord.com/hc/en-us/articles/210298617
function fenced(text: string, limit: number, mode: "length" | "newline"): string[] {
  const out: string[] = [];
  let open = "";

  for (const part of chunk(text, limit - 16, mode)) {
    let body = open === "" ? part : `${open}\n${part}`;

    for (const line of part.split("\n")) {
      const fence = /^\s*```(\S*)/u.exec(line);

      if (fence) {
        open = open === "" ? `\`\`\`${fence[1] ?? ""}` : "";
      }
    }

    if (open !== "") {
      body += "\n```";
    }

    out.push(body);
  }

  return out;
}

const CHANNEL_TAG_DELIMITERS = /[<>[\]\r\n;]/gu;

function safeAttName(att: Attachment): string {
  return (att.name ?? att.id).replaceAll(CHANNEL_TAG_DELIMITERS, "_");
}

function listed(attachments: Collection<string, Attachment>): string[] {
  return attachments.map(
    (att) =>
      `${safeAttName(att)} (${att.contentType ?? "unknown"}, ${(att.size / 1024).toFixed(0)}KB)`,
  );
}

async function downloadAttachment(att: Attachment): Promise<string> {
  if (att.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `attachment too large: ${(att.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`,
    );
  }

  const res = await fetch(att.url);
  const buf = Buffer.from(await res.arrayBuffer());
  const name = att.name ?? att.id;
  const rawExt = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "bin";
  const ext = rawExt.replaceAll(/[^a-zA-Z0-9]/gu, "") || "bin";
  const path = join(INBOX_DIR, `${Date.now()}-${att.id}.${ext}`);
  mkdirSync(INBOX_DIR, { recursive: true });
  writeFileSync(path, buf);

  return path;
}

async function hear(att: Attachment | undefined): Promise<string | undefined> {
  if (!att) {
    return;
  }

  try {
    return await transcribe(() => downloadAttachment(att));
  } catch (error) {
    failed("voice transcription failed")(error);
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Discord's links to a sent file expire, so the pictures hex sends are kept on disk under their message, for the apps that show them later.
function keepPictures(message: string, files: string[]) {
  const pictures = files.filter((file) => /\.(?:png|jpe?g)$/iu.test(file));

  if (pictures.length === 0) {
    return;
  }

  const dir = join(SENT_DIR, message);
  mkdirSync(dir, { recursive: true });

  const paths = pictures.map((file, i) => {
    const copy = join(dir, `${i}-${basename(file)}`);
    copyFileSync(file, copy);

    return copy;
  });

  return paths.join("; ");
}

async function images(attachments: Collection<string, Attachment>): Promise<string[]> {
  const shown = attachments.filter(
    (att) => att.contentType?.startsWith("image/") === true && att.size <= MAX_ATTACHMENT_BYTES,
  );

  const paths = await Promise.all(
    shown.map((att) => downloadAttachment(att).catch(failed("image download failed"))),
  );

  return paths.filter((path) => path !== undefined);
}

function serve(token: string) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildMessagePolls,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.DirectMessageReactions,
      GatewayIntentBits.DirectMessagePolls,
    ],
    partials: [
      Partials.Channel,
      Partials.Message,
      Partials.Reaction,
      Partials.User,
      Partials.Poll,
      Partials.PollAnswer,
    ],
  });

  const ledger = new Ledger(STATE_DIR, "discord");

  function bot() {
    if (!client.user) {
      throw new Error("the bot isn't logged in to Discord yet");
    }

    return client.user;
  }

  async function threadChannel(thread: string): Promise<Conversation> {
    const ch = await client.channels.fetch(thread);

    if (ch?.isThread() === true) {
      return ch;
    }

    if (ch?.type === ChannelType.DM) {
      return ch;
    }

    throw new Error(`${thread} is not a Discord thread or DM`);
  }

  const post: Post = {
    room: MAX_CHUNK_LIMIT,
    send: async (thread, text) => {
      const sent = await (
        await threadChannel(thread)
      ).send({ content: text, flags: MessageFlags.SuppressEmbeds });

      said(thread, sent.id, text);

      return sent.id;
    },
    pin: async (thread, id) =>
      await (await messageIn(await threadChannel(thread), String(id))).pin(),
    unpin: async (thread, id) => {
      try {
        await (await messageIn(await threadChannel(thread), String(id))).unpin();
      } catch (error) {
        if (codeOf(error) !== RESTJSONErrorCodes.UnknownMessage) {
          throw error;
        }
      }
    },
    edit: async (thread, id, text) => {
      const ch = await threadChannel(thread);

      if (ch.isThread() && ch.archived === true) {
        return false;
      }

      try {
        await (
          await messageIn(ch, String(id))
        ).edit({ content: text, flags: MessageFlags.SuppressEmbeds });
      } catch (error) {
        const code = codeOf(error);

        if (code === RESTJSONErrorCodes.InvalidActionOnArchivedThread) {
          return false;
        }

        if (
          code === RESTJSONErrorCodes.CannotEditMessageAuthoredByAnotherUser ||
          code === RESTJSONErrorCodes.UnknownMessage
        ) {
          return null;
        }

        throw error;
      }
    },
    link: (thread, id) => {
      const where = shown(thread);

      return where === undefined ? undefined : `${where}/${id}`;
    },
    ready: threadChannel,
  };

  function shown(thread: string) {
    const channel = client.channels.cache.get(thread);

    if (channel?.isDMBased() === true) {
      return `https://discord.com/channels/@me/${thread}`;
    }

    if (channel !== undefined && "guildId" in channel) {
      return `https://discord.com/channels/${channel.guildId}/${thread}`;
    }
  }

  function guild() {
    const first = client.guilds.cache.first();

    if (!first) {
      throw new Error("the bot is in no Discord server");
    }

    return first;
  }

  async function textChannel(name?: string): Promise<TextChannel | NewsChannel>;
  async function textChannel(
    name: string | undefined,
    forums: true,
  ): Promise<TextChannel | NewsChannel | ForumChannel>;
  async function textChannel(
    name?: string,
    forums = false,
  ): Promise<TextChannel | NewsChannel | ForumChannel> {
    const fits = forums ? isPostable : isText;
    const g = guild();
    const wanted = name?.replace(/^#/u, "").toLowerCase();

    const found =
      wanted !== undefined && wanted !== ""
        ? (await g.channels.fetch()).find(
            (ch) => fits(ch) && (ch.id === wanted || ch.name.toLowerCase() === wanted),
          )
        : g.systemChannel;

    if (!fits(found)) {
      throw new Error(
        wanted !== undefined && wanted !== ""
          ? `no ${forums ? "text or forum" : "text"} channel named #${wanted}`
          : "name a channel to open the thread in",
      );
    }

    return found;
  }

  async function readable(id: string): Promise<TextChannel | NewsChannel | ThreadChannel> {
    const ch = await client.channels.fetch(id).catch(() => null);
    const text = ch !== null && (isText(ch) || ch.isThread()) ? ch : undefined;

    if (
      text === undefined ||
      text.guildId !== guild().id ||
      text.permissionsFor(bot())?.has(READ) !== true
    ) {
      throw new Error(`the bot can't read ${id}; list_channels shows the channels it can`);
    }

    return text;
  }

  function row(
    sentAt: Date,
    author: { id: string; username: string },
    content: string,
    details: string,
  ): string {
    const who = author.id === client.user?.id ? "me" : author.username;

    return `[${sentAt.toISOString()}] ${who}: ${oneRow(content)}  (${details})`;
  }

  async function history(caller: string, args: ToolInput<"fetch_messages">): Promise<string> {
    const limit = Math.min(args.limit ?? 20, 100);
    const named = filled(args.thread) ? args.thread : undefined;

    const channel =
      named === undefined && filled(args.channel)
        ? await textChannel(args.channel, true)
        : undefined;

    if (isForum(channel)) {
      return await posts(channel, limit);
    }

    const id =
      named === undefined
        ? (channel?.id ?? caller)
        : /^\d+$/u.test(named)
          ? named
          : hub.find(named);

    const ch = id === caller ? await threadChannel(caller) : await readable(id);

    const msgs = await ch.messages.fetch({
      limit,
      ...(filled(args.before) && { before: args.before }),
    });

    const arr = [...msgs.values()].toReversed();

    if (arr.length === 0) {
      return "(no messages)";
    }

    return arr
      .map((m) => {
        const atts = m.attachments.size > 0 ? ` +${m.attachments.size}att` : "";

        const lastReply = m.thread?.lastMessageId;

        const last =
          lastReply === undefined || lastReply === null || lastReply === ""
            ? ""
            : `, last reply ${new Date(SnowflakeUtil.timestampFrom(lastReply)).toISOString()}`;

        const thread = m.thread ? `, ${m.thread.messageCount ?? 0} replies${last}` : "";

        return row(m.createdAt, m.author, m.content, `id: ${m.id}${atts}${thread}`);
      })
      .join("\n");
  }

  async function posts(forum: ForumChannel, limit: number): Promise<string> {
    if (forum.permissionsFor(bot())?.has(READ) !== true) {
      throw new Error(`the bot can't read ${forum.id}; list_channels shows the channels it can`);
    }

    const [active, archived] = await Promise.all([
      forum.threads.fetchActive(),
      forum.threads.fetchArchived({ limit }),
    ]);

    const all = [...active.threads.values(), ...archived.threads.values()].filter(
      (each) => each.parentId === forum.id,
    );

    const rows = all
      .toSorted((a, b) => latestActivity(a) - latestActivity(b))
      .slice(-limit)
      .map(
        (each) =>
          `[${new Date(latestActivity(each)).toISOString()}] ${each.name.replaceAll(/[\r\n]+/gu, " ")}  (post ${each.id}, ${each.messageCount ?? 0} replies${each.archived === true ? ", archived" : ""})`,
      );

    return rows.join("\n") || "(no posts)";
  }

  async function search(args: ToolInput<"search_messages">): Promise<string> {
    const query = new URLSearchParams({
      content: args.query,
      limit: String(Math.min(args.limit ?? 25, 25)),
    });

    if (filled(args.channel)) {
      query.set("channel_id", (await textChannel(args.channel)).id);
    }

    if (args.offset !== undefined && args.offset !== 0) {
      query.set("offset", String(args.offset));
    }

    const found = SearchResult.parse(
      await client.rest.get(Routes.guildMessagesSearch(guild().id), { query }),
    );

    if (!("messages" in found)) {
      return `Discord is still indexing this server's messages; search again ${(found.retry_after ?? 0) === 0 ? "shortly" : `in ${found.retry_after}s`}`;
    }

    const threads = new Map(found.threads?.map((t) => [t.id, t.name]));

    const rows = found.messages.flat().map((m) => {
      const where = threads.has(m.channel_id)
        ? `thread ${m.channel_id} "${threads.get(m.channel_id) ?? ""}"`
        : `#${guild().channels.cache.get(m.channel_id)?.name ?? m.channel_id}`;

      const atts = m.attachments.length > 0 ? ` +${m.attachments.length}att` : "";

      return row(new Date(m.timestamp), m.author, m.content, `id: ${m.id}, in ${where}${atts}`);
    });

    return [`${found.total_results} found, newest first`, ...rows].join("\n");
  }

  async function listChannels(): Promise<string> {
    const found = [...(await guild().channels.fetch()).values()].flatMap((ch) =>
      isPostable(ch) && ch.permissionsFor(bot())?.has(READ) === true ? [ch] : [],
    );

    return (
      found.map((ch) => `#${ch.name}  (id: ${ch.id}${isForum(ch) ? ", forum" : ""})`).join("\n") ||
      "(none)"
    );
  }

  const link = (thread: string) => `https://discord.com/channels/${guild().id}/${thread}`;

  function said(
    thread: string,
    id: string | undefined,
    text: string,
    meta: Record<string, string> = {},
  ) {
    hub.sent(thread, { ...(id !== undefined && { key: id }), content: text, meta });
  }

  async function place(name: string, where?: string, about?: string, tags: string[] = []) {
    const parent = await textChannel(where, true);

    if (!isForum(parent)) {
      const thread = await parent.threads.create({ name });

      if (filled(about)) {
        said(thread.id, (await thread.send(about)).id, about);
      }

      return { thread: thread.id, link: link(thread.id) };
    }

    const wanted = tags.map((tag) => tag.toLowerCase());
    const applied = parent.availableTags.filter((tag) => wanted.includes(tag.name.toLowerCase()));

    if (applied.length < wanted.length) {
      throw new Error(
        `#${parent.name} has the tags ${parent.availableTags.map((tag) => tag.name).join(", ") || "(none)"}`,
      );
    }

    const opened = await parent.threads.create({
      name,
      message: { content: about ?? name },
      appliedTags: applied.map((tag) => tag.id),
    });

    said(opened.id, opened.id, about ?? name);

    return { thread: opened.id, link: link(opened.id) };
  }

  async function backfill(thread: string, turns: Turn[]) {
    const ch = inThread(await threadChannel(thread));
    const parent = ch.parent;

    if (!isPostable(parent)) {
      throw new Error(`${thread} hangs off no text or forum channel`);
    }

    const hook =
      (await parent.fetchWebhooks()).find(
        (each) => each.owner?.id === bot().id && each.token !== null && each.token !== "",
      ) ?? (await parent.createWebhook({ name: "hex" }));

    const [ownerId] = loadAccess().allowFrom;

    if (ownerId === undefined) {
      throw new Error("access.json allows no one, so there's no owner to post as");
    }

    const owner = await client.users.fetch(ownerId);

    const as = {
      me: { username: owner.displayName, avatarURL: owner.displayAvatarURL() },
      hex: {
        username: ch.guild.members.me?.displayName ?? bot().displayName,
        avatarURL: bot().displayAvatarURL(),
      },
    };

    for (const { from, text } of turns) {
      for (const content of fenced(text, MAX_CHUNK_LIMIT, "newline")) {
        await hook.send({ content, threadId: ch.id, ...as[from], allowedMentions: { parse: [] } });
      }
    }
  }

  const deleting = new Set<string>();

  const typing = new Map<string, ReturnType<typeof setInterval>>();

  function sendTyping(thread: string): void {
    void threadChannel(thread)
      .then((ch) => ch.sendTyping())
      .catch(() => null);
  }

  // Discord's typing indicator lasts 10 seconds: https://docs.discord.com/developers/resources/channel#trigger-typing-indicator
  function showTyping(thread: string, busy: boolean): void {
    process.stderr.write(`discord hub: ${thread} ${busy ? "busy" : "idle"}\n`);
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
      }, 8000),
    );
  }

  const asking = new Map<string, Set<string>>();

  async function ask(thread: string, request: Permission): Promise<void> {
    const ch = await threadChannel(thread);
    const input = preview(request);

    const sent = await ch.send({
      content: `🔐 **${request.tool_name}**: ${request.description.slice(0, 300)}${input === "" ? "" : `\n${block(input, 1500)}`}`,
      components: verdicts(request.request_id),
    });

    said(thread, sent.id, sent.content, { permission: request.request_id });
    asking.set(thread, (asking.get(thread) ?? new Set()).add(sent.id));
  }

  function settle(thread: string, busy: boolean, background: boolean): void {
    showTyping(thread, busy);

    if (busy || background) {
      return;
    }

    for (const id of asking.get(thread) ?? []) {
      void threadChannel(thread)
        .then((ch) => ch.messages.edit(id, { components: only("No longer waiting") }))
        .catch(() => null);
    }

    asking.delete(thread);
  }

  // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Ledger.find is not an array method
  const questionAt = (thread: string, message: MessageId) => ledger.find(thread, message);

  async function redraw(thread: string, message: MessageId): Promise<void> {
    const question = questionAt(thread, message);

    if (question === undefined || question.options.length === 0) {
      return;
    }

    const ch = await threadChannel(thread);

    if (!isPoll(question)) {
      await ch.messages.edit(String(message), { components: controls(question) });

      return;
    }

    const answeredElsewhere = question.answer !== undefined && question.answer.via !== "discord";

    // Discord has no endpoint for the bot to vote, so a poll answered elsewhere is ended: https://docs.discord.com/developers/resources/poll#poll-endpoints
    if (question.settled !== undefined || answeredElsewhere) {
      const { poll } = await ch.messages.fetch(String(message));

      if (!poll) {
        throw new Error(`message ${String(message)} has no poll`);
      }

      await poll.end();
    }
  }

  const drawing = new Map<string, Promise<void>>();

  function draw(thread: string, message: MessageId): Promise<void> {
    const key = `${thread}:${message}`;

    const drawn = (drawing.get(key) ?? Promise.resolve())
      .then(() => redraw(thread, message))
      .catch(failed(`couldn't draw the buttons on ${thread} ${message}`));

    drawing.set(key, drawn);
    void drawn.then(() => drawing.get(key) === drawn && drawing.delete(key));

    return drawn;
  }

  function quotable(ref: string): string | undefined {
    const id = ref.replace(/^discord:/u, "");

    if (/^\d+$/u.test(id)) {
      return id;
    }

    const kept = hub.said(id);

    return kept?.meta?.button_message_id ?? kept?.meta?.poll_message_id ?? kept?.meta?.message_id;
  }

  async function answerQuestion(thread: string, message: MessageId, label: string, via: string) {
    const question = questionAt(thread, message);

    if (question === undefined || question.answer !== undefined) {
      return;
    }

    const answered = hub.deliver(
      thread,
      hub.name(thread) ?? thread,
      {
        author: "owner",
        content: isPoll(question) ? `(vote: ${label})` : label,
        meta: {
          chat_id: thread,
          user: `hex ${via}`,
          ts: new Date().toISOString(),
          ...(isPoll(question)
            ? { vote: label, poll_message_id: String(message), poll: question.text }
            : { button: "true", button_message_id: String(message) }),
          answered_in: answeredIn(via),
        },
      },
      () => ledger.answered(thread, message, label, via),
    );

    if (answered) {
      await draw(thread, message);
    }
  }

  async function settleQuestion(thread: string, message: MessageId, note: string) {
    const question = questionAt(thread, message);

    if (question === undefined || !waits(question)) {
      return;
    }

    ledger.settled(thread, message, note);
    await draw(thread, message);
  }

  async function reopenQuestion(thread: string, message: MessageId, via: string) {
    const question = questionAt(thread, message);

    if (
      question === undefined ||
      (question.answer === undefined && question.settled === undefined)
    ) {
      return;
    }

    const taken = question.answer?.label;

    const reopened = filled(taken)
      ? hub.deliver(
          thread,
          hub.name(thread) ?? thread,
          {
            author: "owner",
            content: `(took back: ${taken})`,
            meta: {
              chat_id: thread,
              user: `hex ${via}`,
              ts: new Date().toISOString(),
              took_back: taken,
              [isPoll(question) ? "poll_message_id" : "button_message_id"]: String(message),
            },
          },
          () => ledger.reopened(thread, message),
        )
      : ledger.reopened(thread, message);

    if (reopened) {
      await draw(thread, message);
    }
  }

  async function conversation(caller: string, named?: string) {
    const thread = named === undefined || named === "" ? caller : hub.find(named);

    return { thread, ch: await threadChannel(thread) };
  }

  async function gone(thread: string) {
    try {
      await client.channels.fetch(thread);

      return false;
    } catch (error) {
      return codeOf(error) === RESTJSONErrorCodes.UnknownChannel;
    }
  }

  const handlers: Handlers<typeof tools> = {
    new_thread: async (caller, args) => {
      const name = title(args.title);
      const app = args.app ?? "discord";
      const { about, channel: where } = args;

      if (app !== "discord") {
        return `started thread "${name}" in ${app}: ${(await begin(app, name, args.prompt, { about, ...(where !== undefined && { where }) })).link}`;
      }

      const here = await threadChannel(caller);
      const parent = where ?? (here.isThread() ? here.parent?.name : undefined);
      const { thread, link: opened } = await place(name, parent, about, args.tags);
      hub.open(thread, name, args.prompt);

      return `started thread "${name}": ${opened}`;
    },

    fetch_messages: history,

    list_channels: listChannels,

    search_messages: (_caller, args) => search(args),

    forward: async (caller, args) => {
      const to = filled(args.channel)
        ? await textChannel(args.channel)
        : filled(args.thread)
          ? await threadChannel(hub.find(args.thread))
          : undefined;

      if (to === undefined) {
        throw new Error("name a thread or channel to forward to");
      }

      const sent = await (
        await messageIn(await threadChannel(caller), args.message_id)
      ).forward(to.id);

      return `forwarded (id: ${sent.id})`;
    },

    reply: async (caller, args) => {
      const { thread, ch } = await conversation(caller, args.thread);
      const access = loadAccess();
      const text = tappable(args.text);
      const reply_to = args.reply_to === undefined ? undefined : quotable(args.reply_to);
      const files = sendable(args.files ?? []);
      const labels = args.buttons;
      const multiple = args.multiple === true;
      const asks = labels !== undefined && labels.length > 0;
      const components = asks ? choices(labels, multiple) : undefined;

      const limit = Math.max(
        100,
        Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT),
      );

      const replyMode = access.replyToMode ?? "first";
      const chunks = fenced(text, limit, access.chunkMode ?? "newline");
      const sentIds: string[] = [];

      try {
        for (const [i, content] of chunks.entries()) {
          const shouldReplyTo =
            reply_to !== undefined && replyMode !== "off" && (replyMode === "all" || i === 0);

          const sent = await ch.send({
            content,
            ...(args.silent === true && { flags: MessageFlags.SuppressNotifications }),
            ...(i === 0 && files.length > 0 && { files }),
            ...(i === chunks.length - 1 && components && { components }),
            ...(shouldReplyTo && {
              reply: { messageReference: reply_to, failIfNotExists: false },
            }),
          });

          const pictures = i === 0 ? keepPictures(sent.id, files) : undefined;
          said(thread, sent.id, content, pictures === undefined ? {} : { image_path: pictures });
          sentIds.push(sent.id);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        said(thread, undefined, chunks.slice(sentIds.length).join("\n"), { failed: msg });
        throw new Error(
          `reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`,
          { cause: error },
        );
      }

      const last = sentIds.at(-1);

      if (last === undefined) {
        throw new Error("reply had nothing to send");
      }

      if (asks) {
        ledger.ask(thread, last, text, labels, {
          multiple,
          ...(files.length > 0 && sentIds[0] !== undefined && { attached: [sentIds[0]] }),
        });
      } else if (text !== "") {
        ledger.said(thread, last, text);
      }

      return sentIds.length === 1
        ? `sent (id: ${sentIds[0]})`
        : `sent ${sentIds.length} parts (ids: ${sentIds.join(", ")})`;
    },

    react: async (caller, args) => {
      const { ch } = await conversation(caller);
      const msg = await messageIn(ch, args.message_id);

      if (args.remove !== true) {
        await msg.react(args.emoji);

        return "reacted";
      }

      const emoji = parseEmoji(args.emoji);
      const mine = msg.reactions.cache.get(emoji?.id ?? emoji?.name ?? "");

      if (mine?.me !== true) {
        throw new Error(`the bot hasn't reacted ${args.emoji} to that message`);
      }

      await mine.users.remove();

      return "reaction removed";
    },

    edit_message: async (caller, args) => {
      const { thread, ch } = await conversation(caller);
      const pinned = ledger.pin(thread);

      if (pinned !== undefined && pinned.message === args.message_id && args.text !== undefined) {
        if (args.files !== undefined) {
          throw new Error("a status post is text: send the file in its own message");
        }

        await ledger.rewrite(thread, post, tappable(args.text), pinned.message);
        said(thread, undefined, tappable(args.text), {
          edited: "true",
          message_id: pinned.message,
        });

        return `edited the status post's note (id: ${pinned.message}); hex keeps the questions and tasks under it current`;
      }

      const msg = await messageIn(ch, args.message_id);
      const files = args.files === undefined ? undefined : sendable(args.files);

      const edited =
        args.text !== undefined || files !== undefined
          ? await msg.edit({
              ...(args.text !== undefined && { content: tappable(args.text) }),
              ...(files !== undefined && { files, attachments: [] }),
            })
          : msg;

      if (args.text !== undefined) {
        said(thread, undefined, tappable(args.text), { edited: "true", message_id: edited.id });
        ledger.edited(thread, edited.id, args.text);
      }

      if (args.settled === true) {
        await settleQuestion(thread, edited.id, "✓ Settled");
      }

      return `edited (id: ${edited.id})`;
    },

    delete_message: async (caller, args) => {
      const { thread, ch } = await conversation(caller);
      const msg = await messageIn(ch, args.message_id);

      if (msg.author.id !== bot().id) {
        throw new Error("the bot can only delete its own messages");
      }

      deleting.add(msg.id);

      try {
        await msg.delete();
      } catch (error) {
        deleting.delete(msg.id);
        throw error;
      }

      await ledger.deleted(thread, msg.id);

      return "deleted";
    },

    pin: async (caller, args) => {
      const { thread } = await conversation(caller);

      if (args.unpin === true) {
        const was = await ledger.unpin(thread, post, args.message_id);

        return was === undefined
          ? "this thread has no status post"
          : `unpinned the status post (id: ${was})`;
      }

      if (args.note === undefined) {
        throw new Error("pin takes the status post's note, or unpin: true");
      }

      return `posted and pinned the status post (id: ${await ledger.post(thread, tappable(args.note), post)}); hex keeps the questions and tasks under it current`;
    },

    poll: async (caller, args) => {
      const { thread, ch } = await conversation(caller);

      const sent = await ch.send({
        poll: {
          question: { text: args.question },
          answers: args.options.map((text) => ({ text })),
          allowMultiselect: args.multiple === true,
          duration: 24,
        },
      });

      said(thread, sent.id, args.question, { poll: args.options.join(" / ") });
      ledger.ask(thread, sent.id, args.question, args.options, {
        poll: sent.id,
        multiple: args.multiple === true,
      });

      return `sent poll (id: ${sent.id})`;
    },

    download_attachment: async (caller, args) => {
      const { ch } = await conversation(caller);
      const msg = await messageIn(ch, args.message_id);
      const attachments = msg.messageSnapshots.first()?.attachments ?? msg.attachments;

      if (attachments.size === 0) {
        return "message has no attachments";
      }

      const lines: string[] = [];

      for (const att of attachments.values()) {
        const path = await downloadAttachment(att);
        const kb = (att.size / 1024).toFixed(0);
        lines.push(`  ${path}  (${safeAttName(att)}, ${att.contentType ?? "unknown"}, ${kb}KB)`);
      }

      return `downloaded ${lines.length} attachment(s):\n${lines.join("\n")}`;
    },

    rename_thread: async (caller, args) => {
      const { thread, ch } = await conversation(caller);
      const name = title(args.title);
      await inThread(ch).setName(name);
      hub.rename(thread, name);

      return `renamed to "${name}"`;
    },

    close_thread: async (caller, args) => {
      const thread = filled(args.thread) ? hub.find(args.thread) : caller;

      if (await gone(thread)) {
        const name = hub.name(thread) ?? thread;
        void hub.retire(thread);
        void ledger.forget(thread);

        return `forgot "${name}": its Discord thread no longer exists`;
      }

      const closing = inThread(await threadChannel(thread));
      void hub.retire(thread);
      await closing.setArchived(true);

      return `archived "${closing.name}"; its session stops once it's idle`;
    },

    handoff: async (caller, args) => {
      const { thread, ch } = await conversation(caller);
      const { to } = args;
      const name = filled(args.title) ? title(args.title) : nameOf(ch);
      const target = await move(hub, thread, to, name, args.channel);
      await ch.send(`Moved to ${to}: ${target}`);

      if (ch.isThread()) {
        await ch.setArchived(true);
      }

      return `moving to ${to}: ${target}. Your session stops here once this turn ends and resumes there.`;
    },
  };

  const call = dispatch(tools, handlers);

  const dms = new Set<string>();

  const hub = startHub({
    stateDir: STATE_DIR,
    channel: "plugin:discord@hex",
    server,
    link: shown,
    call,
    state: settle,
    fresh: (thread) => dms.has(thread),
    failed: (thread, reason, turn) => {
      void threadChannel(thread)
        .then(
          async (ch) =>
            await ch.send(
              `${turn === true ? "This thread's last turn failed" : "Couldn't start this thread's session"}: ${reason}`,
            ),
        )
        .catch(() => null);
    },
    permission: (thread, request) =>
      void ask(thread, request).catch(failed(`couldn't relay a permission prompt to ${thread}`)),
    questions: {
      answer: (thread, message, label, via) => void answerQuestion(thread, message, label, via),
      settle: (thread, message, note) => void settleQuestion(thread, message, note),
      reopen: (thread, message, via) => void reopenQuestion(thread, message, via),
    },
    ...(process.env.HEX_DIR !== undefined && { hexDir: process.env.HEX_DIR }),
    ...(process.env.HEX_LAUNCHER !== undefined && { launcher: process.env.HEX_LAUNCHER }),
  });

  clients.set("discord", {
    hub,
    place: (name, where, about) => place(name, where, about),
    backfill,
  });

  voiceCalls(client, allowed);

  async function threadOf(msg: DiscordMessage): Promise<Conversation | undefined> {
    if (msg.channel.isDMBased()) {
      dms.add(msg.channelId);
    }

    if (msg.channel.isThread() || msg.channel.type === ChannelType.DM) {
      return msg.channel;
    }

    if (!isText(msg.channel)) {
      return;
    }

    if (msg.thread !== null && filled(hub.name(msg.thread.id))) {
      return msg.thread;
    }

    if (client.user === null || !msg.mentions.has(client.user)) {
      return;
    }

    const firstWord = withoutMentions(msg.content)
      .split(/\s+/u)
      .find((word) => word !== "");

    return await (msg.thread ?? msg.startThread({ name: firstWord ?? "Thread" }));
  }

  async function handleInbound(
    msg: DiscordMessage,
    edited = false,
    thread?: ThreadChannel,
  ): Promise<void> {
    const access = loadAccess();

    if (!access.allowFrom.includes(msg.author.id)) {
      return;
    }

    if (msg.type === MessageType.ThreadStarterMessage && msg.channel.isThread()) {
      await handleInbound(await msg.fetchReference(), edited, msg.channel);

      return;
    }

    const ch = thread ?? (await threadOf(msg));

    if (ch === undefined) {
      return;
    }

    const opened = !edited && ch.id === msg.id;
    const tagged = opened && ch.isThread() && ch.ownerId === bot().id;
    const forum = ch.isThread() && ch.parent?.isThreadOnly() === true;

    if (ch.isThread() && ch.archived === true) {
      await ch.setArchived(false).catch(() => null);
    }

    void ch.sendTyping().catch(() => null);

    if (filled(access.ackReaction)) {
      void msg.react(access.ackReaction).catch(() => null);
    }

    const forwarded = msg.messageSnapshots.first();
    const source = forwarded ?? msg;
    const atts = listed(source.attachments);
    const stickers = source.stickers.map((s) => `${s.name} (${s.url})`);
    const poll = msg.poll;
    const voiced = source.flags.has(MessageFlags.IsVoiceMessage);
    const heard = voiced ? await hear(source.attachments.first()) : undefined;
    const shots = edited || voiced ? [] : await images(source.attachments);
    const typed = withoutMentions(source.content);

    const placeholder =
      atts.length > 0 ? "(attachment)" : stickers.length > 0 ? "(sticker)" : poll ? "(poll)" : "";

    const message: Message = {
      author: "owner",
      key: edited ? `${msg.id}@${String(msg.editedTimestamp)}` : msg.id,
      content: filled(heard)
        ? `(voice message) ${heard}`
        : voiced
          ? "(voice message that didn't transcribe: fetch it with download_attachment and run .hex/bin/transcribe on the file)"
          : typed === ""
            ? placeholder
            : typed,
      meta: {
        chat_id: ch.id,
        message_id: msg.id,
        user: msg.author.username,
        user_id: msg.author.id,
        ts: msg.createdAt.toISOString(),
        ...(ch.isThread() && ch.parent && { channel: ch.parent.name }),
        ...(tagged && { new_thread: "true" }),
        ...(opened && forum && { post_title: nameOf(ch) }),
        ...(shots.length > 0 && { image_path: shots.join("; ") }),
        ...(atts.length > 0 && {
          attachment_count: String(atts.length),
          attachments: atts.join("; "),
        }),
        ...(stickers.length > 0 && { stickers: stickers.join("; ") }),
        ...(poll && {
          poll: poll.question.text ?? "",
          poll_options: poll.answers.map((a) => a.text).join("; "),
          ...(poll.allowMultiselect && { poll_multiple: "true" }),
        }),
        ...(await replyMeta(msg)),
        ...(edited && { edited: "true" }),
        ...(forwarded && { forwarded: "true" }),
      },
    };

    hub.deliver(ch.id, nameOf(ch), message);
    ledger.heard(ch.id, msg.id, message.content, message.meta.reply_to_message_id);
  }

  async function servedThread(
    msg: DiscordMessage | PartialMessage,
  ): Promise<Conversation | undefined> {
    const id = msg.channel.isThread() || msg.channel.isDMBased() ? msg.channelId : msg.id;

    return filled(hub.name(id)) ? await threadChannel(id) : undefined;
  }

  async function handleReaction(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
    removed: boolean,
  ): Promise<void> {
    if (!allowed(user.id)) {
      return;
    }

    const ch = await servedThread(reaction.message);

    if (ch === undefined) {
      return;
    }

    const target = reaction.message.partial
      ? await reaction.message.fetch().catch(() => null)
      : reaction.message;

    const who = user.partial ? await user.fetch() : user;
    const emoji = reaction.emoji.toString();
    hub.deliver(ch.id, nameOf(ch), {
      author: "owner",
      content: `(${removed ? "reaction removed" : "reaction"}: ${emoji})`,
      meta: {
        chat_id: ch.id,
        user: who.username,
        user_id: who.id,
        ts: new Date().toISOString(),
        reaction: emoji,
        ...(removed && { reaction_removed: "true" }),
        reaction_to_message_id: reaction.message.id,
        ...(target !== null && { reaction_to_user: target.author.username }),
        ...(target !== null && filled(target.content) && { reaction_to_text: target.content }),
      },
    });
  }

  // Discord's delete event doesn't say who deleted the message: https://docs.discord.com/developers/events/gateway-events#message-delete
  async function handleDelete(msg: DiscordMessage | PartialMessage): Promise<void> {
    if (deleting.delete(msg.id)) {
      return;
    }

    const ch = await servedThread(msg);

    if (ch === undefined) {
      return;
    }

    void ledger.deleted(ch.id, msg.id);
    hub.deliver(ch.id, nameOf(ch), {
      author: "other",
      content: "(deleted a message)",
      meta: {
        user: "discord",
        chat_id: ch.id,
        message_id: msg.id,
        ts: new Date().toISOString(),
        deleted: "true",
        ...(filled(msg.content) && { deleted_text: msg.content }),
      },
    });
  }

  async function handleVote(
    answer: PollAnswer | PartialPollAnswer,
    userId: string,
    removed: boolean,
  ): Promise<void> {
    if (!allowed(userId)) {
      return;
    }

    const ch = await servedThread(answer.poll.message);

    if (ch === undefined) {
      return;
    }

    const msg = answer.poll.message.partial
      ? await answer.poll.message.fetch()
      : answer.poll.message;

    if (msg.author.id !== bot().id || msg.poll === null) {
      return;
    }

    const vote = msg.poll.answers.get(answer.id)?.text ?? "";
    const who = await client.users.fetch(userId);
    hub.deliver(
      ch.id,
      nameOf(ch),
      {
        author: "owner",
        content: `(${removed ? "vote removed" : "vote"}: ${vote})`,
        meta: {
          chat_id: ch.id,
          user: who.username,
          user_id: who.id,
          ts: new Date().toISOString(),
          vote,
          ...(removed && { vote_removed: "true" }),
          poll_message_id: msg.id,
          poll: msg.poll.question.text ?? "",
        },
      },
      () => {
        if (!removed) {
          ledger.answered(ch.id, msg.id, vote, "discord", true);
        } else if (questionAt(ch.id, msg.id)?.answer?.label === vote) {
          ledger.reopened(ch.id, msg.id);
        }

        return true;
      },
    );
  }

  async function picked(
    ch: Conversation,
    label: string,
    tappedAt: Date,
    user: { id: string; username: string },
    message: string,
  ) {
    const question = questionAt(ch.id, message);
    hub.deliver(
      ch.id,
      nameOf(ch),
      {
        author: "owner",
        content: label,
        meta: {
          chat_id: ch.id,
          user: user.username,
          user_id: user.id,
          ts: tappedAt.toISOString(),
          button: "true",
          button_message_id: message,
        },
      },
      question && (() => ledger.answered(ch.id, message, label, "discord")),
    );

    if (question !== undefined) {
      await draw(ch.id, message);
    }
  }

  // Discord wants the first answer to a tap within 3 seconds: https://docs.discord.com/developers/interactions/receiving-and-responding#responding-to-an-interaction
  async function handleTap(tap: ButtonInteraction): Promise<void> {
    if (!allowed(tap.user.id)) {
      await tap.deferUpdate();

      return;
    }

    const [, behavior, request] = /^perm:(allow|deny):(\w+)$/u.exec(tap.customId) ?? [];

    if (request !== undefined && (behavior === "allow" || behavior === "deny")) {
      await tap.update({ components: verdicts(request, behavior) });
      asking.get(tap.channelId)?.delete(tap.message.id);

      hub.answer(tap.channelId, request, behavior);

      return;
    }

    const labels = tap.message.components.flatMap((actionRow) =>
      actionRow.type === ComponentType.ActionRow
        ? actionRow.components.flatMap((each) =>
            each.type === ComponentType.Button ? [each.label ?? ""] : [],
          )
        : [],
    );

    const chosen = Number(tap.customId);
    await tap.update({ components: buttons(labels, chosen) });
    await picked(
      await threadChannel(tap.channelId),
      labels[chosen] ?? "",
      tap.createdAt,
      tap.user,
      tap.message.id,
    );
  }

  async function handleMenu(pick: StringSelectMenuInteraction): Promise<void> {
    if (!allowed(pick.user.id)) {
      await pick.deferUpdate();

      return;
    }

    const labels = pick.component.options.map((option) => option.label);
    const chosen = pick.values.map((value) => labels[Number(value)] ?? "");
    await pick.update({ components: menu(labels, chosen) });
    await picked(
      await threadChannel(pick.channelId),
      chosen.join("; "),
      pick.createdAt,
      pick.user,
      pick.message.id,
    );
  }

  async function handleCommand(command: ChatInputCommandInteraction): Promise<void> {
    const answer = async (content: string) => {
      await command.reply({ content, flags: MessageFlags.Ephemeral });
    };

    if (!allowed(command.user.id)) {
      await answer("hex only answers its owner.");

      return;
    }

    const thread = command.channelId;

    if (!filled(hub.name(thread))) {
      await answer("This channel has no session: use it in one of hex's threads or the DM.");

      return;
    }

    switch (command.commandName) {
      case "model":
      case "effort": {
        const value = command.options.getString(command.commandName, true);
        hub.configure(thread, { [command.commandName]: value });

        const name =
          [...MODELS, ...EFFORTS].find((choice) => choice.value === value)?.name ?? value;

        await answer(
          `${command.commandName === "model" ? "Model" : "Effort"}: ${name}, from this thread's next message.`,
        );

        return;
      }

      case "compact": {
        await answer(compacting(thread));

        return;
      }

      case "stop": {
        void hub.stop(thread);
        await answer("Stopped. The next message resumes it.");
      }
    }
  }

  function compacting(thread: string): string {
    if (dms.has(thread)) {
      return "The DM starts a fresh session whenever its last one is spent, so there's nothing to compact.";
    }

    if (typing.has(thread)) {
      return "This thread is working; compact it once it's done.";
    }

    if (!filled(hub.session(thread))) {
      return "This thread has nothing to compact yet.";
    }

    void hub.command(thread, "/compact");

    return "Compacting this thread.";
  }

  client.on("messageReactionAdd", (reaction, user) => {
    handleReaction(reaction, user, false).catch(failure("handleReaction"));
  });

  client.on("messageReactionRemove", (reaction, user) => {
    handleReaction(reaction, user, true).catch(failure("handleReaction"));
  });

  client.on("messagePollVoteAdd", (answer, userId) => {
    handleVote(answer, userId, false).catch(failure("handleVote"));
  });

  client.on("messagePollVoteRemove", (answer, userId) => {
    handleVote(answer, userId, true).catch(failure("handleVote"));
  });

  client.on("messageDelete", (msg) => {
    handleDelete(msg).catch(failure("handleDelete"));
  });

  client.on("messageDeleteBulk", (msgs) => {
    for (const msg of msgs.values()) {
      handleDelete(msg).catch(failure("handleDelete"));
    }
  });

  client.on("interactionCreate", (interaction) => {
    if (interaction.isButton()) {
      handleTap(interaction).catch(failure("handleTap"));
    } else if (interaction.isStringSelectMenu()) {
      handleMenu(interaction).catch(failure("handleMenu"));
    } else if (interaction.isChatInputCommand()) {
      handleCommand(interaction).catch(failure("handleCommand"));
    }
  });

  let cursor = readCursor();

  let oneAtATimeBehindTheCursor: Promise<unknown> = Promise.resolve();
  let caught = new Set<string>();

  async function take(msg: DiscordMessage) {
    if (!msg.author.bot) {
      await handleInbound(msg).catch(failure("handleInbound"));
    }

    if (BigInt(msg.id) > BigInt(cursor)) {
      cursor = keepCursor(msg.id);
    }
  }

  const listensIn = (ch: Channel | null | undefined): ch is Listened =>
    ch?.type === ChannelType.DM ||
    (ch !== null &&
      ch !== undefined &&
      (isText(ch) || ch.isThread()) &&
      ch.permissionsFor(bot())?.has(READ) === true);

  async function catchUp() {
    const from = cursor;
    const g = client.guilds.cache.first();

    const [channels, active, ownerDms] = await Promise.all([
      g ? g.channels.fetch().then((found) => [...found.values()]) : [],
      g ? g.channels.fetchActiveThreads().then((found) => [...found.threads.values()]) : [],
      Promise.all(
        loadAccess().allowFrom.map(async (id) => {
          try {
            return await client.users.createDM(id, { force: true });
          } catch (error) {
            failure(`opening the DM with ${id}`)(error);
          }
        }),
      ),
    ]);

    const parents = channels.flatMap((ch) =>
      isPostable(ch) && ch.permissionsFor(bot())?.has(READ) === true ? [ch] : [],
    );

    const archived = await Promise.all(
      parents.map(async (ch) => {
        try {
          return await archivedSince(ch, from);
        } catch (error) {
          failure(`listing ${ch.id}'s archived threads`)(error);

          return [];
        }
      }),
    );

    const places = [...channels, ...active, ...archived.flat(), ...ownerDms]
      .filter(listensIn)
      .filter((ch) => filled(ch.lastMessageId) && BigInt(ch.lastMessageId) > BigInt(from));

    const missed = (
      await Promise.all(
        places.map(async (ch) => {
          try {
            return await messagesAfter(ch, from);
          } catch (error) {
            failure(`catching up on ${ch.id}`)(error);

            return [];
          }
        }),
      )
    )
      .flat()
      .toSorted((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

    if (missed.length > 0) {
      process.stderr.write(
        `discord hub: catching up on ${missed.length} message(s) since ${new Date(SnowflakeUtil.timestampFrom(from)).toISOString()}\n`,
      );
    }

    caught = new Set(missed.map((m) => m.id));

    for (const msg of missed) {
      await take(msg);
    }
  }

  client.on("shardReady", () => {
    oneAtATimeBehindTheCursor = oneAtATimeBehindTheCursor
      .then(catchUp)
      .catch(failure("catching up"));
  });

  client.on("messageCreate", (msg) => {
    oneAtATimeBehindTheCursor = oneAtATimeBehindTheCursor
      .then(() => (caught.has(msg.id) ? undefined : take(msg)))
      .catch(failure("handling a message"));
  });

  client.on("messageUpdate", (before, after) => {
    if (before.partial || before.content === after.content || after.author.bot) {
      return;
    }

    handleInbound(after, true).catch(failure("handleInbound"));
  });

  client.on("threadUpdate", (before, after) => {
    if (before.name !== after.name) {
      hub.rename(after.id, after.name);
    }

    if (before.archived === true && after.archived !== true) {
      ledger.rewrite(after.id, post).catch(failed(`couldn't rewrite ${after.id}'s status post`));
    }
  });

  client.on("threadDelete", (thread) => {
    process.stderr.write(`discord hub: thread ${thread.id} was deleted, forgetting it\n`);
    void ledger.forget(thread.id);
    void hub.retire(thread.id);
  });

  client.on("error", (error) => {
    process.stderr.write(`discord hub: client error: ${String(error)}\n`);
  });

  client.once("clientReady", (c) => {
    process.stderr.write(`discord hub: gateway connected as ${c.user.tag}\n`);
    const id = client.guilds.cache.first()?.id;

    if (filled(id)) {
      writeFileSync(GUILD_FILE, `${JSON.stringify({ id })}\n`);
    }

    hub.save();
    void c.application?.commands.set(COMMANDS).catch(failure("registering slash commands"));
    ledger.keep(post, (thread, error) => {
      failed(`couldn't rewrite ${thread}'s status post`)(error);
    });
  });

  async function login(attempt = 1): Promise<void> {
    try {
      await client.login(token);
    } catch (error) {
      if (codeOf(error) === DiscordjsErrorCodes.TokenInvalid) {
        failed("login failed")(error);

        return;
      }

      const delay = Math.min(1000 * 2 ** (attempt - 1), 60_000);
      process.stderr.write(
        `discord hub: login failed: ${String(error)}, retrying in ${delay / 1000}s\n`,
      );
      setTimeout(() => void login(attempt + 1), delay);
    }
  }

  void login();
}

const TOKEN = process.env.DISCORD_BOT_TOKEN;

if (TOKEN !== undefined && TOKEN !== "") {
  process.on("unhandledRejection", (error) => {
    process.stderr.write(`discord hub: unhandled rejection: ${String(error)}\n`);
  });
  process.on("uncaughtException", (error) => {
    process.stderr.write(`discord hub: uncaught exception: ${String(error)}\n`);
  });
  serve(TOKEN);
} else {
  process.stderr.write(`discord hub: no DISCORD_BOT_TOKEN in ${ENV_FILE}, Discord stays off\n`);
}
