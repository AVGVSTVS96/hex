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
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // asked: the session asked to start over (a call ended). stale: it started with what the hub no longer gives a session. underway: it's starting over, and its renewal waits for the new session.
  renew?: "asked" | "stale" | "underway" | undefined;
  held: (() => void)[];
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A call waited for the session now connected to start, so it is as new as the call.
  awaited?: boolean | undefined;
};

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A thread's session starting over, for a call or for what the hub now gives a session, and those who wait for the new one.
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A thread renews at its next rest: the main thread and a fresh thread start over as soon as the process exits, any other when its next message resumes it. A keep (a call started) cancels it. When the session asked for it, a rest the Stop hook reported with no agents working is taken as it is: Claude's own status lags the hook and counts a running shell as busy, so checking it could put the renew off for good, and a session that asked is done with what its shells were for.
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A renew is on its way while the thread's session winds down its turn or restarts, but not while it waits on background agents, which can take as long as they like.
  function pending(thread: string) {
    const renewing = renewalOf(thread);

    return (
      renewing.renew === "underway" || (!!renewing.renew && turns.of(thread).is !== "background")
    );
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Resolves once the thread's renew is through (its new session connected) or off, right away when none is on its way, so a voice call can wait for the new session.
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A thread is on a call from its keep until its renew, which starts the next call in a new session. That session starts when the last call ends and can wait hours for the next, so a call that finds it still waiting for its first message starts it over, reading memory as it is now, unless a call waited for it to start. The stop comes first, so a message meanwhile waits for the new session, and the call is on once that session connects, so a restart that never gets there doesn't hold up the hub's own. Resolves once the session the call runs in is connected.
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A session connected, so a renew that waited for one is through. One that only reconnects still owes a renew it asked for.
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
