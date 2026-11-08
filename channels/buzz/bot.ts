#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
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

import { decode } from "nostr-tools/nip19";
import { finalizeEvent } from "nostr-tools/pure";
import type { Event } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";
import { z } from "zod";

import { startHub, clients, begin, move, tappable, title, dispatch } from "../../hub/hub.ts";
import type { Handlers, Message, Turn } from "../../hub/hub.ts";
import { startActivity } from "./activity.ts";
import { server, tools } from "./channel.ts";
import { startMemory } from "./memory.ts";
import { connectRelay, nostrEvent } from "./relay.ts";

const STATE_DIR =
  process.env.BUZZ_STATE_DIR ?? join(homedir(), ".claude", "channels", "hex", "buzz");

const ACCESS_FILE = join(STATE_DIR, "access.json");
const ENV_FILE = join(STATE_DIR, ".env");
const CURSOR_FILE = join(STATE_DIR, "cursor.json");
const BUTTONS_FILE = join(STATE_DIR, "buttons.json");
const CHANNELS_FILE = join(STATE_DIR, "channels.json");
const INBOX_DIR = join(STATE_DIR, "inbox");

type Json = z.core.util.JSONType;

type Args<Name extends keyof Handlers<typeof tools>> = Parameters<Handlers<typeof tools>[Name]>[1];

const access = z.object({
  allowFrom: z
    .array(z.string())
    .describe("Pubkeys (hex) allowed to talk to Hex. Default: the owner named in the auth tag.")
    .exactOptional(),
  channel: z
    .string()
    .describe("Channel, by name or id, that handoffs from other apps open in. Default: general.")
    .exactOptional(),
  panels: z.boolean().describe("false turns off the activity and memory panels.").exactOptional(),
  share: z
    .array(z.string())
    .describe("Files and folders, relative to the hex folder, shown in the owner's memory panel.")
    .exactOptional(),
});

const asked = z.object({
  thread: z.string(),
  choices: z.array(z.object({ label: z.string(), reaction: z.string().exactOptional() })),
  chosen: z.number().exactOptional(),
});

type Asked = z.output<typeof asked>;

const cursorSchema = z.object({ at: z.number(), ids: z.array(z.string()) });

const authTagSchema = z.tuple([z.string(), z.string()], z.string());

const profileNames = z.looseObject({
  display_name: z.string().default("").catch(""),
  name: z.string().default("").catch(""),
});

