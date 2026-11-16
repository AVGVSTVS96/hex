import type { FSWatcher } from "node:fs";

import * as claude from "./claude.ts";
import { clock } from "./clock.ts";
import type { Timer } from "./clock.ts";
import type { failedStarts, Opening } from "./failing.ts";
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
// Where a thread's session stands. launching: the hub started or restarted it and waits for its channel, so one that ends first failed to start. recovering: it runs without its channel, which Claude Code may still bring back. Either wait ends at its deadline. watch: on Claude's job record of the session.
type Phase =
  | { is: "stopped" }
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // again: the hub started the thread again on its own (retry, revive), not for a message or prompt.
  | {
      is: "launching";
      job?: string;
      watch?: FSWatcher;
      deadline?: Timer | undefined;
      respawned?: boolean;
      again?: boolean | undefined;
    }
  | { is: "recovering"; deadline?: Timer | undefined; again?: boolean | undefined }
  | { is: "live"; line: Line; watch?: FSWatcher };

type Standing = { phase: Phase };

function become(standing: Standing, phase: Phase) {
  const was = standing.phase;

  if (was.is === "launching" || was.is === "live") {
    was.watch?.close();
  }

  if (was.is === "launching" || was.is === "recovering") {
    clock.clearTimeout(was.deadline);
  }

  standing.phase = phase;
}

