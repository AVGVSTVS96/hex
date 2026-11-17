import { randomUUID } from "node:crypto";

import { besideOf } from "./beside.ts";
import * as claude from "./claude.ts";
import type { Keep } from "./kept.ts";
import { present } from "./present.ts";
import type { Runs } from "./runs.ts";
import type { Threads } from "./threads.ts";
import type { MessagesWaiting } from "./waiting.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// turn: the session started, and its last turn failed on the API rather than its start.
export type Failed = (thread: string, reason: string, turn?: boolean) => void;

const TELL_GENERAL_AFTER_FAILED_STARTS = 3;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What a new session starts with: its first prompt, and the session it continues as a fork. quiet: the prompt is the hub's own (a compaction), so the thread doesn't show as working.
export type Opening = { prompt?: string | undefined; fork?: string | undefined; quiet?: boolean };

type Starting = {
  opening?: Opening | undefined;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // retried: another session's start set one off since a message's last failed, told: General heard.
  failing?: { count: number; retried?: boolean; told?: boolean } | undefined;
};

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A thread's starts until its session connects: a start's prompt and the session it forks are kept, so the next start after a failed one, a retry or the thread's next message, starts with them, and so is the run of starts that failed in a row. Its chat hears of each one a message or prompt set off, but of one the hub set off on its own only as the run's first, and General hears once, from the third on. General's own failed starts reach only its chat, which needs no session to read them.
export function failedStarts({
  runs,
  threads,
  waiting,
  kept,
  app,
  main,
  generalThread,
  generalHubMain,
  failed,
}: {
  runs: Runs;
  threads: Threads;
  waiting: MessagesWaiting;
  kept: Keep;
  app: string;
  main: string | undefined;
  generalThread: string | undefined;
  generalHubMain: () => string | undefined;
  failed: Failed;
}) {
  const starting = runs.part((): Starting => ({}));

  function keepOpening(thread: string, given: Opening): Readonly<Opening> {
    const start = starting.of(thread);

    if (present(given.prompt) || present(given.fork)) {
      start.opening = given;
    }

    return start.opening ?? {};
  }

  function failedLast(thread: string) {
    return starting.of(thread).failing !== undefined;
  }

  function failure(thread: string, reason: string, again: boolean) {
    const start = starting.of(thread);
    start.failing ??= { count: 0 };
    const { failing } = start;
    failing.count++;

    if (!again) {
      failing.retried = false;
    }

    process.stderr.write(
      `hub: ${thread}'s session failed to start, ${failing.count} in a row: ${reason}\n`,
    );

    if (!again || failing.count === 1) {
      failed(thread, reason);
    }

    const generalMain = generalHubMain();

    if (
      failing.count >= TELL_GENERAL_AFTER_FAILED_STARTS &&
      failing.told !== true &&
      generalMain !== undefined &&
      thread !== generalThread
    ) {
      failing.told = true;
      const body = `[hub] hex couldn't start the session of ${app} thread "${threads.get(thread)?.name ?? thread}" ${failing.count} times in a row: ${reason}. Its next message starts it again.`;
      void kept(
        (store) =>
          store.messages.deliver({
            key: `hub:${app}:${thread}:failing@${randomUUID()}`,
            to: besideOf(generalMain),
            from: "hub",
            author: "prompt",
            body,
            meta: { user: "hub" },
          }),
        false,
      );
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Claude Code failed a start for not finding the session it resumed or forked, and no project folder has its conversation, so the thread lets go of it once a note is kept that tells its next session why it starts without it. One another folder has fails as any start does.
  async function lost(thread: string, reason: string) {
    const known = threads.get(thread);
    const start = starting.of(thread);
    const session = /source session (\S+) not found/u.exec(reason)?.[1];

    if (
      !known ||
      !present(session) ||
      ![known.session, known.fork, start.opening?.fork].includes(session) ||
      claude.saved(session)
    ) {
      return false;
    }

    const key = `hub:${thread}:lost:${session}`;
    const body = `[hub] Claude Code no longer has the conversation of session ${session}, which this thread was to continue, so you're a new session without it; say so when you reply.`;

    if (
      !(await kept(async (store) => {
        await store.messages.deliver({
          key,
          to: thread,
          from: "hub",
          author: "prompt",
          body,
          meta: { user: "hub" },
        });

        return true;
      }, false))
    ) {
      return false;
    }

    waiting.passed(thread, key);
    process.stderr.write(
      `hub: ${thread} lets go of session ${session}, which Claude Code can't find, and starts a new one\n`,
    );

    threads.update(thread, {
      ...(known.session === session && { session: undefined }),
      ...(known.fork === session && { fork: undefined }),
    });

    if (start.opening?.fork === session) {
      delete start.opening.fork;
    }

    return true;
  }

  function connected(thread: string) {
    const start = starting.of(thread);
    start.failing = undefined;
    start.opening = undefined;
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // After the owner's stop only the thread's next message starts it again, without the prompt it was opened with, though a moved copy still starts from the conversation it forks.
  function halted(thread: string) {
    const start = starting.get(thread);

    if (start?.failing) {
      start.failing.retried = true;
    }

    if (start?.opening) {
      start.opening = present(start.opening.fork) ? { fork: start.opening.fork } : undefined;
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A thread whose session failed to start keeps its prompt and the messages it was handed waiting, and the main thread is always running, so each starts again once starts go through. Once for each failed start a message set off: one that fails even then has a problem of its own, and waits for its next message. Each is yielded as it's marked retried, so its start begins before the next thread is looked at.
  async function* retries(stopped: (thread: string) => boolean) {
    for (const [thread, start] of starting.all()) {
      if (
        !start.failing ||
        start.failing.retried === true ||
        !stopped(thread) ||
        !(thread === main || start.opening || (await waiting.forNext(thread)).length > 0)
      ) {
        continue;
      }

      start.failing.retried = true;
      yield thread;
    }
  }

  return { keepOpening, failedLast, failure, lost, connected, halted, retries };
}