function isGiven(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

function readEnvFile(): string {
  try {
    chmodSync(ENV_FILE, 0o600);

    return readFileSync(ENV_FILE, "utf-8");
  } catch {
    return "";
  }
}

function loadAccess(): z.output<typeof access> {
  let raw: unknown;

  try {
    raw = JSON.parse(readFileSync(ACCESS_FILE, "utf-8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }

    process.stderr.write(
      `buzz hub: ${ACCESS_FILE} is unreadable, so every sender is dropped: ${String(error)}\n`,
    );

    return { allowFrom: [] };
  }

  const parsed = access.safeParse(raw);

  if (!parsed.success) {
    process.stderr.write(
      `buzz hub: ${ACCESS_FILE} is unreadable, so every sender is dropped: ${z.prettifyError(parsed.error)}\n`,
    );

    return { allowFrom: [] };
  }

  return parsed.data;
}

const isNsec = (key: string): key is `nsec1${string}` => key.startsWith("nsec1");

function secretKeyOf(key: string): Uint8Array {
  return isNsec(key) ? decode(key).data : hexToBytes(key);
}

const BUZZ_MESSAGE_CAP_BYTES = 64 * 1024;
const MOST_BYTES_A_CHARACTER_TAKES = 4;
const MAX_CHUNK_LIMIT = BUZZ_MESSAGE_CAP_BYTES / MOST_BYTES_A_CHARACTER_TAKES;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

const CHAT = 9;
const OLDER_CHAT = 40_002;
const DIFF = 40_008;
const POST = 45_001;
const COMMENT = 45_003;
const EDIT = 40_003;
const REACTION = 7;
const NIP09_DELETION = 5;
const NIP29_ADMIN_DELETION = 9005;
const MESSAGES = [CHAT, OLDER_CHAT, DIFF, POST, COMMENT];
const INBOUND = [CHAT, POST, COMMENT, EDIT, REACTION, NIP09_DELETION, NIP29_ADMIN_DELETION];
const CANVAS = 40_100;
const TYPING = 20_002;
const PRESENCE = 20_001;
const NIP29_CREATE_GROUP = 9007;
const NIP29_ADD_USER = 9000;
const RESEND_TYPING_SINCE_BUZZ_SHOWS_IT_ABOUT_8_SECONDS_MS = 3000;
const OLDER_RELAYS_UPLOAD = "/media/upload";

const uploadedBlob = z.looseObject({
  url: z.string(),
  sha256: z.string(),
  size: z.number(),
  type: z.string(),
  dim: z.string().exactOptional(),
});

const threadSummary = z.looseObject({
  descendant_count: z.number(),
  last_reply_at: z.number().exactOptional(),
});

const KEYCAPS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

function assertNotChannelStateOrSecrets(f: string): void {
  let real: string;
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

function chunk(text: string, limit: number): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const out: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    const para = rest.lastIndexOf("\n\n", limit);
    const line = rest.lastIndexOf("\n", limit);
    const space = rest.lastIndexOf(" ", limit);
    const cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/u, "");
  }

  if (rest) {
    out.push(rest);
  }

  return out;
}

function chunksThatCloseAndReopenCodeFences(text: string, limit: number): string[] {
  const out: string[] = [];
  let open = "";

  for (const part of chunk(text, limit - 16)) {
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

function keep(path: string, value: Json) {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value)}\n`);
  renameSync(`${path}.tmp`, path);
}

function load<T>(path: string, schema: z.ZodType<T>, fallback: T): T {
  let raw: unknown;

  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return fallback;
  }

  const parsed = schema.safeParse(raw);

  return parsed.success ? parsed.data : fallback;
}

const withoutVariationSelector = (emoji: string) => emoji.replaceAll("️", "");

const keycap = (emoji: string) =>
  KEYCAPS.findIndex(
    (choice) => withoutVariationSelector(choice) === withoutVariationSelector(emoji),
  );

function now() {
  return Math.floor(Date.now() / 1000);
}

function iso(seconds: number) {
  return new Date(seconds * 1000).toISOString();
}

function byTime(a: Event, b: Event) {
  return a.created_at - b.created_at || a.id.localeCompare(b.id);
}

function tag(event: Event, name: string) {
  return event.tags.find((t) => t[0] === name)?.[1];
}

const EVENT_ID = /^[0-9a-f]{64}$/u;

function marked(event: Event, marker: string): string | undefined {
  return event.tags.find((t) => t[0] === "e" && EVENT_ID.test(t[1] ?? "") && t[3] === marker)?.[1];
}

function nip10RootAsBuzzReadsIt(event: Event): string | undefined {
  const reply = marked(event, "reply");

  return reply === undefined ? undefined : (marked(event, "root") ?? reply);
}

function filesOf(event: Event) {
  return event.tags
    .filter((t) => t[0] === "imeta")
    .map((t) => {
      const fields = Object.fromEntries(
        t
          .slice(1)
          .map((field) => [
            field.slice(0, field.indexOf(" ")),
            field.slice(field.indexOf(" ") + 1),
          ]),
      );

      const name = (fields.filename ?? fields.url?.split("/").pop() ?? "file").replaceAll(
        /[<>[\]\r\n;]/gu,
        "_",
      );

      return {
        url: fields.url ?? "",
        type: fields.m ?? "unknown",
        size: Number(fields.size ?? 0),
        name,
      };
    });
}

function listed(event: Event): string[] {
  return filesOf(event).map(
    (file) => `${file.name} (${file.type}, ${(file.size / 1024).toFixed(0)}KB)`,
  );
}

const isChannel = (thread: string) => thread.includes("-");

const link = (channel: string, id: string) => `buzz://message?channel=${channel}&id=${id}`;

function threadTags(thread: string, parent?: string): string[][] {
  if (isChannel(thread)) {
    return isGiven(parent) ? [["e", parent, "", "reply"]] : [];
  }

  return isGiven(parent) && parent !== thread
    ? [
        ["e", thread, "", "root"],
        ["e", parent, "", "reply"],
      ]
    : [["e", thread, "", "reply"]];
}

function serve(url: string, secretKey: Uint8Array, authTag: z.output<typeof authTagSchema>) {
  const [, owner] = authTag;
  const relay = connectRelay({ url, secretKey, authTag });
  const me = relay.pubkey;
  const start = now();
  const http = url.replace(/^ws/u, "http").replace(/\/$/u, "");
  const channels = new Map<string, { name: string; dm: boolean; forum: boolean }>();

  const homes = new Map(Object.entries(load(CHANNELS_FILE, z.record(z.string(), z.string()), {})));
  const names = new Map<string, Promise<string>>();
  const triggers = new Map<string, string[]>();
  const acks = new Map<string, string[]>();
  const typing = new Map<string, ReturnType<typeof setInterval>>();

  const reactions = new Map<
    string,
    { thread: string; emoji: string; meta: Record<string, string> }
  >();

  const buttons = load(BUTTONS_FILE, z.record(z.string(), asked), {});

  const accessAtStart = loadAccess();
  const panels = accessAtStart.panels !== false;

  const activity = panels
    ? startActivity({
        relay,
        secretKey,
        owner,
        hexDir: process.env.HEX_DIR ?? process.cwd(),
        cancel,
      })
    : undefined;

  const memory = panels
    ? startMemory({
        relay,
        secretKey,
        owner,
        hexDir: process.env.HEX_DIR ?? process.cwd(),
        share: accessAtStart.share,
      })
    : undefined;

  function log(line: string) {
    process.stderr.write(`buzz hub: ${line}\n`);
    activity?.log(line);
  }

  const allowed = (pubkey: string) => (loadAccess().allowFrom ?? [owner]).includes(pubkey);

  function nameOf(pubkey: string): Promise<string> {
    const known = names.get(pubkey);

    if (known) {
      return known;
    }

    const looked = relay.query([{ kinds: [0], authors: [pubkey], limit: 1 }]).then(
      ([profile]) => {
        const content = profile?.content ?? "";
        const { display_name, name } = profileNames.parse(JSON.parse(content || "{}"));

        return display_name || name || pubkey.slice(0, 8);
      },
      () => pubkey.slice(0, 8),
    );

    names.set(pubkey, looked);

    return looked;
  }

  function home(thread: string, channel: string) {
    if (homes.get(thread) === channel) {
      return;
    }

    homes.set(thread, channel);
    keep(CHANNELS_FILE, Object.fromEntries(homes));
    hub.save();
  }

  async function channelOf(thread: string): Promise<string> {
    if (isChannel(thread)) {
      return thread;
    }

    const known = homes.get(thread);

    if (known !== undefined) {
      return known;
    }

    const [root] = await relay.query([{ kinds: MESSAGES, ids: [thread] }]);
    const channel = root && tag(root, "h");

    if (!isGiven(channel)) {
      throw new Error(`can't find the channel of thread ${thread}`);
    }

    home(thread, channel);

    return channel;
  }

  function channelNamed(where?: string): string {
    const wanted = where?.replace(/^#/u, "").toLowerCase();

    if (isGiven(wanted) && channels.has(wanted)) {
      return wanted;
    }

    const open = [...channels].filter(([, channel]) => !channel.dm);

    const found = isGiven(wanted)
      ? open.find(([, channel]) => channel.name.toLowerCase() === wanted)
      : (open.find(([, channel]) => channel.name.toLowerCase() === "general") ?? open[0]);

    if (!found) {
      throw new Error(
        isGiven(wanted) ? `Hex is in no channel named #${wanted}` : "Hex is in no Buzz channel",
      );
    }

    return found[0];
  }

  function onlyHexsOwnChannel(caller: string, channel: string): string {
    const known = channels.get(channel);

    if (!known) {
      throw new Error("Hex isn't in that channel; list_channels shows the ones it is in");
    }

    if (known.dm && channel !== caller) {
      throw new Error("that is a direct message with someone else");
    }

    return channel;
  }

  async function post(
    thread: string,
    content: string,
    extra: string[][] = [],
    parent?: string,
  ): Promise<Event> {
    const channel = await channelOf(thread);

    return await relay.publish({
      kind: channels.get(channel)?.forum === true ? COMMENT : CHAT,
      content,
      tags: [["h", channel], ...threadTags(thread, parent), ["p", owner], ...extra],
    });
  }

  async function place(name: string, where?: string, aboutLine?: string) {
    const channel = channelNamed(where ?? loadAccess().channel);

    const root = await relay.publish({
      kind: channels.get(channel)?.forum === true ? POST : CHAT,
      content: [`**${name}**`, aboutLine].filter(Boolean).join("\n"),
      tags: [
        ["h", channel],
        ["p", owner],
      ],
    });

    home(root.id, channel);

    return { thread: root.id, link: tappable(link(channel, root.id)) };
  }

  // The relay refuses events dated more than 15 minutes off, so a backfill posts the chat now, quoting the owner's lines: https://github.com/block/buzz/blob/d839d3731a11ab363a69e7f5b851c3031b7680dd/crates/buzz-relay/src/handlers/ingest.rs#L2670
  async function backfill(thread: string, turns: Turn[]) {
    const name = await nameOf(owner);

    for (const { from, text } of turns) {
      for (const part of chunksThatCloseAndReopenCodeFences(text, MAX_CHUNK_LIMIT)) {
        await post(
          thread,
          from === "me" ? `> **${name}**\n${part.replaceAll(/^/gmu, "> ")}` : part,
        );
      }
    }
  }

  function blossom(action: "upload" | "get", sha256?: string) {
    const auth = finalizeEvent(
      {
        kind: 24_242,
        content: action === "get" ? "Get buzz-media" : "Upload file",
        created_at: now(),
        tags: [
          ["t", action],
          ...(isGiven(sha256) ? [["x", sha256]] : []),
          ["expiration", String(now() + 60)],
          ["server", new URL(http).host],
        ],
      },
      secretKey,
    );

    return {
      Authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64url")}`,
      "x-auth-tag": JSON.stringify(authTag),
    };
  }

  async function blossomUploadAsTheBuzzCliDoes(path: string) {
    const body = readFileSync(path);
    const sha256 = createHash("sha256").update(body).digest("hex");
    const [type = ""] = Bun.file(path).type.split(";");

    const put = (endpoint: string) =>
      fetch(`${http}${endpoint}`, {
        method: "PUT",
        body,
        headers: { ...blossom("upload", sha256), "Content-Type": type, "X-SHA-256": sha256 },
      });

    let res = await put("/upload");

    if (res.status === 404 || res.status === 405) {
      res = await put(OLDER_RELAYS_UPLOAD);
    }

    if (!res.ok) {
      throw new Error(`upload of ${path} failed: ${res.status} ${await res.text()}`);
    }

    const blob = uploadedBlob.parse(await res.json());

    const filename = basename(path);

    const line = blob.type.startsWith("video/")
      ? `![video](${blob.url})`
      : blob.type.startsWith("image/")
        ? `![image](${blob.url})`
        : `[${filename.replaceAll(/[\\[\]]/gu, "\\$&")}](${blob.url})`;

    const imeta = [
      "imeta",
      `url ${blob.url}`,
      `m ${blob.type}`,
      `x ${blob.sha256}`,
      `size ${blob.size}`,
      ...(isGiven(blob.dim) ? [`dim ${blob.dim}`] : []),
      `filename ${filename}`,
    ];

    return { line, imeta };
  }

  async function download(
    file: { url: string; name: string; size: number },
    id: string,
  ): Promise<string> {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `attachment too large: ${(file.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`,
      );
    }

    const res = await fetch(file.url, {
      headers: new URL(file.url).host === new URL(http).host ? blossom("get") : {},
    });

    if (!res.ok) {
      throw new Error(`download failed: HTTP ${res.status}`);
    }

    const rawExt = file.name.includes(".")
      ? file.name.slice(file.name.lastIndexOf(".") + 1)
      : "bin";

    const ext = rawExt.replaceAll(/[^a-zA-Z0-9]/gu, "") || "bin";
    const path = join(INBOX_DIR, `${Date.now()}-${id.slice(0, 8)}.${ext}`);
    mkdirSync(INBOX_DIR, { recursive: true });
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));

    return path;
  }

  async function message(thread: string, id: string): Promise<Event> {
    const [found] = await relay.query([
      { kinds: MESSAGES, ids: [id], "#h": [await channelOf(thread)] },
    ]);

    if (!found) {
      throw new Error(`no message ${id} in this thread`);
    }

    return found;
  }

  async function nip98Query(filters: Json[]): Promise<Event[]> {
    const queryUrl = `${http}/query`;
    const body = JSON.stringify(filters);

    const auth = finalizeEvent(
      {
        kind: 27_235,
        content: "",
        created_at: now(),
        tags: [
          ["u", queryUrl],
          ["method", "POST"],
          ["payload", createHash("sha256").update(body).digest("hex")],
          ["nonce", crypto.randomUUID()],
        ],
      },
      secretKey,
    );

    const headers = {
      Authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64")}`,
      "x-auth-tag": JSON.stringify(authTag),
      "Content-Type": "application/json",
    };

    const res = await fetch(queryUrl, { method: "POST", body, headers });

    if (!res.ok) {
      throw new Error(`the relay refused the read: ${res.status} ${await res.text()}`);
    }

    return z.array(nostrEvent).parse(await res.json());
  }

  async function rows(events: Event[], note: (event: Event) => string = () => ""): Promise<string> {
    if (events.length === 0) {
      return "(no messages)";
    }

    const lines = await Promise.all(
      events.map(async (m) => {
        const who = m.pubkey === me ? "me" : await nameOf(m.pubkey);
        const files = filesOf(m).length;
        const atts = files > 0 ? ` +${files}att` : "";
        const oneLineSoItCantForgeTheNextRow = m.content.replaceAll(/[\r\n]+/gu, " ⏎ ");

        return `[${iso(m.created_at)}] ${who}: ${oneLineSoItCantForgeTheNextRow}  (id: ${m.id}${atts}${note(m)})`;
      }),
    );

    return lines.join("\n");
  }

  async function channelWindow(channel: string, limit: number, before?: Event): Promise<string> {
    const window: Json = {
      kinds: MESSAGES,
      "#h": [channel],
      limit,
      top_level: true,
      include_summaries: true,
    };

    if (before) {
      window.until = before.created_at;
      window.before_id = before.id;
    }

    const page = await nip98Query([window]);

    if (!page.some((event) => event.kind === 39_006)) {
      throw new Error("the relay won't show Hex that channel");
    }

    const threads = new Map(
      page
        .filter((event) => event.kind === 39_005)
        .map((event) => [tag(event, "d"), threadSummary.parse(JSON.parse(event.content))]),
    );

    const newestFirst = page.filter((event) => MESSAGES.includes(event.kind));

    return await rows(newestFirst.toReversed(), (event) => {
      const thread = threads.get(event.id);

      if (!thread) {
        return "";
      }

      const lastReply =
        thread.last_reply_at === undefined || thread.last_reply_at === 0
          ? ""
          : `, last reply ${iso(thread.last_reply_at)}`;

      return `, ${thread.descendant_count} replies${lastReply}`;
    });
  }

  async function history(caller: string, args: Args<"fetch_messages">): Promise<string> {
    const limit = Math.min(args.limit ?? 20, 100);
    const named = args.thread;

    const thread = isGiven(named)
      ? /^[0-9a-f]{64}$/u.test(named)
        ? named
        : hub.find(named)
      : isGiven(args.channel)
        ? channelNamed(args.channel)
        : caller;

    const channel = await channelOf(thread);

    if (thread !== caller) {
      onlyHexsOwnChannel(caller, channel);
    }

    const before = isGiven(args.before) ? await message(channel, args.before) : undefined;

    if (isChannel(thread) && channels.get(thread)?.dm !== true) {
      return await channelWindow(thread, limit, before);
    }

    const page = before ? { until: before.created_at, limit: limit + 1 } : { limit };

    const events = await relay.query(
      isChannel(thread)
        ? [{ kinds: MESSAGES, "#h": [channel], ...page }]
        : [
            { kinds: MESSAGES, ids: [thread], "#h": [channel] },
            { kinds: MESSAGES, "#h": [channel], "#e": [thread], ...page },
          ],
    );

    return await rows(
      events
        .filter((event) => !before || byTime(event, before) < 0)
        .toSorted(byTime)
        .slice(-limit),
    );
  }

  async function search(caller: string, args: Args<"search_messages">): Promise<string> {
    const limit = Math.min(args.limit ?? 20, 100);

    const scope = isGiven(args.channel)
      ? [onlyHexsOwnChannel(caller, channelNamed(args.channel))]
      : [...channels].flatMap(([id, channel]) => (!channel.dm || id === caller ? [id] : []));

    const hits =
      scope.length > 0
        ? await relay.query([{ kinds: MESSAGES, search: args.query, "#h": scope, limit }])
        : [];

    return await rows(hits, (event) => {
      const channel = channels.get(tag(event, "h") ?? "");
      const root = nip10RootAsBuzzReadsIt(event);

      const where =
        channel?.dm === true ? "this direct message" : `#${channel?.name ?? "undefined"}`;

      return `, in ${where}${isGiven(root) ? `, thread ${root}` : ""}`;
    });
  }

  function edit(target: Event, text: string) {
    const links = filesOf(target).map((file) => `](${file.url})`);

    const mediaDesktopShowsInPlaceOfTheOriginals = target.content
      .split("\n")
      .filter((line) => links.some((each) => line.endsWith(each)));

    const imeta = target.tags.filter((t) => t[0] === "imeta");

    return relay.publish({
      kind: EDIT,
      content: [text, ...mediaDesktopShowsInPlaceOfTheOriginals].join("\n"),
      tags: [["h", tag(target, "h") ?? ""], ["e", target.id], ...imeta],
    });
  }

  async function canvas(channel: string, text?: string, revision?: string): Promise<string> {
    const [head] = await relay.query([{ kinds: [CANVAS], "#h": [channel], limit: 1 }]);

    if (text === undefined) {
      return head
        ? `${head.content}\n\n(revision: ${head.id})`
        : "(this channel has no canvas yet)";
    }

    const asDesktopDoesOneSecondPastTheHead = (head?.created_at ?? 0) + 1;

    const saved = await relay.publish({
      kind: CANVAS,
      content: text,
      tags: [["h", channel], ...(isGiven(revision) ? [["expected-revision", revision]] : [])],
      created_at: Math.max(now(), asDesktopDoesOneSecondPastTheHead),
    });

    return `canvas saved (revision: ${saved.id})`;
  }

  async function whoIsOnline(): Promise<string> {
    const people = loadAccess().allowFrom ?? [owner];

    const status = new Map(
      (await nip98Query([{ kinds: [PRESENCE], authors: people }])).map((event) => [
        tag(event, "p") ?? event.pubkey,
        event.content,
      ]),
    );

    const lines = await Promise.all(
      people.map(async (pubkey) => `${await nameOf(pubkey)}: ${status.get(pubkey) ?? "offline"}`),
    );

    return lines.join("\n");
  }

  function listChannels(): string {
    const lines = [...channels].map(([id, channel]) =>
      channel.dm ? `${channel.name}  (id: ${id}, direct message)` : `#${channel.name}  (id: ${id})`,
    );

    return lines.join("\n") || "(none)";
  }

  async function createChannel(args: Args<"create_channel">): Promise<string> {
    const name = args.name.trim().replace(/^#/u, "");

    if (name === "") {
      throw new Error("a channel needs a name");
    }

    const id = crypto.randomUUID();
    const forum = args.type === "forum";
    await relay.publish({
      kind: NIP29_CREATE_GROUP,
      content: "",
      tags: [
        ["h", id],
        ["name", name],
        ["visibility", args.private === true ? "private" : "open"],
        ["channel_type", forum ? "forum" : "stream"],
        ...(isGiven(args.about) ? [["about", args.about]] : []),
      ],
    });
    await relay.publish({
      kind: NIP29_ADD_USER,
      content: "",
      tags: [
        ["h", id],
        ["p", owner],
      ],
    });
    channels.set(id, { name, dm: false, forum });
    listen();

    return `created #${name} (id: ${id}); new_thread can open threads in it`;
  }

  function react(id: string, emoji: string) {
    return relay.publish({ kind: REACTION, content: emoji, tags: [["e", id]] });
  }

  async function ack(thread: string, id: string, emoji: string) {
    const reaction = await react(id, emoji);
    acks.set(thread, [...(acks.get(thread) ?? []), reaction.id]);
  }

  function unack(thread: string) {
    for (const id of acks.get(thread) ?? []) {
      void relay
        .publish({ kind: NIP09_DELETION, content: "", tags: [["e", id]] })
        .catch(() => null);
    }

    acks.delete(thread);
  }

  function sendTyping(thread: string): void {
    void channelOf(thread)
      .then((channel) =>
        relay.publish({ kind: TYPING, content: "", tags: [["h", channel], ...threadTags(thread)] }),
      )
      .catch(() => null);
  }

  function showState(thread: string, busy: boolean): void {
    log(`${thread} ${busy ? "busy" : "idle"}`);
    const started = busy && !typing.has(thread);
    clearInterval(typing.get(thread));
    typing.delete(thread);

    if (!busy) {
      triggers.delete(thread);
      unack(thread);
      activity?.idle(thread);

      return;
    }

    typing.set(
      thread,
      setInterval(() => {
        sendTyping(thread);
      }, RESEND_TYPING_SINCE_BUZZ_SHOWS_IT_ABOUT_8_SECONDS_MS),
    );
    const latest = triggers.get(thread)?.at(-1);

    if (started) {
      sendTyping(thread);

      if (isGiven(latest)) {
        void ack(thread, latest, "💬").catch(() => null);
      }
    }

    void showBusyInActivity(thread).catch(() => null);
  }

  async function showBusyInActivity(thread: string) {
    const channel = await channelOf(thread);

    if (typing.has(thread)) {
      activity?.busy({
        thread,
        channel,
        session: hub.session(thread),
        triggers: triggers.get(thread) ?? [],
      });
    }
  }

  function cancel({
    channel,
    thread,
    session,
  }: {
    channel: string;
    thread?: string;
    session?: string;
  }) {
    const matches = [...typing.keys()].filter(
      (busy) =>
        (isChannel(busy) ? busy : homes.get(busy)) === channel &&
        (!isGiven(thread) || busy === thread) &&
        (!isGiven(session) || hub.session(busy) === session),
    );

    const [only, ...others] = matches;

    if (only === undefined) {
      return "no_active_turn";
    }

    if (others.length > 0) {
      return "ambiguous_target";
    }

    stop(only);

    return "sent";
  }

  function stop(thread: string) {
    void hub.interrupt(thread).catch(() => null);
  }

  const handlers: Handlers<typeof tools> = {
    new_thread: async (caller, args) => {
      const name = title(args.title);
      const app = args.app ?? "buzz";

      if (app !== "buzz") {
        const where = args.channel === undefined ? {} : { where: args.channel };
        const opened = await begin(app, name, args.prompt, { about: args.about, ...where });

        return `started thread "${name}" in ${app}: ${opened.link}`;
      }

      const { thread } = await place(name, args.channel ?? (await channelOf(caller)), args.about);

      hub.open(thread, name, args.prompt);

      return `started thread "${name}": ${link(await channelOf(thread), thread)}`;
    },
    fetch_messages: history,
    search_messages: search,
    list_channels: () => Promise.resolve(listChannels()),
    create_channel: async (_caller, args) => await createChannel(args),
    presence: async () => await whoIsOnline(),
    canvas: async (caller, args) => {
      const channel = isGiven(args.channel)
        ? onlyHexsOwnChannel(caller, channelNamed(args.channel))
        : await channelOf(caller);

      return await canvas(channel, args.text, args.revision);
    },
    reply: async (caller, args) => {
      const thread = isGiven(args.thread) ? hub.find(args.thread) : caller;
      const choices = args.buttons ?? [];

      if (choices.length > KEYCAPS.length) {
        throw new Error(`at most ${KEYCAPS.length} buttons`);
      }

      const text = [args.text, choices.map((label, i) => `${KEYCAPS[i]} ${label}`).join("\n")]
        .filter(Boolean)
        .join("\n\n");

      const files = args.files ?? [];

      for (const f of files) {
        assertNotChannelStateOrSecrets(f);
        const st = statSync(f);

        if (st.size > MAX_ATTACHMENT_BYTES) {
          throw new Error(
            `file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 100MB)`,
          );
        }
      }

      const uploads = await Promise.all(files.map(blossomUploadAsTheBuzzCliDoes));
      const chunks = chunksThatCloseAndReopenCodeFences(text, MAX_CHUNK_LIMIT);
      const sentIds: string[] = [];

      try {
        for (const [i, part] of chunks.entries()) {
          const last = i === chunks.length - 1;
          const content = last ? part + uploads.map((u) => `\n${u.line}`).join("") : part;

          const sent = await post(
            thread,
            content,
            last ? uploads.map((u) => u.imeta) : [],
            i === 0 ? args.reply_to : undefined,
          );

          hub.sent(thread, { key: sent.id, content });
          sentIds.push(sent.id);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        hub.sent(thread, {
          content: chunks.slice(sentIds.length).join("\n"),
          meta: { failed: msg },
        });
        throw new Error(
          `reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`,
          { cause: error },
        );
      }

      const lastId = sentIds.at(-1);

      if (choices.length > 0 && lastId !== undefined) {
        const offered: Asked = { thread, choices: choices.map((label) => ({ label })) };
        buttons[lastId] = offered;
        keep(BUTTONS_FILE, buttons);

        for (const [i, choice] of offered.choices.entries()) {
          choice.reaction = (await react(lastId, KEYCAPS[i] ?? "")).id;
        }

        keep(BUTTONS_FILE, buttons);
      }

      return sentIds.length === 1
        ? `sent (id: ${lastId})`
        : `sent ${sentIds.length} parts (ids: ${sentIds.join(", ")})`;
    },
    react: async (caller, args) => {
      const target = await message(caller, args.message_id);

      if (args.remove !== true) {
        await react(target.id, args.emoji);

        return "reacted";
      }

      const mine = await relay.query([
        { kinds: [7], authors: [me], "#e": [target.id], "#h": [tag(target, "h") ?? ""] },
      ]);

      const reaction = mine.find((event) => event.content === args.emoji);

      if (!reaction) {
        throw new Error(`the bot hasn't reacted ${args.emoji} to that message`);
      }

      await relay.publish({ kind: 5, content: "", tags: [["e", reaction.id]] });

      return "reaction removed";
    },
    edit_message: async (caller, args) => {
      const target = await message(caller, args.message_id);

      if (target.pubkey !== me) {
        throw new Error("only the bot's own messages can be edited");
      }

      const edited = await edit(target, args.text);
      hub.sent(caller, {
        key: edited.id,
        content: args.text,
        meta: { edited: "true", message_id: target.id },
      });

      return `edited (id: ${edited.id})`;
    },
    delete_message: async (caller, args) => {
      const target = await message(caller, args.message_id);

      if (target.pubkey !== me) {
        throw new Error("only the bot's own messages can be deleted");
      }

      await relay.publish({
        kind: 5,
        content: "",
        tags: [
          ["h", tag(target, "h") ?? ""],
          ["e", target.id],
        ],
      });

      return "deleted";
    },
    download_attachment: async (caller, args) => {
      const msg = await message(caller, args.message_id);
      const files = filesOf(msg);

      if (files.length === 0) {
        return "message has no attachments";
      }

      const lines: string[] = [];

      for (const file of files) {
        const path = await download(file, msg.id);
        lines.push(`  ${path}  (${file.name}, ${file.type}, ${(file.size / 1024).toFixed(0)}KB)`);
      }

      return `downloaded ${lines.length} attachment(s):\n${lines.join("\n")}`;
    },
    rename_thread: async (caller, args) => {
      const name = title(args.title);
      hub.rename(caller, name);
      const head = isChannel(caller) ? undefined : await message(caller, caller);

      if (head?.pubkey !== me) {
        return `renamed to "${name}"`;
      }

      await edit(head, `**${name}**`);

      return `renamed to "${name}", and its first message in Buzz now says so`;
    },
    close_thread: async (caller, args) => {
      const thread = isGiven(args.thread) ? hub.find(args.thread) : caller;

      if (isChannel(thread)) {
        throw new Error("only threads can be closed");
      }

      void hub.retire(thread);
      await react(thread, "✅");

      return `closed "${hub.name(thread) ?? thread}"; its session stops once it's idle`;
    },
    handoff: async (caller, args) => {
      const name = isGiven(args.title) ? title(args.title) : (hub.name(caller) ?? "Buzz");
      const target = await move(hub, caller, args.to, name, args.channel);
      await post(caller, `Moved to ${args.to}: ${target}`);

      return `moving to ${args.to}: ${target}. Your session stops here once this turn ends and resumes there.`;
    },
  };

  const call = dispatch(tools, handlers);

  const hub = startHub({
    stateDir: STATE_DIR,
    channel: "plugin:buzz@hex",
    server,
    link: (thread) =>
      isChannel(thread)
        ? `buzz://channel/${thread}`
        : homes.has(thread)
          ? link(homes.get(thread) ?? "", thread)
          : undefined,
    call,
    state: showState,
    fresh: (thread) => channels.get(thread)?.dm ?? false,
    failed: (thread, reason) => {
      void post(thread, `Couldn't start this thread's session: ${reason}`).catch(() => null);
    },
    hexDir: process.env.HEX_DIR,
    launcher: process.env.HEX_LAUNCHER,
  });

  clients.set("buzz", { hub, place, backfill, close: shutdown, stop });

  async function unmention(text: string): Promise<string> {
    const label = (await nameOf(me)).replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const pubkeyDesktopAddsWhenTwoMembersShareAName = `(?: \\(${me}\\))?`;

    return text
      .replaceAll(
        new RegExp(
          `(^|\\s)@${label}${pubkeyDesktopAddsWhenTwoMembersShareAName}(?=[\\s,;.!?:)]|$)`,
          "giu",
        ),
        "$1",
      )
      .trim();
  }

  function threadOf(event: Event, tagged: boolean): string | undefined {
    const head = nip10RootAsBuzzReadsIt(event) ?? event.id;

    if (hub.name(head) !== undefined) {
      return head;
    }

    const channel = tag(event, "h") ?? "";

    if (channels.get(channel)?.dm === true) {
      return channel;
    }

    return tagged ? head : undefined;
  }

  async function replyMeta(
    event: Event,
    thread: string,
    joined: boolean,
  ): Promise<{ meta: Record<string, string>; own?: string | undefined }> {
    const parent = marked(event, "reply");

    if (!isGiven(parent) || (parent === thread && !joined)) {
      return { meta: {} };
    }

    const [replied] = await relay.query([{ kinds: MESSAGES, ids: [parent] }]);

    if (!replied) {
      return { meta: { reply_to_message_id: parent } };
    }

    const atts = listed(replied);

    const meta: Message["meta"] = {
      reply_to_message_id: replied.id,
      reply_to_user: replied.pubkey === me ? "me" : await nameOf(replied.pubkey),
    };

    if (replied.content !== "") {
      meta.reply_to_text = replied.content;
    }

    if (atts.length > 0) {
      meta.reply_to_attachments = atts.join("; ");
    }

    return {
      meta,
      own: replied.pubkey === event.pubkey ? await unmention(replied.content) : undefined,
    };
  }

  async function originalOf(event: Event): Promise<Event | undefined> {
    if (event.kind !== EDIT) {
      return event;
    }

    const id = tag(event, "e");
    const [original] = isGiven(id) ? await relay.query([{ kinds: MESSAGES, ids: [id] }]) : [];

    return original?.pubkey === event.pubkey ? original : undefined;
  }

  function authorOf(event: Event) {
    return event.pubkey === owner ? "owner" : "other";
  }

  async function about(
    event: Event,
    thread: string,
    channel = tag(event, "h"),
  ): Promise<Record<string, string>> {
    const where = channels.get(channel ?? "");

    const meta: Message["meta"] = {
      chat_id: thread,
      user: await nameOf(event.pubkey),
      user_id: event.pubkey,
      ts: iso(event.created_at),
    };

    if (where && !where.dm) {
      meta.channel = where.name;
    }

    return meta;
  }

  async function inbound(event: Event): Promise<void> {
    if (event.pubkey === me || !allowed(event.pubkey)) {
      return;
    }

    if (event.kind === REACTION) {
      await handleReaction(event);

      return;
    }

    if (event.kind === NIP09_DELETION || event.kind === NIP29_ADMIN_DELETION) {
      await handleDeletion(event);

      return;
    }

    await handleInbound(event);
  }

  async function handleReaction(event: Event): Promise<void> {
    const id = event.tags.findLast((t) => t[0] === "e")?.[1];
    const offered = isGiven(id) ? buttons[id] : undefined;
    const index = keycap(event.content);

    if (isGiven(id) && offered?.choices[index]) {
      if (offered.chosen === undefined) {
        await tap(event, id, offered, index);
      }

      return;
    }

    const [target] = isGiven(id) ? await relay.query([{ kinds: MESSAGES, ids: [id] }]) : [];
    const thread = target && threadOf(target, false);

    if (!target || !isGiven(thread)) {
      return;
    }

    const meta: Message["meta"] = {
      reaction_to_message_id: target.id,
      reaction_to_user: target.pubkey === me ? "me" : await nameOf(target.pubkey),
    };

    if (target.content !== "") {
      meta.reaction_to_text = target.content;
    }

    reactions.set(event.id, { thread, emoji: event.content, meta });
    hub.deliver(thread, hub.name(thread) ?? (await nameOf(event.pubkey)), {
      key: event.id,
      author: authorOf(event),
      content: `(reaction: ${event.content})`,
      meta: { ...(await about(event, thread, tag(target, "h"))), reaction: event.content, ...meta },
    });
  }

  async function tap(event: Event, id: string, offered: Asked, index: number): Promise<void> {
    offered.chosen = index;
    keep(BUTTONS_FILE, buttons);

    for (const [i, choice] of offered.choices.entries()) {
      if (i !== index && isGiven(choice.reaction)) {
        void relay
          .publish({ kind: NIP09_DELETION, content: "", tags: [["e", choice.reaction]] })
          .catch(() => null);
      }
    }

    const meta = await about(event, offered.thread, await channelOf(offered.thread));
    hub.deliver(offered.thread, hub.name(offered.thread) ?? meta.user ?? "", {
      key: event.id,
      author: authorOf(event),
      content: offered.choices[index]?.label ?? "",
      meta: { ...meta, button: "true", button_message_id: id },
    });
  }

  async function handleDeletion(event: Event): Promise<void> {
    const id = tag(event, "e") ?? "";
    const reaction = reactions.get(id);
    const keptByHexDbSinceTheRelayHidesDeletedEvents = hub.said(id);
    const found = keptByHexDbSinceTheRelayHidesDeletedEvents;
    const wasReactionOrTap = isGiven(found?.meta?.reaction) || isGiven(found?.meta?.button);
    const said = wasReactionOrTap ? undefined : found;
    const thread = reaction?.thread ?? said?.to;

    if (!isGiven(thread) || (hub.name(thread) === undefined && channels.get(thread)?.dm !== true)) {
      return;
    }

    reactions.delete(id);
    const meta = await about(event, thread);
    const author = authorOf(event);
    const deletion: Message["meta"] = { ...meta, deleted: "true", message_id: id };

    if (isGiven(said?.body)) {
      deletion.deleted_text = said.body;
    }

    hub.deliver(
      thread,
      hub.name(thread) ?? meta.user ?? "",
      reaction
        ? {
            key: event.id,
            author,
            content: `(reaction removed: ${reaction.emoji})`,
            meta: { ...meta, reaction: reaction.emoji, reaction_removed: "true", ...reaction.meta },
          }
        : {
            key: event.id,
            author,
            content: "(deleted a message)",
            meta: deletion,
          },
    );
  }

  async function handleInbound(event: Event): Promise<void> {
    const original = await originalOf(event);

    if (!original) {
      return;
    }

    const edited = original !== event;
    const tagged = [original, event].some((e) => e.tags.some((t) => t[0] === "p" && t[1] === me));
    const thread = threadOf(original, tagged);

    if (!isGiven(thread)) {
      return;
    }

    const channel = tag(original, "h") ?? "";
    const joined = !edited && !isChannel(thread) && hub.name(thread) === undefined;

    if (!isChannel(thread)) {
      home(thread, channel);
    }

    const text = await unmention(event.content);

    if (!edited && event.pubkey === owner && tagged && text === "!shutdown") {
      await shutdown();

      return;
    }

    if (!edited && event.pubkey === owner && tagged && text === "!cancel") {
      stop(thread);

      return;
    }

    triggers.set(thread, [...(triggers.get(thread) ?? []), original.id]);
    void ack(thread, original.id, "👀").catch(() => null);

    const listedInMetaSinceContentIsForgeable = listed(event);
    const atts = listedInMetaSinceContentIsForgeable;
    const { meta: reply, own } = await replyMeta(original, thread, joined);

    const firstWord = (text || (reply.reply_to_text ?? ""))
      .split(/\s+/u)
      .find((word) => word !== "" && !word.startsWith("@"));

    const name = isChannel(thread) ? await nameOf(event.pubkey) : (firstWord ?? "Thread");

    const meta: Message["meta"] = {
      ...(await about(event, thread, channel)),
      message_id: original.id,
    };

    if (joined) {
      meta.new_thread = "true";
    }

    if (atts.length > 0) {
      meta.attachment_count = String(atts.length);
      meta.attachments = atts.join("; ");
    }

    Object.assign(meta, reply);

    if (edited) {
      meta.edited = "true";
    }

    const ownWordsOnABareTag = own ?? "";

    const delivered: Message = {
      key: event.id,
      author: authorOf(event),
      content: text || (atts.length > 0 ? "(attachment)" : ownWordsOnABareTag || "(tagged you)"),
      meta,
    };

    hub.deliver(thread, name, delivered);
  }

  let cursor = load(CURSOR_FILE, cursorSchema, { at: start, ids: [] });

  function handled(event: Event) {
    if (event.created_at < cursor.at) {
      return;
    }

    cursor =
      event.created_at === cursor.at
        ? { at: cursor.at, ids: [...cursor.ids, event.id] }
        : { at: event.created_at, ids: [event.id] };
    keep(CURSOR_FILE, cursor);
  }

  let oneAtATimeInArrivalOrder = Promise.resolve();
  let off = false;
  let unlisten: (() => void) | undefined;

  async function handleInTurn(event: Event) {
    if (off || (event.created_at === cursor.at && cursor.ids.includes(event.id))) {
      return;
    }

    try {
      await inbound(event);
    } catch (error) {
      log(`handleInbound failed: ${String(error)}`);
    }

    try {
      handled(event);
    } catch (error) {
      log(`couldn't save where Buzz left off: ${String(error)}`);
    }
  }

  function listen() {
    const previous = unlisten;
    const relaySendsLiveOnlyToASubscriptionNamingEachChannel = [...channels.keys()];

    unlisten =
      channels.size === 0
        ? undefined
        : relay.subscribe(
            [
              {
                kinds: INBOUND,
                "#h": relaySendsLiveOnlyToASubscriptionNamingEachChannel,
                since: cursor.at,
              },
            ],
            (event) => {
              const previousEvent = oneAtATimeInArrivalOrder;
              oneAtATimeInArrivalOrder = (async () => {
                await previousEvent;
                await handleInTurn(event);
              })();
            },
          );
    previous?.();
  }

  async function enter(ids: string[]) {
    const metas = ids.length > 0 ? await relay.query([{ kinds: [39_000], "#d": ids }]) : [];

    for (const id of ids) {
      const meta = metas.find((each) => tag(each, "d") === id);

      const dm =
        meta?.tags.some((t) => (t[0] === "t" && t[1] === "dm") || t[0] === "hidden") ?? false;

      const forum = meta?.tags.some((t) => t[0] === "t" && t[1] === "forum") ?? false;
      channels.set(id, { name: (meta ? tag(meta, "name") : undefined) ?? id, dm, forum });
    }

    listen();
  }

  async function discover() {
    const members = await relay.query([{ kinds: [39_002], "#p": [me] }]);
    await enter(members.map((event) => tag(event, "d") ?? "").filter((id) => id !== ""));
    log(`connected as ${me.slice(0, 8)}, in ${channels.size} channel(s)`);
  }

  async function joinChannel(id: string) {
    try {
      await enter([id]);
    } catch (error) {
      log(`joining ${id} failed: ${String(error)}`);
    }
  }

  const membership = relay.subscribe(
    [{ kinds: [44_100, 44_101], "#p": [me], since: start }],
    (event) => {
      const id = tag(event, "h");

      if (!isGiven(id)) {
        return;
      }

      if (event.kind === 44_100) {
        void joinChannel(id);

        return;
      }

      channels.delete(id);
      listen();
    },
  );

  function presence() {
    void relay.publish({ kind: PRESENCE, content: "online", tags: [] }).catch(() => null);
  }

  const heartbeat = setInterval(presence, 60_000);
  presence();

  async function locate() {
    for (const thread of hub.threads()) {
      if (!isChannel(thread) && !homes.has(thread)) {
        await channelOf(thread).catch(() => null);
      }
    }
  }

  async function startUp() {
    try {
      await discover();
      await locate();
    } catch (error) {
      log(`channel discovery failed: ${String(error)}`);
    }
  }

  void startUp();

  async function shutdown() {
    log("shutting down");
    off = true;
    clearInterval(heartbeat);

    for (const timer of typing.values()) {
      clearInterval(timer);
    }

    typing.clear();
    membership();
    unlisten?.();
    await Promise.race([
      relay.publish({ kind: PRESENCE, content: "offline", tags: [] }).catch(() => null),
      Bun.sleep(2000),
    ]);
    activity?.close();
    memory?.close();
    relay.close();
  }
}

for (const line of readEnvFile().split("\n")) {
  const [, name, value] = /^(\w+)=(.*)$/u.exec(line) ?? [];

  if (name !== undefined && value !== undefined) {
    process.env[name] = value;
  }
}

const RELAY_URL = process.env.BUZZ_RELAY_URL;
const PRIVATE_KEY = process.env.BUZZ_PRIVATE_KEY;
const AUTH_TAG = process.env.BUZZ_AUTH_TAG;

if (!isGiven(RELAY_URL) || !isGiven(PRIVATE_KEY) || !isGiven(AUTH_TAG)) {
  process.stderr.write(
    `buzz hub: no BUZZ_RELAY_URL, BUZZ_PRIVATE_KEY and BUZZ_AUTH_TAG in ${ENV_FILE}, Buzz stays off\n`,
  );
} else {
  process.on("unhandledRejection", (error) => {
    process.stderr.write(`buzz hub: unhandled rejection: ${String(error)}\n`);
  });
  process.on("uncaughtException", (error) => {
    process.stderr.write(`buzz hub: uncaught exception: ${String(error)}\n`);
  });
  serve(RELAY_URL, secretKeyOf(PRIVATE_KEY), authTagSchema.parse(JSON.parse(AUTH_TAG)));
}
