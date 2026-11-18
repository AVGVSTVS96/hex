import { randomUUID } from "node:crypto";

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
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The line of a session that just connected, while the hub reads what it's given: until then it takes nothing new (catchingUp).
  catching?: Line | undefined;
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Keys of messages the store didn't say it kept, which the queue keeps for the thread's next session as it does one without a key.
  const unkept = new Set<string>();

  const keptOnlyHere = (message: Message) =>
    !present(message.meta.key) || unkept.has(message.meta.key);

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

  async function markAll(thread: string) {
    for (const message of await forNext(thread)) {
      mark(thread, message);
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A session that died mid-turn ran no Stop hook, so its turn ends in hex's record of it here, and what it took without answering waits for the thread's next session. One that had started background agents lost any still working, so the hub's own line waits for the next session too, and starts it when nothing else does. Only for a thread none of whose sessions runs.
  async function cut(thread: string, session: string | undefined) {
    const { given, waited } = await kept((store) => store.turns.cut(thread, session), {
      given: [],
      waited: false,
    });

    if (waited) {
      await agentsEnded(thread);
    }

    if (!given.length) {
      return;
    }

    process.stderr.write(
      `hub: ${thread}'s session ended without answering ${given.length} of its messages, so the thread's next session gets them\n`,
    );

    for (const message of await forNext(thread)) {
      if (given.includes(message.meta.key ?? "")) {
        mark(thread, message);
      }
    }
  }

  async function agentsEnded(thread: string) {
    process.stderr.write(
      `hub: ${thread}'s session was cut short with background agents started, so the thread's next session is told\n`,
    );

    await kept(
      (store) =>
        store.messages.deliver({
          key: `hub:${thread}:agents-ended@${randomUUID()}`,
          to: thread,
          from: "hub",
          author: "prompt",
          body: "[hub] This thread's session was cut short after it started background agents, and any still working ended with it. Check what they finished, then carry on.",
          meta: { user: "hub" },
        }),
      false,
    );
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // What a thread's next session gets: every message no session has taken, and any the store couldn't keep. A store that didn't answer said nothing of which are taken, so all that waits here counts.
  async function forNext(thread: string): Promise<Message[]> {
    const rows = await kept<Row[] | undefined>(
      (store) => store.messages.untaken(thread),
      undefined,
    );

    const read = new Set(rows?.map((row) => row.key));

    return [
      ...(rows ?? []).map(toMessageWithKeyFirstForTheHook),
      ...waiting
        .of(thread)
        .queue.filter(
          (message) =>
            !read.has(message.meta.key ?? "") && (rows === undefined || keptOnlyHere(message)),
        ),
    ];
  }

  function notKept(key: string) {
    unkept.add(key);
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // What a session that connected on line is given is read from the store while its line takes nothing new: a message that comes meanwhile waits in the queue (catchingUp), and connected gives it after what was read. rows: none when the store didn't answer.
  async function catchUp(thread: string, line: Line) {
    const box = waiting.of(thread);
    box.catching = line;
    const before = box.queue.length;
    await kept((store) => store.messages.letHeldGo(thread), []);

    const rows = await kept<Row[] | undefined>(
      (store) => store.messages.untaken(thread),
      undefined,
    );

    return { rows, before };
  }

  function catchingUp(thread: string, line: Line) {
    return waiting.get(thread)?.catching === line;
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // What was read, then what came while it was: of what waited before, only what the store doesn't keep, since what it keeps and didn't give is taken. A store that didn't answer said nothing of the kind, so all that waited is given.
  function connected(
    thread: string,
    line: Line,
    { rows, before }: Awaited<ReturnType<typeof catchUp>>,
  ): Message[] {
    const box = waiting.of(thread);
    const read = new Set(rows?.map((row) => row.key));

    const given = [
      ...(rows ?? []).map(toMessageWithKeyFirstForTheHook),
      ...box.queue
        .splice(0)
        .filter(
          (message, at) =>
            !read.has(message.meta.key ?? "") &&
            (rows === undefined || at >= before || keptOnlyHere(message)),
        ),
    ];

    box.catching = undefined;

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
  // The client hears a message no longer waits once no session's left to take it: of those it was told of before the store was read, so one told of since isn't settled by a read that came before it.
  function settler() {
    const before = new Set([...waiting.all()].flatMap(([, { told }]) => [...told.values()]));

    return (untaken: Set<string>) => {
      for (const [thread, { told }] of waiting.all()) {
        for (const [key, message] of told) {
          if (untaken.has(key) || !before.has(message)) {
            continue;
          }

          told.delete(key);
          waits?.(thread, message, false);
        }
      }
    };
  }

  return {
    of,
    hold,
    mark,
    markAll,
    cut,
    forNext,
    pass,
    passed,
    drain,
    notKept,
    catchUp,
    catchingUp,
    connected,
    settler,
  };
}
