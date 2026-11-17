import type { FSWatcher } from "node:fs";

import { Cause, Data, Effect, Option } from "effect";

import * as claude from "./claude.ts";
import { clock } from "./clock.ts";
import type { failedStarts, Opening } from "./failing.ts";
import { ownedWork } from "./fibers.ts";
import type { Work } from "./fibers.ts";
import type { SessionFiles } from "./files.ts";
import type { Keep } from "./kept.ts";
import type { Line } from "./mcp.ts";
import type { sessionPauses } from "./pauses.ts";
import { present } from "./present.ts";
import type { Runs } from "./runs.ts";
import type { sessionStarts } from "./start.ts";
import type { sessionStops } from "./stops.ts";
import type { Threads } from "./threads.ts";
import type { MessagesWaiting } from "./waiting.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Where a thread's session stands. launching: the hub started or restarted it and waits for its channel, so one that ends first failed to start. recovering: it runs without its channel, which Claude Code may still bring back. again: the hub started the thread again on its own (retry, revive), not for a message or prompt.
type Phase =
  | { is: "stopped" }
  | {
      is: "launching";
      started?: Promise<string>;
      job?: string;
      respawned?: boolean;
      again?: boolean | undefined;
    }
  | { is: "recovering"; again?: boolean | undefined }
  | { is: "live"; line: Line };

type Launching = Extract<Phase, { is: "launching" }>;

type Waiting = Extract<Phase, { is: "launching" | "recovering" }>;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// work: what the hub is doing for the phase, which lasts no longer than it does.
type Standing = { phase: Phase; work: Work<StartFailed> };

class StartFailed extends Data.TaggedError("StartFailed")<{ reason: string }> {}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Claude's job record of a session, read now and at each change, until a reading ends it or it's interrupted. Effect runs a callback's own cleanup only when it's interrupted, so the watch closes in ensuring, however this ends.
const watched = <E = never>(
  thread: string,
  job: string,
  read: (record: claude.Job, end: (ended: Effect.Effect<never, E>) => void) => void,
) =>
  Effect.suspend(() => {
    let watch: FSWatcher | undefined;

    return Effect.callback<never, E>((resume) => {
      const check = () => {
        read(claude.record(job), resume);
      };

      try {
        watch = claude.watchJob(job, check);
        check();
      } catch {
        process.stderr.write(
          `hub: no job record for ${job}, so ${thread}'s session can't be seen\n`,
        );
      }
    }).pipe(Effect.ensuring(Effect.sync(() => watch?.close())));
  });

const failedRecord = (thread: string, job: string) =>
  watched<StartFailed>(thread, job, ({ state, detail }, end) => {
    if (state === "failed") {
      end(
        Effect.fail(
          new StartFailed({
            reason: detail === undefined || detail === "" ? "the session failed to start" : detail,
          }),
        ),
      );
    }
  });

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A session without its channel gets Claude Code's reconnect window to come back, and a starting one, still running each time the hub looks, also the time Claude Code waits for the hub to answer its channel. Returns the session once it has run past that without its channel, or nothing when it's gone. sessionOf: the running session serving the thread, as Claude lists it then. since: when the wait began, which a session that started later begins again. pid: the starting session's process, which the hub looks at itself until its wait is over.
const channelless = Effect.fn("channelless")(function* channelless(
  phase: Waiting,
  sessionOf: () => Promise<claude.Agent | undefined>,
  { reconnect, connect }: { reconnect: number; connect: number },
) {
  let since = clock.now();
  let pid: number | undefined;

  for (;;) {
    yield* Effect.sleep(reconnect);
    const connecting = phase.is === "launching" && clock.now() - since < connect;

    if (connecting && pid !== undefined && pid !== 0 && claude.alive(pid)) {
      continue;
    }

    const running = yield* Effect.promise(sessionOf);

    if (!running) {
      return;
    }

    if ((running.startedAt ?? 0) >= since) {
      since = clock.now();
      pid = undefined;
    } else if (connecting) {
      ({ pid } = running);
    } else {
      return running;
    }
  }
});

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The thread a session was started for, by the settings file it started with.
function boundTo(agent: claude.Agent, channel: string) {
  const env = claude.settingsOf(agent)?.env;

  return env?.HEX_CHANNEL === channel ? env.HEX_THREAD : undefined;
}

