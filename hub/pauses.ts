import { Effect } from "effect";

import * as claude from "./claude.ts";
import type { Failed } from "./failing.ts";
import type { Owing, Paused } from "./kept.ts";
import type { Line } from "./mcp.ts";
import { ordered } from "./ordered.ts";
import { present } from "./present.ts";
import type { Runs } from "./runs.ts";
import type { Store } from "./store.ts";
import type { Threads } from "./threads.ts";
import type { SessionTurns } from "./turns.ts";
import type { MessagesWaiting } from "./waiting.ts";

type Pause = {
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Claude Code paused the session on a choice for someone at its terminal, so it takes no message until it starts over.
  paused?: boolean | undefined;
};

export type SessionPauses = ReturnType<typeof sessionPauses>;

// Claude Code can pause a session mid-turn on a choice for someone at its terminal, like a reply its model's safeguards stopped or a permission prompt, and no hook says so: its job record says it needs something and Claude lists it as waiting. The turn ends in hex's record, so what went unanswered isn't given to another session to pause on again, and the chat hears why. No shell command answers the dialog (https://code.claude.com/docs/en/agent-view#manage-sessions-from-the-shell), and its choices are a terminal's: another model, which the owner's settings can rule out, or editing the prompt in the terminal. So the session keeps running, with any agents it started, until the thread's next message starts it again, past a refused turn when the safeguards stopped it (rewound).
export function sessionPauses({
  runs,
  threads,
  waiting,
  turns,
  must,
  serving,
  turnEnded,
  failed,
}: {
  runs: Runs;
  threads: Threads;
  waiting: MessagesWaiting;
  turns: SessionTurns;
  must: Owing["must"];
  serving: () => boolean;
  turnEnded: (thread: string) => Promise<void>;
  failed: Failed;
}) {
  const pauses = runs.part((): Pause => ({}));

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Whether the paused session's turn left something unanswered, ending it in hex's record if so: one check at a time for each session, so the next reads what the one before it ended.
  const ending = ordered();

  const leftUnanswered = (session: string, store: Store) =>
    ending(session, async () => {
      if ((await store.turns.unanswered(session)).length === 0) {
        return false;
      }

      await store.turns.handled(session);

      return true;
    });

  function of(thread: string): Readonly<Pause> {
    return pauses.of(thread);
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Runs as work of the live session the job record spoke of, so one that ended while Claude answered isn't acted on.
  const check = Effect.fn("check")(function* check(
    thread: string,
    line: Line,
    needs: string | undefined,
  ) {
    const pause = pauses.of(thread);
    const session = threads.current(thread);

    const running =
      present(needs) && present(session)
        ? yield* Effect.promise(() => claude.agent(session, serving))
        : undefined;

    const was = pause.paused;
    pause.paused = running?.status === "waiting";

    if (was === true && !pause.paused) {
      for (const message of waiting.drain(thread)) {
        turns.handIn(thread, line, message);
      }
    }

    if (pause.paused && present(session)) {
      yield* Effect.promise(() => tell(thread, session, needs));
    }
  });

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // What a paused session's turn left unanswered is told to its chat, once: by the check that finds it paused, or by a stop that reaches it first (stopped), since a stop takes what the session took as handled. It's a read of the store and a write to it, so the hub owes it to a store that doesn't answer, and tells once it does (told).
  async function tell(thread: string, session: string, needs: string | undefined) {
    await must({ kind: "paused", thread, session, ...(present(needs) && { needs }) }, undefined);
  }

  async function told({ thread, session, needs }: Paused, store: Store) {
    if (!(await leftUnanswered(session, store))) {
      return;
    }

    process.stderr.write(
      `hub: ${thread}'s session paused mid-turn: ${needs ?? "Claude lists it as waiting"}\n`,
    );
    void turnEnded(thread);
    const refusal = claude.refused(claude.transcript(threads.cwd(thread), session));
    const { model } = threads.of(thread);

    failed(
      thread,
      refusal
        ? `the model's safety filter flagged your message${present(refusal.category) ? ` as ${refusal.category}` : ""}, so it got no answer. Your next message starts this topic again from just before it, still on ${model ?? "the same model"}, with the flagged message left out: send what you need in other words.`
        : `its session stopped on a question only its terminal can answer${present(needs) ? ` ("${needs}")` : ""}, so your message got no answer. Your next message starts it again.`,
      true,
    );
  }

  async function stopped(thread: string, running: claude.Agent) {
    if (running.status === "waiting") {
      await tell(thread, running.sessionId, claude.needs(running));
    }
  }

  function connected(thread: string) {
    pauses.of(thread).paused = undefined;
  }

  return { of, check, stopped, told, connected };
}
