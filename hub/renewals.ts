import type { ThreadCalls } from "./calls.ts";
import * as claude from "./claude.ts";
import type { Keep } from "./kept.ts";
import { present } from "./present.ts";
import type { SessionRests } from "./rest.ts";
import type { Runs } from "./runs.ts";
import type { ThreadSessions } from "./sessions.ts";
import type { SessionStarts } from "./start.ts";
import type { SessionStops } from "./stops.ts";
import type { Threads } from "./threads.ts";
import type { SessionTurns } from "./turns.ts";
import type { MessagesWaiting } from "./waiting.ts";

type Renewal = {
  renew?: "asked" | "stale" | "underway" | undefined;
  held: (() => void)[];
  awaited?: boolean | undefined;
};

export function threadRenewals({
  runs,
  threads,
  turns,
  waiting,
  sessions,
  starts,
  stops,
  rests,
  calls,
  kept,
  serving,
  main,
  fresh,
}: {
  runs: Runs;
  threads: Threads;
  turns: SessionTurns;
  waiting: MessagesWaiting;
  sessions: ThreadSessions;
  starts: SessionStarts;
  stops: SessionStops;
  rests: SessionRests;
  calls: ThreadCalls;
  kept: Keep;
  serving: () => boolean;
  main: string | undefined;
  fresh: (thread: string) => boolean;
}) {
  const renewals = runs.part((): Renewal => ({ held: [] }));
  const renewalOf = renewals.of;

  function atRest(thread: string) {
    const renewing = renewalOf(thread);

    if (
      turns.of(thread).is === "done" &&
      (renewing.renew === "asked" || renewing.renew === "stale")
    ) {
      void renew(thread, renewing.renew === "asked");
    }
  }

  // WARNING: Claude's own status lags the Stop hook and counts a running shell as busy, so a rest the hook reported doesn't wait for it.
  async function renew(thread: string, rested = false) {
    const renewing = renewalOf(thread);
    const voice = calls.of(thread);
    const turn = turns.of(thread);
    const session = threads.current(thread);

    if (!present(session)) {
      return;
    }

    const running = await claude.agent(session, serving);

    if (
      !(renewing.renew === "asked" || renewing.renew === "stale") ||
      turn.is === "busy" ||
      turn.untaken === true ||
      voice.on ||
      (!rested && running?.status === "busy")
    ) {
      return;
    }

    renewing.renew = running && (thread === main || fresh(thread)) ? "underway" : undefined;

    if (renewing.renew) {
      void sessions.cycle(thread, running);
    } else {
      void stops.stop(thread);
    }

    letGo(thread);
  }

  function startFailed(thread: string) {
    const renewing = renewalOf(thread);

    if (renewing.renew === "underway") {
      renewing.renew = undefined;
    }
  }

  function pending(thread: string) {
    const renewing = renewalOf(thread);

    return (
      renewing.renew === "underway" || (!!renewing.renew && turns.of(thread).is !== "background")
    );
  }

  function renewal(thread: string): Promise<void> {
    const renewing = renewalOf(thread);

    if (!pending(thread)) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      renewing.held.push(resolve);
    });
  }

  function letGo(thread: string) {
    const renewing = renewalOf(thread);

    if (pending(thread)) {
      return;
    }

    for (const resolve of renewing.held.splice(0)) {
      resolve();
    }
  }

  async function keep(thread: string) {
    const renewing = renewalOf(thread);
    const callOn = calls.joining(thread);

    if (renewing.renew !== "underway") {
      renewing.renew = undefined;
    }

    const session = threads.current(thread);

    const untouched = () =>
      renewing.awaited !== true &&
      threads.current(thread) === session &&
      sessions.of(thread).phase.is === "live" &&
      turns.of(thread).is === "done" &&
      !waiting.of(thread).handed.size &&
      rests.warmFor(thread) === undefined;

    if (
      present(session) &&
      untouched() &&
      !(await kept((store) => store.messages.took(session), true)) &&
      untouched()
    ) {
      renewing.renew = "underway";
      void stops.stop(thread).then(() => sessions.cycle(thread));
      await renewal(thread);
      callOn();

      return;
    }

    callOn();
    letGo(thread);
    await renewal(thread);
  }

  function renewAsked(thread: string) {
    const renewing = renewalOf(thread);

    if (renewing.renew !== "underway") {
      renewing.renew = "asked";
    }

    calls.hangUp(thread);
  }

  function connecting(thread: string) {
    const renewing = renewalOf(thread);

    if (renewing.renew !== "asked") {
      renewing.renew = undefined;
    }
  }

  function noteAwaited(thread: string) {
    const renewing = renewalOf(thread);
    renewing.awaited = renewing.held.length > 0;
  }

  function connected(thread: string) {
    const renewing = renewalOf(thread);
    letGo(thread);

    if (starts.stale(thread)) {
      renewing.renew = "stale";
      void renew(thread);
    }
  }

  return {
    atRest,
    startFailed,
    renewal,
    letGo,
    keep,
    renewAsked,
    connecting,
    noteAwaited,
    connected,
  };
}
