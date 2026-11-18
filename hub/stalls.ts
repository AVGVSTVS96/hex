import type { Failed } from "./failing.ts";
import type { ThreadInbox } from "./inbox.ts";
import type { Runs } from "./runs.ts";
import type { Threads } from "./threads.ts";
import type { SessionTurns } from "./turns.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Claude Code's StopFailure errors that clear on their own, or once an account has room or the login works again; a refused connection reaches the hook as server_error.
const PASSING_API_ERRORS = new Set([
  "rate_limit",
  "overloaded",
  "server_error",
  "billing_error",
  "authentication_failed",
]);

type Stall = {
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Its last turn failed on the API, until a turn begins or goes through. waiting: the error clears without a word to this thread (a rate limit, a dropped connection, a login that works again), so it carries on at the next turn anywhere that goes through; resumed: the hub had it carry on, once; told: its chat heard it waits for its next message.
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A turn the API refused ends with what set it off unanswered and nothing to start it again, and the session can't say why when its requests don't go through. So the thread's chat hears the API's error from the hub, and whether it carries on: one that clears does, once, at the next turn anywhere that goes through (resume), and the chat hears again only when that changes.
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // One thread for each turn that goes through, so the threads an outage stalled don't all hit the API in the same moment.
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

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A turn that begins or ends without failing is past its stall, but for the turn the hub had it carry on with, which stays resumed as it begins: if that one fails too, its chat hears it.
  function passed(thread: string, busy: boolean) {
    const stalled = stallOf(thread);

    if (!busy || stalled.is !== "resumed") {
      stalled.is = undefined;
    }
  }

  return { stall, passed, resume };
}
