import type { Failed } from "./failing.ts";
import type { ThreadInbox } from "./inbox.ts";
import type { Runs } from "./runs.ts";
import type { Threads } from "./threads.ts";
import type { SessionTurns } from "./turns.ts";

// WARNING: Claude Code reports a refused connection to the StopFailure hook as server_error.
const PASSING_API_ERRORS = new Set([
  "rate_limit",
  "overloaded",
  "server_error",
  "billing_error",
  "authentication_failed",
]);

type Stall = {
  is?: "waiting" | "resumed" | "told" | undefined;
};

export type StalledTurns = ReturnType<typeof stalledTurns>;

export function stalledTurns({
  runs,
  threads,
  turns,
  inbox,
  failed,
}: {
  runs: Runs;
  threads: Threads;
  turns: SessionTurns;
  inbox: ThreadInbox;
  failed: Failed;
}) {
  const stalls = runs.part((): Stall => ({}));
  const stallOf = stalls.of;

  function stall(thread: string, error = "unknown", said?: string) {
    const stalled = stallOf(thread);
    const was = stalled.is;
    stalled.is = PASSING_API_ERRORS.has(error) && was !== "resumed" ? "waiting" : "told";
    process.stderr.write(`hub: ${thread}'s turn failed on the API (${error})\n`);

    if (was === stalled.is) {
      return;
    }

    const why = (said !== undefined && said !== "" ? said : error).slice(0, 400);

    const next =
      stalled.is === "waiting"
        ? "It carries on once turns go through again."
        : "Its next message starts it again.";

    failed(thread, `${why}\n${next}`, true);
  }

  function resume() {
    for (const [thread, stalled] of stalls.all()) {
      if (stalled.is !== "waiting" || turns.of(thread).is === "busy") {
        continue;
      }

      stalled.is = "resumed";
      void inbox.deliver(thread, threads.get(thread)?.name ?? thread, {
        content:
          "[hub] Your last turn here failed on the API, and turns go through again now: carry on with it.",
        author: "prompt",
        meta: { user: "hub" },
      });

      return;
    }
  }

  function passed(thread: string, busy: boolean) {
    const stalled = stallOf(thread);

    if (!busy || stalled.is !== "resumed") {
      stalled.is = undefined;
    }
  }

  return { stall, passed, resume };
}
