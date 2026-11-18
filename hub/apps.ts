import { carried } from "./chat.ts";
import type { Turn } from "./chat.ts";
import type { Hub } from "./hub.ts";
import { fileOnly, held as filesIn, pictureOf, pictures } from "./pictures.ts";
import { present } from "./present.ts";
import type { Store } from "./store.ts";
import type { Message } from "./waiting.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A call on a line a client holds, like a Discord voice channel: the line plays the voice's audio and ends when the call does, and the call engine hears the caller and can be hung up on. Audio is base64 PCM at 24 kHz, mono.
export type VoiceLine = { play: (audio: string) => void; end: () => void };

export type Held = { hear: (audio: string) => void; hangUp: () => void };

export type CallEngine = {
  take?: (from: "discord", greeting: string, line: VoiceLine) => Held;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A stop freezes the sessions on this machine while a live call still holds the hub, so the caller is told nothing can answer here.
  stops?: () => void;
};

export const engine: CallEngine = {};

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Every client running in this process, so a thread can move between them. place() opens a thread on the client, led by its about line if given, for a session working in cwd, and returns its id and a link to it. backfill() posts a thread's chat so far into a thread it placed, in order.
export type Client = {
  hub: Hub;
  place: (
    name: string,
    where?: string,
    about?: string,
    cwd?: string,
  ) => Promise<{ thread: string; link: string }>;
  backfill?: (thread: string, turns: Turn[]) => Promise<void>;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The client shows only the turns its own messages start, so a session moved there waits for one.
  waits?: boolean;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // What the client does as the hub stops, once no call is live.
  close?: () => Promise<void>;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A stop hands the owner's messages to the hub that runs next, maybe on the cloud twin, so the client stops taking them in at once, while a live call still holds this hub.
  deafen?: () => Promise<void>;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The owner's stop as the client's own Stop does it, when it keeps state of its own about a turn.
  stop?: (thread: string) => void;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A local copy of a file the app holds by its own id, such as one a message carried.
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Once the app's client runs in this process, for a channel that shows another's threads: the channels load in no order.
  joined(app: string): Promise<void> {
    return this.has(app)
      ? Promise.resolve()
      : new Promise((resolve) => {
          this.awaited.set(app, [...(this.awaited.get(app) ?? []), resolve]);
        });
  }
}

export const clients = new Clients();

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Resolves with the hub serving General once General's session first connects to it: from then on, hex works on the code this process runs.
export const { promise: up, resolve: reached } = Promise.withResolvers<Hub>();

function client(app: string) {
  const there = clients.get(app);

  if (!there) {
    throw new Error(
      `${app} isn't connected${clients.size ? `; threads open in ${[...clients.keys()].join(", ")}` : ""}`,
    );
  }

  return there;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The app that takes the owner's words for a thread when they're written in another client: it holds the thread, and shows more than the turns it starts itself, as T3 Code does (waits).
function taking(app: string, thread: string) {
  const there = clients.get(app);
  const name = there?.hub.name(thread);

  return there && there.waits !== true && present(name) ? { there, name } : undefined;
}

export const writable = (app: string, thread: string) => taking(app, thread) !== undefined;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Each thread's last showing of the owner's words, so the next waits for it and they show in the order they were written.
const showing = new Map<string, Promise<void>>();

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The owner's words for a thread, written in another client: the thread's app takes them as it does its own messages, then shows them where the thread lives, so its chat there holds everything said in it. A key sent again changes nothing. Whether the thread can take them.
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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Opens a thread on any client and starts its session: on a prompt, its first message as the session starts, or on a message that reaches it the way the app's own messages do.
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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Opens the thread on another client and posts its chat so far there; the backfill settles either way.
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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Moves a thread to another client: its session stops here and resumes there, memory intact, once its chat is backfilled. The main thread never leaves, and a thread its app owns (copy) stays, so a copy continues instead.
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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Opens a copy of the thread on another client with its chat so far, and leaves it here. The copy continues the thread's session as a fork with its first message, so the two never share a session.
export async function mirror(from: Hub, thread: string, to: string, where?: string) {
  const name = from.name(thread) ?? thread;
  const { target, session, dest, link, filled, cwd } = await carry(from, thread, to, name, where);
  target.hub.follow(dest, name, session, cwd);
  await filled;

  return link;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Where a file a chat message holds is on disk, fetched from its app when only the app keeps it.
export async function heldFile(store: Store, key: string, at: number) {
  const row = await store.messages.get(key);
  const kept = row ? filesIn(row)[at] : undefined;

  if (!kept || !row) {
    return;
  }

  const path = kept.path ?? (await clients.get(row.from)?.file?.(kept.telegram ?? ""));

  return present(path) ? { path, type: kept.type ?? "application/octet-stream" } : undefined;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The file of a picture history() named, or undefined when the id names none.
export async function sentPicture(store: Store, id: string) {
  const picture = pictureOf(id);

  return picture && (await heldFile(store, picture.key, picture.at));
}
