import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { clients, fileOnly, held, heldFile, owners, say, shown, typed } from "@hex/hub";
import type { Row, Store } from "@hex/hub";
import { z } from "zod";

export type Chat = { id: string; name: string; line?: string; pinned?: boolean };

export type File = { name: string; url: string; type?: string; width?: number; height?: number };

export type Message = { from: "me" | "hex"; text: string; pending?: true; files?: File[] };

const APP = "telegram";
const LATEST_MESSAGES = 40;
const HELD_FOR_A_CHANGE = 25_000;

const ALBUM_MAX = 10;

const Uploaded = z.object({
  type: z.enum(["image/jpeg", "image/png"]),
  data: z.base64(),
  width: z.int().positive().optional(),
  height: z.int().positive().optional(),
});

const Sent = z
  .object({
    text: z.string().trim(),
    id: z.string().regex(/^[\w-]+$/u),
    files: z.array(Uploaded).max(ALBUM_MAX).default([]),
  })
  .refine(({ text, files }) => text !== "" || files.length > 0);

export type Photo = { path: string; width?: number; height?: number };

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

const pollText = (question: string, options: string) =>
  [question, "", ...options.split(" / ").map((option) => `• ${option}`)].join("\n");

function asTelegramShowsIt(row: Row, edits: Map<string, string>): Message[] {
  const meta = row.meta ?? {};

  if (row.from === "terminal" || !row.taken || notAMessageInTelegram(meta)) {
    return [];
  }

  if (row.author === "hex" ? !shown(row) : row.author !== "owner") {
    return [];
  }

  const files = held(row).map(({ name, type, dimensions }, at): File => {
    const [width = 0, height = 0] = (dimensions ?? "").split("x").map(Number);

    return {
      name,
      url: `files/${encodeURIComponent(row.key)}/${String(at)}`,
      ...(type !== undefined && { type }),
      ...(width > 0 && height > 0 && { width, height }),
    };
  });

  const said = edits.get(telegramIdOf(row)) ?? row.body;
  const body = filled(meta.media) ? typed(said, meta.media.split("; ").length) : said;
  const text = filled(meta.poll) && row.author === "hex" ? pollText(body, meta.poll) : body;

  return [
    {
      from: row.author === "hex" ? "hex" : "me",
      text: files.length > 0 && fileOnly(row) ? "" : text,
      ...(files.length > 0 && { files }),
    },
  ];
}

function latest(store: Store, thread: string, count: number, rows = count * 2): Message[] {
  const newest = store.messages.said(thread, rows);

  const edits = new Map(
    newest
      .filter((row) => row.meta?.edited === "true" && filled(row.meta.message_id))
      .map((row) => [row.meta?.message_id ?? "", row.body]),
  );

  const showing = newest.flatMap((row) => asTelegramShowsIt(row, edits));

  return showing.length >= count || newest.length < rows
    ? showing.slice(-count)
    : latest(store, thread, count, rows * 4);
}

function messages(store: Store, thread: string, count = LATEST_MESSAGES): Message[] {
  const waiting = owners(store.messages.untaken(thread)).map(({ body }): Message => ({
    from: "me",
    text: body,
    pending: true,
  }));

  return [...latest(store, thread, count), ...waiting].slice(-count);
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
    const line = lineOf(messages(store, thread, 1).at(-1));

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

const photoLines = (count: number) => Array.from({ length: count }, () => "(photo)").join("\n");

const content = (text: string, photos: number) =>
  photos === 0
    ? text
    : text === "" && photos > 1
      ? `(album of ${String(photos)})`
      : [text, photoLines(photos)].filter(filled).join("\n");

const photoMeta = (id: string, photos: Photo[]) =>
  photos.length === 0
    ? {}
    : {
        image_path: photos.map(({ path }) => path).join("; "),
        image_dimensions: photos
          .map(({ width, height }) =>
            width !== undefined && height !== undefined ? `${String(width)}x${String(height)}` : "",
          )
          .join("; "),
        media: photos.map((_, at) => `photo ${id}-${String(at)}`).join("; "),
        files: photos.map(({ path }) => path).join("; "),
      };

export function send(chat: string, text: string, id: string, photos: Photo[] = []) {
  const { app, thread } = placeOf(chat);

  const taken = say(app, thread, {
    content: content(text, photos.length),
    key: `iikb-${id}`,
    meta: { user: "iikb", ts: new Date().toISOString(), ...photoMeta(id, photos) },
  });

  if (!taken) {
    throw new Error("This chat's app isn't running, so words typed here can't reach it.");
  }
}

async function file(store: Store, key: string, at: number) {
  const kept = store.messages.get(key)?.from === APP ? await heldFile(store, key, at) : undefined;

  return kept
    ? new Response(Bun.file(kept.path), { headers: { "content-type": kept.type } })
    : status(404);
}

const status = (code: number, said?: string) => new Response(said ?? null, { status: code });

async function keep(dir: string, id: string, files: z.infer<typeof Uploaded>[]): Promise<Photo[]> {
  if (files.length > 0) {
    mkdirSync(dir, { recursive: true });
  }

  return await Promise.all(
    files.map(async ({ type, data, width, height }, at) => {
      const path = join(dir, `${id}-${String(at)}.${type === "image/png" ? "png" : "jpg"}`);
      await Bun.write(path, Buffer.from(data, "base64"));

      return { path, ...(width !== undefined && height !== undefined && { width, height }) };
    }),
  );
}

async function route(
  store: Store,
  request: Request,
  path: string,
  after: string | null,
  photos: string,
) {
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
    return status(400, "Send { text, id, files? }");
  }

  const { text, id, files } = sent.data;
  send(chat, text, id, await keep(photos, id, files));

  return status(204);
}

export async function answer(
  store: Store,
  request: Request,
  token = "",
  photos = join(store.dir, "iikb", "photos"),
): Promise<Response> {
  if (token !== "" && request.headers.get("authorization") !== `Bearer ${token}`) {
    return status(401);
  }

  const url = new URL(request.url);

  try {
    return await route(
      store,
      request,
      url.pathname.slice(1),
      url.searchParams.get("after"),
      photos,
    );
  } catch (error) {
    return status(502, error instanceof Error ? error.message : String(error));
  }
}
