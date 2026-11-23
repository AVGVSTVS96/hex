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
  const rowKeyOfRunningSession = new Map<string, string | undefined>();
  let started: Promise<void> = Promise.resolve();

  const besideAddresses = () => threads.ids().map(besideOf);

  const rows = () => kept((store) => store.messages.beside(besideAddresses()), []);

  async function beside(row: RowBeside) {
    await started;
    const thread = besideWhat(row.beside);
    const resumed = row.resume;
    const known = thread === undefined ? undefined : threads.get(thread);

    if (
      !serving() ||
      thread === undefined ||
      !known ||
      [...rowKeyOfRunningSession.values()].includes(row.key) ||
      (resumed !== undefined && rowKeyOfRunningSession.has(resumed))
    ) {
      return;
    }

    const session = resumed !== undefined && claude.saved(resumed) ? resumed : randomUUID();
    rowKeyOfRunningSession.set(session, row.key);

    if (resumed !== undefined && live().has(resumed)) {
      rowKeyOfRunningSession.delete(session);

      return;
    }

    if (ownTurnsOnly()) {
      await kept((store) => store.messages.readdress(row.key, thread), false);
      rowKeyOfRunningSession.delete(session);

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

  const ending = ordered();

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

      rowKeyOfRunningSession.delete(session);

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

  async function release() {
    await kept((store) => store.messages.supersede(besideAddresses()), undefined);
    const stalled = (await rows()).filter((row) => row.meta?.stalled !== undefined);

    if (stalled.some((row) => [...rowKeyOfRunningSession.values()].includes(row.key))) {
      return;
    }

    const [next] = stalled;

    if (next) {
      void beside(next);
    }
  }

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
    rowKeyOfRunningSession.set(run.id, undefined);
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
