import { z } from "zod";

// Telegram's Bot API as hex's bot uses it, at TELEGRAM_API_ROOT: https://core.telegram.org/bots/api
// getUpdates long-polls, an update stays until a later call asks from past it, and a second poller ends the first with 409: https://core.telegram.org/bots/api#getupdates

export const OWNER = 777;
export const GROUP = -1_009_000_000_001;
export const GENERAL = String(GROUP);

const PayloadJson = z.record(z.string(), z.json());

type Payload = z.infer<typeof PayloadJson>;

type Update = { update_id: number; message: { message_id: number } };

const chat = (id: number) => ({ id, type: "supergroup", title: "drill", is_forum: true });

const ok = (result: z.infer<typeof z.json>) => Response.json({ ok: true, result });

const conflict = () =>
  Response.json(
    { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" },
    { status: 409 },
  );

async function payloadOf(request: Request): Promise<Payload> {
  const type = request.headers.get("content-type") ?? "";

  const text = await request.text();

  if (type.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }

  return text === "" ? {} : PayloadJson.parse(JSON.parse(text));
}

export function telegram() {
  let updates: Update[] = [];
  const sent: Payload[] = [];
  let lastUpdate = 0;
  let lastMessage = 1000;
  let polling: { offset: number; answer: (response: Response) => void } | undefined;

  const due = (offset: number) => updates.filter(({ update_id }) => update_id >= offset);

  const message = (payload: Payload) => ({
    message_id: ++lastMessage,
    date: Math.floor(Date.now() / 1000),
    chat: chat(Number(payload.chat_id)),
    from: { id: 1, is_bot: true, first_name: "hex", username: "drill_bot" },
    ...(payload.message_thread_id !== undefined && {
      message_thread_id: Number(payload.message_thread_id),
      is_topic_message: true,
    }),
  });

  function getUpdates(payload: Payload, signal: AbortSignal) {
    const offset = Number(payload.offset ?? 0);
    updates = due(offset);
    polling?.answer(conflict());
    polling = undefined;

    if (updates.length > 0 || Number(payload.timeout ?? 0) === 0) {
      return ok(updates);
    }

    const { promise, resolve } = Promise.withResolvers<Response>();

    const done = () => {
      if (polling === poll) {
        polling = undefined;
      }

      clearTimeout(timer);
    };

    const poll = {
      offset,
      answer: (response: Response) => {
        done();
        resolve(response);
      },
    };

    const timer = setTimeout(
      () => {
        poll.answer(ok([]));
      },
      Number(payload.timeout) * 1000,
    );

    signal.addEventListener("abort", done);
    polling = poll;

    return promise;
  }

  function answer(method: string, payload: Payload) {
    if (/^(send|forward|copy|edit)/u.test(method)) {
      sent.push(payload);

      return ok(method === "sendMediaGroup" ? [message(payload)] : message(payload));
    }

    const answers = new Map([
      ["getMe", () => ok({ id: 1, is_bot: true, first_name: "hex", username: "drill_bot" })],
      ["getChat", () => ok(chat(Number(payload.chat_id)))],
      [
        "getChatMember",
        () => ok({ status: "creator", user: { id: OWNER, is_bot: false, first_name: "Owner" } }),
      ],
      [
        "createForumTopic",
        () => ok({ message_thread_id: ++lastMessage, name: payload.name ?? "", icon_color: 0 }),
      ],
      ["getForumTopicIconStickers", () => ok([])],
    ]);

    return answers.get(method)?.() ?? ok(true);
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);

      if (pathname === "/owner") {
        return Response.json({ key: say(await request.text()) });
      }

      if (pathname === "/sent") {
        return Response.json(sent);
      }

      const method = pathname.split("/").at(-1) ?? "";
      const payload = await payloadOf(request);

      return method === "getUpdates"
        ? await getUpdates(payload, request.signal)
        : answer(method, payload);
    },
  });

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The owner writing in a topic of the group: from a drill, or from outside as `curl -d <words> <url>/owner`, with what hex sent at `<url>/sent`.
  function say(text: string, topic = 42) {
    const update = {
      update_id: ++lastUpdate,
      message: {
        message_id: ++lastMessage,
        date: Math.floor(Date.now() / 1000),
        chat: chat(GROUP),
        from: { id: OWNER, is_bot: false, first_name: "Owner", username: "owner" },
        message_thread_id: topic,
        is_topic_message: true,
        text,
      },
    };

    updates.push(update);

    if (polling !== undefined && due(polling.offset).length > 0) {
      polling.answer(ok(due(polling.offset)));
    }

    return `telegram:${GROUP}:${update.message.message_id}`;
  }

  return {
    url: server.url.origin,
    say,
    heard: (words: string) =>
      sent.filter((payload) => JSON.stringify(payload).includes(words)).length,
    stop: async () => {
      polling?.answer(ok([]));
      await server.stop(true);
    },
  };
}
