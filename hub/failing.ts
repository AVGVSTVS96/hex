import { randomUUID } from "node:crypto";

import { besideOf } from "./beside.ts";
import * as claude from "./claude.ts";
import type { Keep } from "./kept.ts";
import { present } from "./present.ts";
import type { Runs } from "./runs.ts";
import type { Threads } from "./threads.ts";
import type { MessagesWaiting } from "./waiting.ts";

export type Failed = (thread: string, reason: string, failedOnATurn?: boolean) => void;

const TELL_GENERAL_AFTER_FAILED_STARTS = 3;

export type Opening = { prompt?: string | undefined; fork?: string | undefined; quiet?: boolean };

type Starting = {
  opening?: Opening | undefined;
  failing?: { count: number; retried?: boolean; generalTold?: boolean } | undefined;
};

export type FailedStarts = ReturnType<typeof failedStarts>;

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
      failing.generalTold !== true &&
      generalMain !== undefined &&
      thread !== generalThread
    ) {
      failing.generalTold = true;
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

  function halted(thread: string) {
    const start = starting.get(thread);

    if (start?.failing) {
      start.failing.retried = true;
    }

    if (start?.opening) {
      start.opening = present(start.opening.fork) ? { fork: start.opening.fork } : undefined;
    }
  }

  async function* retries(stopped: (thread: string) => boolean) {
    for (const [thread, start] of starting.all()) {
      const { failing } = start;

      if (
        !failing ||
        failing.retried === true ||
        !stopped(thread) ||
        !(thread === main || start.opening || (await waiting.forNext(thread)).length > 0)
      ) {
        continue;
      }

      failing.retried = true;
      yield thread;
    }
  }

  return { keepOpening, failedLast, failure, lost, connected, halted, retries };
}
