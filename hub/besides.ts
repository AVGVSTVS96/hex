import { randomUUID } from "node:crypto";

import {
  besideOf,
  besideWhat,
  jobOf,
  lastWords,
  prompt as besidePrompt,
  run as runBeside,
} from "./beside.ts";
import * as claude from "./claude.ts";
import type { Failed } from "./failing.ts";
import type { SessionFiles } from "./files.ts";
import type { Keep } from "./kept.ts";
import { ordered } from "./ordered.ts";
import { live } from "./running.ts";
import type { Session } from "./running.ts";
import type { SessionStarts } from "./start.ts";
import type { Row } from "./store.ts";
import type { Threads } from "./threads.ts";
import { wentThrough } from "./through.ts";

type RowBeside = Row & { beside: string; resume?: string };

export type SessionsBeside = ReturnType<typeof sessionsBeside>;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The sessions that run beside a thread, one for each row kept beside it. ownTurnsOnly: the app's client shows only the turns its own messages start. wake: a run ended, so what it left for the thread's session, and the rows behind it, can go on.
export function sessionsBeside({
  threads,
  files,
  starts,
  kept,
  serving,
  app,
  main,
  channel,
  launcher,
  zone,
  ownTurnsOnly,
  failed,
  wake,
}: {
  threads: Threads;
  files: SessionFiles;
  starts: SessionStarts;
  kept: Keep;
  serving: () => boolean;
  app: string;
  main: string | undefined;
  channel: string;
  launcher: string;
  zone: () => string;
  ownTurnsOnly: () => boolean;
  failed: Failed;
  wake: () => void;
}) {
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Each session running beside a thread, by the row it was started for, if this hub started it.
  const besides = new Map<string, string | undefined>();
  let started: Promise<void> = Promise.resolve();

  const besideAddresses = () => threads.ids().map(besideOf);

  const rows = () => kept((store) => store.messages.beside(besideAddresses()), []);

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A row beside a thread starts a session of its own, as hex in the thread's chat, which takes the row itself; one for a session that ran beside it resumes that session once its run is over, where this machine has its conversation. A client that shows only the turns its own messages start can't be spoken into from beside, so there the row goes to the thread.
  async function beside(row: RowBeside) {
    await started;
    const thread = besideWhat(row.beside);
    const resumed = row.resume;
    const known = thread === undefined ? undefined : threads.get(thread);

    if (
      !serving() ||
      thread === undefined ||
      !known ||
      [...besides.values()].includes(row.key) ||
      (resumed !== undefined && besides.has(resumed))
    ) {
      return;
    }

    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // The row is this run's from here on, so a wake while the store is asked about it starts no second run.
    const session = resumed !== undefined && claude.saved(resumed) ? resumed : randomUUID();
    besides.set(session, row.key);

    if (resumed !== undefined && live().has(resumed)) {
      besides.delete(session);

      return;
    }

    if (ownTurnsOnly()) {
      await kept((store) => store.messages.readdress(row.key, thread), false);
      besides.delete(session);

      return;
    }

    files.writeBeside(thread);

    const code = await runBeside(
      [
        launcher,
        "-p",
        ...(session === resumed ? ["--resume", session] : ["--session-id", session]),
        ...starts.launchArgs(thread),
        "--settings",
        files.besideSettingsOf(thread),
        besidePrompt(app, row, zone()),
      ],
      {
        cwd: threads.cwd(thread),
        env: {
          HEX_CHANNEL: channel,
          HEX_THREAD: thread,
          HEX_BESIDE: session,
          CLAUDE_CODE_SESSION_NAME: `${known.name}/${jobOf(row)}`,
        },
        log: files.besideLog(session),
      },
    );

    await besideEnded(thread, session, row.key, `exit ${code}`);
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Each thread's runs beside it end one at a time, so each reads what the one before it left.
  const ending = ordered();

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A run beside a thread that saw its turn through is a turn that went through. One that didn't, as on an API error, waits for one to go through anywhere, as a thread's turn does, and its chat hears once while runs there wait; one that waited already is left, and its chat hears that. The run is the hub's until the store has its end, so no look starts it again before then.
  async function besideEnded(
    thread: string,
    session: string,
    key?: string,
    exit = "its session ended",
  ) {
    const said = lastWords(files.besideLog(session));

    if (!serving()) {
      return;
    }

    const { waited, given, left } = await ending(thread, async () => {
      const before = await rows();

      const ended = await kept((store) => store.turns.besideEnded(session, key), {
        given: [],
        left: [],
      });

      besides.delete(session);

      return {
        waited: before.some(
          (row) => row.beside === besideOf(thread) && row.meta?.stalled !== undefined,
        ),
        ...ended,
      };
    });

    if (!serving()) {
      return;
    }

    const why = said === "" ? exit : said;

    for (const row of left) {
      failed(
        thread,
        `[${jobOf(row)}] failed again beside this chat, so it won't run by itself again: ${why}`,
        true,
      );
    }

    const [first] = given;

    if (first && !waited) {
      failed(
        thread,
        `[${jobOf(first)}] ran beside this chat and failed: ${why}\nIt carries on once turns go through again.`,
        true,
      );
    }

    if (!given.length && !left.length) {
      wentThrough("turn");
    }

    wake();
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // One run that waits beside a thread, for each turn that goes through, so the runs an outage stopped don't all start at once.
  async function release() {
    await kept((store) => store.messages.supersede(besideAddresses()), undefined);
    const stalled = (await rows()).filter((row) => row.meta?.stalled !== undefined);

    if (stalled.some((row) => [...besides.values()].includes(row.key))) {
      return;
    }

    const [next] = stalled;

    if (next) {
      void beside(next);
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // As the hub starts, a run beside a thread cut off with the machine gives back what it took, to run again; one that outlived the last hub is waited on to its end; and the logs of runs that ended go. No run starts until then, so none is taken for one cut off.
  function hubStarted() {
    const alive = live();
    files.sweepBesideLogs((session) => alive.has(session));

    for (const run of alive.values()) {
      const thread =
        run.thread?.startsWith(`${app}:`) === true ? run.thread.slice(app.length + 1) : undefined;

      if (
        run.beside !== undefined &&
        thread !== undefined &&
        (thread === main || threads.has(thread))
      ) {
        void waitBeside(thread, run);
      }
    }

    started = kept(async (store) => {
      for (const dead of await store.turns.unfinishedBeside([...alive.keys()])) {
        await store.turns.besideEnded(dead, undefined, undefined, false);
      }
    }, undefined);
  }

  async function waitBeside(thread: string, run: Session) {
    besides.set(run.id, undefined);
    await claude.exited(run.pid);
    await besideEnded(thread, run.id);
  }

  function runReady(ready: RowBeside[]) {
    for (const row of ready) {
      if (row.meta?.stalled === undefined) {
        void beside(row);
      }
    }
  }

  return { rows, runReady, release, hubStarted };
}
