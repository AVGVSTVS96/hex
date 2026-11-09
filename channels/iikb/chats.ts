import { basename } from "node:path";

import { clients, owners, say, shown } from "@hex/hub";
import type { Row, Store } from "@hex/hub";
import { z } from "zod";

export type Chat = { id: string; name: string; line?: string; pinned?: boolean };

export type File = { name: string; url: string; type?: string };

export type Message = { from: "me" | "hex"; text: string; pending?: true; files?: File[] };

type Held = { name: string; type?: string; path?: string; telegram?: string };

const APP = "telegram";
const LATEST_MESSAGES = 40;
const HELD_FOR_A_CHANGE = 25_000;

const Sent = z.object({ text: z.string().trim().min(1), id: z.string().min(1) });

const placeOf = (chat: string) => {
  const colon = chat.indexOf(":");

  return { app: chat.slice(0, colon), thread: chat.slice(colon + 1) };
};

const filled = (value?: string): value is string => value !== undefined && value !== "";

const notAMessageInTelegram = (meta: Record<string, string>) =>
  ["edited", "button", "vote", "vote_removed", "reaction", "reaction_removed", "took_back"].some(
    (flag) => filled(meta[flag]),
  );

const telegramIdOf = (row: Row) =>
  row.meta?.message_id ?? row.key.slice(row.key.lastIndexOf(":") + 1);

const imageType = (path: string) => (path.endsWith(".png") ? "image/png" : "image/jpeg");

const each = (value?: string) => (value ?? "").split("; ");

export function held(row: Row): Held[] {
  const meta = row.meta ?? {};
  const images = each(meta.image_path).filter(Boolean);
  const kinds = each(meta.attachment_kind);
  const names = each(meta.attachment_name);
  const mimes = each(meta.attachment_mime);

  const attachments = each(meta.attachment_file_id).flatMap((telegram, at): Held[] => {
    const kind = kinds[at] ?? "";
    const mime = kind === "photo" ? "image/jpeg" : (mimes[at] ?? "");

    return telegram === ""
      ? []
      : [
          {
            name: [names[at], meta.file, kind].find(filled) ?? "file",
            telegram,
            ...(mime !== "" && { type: mime }),
          },
        ];
  });

  return [
    ...images.map((path) => ({ name: basename(path), path, type: imageType(path) })),
    ...attachments,
  ];
}

const pollText = (question: string, options: string) =>
  [question, "", ...options.split(" / ").map((option) => `• ${option}`)].join("\n");

const fileOnly = (row: Row) =>
  (row.author === "hex" && row.body === `(file: ${row.meta?.file ?? ""})`) ||
  (row.author === "owner" && row.body === "(photo)");

function asTelegramShowsIt(row: Row, edits: Map<string, string>): Message[] {
  const meta = row.meta ?? {};

  if (row.from === "terminal" || !row.taken || notAMessageInTelegram(meta)) {
    return [];
  }

  if (row.author === "hex" ? !shown(row) : row.author !== "owner") {
    return [];
  }

  const files = held(row).map(({ name, type }, at) => ({
    name,
    url: `files/${encodeURIComponent(row.key)}/${String(at)}`,
    ...(type !== undefined && { type }),
  }));

  const body = edits.get(telegramIdOf(row)) ?? row.body;
  const text = filled(meta.poll) && row.author === "hex" ? pollText(body, meta.poll) : body;

  return [
    {
      from: row.author === "hex" ? "hex" : "me",
      text: files.length > 0 && fileOnly(row) ? "" : text,
      ...(files.length > 0 && { files }),
    },
  ];
}

function messages(store: Store, thread: string): Message[] {
  const rows = store.messages.said(thread);

  const edits = new Map(
    rows
      .filter((row) => row.meta?.edited === "true" && filled(row.meta.message_id))
      .map((row) => [row.meta?.message_id ?? "", row.body]),
  );

  const said = rows.flatMap((row) => asTelegramShowsIt(row, edits));

  const waiting = owners(store.messages.untaken(thread)).map(({ body }): Message => ({
    from: "me",
    text: body,
    pending: true,
  }));

  return [...said, ...waiting].slice(-LATEST_MESSAGES);
}

