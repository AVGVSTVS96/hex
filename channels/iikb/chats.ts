import { clients, history, owners, say } from "@hex/hub";
import type { Store } from "@hex/hub";
import { z } from "zod";

export type Chat = { id: string; name: string; line?: string; pinned?: boolean };

export type Message = { from: "me" | "hex"; text: string; pending?: true };

const LATEST_MESSAGES = 40;
const HELD_FOR_A_CHANGE = 25_000;

const Sent = z.object({ text: z.string().trim().min(1), id: z.string().min(1) });

const placeOf = (chat: string) => {
  const colon = chat.indexOf(":");

  return { app: chat.slice(0, colon), thread: chat.slice(colon + 1) };
};

const firstLine = (text: string) => text.trim().split("\n", 1)[0] ?? "";

export function list(store: Store): Chat[] {
  const chats = [...clients].flatMap(([app, client]) =>
    client.waits === true
      ? []
      : client.hub.threads().flatMap((thread) => {
          const name = client.hub.name(thread);

          if (name === undefined || name === "") {
            return [];
          }

          const rank = client.hub.fresh(thread) ? 0 : thread === client.hub.main ? 1 : 2;
          const last = history(store, thread).at(-1);

          return [
            {
              rank,
              at: store.messages.said(thread, 1)[0]?.at ?? "",
              chat: {
                id: `${app}:${thread}`,
                name: rank === 1 ? "General" : name,
                ...(last && { line: firstLine(last.text) }),
                ...(rank < 2 && { pinned: true }),
              },
            },
          ];
        }),
  );

  return chats
    .toSorted((a, b) => a.rank - b.rank || b.at.localeCompare(a.at))
    .map(({ chat }) => chat);
}

function messages(store: Store, thread: string): Message[] {
  const said = history(store, thread).map(({ from, text }): Message => ({ from, text }));

  const waiting = owners(store.messages.untaken(thread)).map(({ body }): Message => ({
    from: "me",
    text: body,
    pending: true,
  }));

  return [...said, ...waiting].slice(-LATEST_MESSAGES);
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

const status = (code: number, said?: string) => new Response(said ?? null, { status: code });

async function route(store: Store, request: Request, chat: string, after: string | null) {
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
    return await route(
      store,
      request,
      decodeURIComponent(url.pathname.slice(1)),
      url.searchParams.get("after"),
    );
  } catch (error) {
    return status(502, error instanceof Error ? error.message : String(error));
  }
}
