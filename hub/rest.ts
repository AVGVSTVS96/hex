import type { ThreadCalls } from "./calls.ts";
import * as claude from "./claude.ts";
import { clock } from "./clock.ts";
import type { Timer } from "./clock.ts";
import type { SessionPauses } from "./pauses.ts";
import { present } from "./present.ts";
import type { Runs } from "./runs.ts";
import type { ThreadSessions } from "./sessions.ts";
import type { SessionStops } from "./stops.ts";
import type { Threads } from "./threads.ts";
import type { SessionTurns } from "./turns.ts";

type Rest = {
  timer?: Timer | undefined;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // When the hub last had the session compact, until its context is back under compactAbove.
  compacting?: number | undefined;
  leaving?: ((session: string) => void) | undefined;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The stop a retire sends, once: the retire and the rest it meets both ask for it, and a stop can be over while its session still holds its channel, as when Claude doesn't list it.
  stopped?: Promise<void> | undefined;
};

export type SessionRests = ReturnType<typeof sessionRests>;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What a thread's session does once it isn't busy, and the timer that waits for it: stop, compact, hand over to a new session, or leave for good when its thread is retired. forget: the thread is gone, and its session with it.
export function sessionRests({
  runs,
  threads,
  turns,
  sessions,
  stops,
  pauses,
  calls,
  serving,
  main,
  fresh,
  idleStop,
  cacheWarm,
  compactAbove,
  capacity,
  forget,
}: {
  runs: Runs;
  threads: Threads;
  turns: SessionTurns;
  sessions: ThreadSessions;
  stops: SessionStops;
  pauses: SessionPauses;
  calls: ThreadCalls;
  serving: () => boolean;
  main: string | undefined;
  fresh: (thread: string) => boolean;
  idleStop: number;
  cacheWarm: number;
  compactAbove: number;
  capacity: number;
  forget: (thread: string, leaving: (session: string) => void) => void;
}) {
  const rests = runs.part((): Rest => ({}));
  const restOf = rests.of;

  function of(thread: string): Readonly<Pick<Rest, "leaving">> {
    return restOf(thread);
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A running session that isn't busy stops after a while; its next message resumes it. The main thread keeps running, and compacts before its cache goes cold.
  function rest(thread: string, rested = false) {
    const quiet = restOf(thread);
    const standing = sessions.of(thread);
    clock.clearTimeout(quiet.timer);
    quiet.timer = undefined;

    if (turns.of(thread).is === "busy" || standing.phase.is !== "live") {
      return;
    }

    if (thread === main) {
      quiet.timer = clock.setTimeout(() => void stopIfIdle(thread), cacheWarm);
    } else if (quiet.leaving) {
      quiet.stopped ??= stops.stop(thread);
    } else if (fresh(thread)) {
      const left = warmFor(thread);

      if (left === 0 && rested) {
        void handOff(thread, true);
      } else if (left !== undefined) {
        quiet.timer = clock.setTimeout(() => void handOff(thread), left);
      }
    } else {
      quiet.timer = clock.setTimeout(() => void stopIfIdle(thread), idleStop);
    }
  }

  // A fresh thread keeps one session running, which takes its messages while its context has room and its cache is warm. Once either is spent, a new session built from the chat takes over at the old one's rest, so the next message finds it running: after the cache expires, the old session would send its whole context uncached, and a new one costs no more. warmFor is how long a session stays worth its messages, undefined before its first request: cacheWarm of an hour's cache, or as much of a shorter one (claude.cacheLife). https://docs.claude.com/en/docs/build-with-claude/prompt-caching
  function warmFor(thread: string) {
    const session = threads.current(thread);

    const {
      sent: context,
      at,
      short,
    } = present(session) ? claude.usage(threads.cwd(thread), session) : { sent: 0 };

    if (!context) {
      return;
    }

    const keepsWarm = (cacheWarm * claude.cacheLife(short)) / claude.cacheLife();

    return context >= capacity ? 0 : Math.max(0, (at ?? clock.now()) + keepsWarm - clock.now());
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A session on a call takes every message of the call, so a call never changes sessions midway.
  function spent(thread: string) {
    return fresh(thread) && !calls.of(thread).on && warmFor(thread) === 0;
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // At a rest the Stop hook reported with no agents working, Claude's own status still says busy for about a second, so a session that filled up on that turn hands over without asking it.
  async function handOff(thread: string, rested = false) {
    const quiet = restOf(thread);
    const turn = turns.of(thread);
    quiet.timer = undefined;
    const running = await claude.agent(threads.current(thread) ?? "", serving);

    if (running && turn.is !== "busy" && (rested || running.status === "idle") && spent(thread)) {
      void sessions.cycle(thread, running);
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The Stop hook ends a turn, but background tasks keep a session busy past it, so Claude's own status decides; a busy session reports idle again when it's done. A big conversation compacts first, while its cache is warm: resumed after the cache expires, it would be written to the cache whole again.
  async function stopIfIdle(thread: string) {
    const quiet = restOf(thread);
    const voice = calls.of(thread);
    const turn = turns.of(thread);
    const pause = pauses.of(thread);
    quiet.timer = undefined;
    const session = threads.current(thread);

    if (!present(session)) {
      return;
    }

    const running = await claude.agent(session, serving);

    if (turn.is === "busy" || running?.status === "busy" || pause.paused === true) {
      return;
    }

    const { sent: context, failed: failedAt } = claude.usage(threads.cwd(thread), session);

    if (running && !quiet.leaving && !fresh(thread) && !voice.on && context > compactAbove) {
      if (failedAt === undefined) {
        compact(thread, running);

        return;
      }

      quiet.compacting ??= failedAt;
    }

    if (thread === main) {
      return;
    }

    if (quiet.leaving) {
      quiet.stopped ??= stops.stop(thread);
    } else {
      void stops.stop(thread);
    }
  }

  function compact(thread: string, running?: claude.Agent) {
    restOf(thread).compacting = clock.now();
    void sessions.cycle(thread, running, "/compact", true);
  }

  async function recompact() {
    for (const [thread, quiet] of rests.all()) {
      const session = threads.current(thread);

      if (quiet.compacting === undefined || !present(session)) {
        continue;
      }

      const { sent: context, failed: failedAt } = claude.usage(threads.cwd(thread), session);

      if (context <= compactAbove) {
        quiet.compacting = undefined;
        continue;
      }

      const standing = sessions.of(thread);
      const resting = standing.phase.is === "live" || standing.phase.is === "stopped";

      if (
        failedAt === undefined ||
        failedAt < quiet.compacting ||
        !resting ||
        turns.of(thread).is === "busy" ||
        stops.ending(thread) ||
        quiet.leaving ||
        calls.of(thread).on
      ) {
        continue;
      }

      const running = await claude.agent(session, serving);

      if (running?.status !== "busy") {
        compact(thread, running);
      }
    }
  }

  function cancel(thread: string) {
    const quiet = restOf(thread);
    clock.clearTimeout(quiet.timer);
    quiet.timer = undefined;
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Resolves with the thread's session once it has stopped and the thread is forgotten, in hex.db too.
  function retire(thread: string): Promise<string> {
    if (thread === main) {
      throw new Error("the main thread stays open");
    }

    return new Promise((resolve) => {
      restOf(thread).leaving = resolve;

      if (sessions.of(thread).phase.is !== "live") {
        forget(thread, resolve);

        return;
      }

      void stopIfIdle(thread);
    });
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Like retire, for a thread whose session another client resumes.
  function release(thread: string) {
    if (thread === main) {
      throw new Error("the main thread stays here");
    }

    if (!present(threads.get(thread)?.session)) {
      throw new Error("this thread has no session yet");
    }

    return retire(thread);
  }

  return { of, rest, warmFor, spent, recompact, cancel, retire, release };
}