const lineOf = (message?: Message) =>
  [message?.text.trim().split("\n", 1)[0], message?.files?.[0]?.name].find(filled);

export function list(store: Store): Chat[] {
  const telegram = clients.get(APP);

  if (!telegram) {
    return [];
  }

  const { hub } = telegram;

  const chats = hub.threads().flatMap((thread) => {
    const name = hub.name(thread);

    if (!filled(name)) {
      return [];
    }

    const rank = hub.fresh(thread) ? 0 : thread === hub.main ? 1 : 2;
    const line = lineOf(messages(store, thread).at(-1));

    return [
      {
        rank,
        at: store.messages.said(thread, 1)[0]?.at ?? "",
        chat: {
          id: `${APP}:${thread}`,
          name: rank === 1 ? "General" : name,
          ...(filled(line) && { line }),
          ...(rank < 2 && { pinned: true }),
        },
      },
    ];
  });

  return chats
    .toSorted((a, b) => a.rank - b.rank || b.at.localeCompare(a.at))
    .map(({ chat }) => chat);
}

function changed(store: Store, thread: string, after: string) {
  const moved = () => store.messages.mark(thread) !== after;

  if (moved()) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      stop();
      resolve();
    };

    const timer = setTimeout(done, HELD_FOR_A_CHANGE);

    const stop = store.watch(() => {
      if (moved()) {
        done();
      }
    });
  });
}

export async function read(store: Store, chat: string, after?: string) {
  const { thread } = placeOf(chat);

  if (after !== undefined && after !== "") {
    await changed(store, thread, after);
  }

  return { version: store.messages.mark(thread), messages: messages(store, thread) };
}

export function send(chat: string, text: string, id: string) {
  const { app, thread } = placeOf(chat);

  const taken = say(app, thread, {
    content: text,
    key: `iikb-${id}`,
    meta: { user: "iikb", ts: new Date().toISOString() },
  });

  if (!taken) {
    throw new Error("This chat's app isn't running, so words typed here can't reach it.");
  }
}

async function file(store: Store, key: string, at: number) {
  const row = store.messages.get(key);
  const kept = row && row.from === APP ? held(row)[at] : undefined;

  if (!kept) {
    return status(404);
  }

  const path = kept.path ?? (await clients.get(APP)?.file?.(kept.telegram ?? ""));

  if (!filled(path)) {
    return status(404);
  }

  return new Response(Bun.file(path), {
    headers: { "content-type": kept.type ?? "application/octet-stream" },
  });
}

const status = (code: number, said?: string) => new Response(said ?? null, { status: code });

async function route(store: Store, request: Request, path: string, after: string | null) {
  const [, key = "", at = ""] = /^files\/([^/]+)\/(\d+)$/u.exec(path) ?? [];

  if (request.method === "GET" && key !== "") {
    return await file(store, decodeURIComponent(key), Number(at));
  }

  const chat = decodeURIComponent(path);

  if (request.method === "GET" && chat === "") {
    return Response.json({ name: "hex", chats: list(store) });
  }

  if (request.method === "GET") {
    return Response.json(await read(store, chat, after ?? undefined));
  }

  if (request.method !== "POST" || chat === "") {
    return status(405);
  }

  const sent = Sent.safeParse(await request.json().catch(() => null));

  if (!sent.success) {
    return status(400, "Send { text, id }");
  }

  send(chat, sent.data.text, sent.data.id);

  return status(204);
}

export async function answer(store: Store, request: Request, token = ""): Promise<Response> {
  if (token !== "" && request.headers.get("authorization") !== `Bearer ${token}`) {
    return status(401);
  }

  const url = new URL(request.url);

  try {
    return await route(store, request, url.pathname.slice(1), url.searchParams.get("after"));
  } catch (error) {
    return status(502, error instanceof Error ? error.message : String(error));
  }
}
