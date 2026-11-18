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

  const delivering = ordered();

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

  // WARNING: Claude Code labels a channel message that comes mid-turn as not from its user, so the owner's words wait for the next tool call's hook (held.ts).
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

  const releasing = new Map<string, Promise<unknown>>();

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

  async function took(keys: string[] | undefined, session: string | undefined) {
    if (keys === undefined || session === undefined) {
      return;
    }

    await Promise.all(keys.map((key) => must({ kind: "take", key, by: session }, false)));
  }

  function resume(thread: string) {
    if (waiting.of(thread).queue.length && !rests.of(thread).leaving) {
      void sessions.cycle(thread);
    }
  }

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
