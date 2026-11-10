import {
  carried,
  clients,
  history,
  owners,
  pictureOf,
  say,
  open as store,
  typed,
  writable,
} from "@hex/hub";
import type { Turn } from "@hex/hub";

import { Changes } from "./changes.ts";
import { caption, meta as mediaMeta } from "./media.ts";
import type { Item } from "./media.ts";

export type Sent = { key: string; text: string; at: string; media?: Turn["media"] };

export type Chat = {
  version: number;
  sends: boolean;
  total: number;
  turns: Turn[];
  waiting: Sent[];
};

const LATEST_TURNS_SENT_TO_THE_PHONE_ON_EACH_CHANGE = 100;

export type Where = { app: string; thread: string; session?: string };

export class Chats {
  private readonly changes = new Changes();
  private readonly seen = new Map<string, { mark: string; said: string; chat: Chat }>();
  private readonly stops: (() => void)[];
  private readonly state: string;

  constructor(state: string) {
    this.state = state;
    this.stops = [
      store(state).watch(() => {
        this.changes.changed();
      }),
    ];
  }

  of(where: Where): Chat {
    const kept = store(this.state);
    const sends = writable(where.app, where.thread);
    const mark = `${kept.messages.mark(where.thread)}:${sends}`;
    const id = `${where.app}:${where.thread}`;
    const seen = this.seen.get(id);

    if (seen?.mark === mark) {
      return seen.chat;
    }

    const turns = history(kept, where.thread).map((turn) => ({
      ...turn,
      text: typed(turn.text, turn.media?.filter((item) => !pictureOf(item.id)).length ?? 0),
    }));

    const waiting = owners(kept.messages.untaken(where.thread)).map(({ key, body, at, meta }) => {
      const media = carried(meta);

      return { key, text: typed(body, media?.length ?? 0), at, ...(media && { media }) };
    });

    const fresh = {
      sends,
      total: turns.length,
      turns: turns.slice(-LATEST_TURNS_SENT_TO_THE_PHONE_ON_EACH_CHANGE),
      waiting,
    };

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

  async send(
    where: Where,
    text: string,
    keyTheAppNamedSoARetryDeliversOnce: string,
    media: Item[] = [],
  ) {
    const taken = say(where.app, where.thread, {
      content: caption(text, media),
      key: keyTheAppNamedSoARetryDeliversOnce,
      meta: { user: "hex app", ts: new Date().toISOString(), ...mediaMeta(media) },
    });

    if (!taken) {
      throw new Error(`Words typed here can't reach this thread; write to it in its own app.`);
    }

    await store(this.state).synced();
  }

  // oxlint-disable-next-line eslint/class-methods-use-this -- the app server stops through its Chats, beside the chat it reads
  stop(where: Where) {
    const client = clients.get(where.app);

    const name = client?.hub.name(where.thread);

    if (!client || name === undefined || name === "") {
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