function underway(standing: Standing) {
  return standing.phase.is === "launching" || standing.phase.is === "live";
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Where each thread's session stands, and the starts and restarts that move it: become is the one writer of which phase it's in, and only this file changes what goes with that phase. What the hub does about it goes up as a fact: a turn began or ended, a start failed.
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
  const standings = runs.part((): Standing => ({ phase: { is: "stopped" } }));
  const standingOf = standings.of;

  function of(thread: string): { readonly phase: Readonly<Phase> } {
    return standingOf(thread);
  }

  function connected(thread: string, line: Line): Readonly<Phase> | undefined {
    const standing = standingOf(thread);

    if (stops.ending(thread)) {
      return;
    }

    const was = standing.phase;
    become(standing, { is: "live", line });
    failing.connected(thread);
    pauses.connected(thread);

    return was;
  }

  function track(thread: string, was: Readonly<Phase>) {
    const job = was.is === "launching" ? was.job : undefined;
    threads.register(thread, thread);

    const id = present(job) ? claude.record(job).sessionId : undefined;

    if (present(id)) {
      threads.note(thread, id);
    }

    const record = job ?? threads.current(thread)?.slice(0, 8);

    if (present(record)) {
      watchJob(thread, record);
    }
  }

  function noteRunning(thread: string, line: Line) {
    const standing = standingOf(thread);

    void (async () => {
      const running = await sessionOf(thread);

      if (running && standing.phase.is === "live" && standing.phase.line === line) {
        threads.note(thread, running.sessionId);
      }
    })();
  }

  function dropped(thread: string, line: Line) {
    const standing = standings.get(thread);

    if (standing?.phase.is !== "live" || standing.phase.line !== line) {
      return false;
    }

    become(standing, { is: "recovering" });

    return true;
  }

  function end(thread: string) {
    become(standingOf(thread), { is: "stopped" });
  }

  function waitedOn(thread: string) {
    const { phase } = standingOf(thread);

    if (phase.is === "launching") {
      phase.again = false;
    }
  }

  async function launch(
    thread: string,
    name: string,
    {
      cwd,
      again,
      ...given
    }: Opening & { cwd?: string | undefined; again?: boolean | undefined } = {},
  ) {
    const standing = standingOf(thread);

    if (!serving() || underway(standing)) {
      return;
    }

    const { prompt, fork, quiet = false } = failing.keepOpening(thread, given);
    threads.register(thread, name, cwd);
    threads.claim(thread);

    if ((present(prompt) && !quiet) || waiting.of(thread).queue.length > 0) {
      turnBegan(thread);
    }

    const phase: Phase = { is: "launching", again };
    become(standing, phase);

    waiting.markAll(thread);

    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // A fork's first start has no session to find; after a failed one, the session it started may run on.
    if (present(fork) && !failing.failedLast(thread)) {
      await watchStart(thread, starts.start(thread, prompt, fork));

      return;
    }

    const running = await sessionOf(thread);

    if (standing.phase !== phase) {
      return;
    }

    if (running) {
      become(standing, { is: "recovering", again });

      recover(thread);

      return;
    }

    waiting.cut(thread, threads.current(thread));
    const daemonChecked = claude.restartStaleDaemon();

    const session = threads.get(thread)?.session;

    if (!present(fork) && present(session) && !fresh(thread)) {
      await claude.rm(session);
    }

    if (standing.phase === phase) {
      await watchStart(thread, starts.start(thread, prompt, fork, daemonChecked));
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The running session serving a thread: its current one, or one started for it whose conversation isn't saved yet.
  async function sessionOf(thread: string) {
    const running = await claude.agents(serving);

    return (
      running.find((agent) => agent.sessionId === threads.current(thread)) ??
      running.find((agent) => boundTo(agent) === thread)
    );
  }

  function boundTo(agent: claude.Agent) {
    const env = claude.settingsOf(agent)?.env;

    return env?.HEX_CHANNEL === channel ? env.HEX_THREAD : undefined;
  }

  async function watchStart(thread: string, job: Promise<string>) {
    try {
      watchJob(thread, await job);
    } catch (error) {
      fail(thread, error instanceof Error ? error.message : String(error));
    }
  }

  function watchJob(thread: string, job: string) {
    const phase = standingOf(thread).phase;

    if (phase.is === "launching") {
      phase.job = job;
      recover(thread);
    } else if (phase.is !== "live") {
      return;
    }

    const check = () => {
      const { state: status, detail, needs } = claude.record(job);

      if (phase.is === "live") {
        const standing = standingOf(thread);
        void pauses.check(thread, phase.line, needs, () => standing.phase === phase);
      } else if (status === "failed") {
        fail(
          thread,
          detail === undefined || detail === "" ? "the session failed to start" : detail,
        );
      }
    };

    try {
      phase.watch = claude.watchJob(job, check);
      check();
    } catch {
      process.stderr.write(`hub: no job record for ${job}, so ${thread}'s session can't be seen\n`);
    }
  }

  function fail(thread: string, reason: string) {
    const standing = standingOf(thread);
    const { phase } = standing;

    if (phase.is !== "launching") {
      return;
    }

    become(standing, { is: "stopped" });

    if (failing.lost(thread, reason)) {
      return void launch(thread, threads.of(thread).name, { again: phase.again });
    }

    startFailed(thread);
    failing.failure(thread, reason, phase.again === true);
    turnEnded(thread);
  }

  function retry() {
    for (const thread of failing.retries((held) => standings.get(held)?.phase.is === "stopped")) {
      void launch(thread, threads.get(thread)?.name ?? thread, { again: true });
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Claude Code runs a slash command like /compact only as a session's first prompt, and reads its launch arguments only at start, so a running session stops and resumes for either.
  async function restart(thread: string, prompt?: string) {
    const session = threads.current(thread);

    if (!present(session)) {
      await launch(thread, threads.of(thread).name, { prompt });

      return;
    }

    void cycle(thread, await claude.agent(session, serving), prompt);
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Resuming before the old process exits starts a copy, so it waits for the exit. The stopped session's stream can close after that, so it isn't waited for.
  async function cycle(thread: string, running?: claude.Agent, prompt?: string, quiet = false) {
    const standing = standingOf(thread);

    if (running) {
      await stops.stop(thread, running);
    }

    if (standing.phase.is === "live" || standing.phase.is === "recovering") {
      become(standing, { is: "stopped" });
    }

    void launch(thread, threads.of(thread).name, { prompt, quiet });
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A session without its channel gets Claude Code's reconnect window to come back, and a starting one, still running each time the hub looks, also the time Claude Code waits for the hub to answer its channel. After that, one still running restarts in place (a turn it was on runs again) if it started before the wait did, or else gets another window; a start that ended is reported, a gone main thread starts again, and a thread whose messages waited on a session that has since ended resumes. pid: the starting session's process, which the hub looks at itself until its wait is over.
  function recover(thread: string, since = clock.now(), pid?: number) {
    const standing = standingOf(thread);
    const phase = standing.phase;

    if (!serving() || phase.is === "stopped" || phase.is === "live" || phase.deadline) {
      return;
    }

    const reconnectOrRecover = async () => {
      phase.deadline = undefined;
      const starting = phase.is === "launching" && clock.now() - since < connect;

      if (starting && pid !== undefined && pid !== 0 && claude.alive(pid)) {
        recover(thread, since, pid);

        return;
      }

      const running = await sessionOf(thread);

      if (standing.phase !== phase) {
        return;
      }

      if (!running) {
        gone(thread);

        return;
      }

      if ((running.startedAt ?? 0) >= since) {
        recover(thread);

        return;
      }

      if (starting) {
        recover(thread, since, running.pid);

        return;
      }

      // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
      // A respawn starts from the flags the session started with, which read the thread's current settings file only for a session the hub started that way.
      if (claude.settingsOf(running)) {
        await respawn(thread, running);

        return;
      }

      void cycle(thread, running);
    };

    phase.deadline = clock.setTimeout(() => void reconnectOrRecover(), reconnect);
  }

  function gone(thread: string) {
    const standing = standingOf(thread);
    const started = standing.phase.is === "launching";
    waiting.cut(thread, threads.current(thread));

    if (started) {
      fail(thread, "its session ended before its channel connected");
    } else {
      become(standing, { is: "stopped" });
    }

    if (thread === main) {
      revive();
    } else if (!started && waiting.forNext(thread).length) {
      void launch(thread, threads.get(thread)?.name ?? thread);
    }
  }

  async function respawn(thread: string, running: claude.Agent) {
    const standing = standingOf(thread);
    const id = running.id ?? running.sessionId.slice(0, 8);

    if (standing.phase.is === "launching" && standing.phase.respawned === true) {
      process.stderr.write(`hub: ${thread}'s session ${id} restarted and still has no channel\n`);

      fail(thread, "its session runs, but its channel never connects");

      return;
    }

    process.stderr.write(
      `hub: ${thread}'s session ${id} runs without its channel, so it restarts in place\n`,
    );

    if (standing.phase.is === "launching") {
      standing.phase.respawned = true;
    } else {
      become(standing, {
        is: "launching",
        respawned: true,
        again: standing.phase.is === "recovering" && standing.phase.again,
      });
    }

    const phase = standing.phase;
    files.write(thread, claude.settingsOf(running));
    await claude.respawn(running);

    if (standing.phase === phase) {
      recover(thread);
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The main thread is always running: started with the hub, and started again when its session is gone.
  function revive() {
    if (!present(main) || !serving() || standingOf(main).phase.is === "live") {
      return;
    }

    threads.update(main, { name: mainName });
    void launch(main, mainName, { again: true });
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Sessions that outlived the hub (a hub restart) reconnect, or recover. A fresh main thread's launch never resumes, so one still running waits for its session instead of starting another.
  function hubStarted(running: claude.Agent[]) {
    const outlived = new Set(
      threads
        .ids()
        .filter((thread) =>
          running.some(
            (agent) => agent.sessionId === threads.current(thread) || boundTo(agent) === thread,
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
      const standing = standingOf(thread);

      if (standing.phase.is !== "stopped") {
        continue;
      }

      if (outlived.has(thread)) {
        become(standing, { is: "recovering" });
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
    recover,
  };
}
