import type { Keep } from "./kept.ts";
import type { Line } from "./mcp.ts";
import { present } from "./present.ts";
import type { Runs } from "./runs.ts";
import type { Author, Row } from "./store.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// key: the app's own id for what the message is, so the app sending it again changes nothing. author: who wrote it, which every message a client delivers says (Store.deliver).
export type Message = {
  content: string;
  meta: Record<string, string>;
  key?: string;
  author?: Author;
};

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// still: the message waits for the thread's session, or else that wait is over.
export type Waits = (thread: string, message: Message, still: boolean) => void;

export function toMessageWithKeyFirstForTheHook(row: Row): Message {
  return { content: row.body, author: row.author, meta: { key: row.key, ...row.meta } };
}

type Waiting = {
  queue: Message[];
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The kept messages the hub has passed on since its session's channel last connected.
  handed: Set<string>;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The kept messages the client was told wait for a session, by key, until one takes them.
  told: Map<string, Message>;
};

export type MessagesWaiting = ReturnType<typeof messagesWaiting>;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A thread's messages on their way to its session: those held for its next session, the keys passed on since its channel last connected, and those the client was told wait. hex.db keeps every keyed one; the queue keeps any it couldn't.
export function messagesWaiting({
  runs,
  kept,
  waits,
}: {
  runs: Runs;
  kept: Keep;
  waits: Waits | undefined;
}) {
  const waiting = runs.part((): Waiting => ({ queue: [], handed: new Set(), told: new Map() }));

  function of(thread: string): {
    readonly queue: readonly Message[];
    readonly handed: ReadonlySet<string>;
  } {
    return waiting.of(thread);
  }

  function hold(thread: string, message: Message) {
    waiting.of(thread).queue.push(message);
    mark(thread, message);
  }

  function mark(thread: string, message: Message) {
    const { told } = waiting.of(thread);
    const { key } = message.meta;

    if (!present(key) || told.has(key)) {
      return;
    }

    told.set(key, message);
    waits?.(thread, message, true);
  }

  function markAll(thread: string) {
    for (const message of forNext(thread)) {
      mark(thread, message);
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // What a thread's next session gets: every message no session has taken, and any the store couldn't keep.
  function forNext(thread: string): Message[] {
    const rows = kept((store) => store.messages.untaken(thread), []);

    return [
      ...rows.map(toMessageWithKeyFirstForTheHook),
      ...waiting.of(thread).queue.filter((message) => !present(message.meta.key)),
    ];
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // False for a key passed on already since the channel connected.
  function pass(thread: string, message: Message) {
    const { handed } = waiting.of(thread);
    const { key } = message.meta;

    if (present(key) && handed.has(key)) {
      return false;
    }

    if (present(key)) {
      handed.add(key);
    }

    return true;
  }

  function passed(thread: string, key: string) {
    waiting.of(thread).handed.add(key);
  }

  function drain(thread: string) {
    return waiting.of(thread).queue.splice(0);
  }

  function connected(thread: string, line: Line) {
    const box = waiting.of(thread);
    kept((store) => store.messages.letHeldGo(thread), []);
    const given = forNext(thread);

    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // They wait until the session takes them, though an earlier hub may be the one that said so.
    for (const message of given) {
      mark(thread, message);
      line.send({ type: "inbound", ...message });
    }

    box.handed = new Set(given.flatMap((message) => message.meta.key ?? []));

    return given;
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The client hears a message no longer waits once no session's left to take it.
  function settle(untaken: Set<string>) {
    for (const [thread, { told }] of waiting.all()) {
      for (const [key, message] of told) {
        if (untaken.has(key)) {
          continue;
        }

        told.delete(key);
        waits?.(thread, message, false);
      }
    }
  }

  return { of, hold, mark, markAll, forNext, pass, passed, drain, connected, settle };
}
