import * as claude from "./claude.ts";
import type { Keep } from "./kept.ts";
import { present } from "./present.ts";
import type { Runs } from "./runs.ts";
import type { Threads } from "./threads.ts";

type Stop = { ending?: Promise<void> | undefined };

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// `claude stop` returns before the process exits, and the session keeps its channel until it does, so a message meanwhile waits for the exit (forward). Its process is found while Claude still lists it, before the stop; when Claude can't say, the stop goes ahead without the wait. The hub stops a session only when it's idle or the owner asks, so what it took is handled. stopping: the hub hears first.
export function sessionStops({
  runs,
  threads,
  kept,
  serving,
  stopping,
}: {
  runs: Runs;
  threads: Threads;
  kept: Keep;
  serving: () => boolean;
  stopping: (thread: string) => void;
}) {
  const stops = runs.part((): Stop => ({}));

  function ending(thread: string) {
    return stops.get(thread)?.ending;
  }

  function stop(thread: string, running?: claude.Agent) {
    const underWay = stops.of(thread);
    stopping(thread);
    const session = running?.sessionId ?? threads.current(thread);

    if (!present(session)) {
      return Promise.resolve();
    }

    if (underWay.ending) {
      return underWay.ending;
    }

    const ended: Promise<void> = (running ? Promise.resolve(running) : claude.listing(session))
      .then((agent) => {
        if (!serving()) {
          return;
        }

        kept((store) => {
          store.turns.handled(session);
        }, undefined);
        void claude.stop(session);

        return agent && claude.exited(agent.pid);
      })
      .finally(() => (underWay.ending = undefined));

    return (underWay.ending = ended);
  }

  return { ending, stop };
}
