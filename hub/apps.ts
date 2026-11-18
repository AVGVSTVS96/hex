import { carried } from "./chat.ts";
import type { Turn } from "./chat.ts";
import type { Hub } from "./hub.ts";
import { fileOnly, held as filesIn, pictureOf, pictures } from "./pictures.ts";
import { present } from "./present.ts";
import type { Store } from "./store.ts";
import type { Message } from "./waiting.ts";

type Base64Pcm24kMono = string;

export type VoiceLine = { play: (audio: Base64Pcm24kMono) => void; end: () => void };

export type Held = { hear: (audio: Base64Pcm24kMono) => void; hangUp: () => void };

export type CallEngine = {
  take?: (from: "discord", greeting: string, line: VoiceLine) => Held;
  stops?: () => void;
};

export const engine: CallEngine = {};

export type Client = {
  hub: Hub;
  place: (
    name: string,
    where?: string,
    about?: string,
    cwd?: string,
  ) => Promise<{ thread: string; link: string }>;
  backfill?: (thread: string, turns: Turn[]) => Promise<void>;
  waits?: boolean;
  close?: () => Promise<void>;
  deafen?: () => Promise<void>;
  stop?: (thread: string) => void;
  file?: (id: string) => Promise<string>;
};

class Clients extends Map<string, Client> {
  private readonly awaited = new Map<string, (() => void)[]>();

  override set(app: string, joining: Client) {
    super.set(app, joining);
    this.awaited.get(app)?.forEach((tell) => {
      tell();
    });
    this.awaited.delete(app);

    return this;
  }

  joined(app: string): Promise<void> {
    return this.has(app)
      ? Promise.resolve()
      : new Promise((resolve) => {
          this.awaited.set(app, [...(this.awaited.get(app) ?? []), resolve]);
        });
  }
}

export const clients = new Clients();

function client(app: string) {
  const there = clients.get(app);

  if (!there) {
    throw new Error(
      `${app} isn't connected${clients.size ? `; threads open in ${[...clients.keys()].join(", ")}` : ""}`,
    );
  }

  return there;
}

function taking(app: string, thread: string) {
  const there = clients.get(app);
  const name = there?.hub.name(thread);

  return there && there.waits !== true && present(name) ? { there, name } : undefined;
}

export const writable = (app: string, thread: string) => taking(app, thread) !== undefined;

const showing = new Map<string, Promise<void>>();

export async function say(
  app: string,
  thread: string,
  message: Omit<Message, "author">,
): Promise<boolean> {
  const home = taking(app, thread);

  if (!home) {
    return false;
  }

  const { there, name } = home;
  const id = `${app}:${thread}`;
  const earlier = showing.get(id);
  const taken = there.hub.deliver(thread, name, { ...message, author: "owner" });

  showing.set(
    id,
    (async () => {
      await earlier;

      try {
        if (!(await taken)) {
          return;
        }

        const photos = pictures({ key: `${app}:${message.key ?? ""}`, meta: message.meta });
        const media = carried(message.meta) ?? (photos.length > 0 ? photos : undefined);
        const words = photos.length > 0 && fileOnly({ author: "owner", body: message.content });
        await there.backfill?.(thread, [
          { from: "me", text: words ? "" : message.content, ...(media && { media }) },
        ]);
      } catch (error) {
        process.stderr.write(
          `hub: couldn't show the owner's words in ${app} thread ${thread}: ${String(error)}\n`,
        );
      }
    })(),
  );

  await taken;

  return true;
}

export async function begin(
  app: string,
  name: string,
  first: string | Message,
  { about, where, cwd }: { about?: string; where?: string; cwd?: string } = {},
) {
  const there = client(app);
  const opened = await there.place(name, where, about);

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- first is TypeScript's own union of a prompt and a message, not unparsed input
  if (typeof first === "string") {
    there.hub.open(opened.thread, name, first, cwd);
  } else {
    there.hub.register(opened.thread, name, cwd);
    await there.hub.deliver(opened.thread, name, first);
  }

  return opened;
}

async function carry(from: Hub, thread: string, to: string, name: string, where?: string) {
  const target = client(to);
  const session = from.session(thread);

  if (!present(session)) {
    throw new Error("this thread has no session yet");
  }

  const cwd = from.cwd(thread);

  const { thread: dest, link } = await target.place(name, where, undefined, cwd);
  const chat = await from.history(thread);

  const filled = (async () => {
    try {
      await target.backfill?.(dest, chat);
    } catch (error) {
      process.stderr.write(`hub: couldn't backfill ${to} thread ${dest}: ${String(error)}\n`);
    }
  })();

  return { target, session, dest, link, filled, cwd };
}

export async function move(
  from: Hub,
  thread: string,
  to: string,
  name: string,
  where?: string,
  copy = thread === from.main,
) {
  const { target, session, dest, link, filled, cwd } = await carry(from, thread, to, name, where);

  const prompt =
    target.waits === true
      ? undefined
      : `This conversation just moved to ${to}, into the thread "${name}". Your ${to} tools now post there. Carry on where you left off.`;

  if (copy) {
    void (async () => {
      await filled;

      if (prompt === undefined) {
        target.hub.follow(dest, name, session, cwd);
      } else {
        target.hub.fork(dest, name, session, prompt, cwd);
      }
    })();
  } else {
    void (async () => {
      const [released] = await Promise.all([from.release(thread), filled]);
      target.hub.adopt(dest, name, released, prompt, cwd);
    })();
  }

  return link;
}

export async function mirror(from: Hub, thread: string, to: string, where?: string) {
  const name = from.name(thread) ?? thread;
  const { target, session, dest, link, filled, cwd } = await carry(from, thread, to, name, where);
  target.hub.follow(dest, name, session, cwd);
  await filled;

  return link;
}

export async function heldFile(store: Store, key: string, at: number) {
  const row = await store.messages.get(key);
  const kept = row ? filesIn(row)[at] : undefined;

  if (!kept || !row) {
    return;
  }

  const path = kept.path ?? (await clients.get(row.from)?.file?.(kept.telegram ?? ""));

  return present(path) ? { path, type: kept.type ?? "application/octet-stream" } : undefined;
}

export async function sentPicture(store: Store, id: string) {
  const picture = pictureOf(id);

  return picture && (await heldFile(store, picture.key, picture.at));
}
