import * as claude from "./claude.ts";
import { clock } from "./clock.ts";
import type { Keep } from "./kept.ts";
import { present } from "./present.ts";
import type { Runs } from "./runs.ts";
import type { Threads } from "./threads.ts";
import type { SessionTurns } from "./turns.ts";

// WARNING: Claude Code shows nothing when Esc meets a turn with nothing left to interrupt.
const ESC_LANDS_WITHIN = 5000;

type Esc = {
  pressing?: Promise<void> | undefined;
};

export function turnInterrupts({
  runs,
  threads,
  turns,
  kept,
  closing,
  turnEnded,
}: {
  runs: Runs;
  threads: Threads;
  turns: SessionTurns;
  kept: Keep;
  closing: AbortSignal;
  turnEnded: (thread: string, background?: boolean) => Promise<void>;
}) {
  const escs = runs.part((): Esc => ({}));

  function interrupt(thread: string): Promise<void> {
    const esc = escs.of(thread);
    esc.pressing ??= press(thread).finally(() => (esc.pressing = undefined));

    return esc.pressing;
  }

  async function press(thread: string): Promise<void> {
    const turn = turns.of(thread);
    const session = threads.current(thread);

    if (!present(session) || turn.is === "background") {
      return;
    }

    const agent = await claude.listing(session);

    if (!agent) {
      return;
    }

    if (turn.is === "done" && agent.state !== "working") {
      return;
    }

    const deadline = new AbortController();

    const timer = clock.setTimeout(() => {
      deadline.abort();
    }, ESC_LANDS_WITHIN);

    const pressed = new Date().toISOString();

    let how: Awaited<ReturnType<typeof claude.interrupt>> | undefined;

    try {
      how = await claude.interrupt(
        threads.cwd(thread),
        session,
        AbortSignal.any([deadline.signal, closing]),
      );
    } catch (error) {
      process.stderr.write(`hub: couldn't interrupt ${thread}'s turn: ${String(error)}\n`);
    } finally {
      clock.clearTimeout(timer);
    }

    if (closing.aborted || threads.current(thread) !== session) {
      return;
    }

    if (how === "interrupted") {
      // WARNING: Claude Code runs no Stop hook for an interrupt.
      await kept((store) => store.turns.handled(session, pressed), undefined);
      await turnEnded(thread, true);

      if (
        (await claude.listing(session))?.state !== "working" &&
        turns.of(thread).is === "background"
      ) {
        await turnEnded(thread);
      }

      return;
    }

    process.stderr.write(`hub: Esc didn't interrupt ${thread}'s turn\n`);
  }

  return { interrupt };
}
