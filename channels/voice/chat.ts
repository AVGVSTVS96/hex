import { carried, clients, history } from "../../hub/hub.ts";
import type { Turn } from "../../hub/hub.ts";
import { owners } from "../../hub/notes.ts";
import { open as store } from "../../hub/store.ts";
import { Changes } from "./changes.ts";
import { caption, meta, typed } from "./media.ts";
import type { Item } from "./media.ts";

export type Sent = { key: string; text: string; at: string; media?: Turn["media"] };

// turns: the chat's latest turns, out of all it has (total). sends: whether words typed in the app
// reach this thread. T3 Code shows only turns it starts, and a session no app holds has no chat to
// send through.
export type Chat = {
  version: number;
  sends: boolean;
  total: number;
  turns: Turn[];
  waiting: Sent[];
};

// How many of a chat's latest turns the app gets: a long thread's whole history would go to the
// phone on every change.
const SHOWN = 100;

export type Where = { app: string; thread: string; session?: string };

// A thread's chat as the app shows it: what the owner said and hex replied, from hex.db, and what
// the owner sent that no session has taken in yet. A wait for it ends when hex.db changes.
export class Chats {
  private readonly changes = new Changes();
  private readonly seen = new Map<string, { mark: string; said: string; chat: Chat }>();
  private readonly stops: (() => void)[];

  constructor(private readonly state: string) {
    this.stops = [
      store(state).watch(() => {
        this.changes.changed();
      }),
    ];
  }

  // Read again only when the thread's messages, or whether it sends, changed since the last read.
  of(where: Where): Chat {
    const kept = store(this.state);
    const sends = !!sendsThrough(where);
    const mark = `${kept.mark(where.thread)}:${sends}`;
    const id = `${where.app}:${where.thread}`;
    const seen = this.seen.get(id);

    if (seen?.mark === mark) {
      return seen.chat;
    }
    const turns = history(kept, where.thread).map((turn) => ({
      ...turn,
      text: typed(turn.text, turn.media?.length ?? 0),
    }));

    const waiting = owners(kept.untaken(where.thread)).map(({ key, body, at, meta }) => {
      const media = carried(meta);

      return { key, text: typed(body, media?.length ?? 0), at, ...(media && { media }) };
    });

    const fresh = { sends, total: turns.length, turns: turns.slice(-SHOWN), waiting };
    const said = JSON.stringify(fresh);

    const chat =
      seen?.said === said
        ? seen.chat
        : { version: Math.max((seen?.chat.version ?? 0) + 1, Date.now()), ...fresh };

    this.seen.set(id, { mark, said, chat });

    return chat;
  }

  async next(where: () => Where, after: number, wait: number) {
    const end = Date.now() + wait;
    let chat = this.of(where());

    while (chat.version === after && Date.now() < end) {
      await this.changes.changes(this.changes.version, end - Date.now());
      chat = this.of(where());
    }

    return chat;
  }

  changed() {
    this.changes.changed();
  }

  // The owner's words, typed in the app, go to the thread's session the way its app's would, with
  // the photos and clips sent with them as images it reads. The app names each message, so sending
  // it again after a lost answer delivers it once.
  send(where: Where, text: string, key: string, media: Item[] = []) {
    const client = sendsThrough(where);
    const name = client?.hub.name(where.thread);

    if (!name) {
      throw new Error(`Words typed here can't reach this thread; write to it in its own app.`);
    }
    client.hub.deliver(where.thread, name, {
      content: caption(text, media),
      key,
      author: "owner",
      meta: { user: "hex app", ts: new Date().toISOString(), ...meta(media) },
    });
  }

  // The owner's stop, as the thread's own app does it.
  stop(where: Where) {
    const client = clients.get(where.app);

    if (!client?.hub.name(where.thread)) {
      throw new Error(`No app here holds this thread, so there's nothing to stop.`);
    }
    (client.stop ?? client.hub.stop)(where.thread);
  }

  close() {
    for (const stop of this.stops) {
      stop();
    }
  }
}

// The app holding the thread, when words typed in the hex app can reach it through it.
const sendsThrough = ({ app, thread }: Where) => {
  const client = clients.get(app);

  return client && !client.waits && client.hub.name(thread) ? client : undefined;
};