function underway(standing: Standing) {
  return standing.phase.is === "launching" || standing.phase.is === "live";
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Where each thread's session stands, and the starts and restarts that move it: become is the one writer of which phase it's in, and only this file changes what goes with that phase. What the hub does for a phase is that phase's work, an Effect: a start's steps, a wait for a channel, a watch on Claude's job record. A phase ending interrupts its work, so none of it acts for a phase that's over, and work that fails or breaks ends a start as failed. What the hub does about a phase goes up as a fact: a turn began or ended, a start failed.
export function threadSessions({
  runs,
  threads,
  waiting,
  files,
  starts,
  stops,
  failing,
  pauses,
  kept,
  serving,
  channel,
  main,
  mainName,
  fresh,
  connect,
  reconnect,
  turnBegan,
  turnEnded,
  startFailed,
}: {
  runs: Runs;
  threads: Threads;
  waiting: MessagesWaiting;
  files: SessionFiles;
  starts: ReturnType<typeof sessionStarts>;
  stops: ReturnType<typeof sessionStops>;
  failing: ReturnType<typeof failedStarts>;
  pauses: ReturnType<typeof sessionPauses>;
  kept: Keep;
  serving: () => boolean;
  channel: string;
  main: string | undefined;
  mainName: string;
  fresh: (thread: string) => boolean;
  connect: number;
  reconnect: number;
  turnBegan: (thread: string) => void;
  turnEnded: (thread: string) => void;
  startFailed: (thread: string) => void;
}) {
  const standings = runs.part((): Standing => ({ phase: { is: "stopped" }, work: ownedWork() }));
  const standingOf = standings.of;

  function of(thread: string): { readonly phase: Readonly<Phase> } {
    return standingOf(thread);
  }

  function become(thread: string, phase: Phase, doing?: Effect.Effect<unknown, StartFailed>) {
    const standing = standingOf(thread);
    standing.phase = phase;
    standing.work.end();

    if (doing) {
      during(thread, doing);
    }
  }

  function during(thread: string, doing: Effect.Effect<unknown, StartFailed>) {
    const { phase, work } = standingOf(thread);

    work.start(doing, (cause) => {
      broke(thread, phase, cause);
    });
  }

  function broke(thread: string, phase: Phase, cause: Cause.Cause<StartFailed>) {
    const error = Cause.squash(cause);
    const planned = error instanceof StartFailed;

    if (!planned) {
      process.stderr.write(
        `hub: ${thread}'s work while ${phase.is} broke: ${Cause.pretty(cause)}\n`,
      );
    }

    if (standingOf(thread).phase !== phase) {
      return;
    }

    if (phase.is === "launching") {
      fail(thread, planned ? error.reason : error instanceof Error ? error.message : String(error));
    } else if (phase.is === "recovering") {
      become(thread, { is: "stopped" });
    }
  }

  function connected(thread: string, line: Line): Readonly<Phase> | undefined {
    if (stops.ending(thread)) {
      return;
    }

    const was = standingOf(thread).phase;
    become(thread, { is: "live", line });
    failing.connected(thread);
    pauses.connected(thread);

    return was;
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A live session's job record is watched under the job it was started as, which the start still under way when it connected has yet to say, or else under its short id, as Claude lists a job without one.
  function track(thread: string, was: Readonly<Phase>, line: Line) {
    const { job, started } = was.is === "launching" ? was : {};
    threads.register(thread, thread);

    const id = present(job) ? claude.record(job).sessionId : undefined;

    if (present(id)) {
      threads.note(thread, id);
    }

    during(
      thread,
      Effect.gen(function* watching() {
        const late =
          !present(job) && started
            ? yield* Effect.option(Effect.tryPromise(() => started))
            : Option.none();

        const record = job ?? Option.getOrUndefined(late) ?? threads.current(thread)?.slice(0, 8);

        if (present(record)) {
          yield* watched(thread, record, ({ needs }) => {
            during(thread, pauses.check(thread, line, needs));
          });
        }
      }),
    );
  }

  function noteRunning(thread: string, line: Line) {
    const { phase } = standingOf(thread);

    if (phase.is !== "live" || phase.line !== line) {
      return;
    }

    during(
      thread,
      Effect.gen(function* noting() {
        const running = yield* Effect.promise(() => sessionOf(thread));

        if (running) {
          threads.note(thread, running.sessionId);
        }
      }),
    );
  }

  function dropped(thread: string, line: Line) {
    const standing = standings.get(thread);

    if (standing?.phase.is !== "live" || standing.phase.line !== line) {
      return false;
    }

    recover(thread);

    return true;
  }

  function recover(thread: string, again?: boolean) {
    const phase: Phase = { is: "recovering", again };
    become(thread, phase, channelOrRestart(thread, phase));
  }

  function end(thread: string) {
    become(thread, { is: "stopped" });
  }

  function waitedOn(thread: string) {
    const { phase } = standingOf(thread);

    if (phase.is === "launching") {
      phase.again = false;
    }
  }

  function launch(
    thread: string,
    name: string,
    {
      cwd,
      again,
      ...given
    }: Opening & { cwd?: string | undefined; again?: boolean | undefined } = {},
  ) {
    if (!serving() || underway(standingOf(thread))) {
      return;
    }

    const phase: Phase = { is: "launching", again };
    become(thread, phase, starting(thread, phase, { name, cwd }, given));
  }

  const starting = Effect.fn("starting")(function* starting(
    thread: string,
    phase: Launching,
    { name, cwd }: { name: string; cwd: string | undefined },
    given: Opening,
  ) {
    const { prompt, fork, quiet = false } = failing.keepOpening(thread, given);
    threads.register(thread, name, cwd);
    threads.claim(thread);

    if ((present(prompt) && !quiet) || waiting.of(thread).queue.length > 0) {
      turnBegan(thread);
    }

    const { again } = phase;
    waiting.markAll(thread);
    let daemonChecked: Promise<void> | undefined;

    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // A fork's first start has no session to find; after a failed one, the session it started may run on.
    if (!present(fork) || failing.failedLast(thread)) {
      if (yield* Effect.promise(() => sessionOf(thread))) {
        recover(thread, again);

        return;
      }

      waiting.cut(thread, threads.current(thread));
      daemonChecked = claude.restartStaleDaemon();
      const session = threads.get(thread)?.session;

      if (!present(fork) && present(session) && !fresh(thread)) {
        yield* Effect.promise(() => claude.rm(session));
      }
    }

    const started = starts.start(thread, prompt, fork, daemonChecked);
    phase.started = started;

    const job = yield* Effect.tryPromise({
      try: () => started,
      catch: (error) =>
        new StartFailed({ reason: error instanceof Error ? error.message : String(error) }),
    });

    phase.job = job;
    during(thread, failedRecord(thread, job));
    yield* channelOrRestart(thread, phase);
  });

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The running session serving a thread: its current one, or one started for it whose conversation isn't saved yet.
  async function sessionOf(thread: string) {
    const running = await claude.agents(serving);

    return (
      running.find((agent) => agent.sessionId === threads.current(thread)) ??
      running.find((agent) => boundTo(agent, channel) === thread)
    );
  }

  function fail(thread: string, reason: string) {
    const { phase } = standingOf(thread);

    if (phase.is !== "launching") {
      return;
    }

    become(thread, { is: "stopped" });

    if (failing.lost(thread, reason)) {
      launch(thread, threads.of(thread).name, { again: phase.again });

      return;
    }

    startFailed(thread);
    failing.failure(thread, reason, phase.again === true);
    turnEnded(thread);
  }

  function retry() {
    for (const thread of failing.retries((held) => standings.get(held)?.phase.is === "stopped")) {
      launch(thread, threads.get(thread)?.name ?? thread, { again: true });
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Claude Code runs a slash command like /compact only as a session's first prompt, and reads its launch arguments only at start, so a running session stops and resumes for either.
  async function restart(thread: string, prompt?: string) {
    const session = threads.current(thread);

    if (!present(session)) {
      launch(thread, threads.of(thread).name, { prompt });

      return;
    }

    void cycle(thread, await claude.agent(session, serving), prompt);
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Resuming before the old process exits starts a copy, so it waits for the exit. The stopped session's stream can close after that, so it isn't waited for, and the wait is no phase's work: a session that connects meanwhile is still the one being stopped.
  async function cycle(thread: string, running?: claude.Agent, prompt?: string, quiet = false) {
    if (running) {
      await stops.stop(thread, running);
    }

    const { phase } = standingOf(thread);

    if (phase.is === "live" || phase.is === "recovering") {
      become(thread, { is: "stopped" });
    }

    launch(thread, threads.of(thread).name, { prompt, quiet });
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The wait for a session's channel, and what the hub does when it stays away. A session still running restarts in place, once (a turn it was on runs again), and is a failed start if its channel stays away after that; a start that ended is reported, a gone main thread starts again, and a thread whose messages waited on a session that has since ended resumes. A respawn starts from the flags the session started with, which read the thread's current settings file only for a session the hub started that way, so any other stops and starts again.
  const channelOrRestart: (thread: string, phase: Waiting) => Effect.Effect<void, StartFailed> =
    Effect.fn("channelOrRestart")(function* channelOrRestart(thread: string, phase: Waiting) {
      for (;;) {
        const running = yield* channelless(phase, () => sessionOf(thread), { reconnect, connect });

        if (!running) {
          gone(thread);

          return;
        }

        const settings = claude.settingsOf(running);

        if (!settings) {
          void cycle(thread, running);

          return;
        }

        const id = running.id ?? running.sessionId.slice(0, 8);

        if (phase.is === "recovering") {
          const next: Phase = { is: "launching", respawned: true, again: phase.again };
          become(thread, next, restarted(thread, next, running, id));

          return;
        }

        if (phase.respawned === true) {
          process.stderr.write(
            `hub: ${thread}'s session ${id} restarted and still has no channel\n`,
          );

          return yield* new StartFailed({
            reason: "its session runs, but its channel never connects",
          });
        }

        phase.respawned = true;
        yield* respawn(thread, running, id);
      }
    });

  const respawn = Effect.fn("respawn")(function* respawn(
    thread: string,
    running: claude.Agent,
    id: string,
  ) {
    process.stderr.write(
      `hub: ${thread}'s session ${id} runs without its channel, so it restarts in place\n`,
    );

    files.write(thread, claude.settingsOf(running));
    yield* Effect.promise(() => claude.respawn(running));
  });

  const restarted = (thread: string, phase: Launching, running: claude.Agent, id: string) =>
    Effect.andThen(respawn(thread, running, id), channelOrRestart(thread, phase));

  function gone(thread: string) {
    const started = standingOf(thread).phase.is === "launching";
    waiting.cut(thread, threads.current(thread));

    if (started) {
      fail(thread, "its session ended before its channel connected");
    } else {
      become(thread, { is: "stopped" });
    }

    if (thread === main) {
      revive();
    } else if (!started && waiting.forNext(thread).length) {
      launch(thread, threads.get(thread)?.name ?? thread);
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The main thread is always running: started with the hub, and started again when its session is gone.
  function revive() {
    if (!present(main) || !serving() || standingOf(main).phase.is === "live") {
      return;
    }

    threads.update(main, { name: mainName });
    launch(main, mainName, { again: true });
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Sessions that outlived the hub (a hub restart) reconnect, or recover. A fresh main thread's launch never resumes, so one still running waits for its session instead of starting another.
  function hubStarted(running: claude.Agent[]) {
    const outlived = new Set(
      threads
        .ids()
        .filter((thread) =>
          running.some(
            (agent) =>
              agent.sessionId === threads.current(thread) || boundTo(agent, channel) === thread,
          ),
        ),
    );

    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // One that was mid-turn when the hub stopped, with no session running for it (a reboot, or hex moved to another machine), has nothing to reconnect: its next session gets what it left at once. The list is from a supervisor that answered, so a session missing from it isn't running.
    const cutShort = threads
      .ids()
      .filter(
        (thread) => !outlived.has(thread) && kept((store) => store.turns.midTurn(thread), false),
      );

    for (const thread of [...outlived, ...cutShort]) {
      if (standingOf(thread).phase.is !== "stopped") {
        continue;
      }

      if (outlived.has(thread)) {
        recover(thread);
      } else {
        gone(thread);
      }
    }

    if (present(main) && !(fresh(main) && outlived.has(main)) && !cutShort.includes(main)) {
      revive();
    }
  }

  return {
    of,
    connected,
    track,
    noteRunning,
    dropped,
    end,
    waitedOn,
    hubStarted,
    launch,
    sessionOf,
    retry,
    restart,
    cycle,
  };
}
