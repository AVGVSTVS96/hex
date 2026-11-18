import { randomUUID } from "node:crypto";

import type { SessionsBeside } from "./besides.ts";
import type { ThreadCalls } from "./calls.ts";
import * as claude from "./claude.ts";
import type { Owing } from "./kept.ts";
import type { Line } from "./mcp.ts";
import { ordered } from "./ordered.ts";
import type { SessionPauses } from "./pauses.ts";
import { present } from "./present.ts";
import type { SessionRests } from "./rest.ts";
import type { ThreadSessions } from "./sessions.ts";
import type { SessionStarts } from "./start.ts";
import type { SessionStops } from "./stops.ts";
import type { NewRow, Row, Told } from "./store.ts";
import type { Threads } from "./threads.ts";
import type { SessionTurns } from "./turns.ts";
import { toMessageWithKeyFirstForTheHook } from "./waiting.ts";
import type { Message, MessagesWaiting } from "./waiting.ts";

export type ThreadInbox = ReturnType<typeof threadInbox>;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The way a message takes into a thread: kept in hex.db first, then to the thread's session as it stands, which takes it now, at its next tool call, or as a new start. The messages are in hex.db, and those that wait for a session are with waiting.ts; what it keeps is the order each thread's messages go on in, and the owner's words held for a turn.
export function threadInbox({
  threads,
  turns,
  waiting,
  sessions,
  starts,
  stops,
  pauses,
  rests,
  calls,
  besides,
  owing,
  serving,
  app,
  fresh,
}: {
  threads: Threads;
  turns: SessionTurns;
  waiting: MessagesWaiting;
  sessions: ThreadSessions;
  starts: SessionStarts;
  stops: SessionStops;
  pauses: SessionPauses;
  rests: SessionRests;
  calls: ThreadCalls;
  besides: SessionsBeside;
  owing: Owing;
  serving: () => boolean;
  app: string;
  fresh: (thread: string) => boolean;
}) {
  const { kept, must } = owing;

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Each thread's deliveries pass their messages on one at a time, in the order they came, whichever the store answers first.
  const delivering = ordered();

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A message is kept before anything else happens to it, so once this resolves the app can be told it arrived: a crash from then on leaves it with hex, for whichever session serves the thread next. A key kept already is the app sending it again. along: the change to hex's records the message tells of, like the answer a tap gives, kept in the same write (questions.told); when it changes nothing, or the store can't take it, there's nothing to tell. Whether the thread is told.
  async function deliver(
    thread: string,
    name: string,
    message: Message,
    along?: Told,
  ): Promise<boolean> {
    const { author } = message;

    if (!author) {
      throw new Error(`a message to ${thread} has no author`);
    }

    const key = `${app}:${message.key ?? randomUUID()}`;
    const { content, meta } = message;

    const row: NewRow = { key, to: thread, from: app, author, body: content, meta };

    const adding = along
      ? must({ kind: "told", app, thread, change: along, row }, false)
      : must({ kind: "deliver", row }, undefined);

    return await delivering(thread, async () => {
      const added = await adding;

      if (added === false || owing.lost()) {
        return false;
      }

      // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
      // A call that failed may still have landed, so the message keeps its key, which keeps a look that finds it from passing it on again, and the queue keeps it for the next session in case it didn't.
      if (added === undefined) {
        waiting.notKept(key);
      }

      pass(thread, name, { content, author, meta: { key, ...meta } });

      return true;
    });
  }

  function pass(thread: string, name: string, message: Message) {
    if (waiting.pass(thread, message)) {
      forward(thread, name, message);
    }
  }

  function forward(thread: string, name: string, message: Message, released = false) {
    const ending = stops.ending(thread);

    if (ending) {
      waiting.hold(thread, message);
      void (async () => {
        await ending;
        resume(thread);
      })();

      return;
    }

    const standing = sessions.of(thread);

    if (standing.phase.is === "live") {
      if (
        pauses.of(thread).paused === true ||
        (starts.stale(thread) && !calls.of(thread).on) ||
        rests.spent(thread)
      ) {
        void refresh(thread, message);
      } else {
        handInOrHold(thread, name, standing.phase.line, message, released);
      }

      return;
    }

    waiting.hold(thread, message);
    sessions.waitedOn(thread);
    sessions.launch(thread, name);
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Claude Code labels a channel message that comes mid-turn as not from its user, so the owner's words wait for the session's next tool call, where hub/held.ts gives them as hook feedback, which Claude Code treats as the user's; the turn's end sends any still waiting (letHeldGo), and a message that comes while it does goes after them. A turn counts from the message that starts it, not from its hook's report. The hold is asked of the store as the turn is read, so a turn's end after it lets it go; one the store doesn't hold goes to the session after all, or on again when that session's line is gone by then. A session that just connected takes nothing new until it's given what waited (waiting.catchUp).
  function handInOrHold(
    thread: string,
    name: string,
    line: Line,
    message: Message,
    released = false,
  ) {
    const { key } = message.meta;
    const session = threads.current(thread);
    const letting = releasing.get(thread);

    if (waiting.catchingUp(thread, line)) {
      waiting.hold(thread, message);

      return;
    }

    if (letting && !released) {
      void (async () => {
        await letting;
        forward(thread, name, message);
      })();

      return;
    }

    if (!turns.active(thread) || message.author !== "owner" || !present(key) || !present(session)) {
      turns.handIn(thread, line, message);

      return;
    }

    void (async () => {
      if (await kept((store) => store.messages.hold(key, session), false)) {
        heldHere.set(thread, [...(heldHere.get(thread) ?? []), message]);

        return;
      }

      const { phase } = sessions.of(thread);

      if (phase.is === "live" && phase.line === line) {
        turns.handIn(thread, line, message);
      } else {
        forward(thread, name, message);
      }
    })();
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Each thread's latest letting go of what was held for its turn, until what it let go has gone on.
  const releasing = new Map<string, Promise<unknown>>();

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The owner's words this hub had the store hold for a turn, so a turn that ends while the store can't let them go still gives them first, from memory (goneOnFromMemory), before anything that came after them.
  const heldHere = new Map<string, Message[]>();
  const goneOnFromMemory = new Set<string>();
  const letGoNow = new Map<string, Set<string>>();

  function tookHeld(thread: string, keys: string[]) {
    const given = new Set(keys);
    heldHere.set(
      thread,
      (heldHere.get(thread) ?? []).filter(({ meta }) => !given.has(meta.key ?? "")),
    );
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // What a turn's end let go goes on: as it ends, or once the store answers again when it ended in an outage, less what went on from memory meanwhile.
  function heldLetGo(thread: string, rows: Row[]) {
    const name = threads.get(thread)?.name;

    for (const row of rows) {
      letGoNow.get(thread)?.add(row.key);

      if (!goneOnFromMemory.delete(row.key) && name !== undefined) {
        forward(thread, name, toMessageWithKeyFirstForTheHook(row), true);
      }
    }
  }

  async function letHeldGo(thread: string) {
    const { promise, resolve } = Promise.withResolvers();
    releasing.set(thread, promise);
    const remembered = heldHere.get(thread) ?? [];
    heldHere.delete(thread);

    try {
      letGoNow.set(thread, new Set());
      await must({ kind: "letHeldGo", thread }, false);
      const name = threads.get(thread)?.name;
      const owed = owing.owes({ kind: "letHeldGo", thread });
      const letGoByStore = letGoNow.get(thread) ?? new Set();
      letGoNow.delete(thread);

      // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
      // From memory: all of it while the store can't let it go, and otherwise what the store no longer held, which a hook took without the session hearing it (held.ts).
      for (const message of remembered) {
        const key = message.meta.key ?? "";

        if (name !== undefined && (owed || !letGoByStore.has(key))) {
          goneOnFromMemory.add(key);
          forward(thread, name, message, true);
        }
      }
    } finally {
      if (releasing.get(thread) === promise) {
        releasing.delete(thread);
      }

      resolve(undefined);
    }
  }

  let waking: Promise<void> | undefined;
  let rang = false;

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Messages kept outside this hub reach its threads as the bell rings, and at its start so do any that no session took before the hub stopped. One look at the store at a time, and one more after it when the bell rang meanwhile, so an older look never lands after a newer one. The bell also rings as a store across the network reconnects, so what the hub owes it goes first.
  function wake() {
    if (!serving()) {
      return;
    }

    void owing.pay();

    if (waking) {
      rang = true;

      return;
    }

    waking = (async () => {
      try {
        do {
          rang = false;
          await look();
        } while (rang);
      } catch (error) {
        process.stderr.write(`hub: a look at hex.db failed: ${String(error)}\n`);
      } finally {
        waking = undefined;
      }
    })();
  }

  async function look() {
    if (!serving()) {
      return;
    }

    const noLongerWaiting = waiting.settler();

    const [rows, besideThem] = await Promise.all([
      kept<Row[] | undefined>((store) => store.messages.untaken(threads.ids()), undefined),
      besides.rows(),
    ]);

    if (!rows || !serving()) {
      return;
    }

    for (const row of rows) {
      const known = threads.get(row.to);

      if (known) {
        pass(row.to, known.name, toMessageWithKeyFirstForTheHook(row));
      }
    }

    besides.runReady(besideThem);
    noLongerWaiting(new Set(rows.map((row) => row.key)));
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A session that started before hex kept messages can't mark one taken itself, so its hook says so here.
  async function took(keys: string[] | undefined, session: string | undefined) {
    if (keys === undefined || session === undefined) {
      return;
    }

    await Promise.all(keys.map((key) => must({ kind: "take", key, by: session }, false)));
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Messages that came while the thread's session was stopping resume it once it's gone, unless a restart already took them.
  function resume(thread: string) {
    if (waiting.of(thread).queue.length && !rests.of(thread).leaving) {
      void sessions.cycle(thread);
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Delivers a message to a fresh start of the thread's session, so it gets new launch arguments or, in a fresh thread, a new session; a session still working, on its turn or on background agents, keeps running and takes it as it is, unless earlier messages already wait for the new start or Claude Code paused it on a dialog no one could read. A session that took over while Claude was asked gets the message as any message would.
  async function refresh(thread: string, message: Message) {
    const standing = sessions.of(thread);
    const waited = waiting.of(thread);
    const phase = standing.phase;
    const running = await claude.agent(threads.current(thread) ?? "", serving);

    if (standing.phase !== phase || phase.is !== "live") {
      forward(thread, threads.of(thread).name, message);

      return;
    }

    const working =
      running?.status !== "waiting" &&
      (fresh(thread)
        ? turns.active(thread) || (running !== undefined && running.status !== "idle")
        : running?.status === "busy");

    if (working && waited.queue.length === 0) {
      handInOrHold(thread, threads.of(thread).name, phase.line, message);

      return;
    }

    waiting.hold(thread, message);
    void sessions.cycle(thread, running);
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A local message reaches a thread this hub already has, named by its key or its <app>:<key> id. Any other would open a stray thread here that later wakes find first.
  async function inbound(id: string, message: Message) {
    const thread = id.startsWith(`${app}:`) ? id.slice(app.length + 1) : id;

    const known = threads.get(thread);

    if (known) {
      await deliver(thread, known.name, message);

      return;
    }

    process.stderr.write(
      `hub: no open ${app} thread ${thread}, so a message for it from ${message.meta?.user ?? "a local tool"} was dropped\n`,
    );
  }

  return { deliver, heldLetGo, letHeldGo, tookHeld, wake, took, inbound };
}
