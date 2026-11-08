import { clock } from "./clock.ts";
import { clip } from "./fit.ts";
import { open } from "./store.ts";
import type { Held, Hold, Store } from "./store.ts";

const FREED_THREADS_WOKEN_AT_ONCE = 2;
const PATIENCE_FOR_A_WOKEN_TURN_TO_END = 15 * 60_000;

export function instant(text: string, zone = Temporal.Now.timeZoneId()): string {
  const iso = text.trim().replace(" ", "T");

  try {
    return Temporal.Instant.from(iso).toString({ smallestUnit: "millisecond" });
  } catch {
    return onOwnersClock(text, iso, zone);
  }
}

function onOwnersClock(text: string, iso: string, zone: string): string {
  try {
    return Temporal.PlainDateTime.from(iso)
      .toZonedDateTime(zone)
      .toInstant()
      .toString({ smallestUnit: "millisecond" });
  } catch {
    throw new Error(`"${text}" isn't a time: write it as YYYY-MM-DD HH:MM on your clock`);
  }
}

export function when(at: string, zone?: string) {
  return new Date(at).toLocaleString("en-US", {
    timeZone: zone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function place(
  store: Store,
  hold: Parameters<Store["hold"]>[0],
  { zone, working }: { zone?: string; working: Set<string> },
): Hold {
  return store.write(() => {
    const placed = store.hold(hold);
    const by = store.names()[placed.by] ?? placed.by;
    const ends = `${placed.until !== undefined && placed.until !== "" ? `at ${when(placed.until, zone)}, or ` : ""}when my word lifts it`;

    for (const { thread } of placed.threads.filter((held) => working.has(held.thread))) {
      store.deliver({
        key: `hold:${placed.id}@${thread}`,
        to: thread,
        from: "hold",
        author: "prompt",
        body: `[hold ${placed.id}] ${by} put this thread on hold: ${placed.why}. Finish the step you're on, commit it, and start nothing new until the hold ends; hex wakes this thread when it does, ${ends}.`,
        meta: { user: "hold" },
      });
    }

    return placed;
  });
}

export function wake(store: Store, at = new Date(clock.now()).toISOString()): string | undefined {
  return store.write(() => {
    const waking = store.waking(PATIENCE_FOR_A_WOKEN_TURN_TO_END, at);
    let room = FREED_THREADS_WOKEN_AT_ONCE - waking.count;
    const woken = new Set<string>();

    for (const { id, thread, why, ending } of store.freed()) {
      if (woken.has(thread)) {
        continue;
      }

      if (room-- <= 0) {
        break;
      }

      woken.add(thread);

      const key = `hold:${id}@${thread}:ended`;
      store.deliver({
        key,
        to: thread,
        from: "hold",
        author: "prompt",
        body: `[hold ${id} ended] ${ending}. The hold on this thread (${why}) is over: pick up where you stopped.`,
        meta: { user: "hold" },
      });
      store.woke(thread, key);
    }

    return woken.size > 0
      ? new Date(Date.parse(at) + PATIENCE_FOR_A_WOKEN_TURN_TO_END).toISOString()
      : waking.until;
  });
}

export function holding(storeDir: string): () => void {
  let store: Store;

  try {
    store = open(storeDir);
  } catch (error) {
    process.stderr.write(`hub: holds can't move on until hex.db opens: ${String(error)}\n`);

    // oxlint-disable-next-line eslint/no-empty-function -- nothing started, so there is nothing to stop
    return () => {};
  }

  let timer: ReturnType<typeof clock.setTimeout> | undefined;

  const step = () => {
    let next = Infinity;

    try {
      const at = new Date(clock.now()).toISOString();
      store.due(at);
      const patience = wake(store, at);

      next = Math.min(
        patience !== undefined && patience !== "" ? Date.parse(patience) : Infinity,
        ...store
          .holds()
          .flatMap((hold) =>
            hold.until !== undefined && hold.until !== "" ? [Date.parse(hold.until)] : [],
          ),
      );
    } catch (error) {
      process.stderr.write(`hub: holds couldn't move on: ${String(error)}\n`);
      next = clock.now() + 60_000;
    } finally {
      clock.clearTimeout(timer);

      if (next < Infinity) {
        timer = clock.setTimeout(step, Math.min(2 ** 31 - 1, Math.max(0, next - clock.now())));
      }
    }
  };

  const unwatch = store.watch(step);

  step();

  return () => {
    unwatch();
    clock.clearTimeout(timer);
  };
}

function ended(held: Held) {
  return held.ended !== undefined && held.ended !== "";
}

export function line(hold: Hold, store: Store, zone?: string): string {
  const names = store.names();
  const name = (thread: string) => names[thread] ?? thread;
  const stillHeld = hold.threads.filter((held) => !ended(held)).map((held) => name(held.thread));
  const freed = hold.threads.filter((held) => ended(held)).map((held) => name(held.thread));

  const said =
    hold.message !== undefined && hold.message !== "" ? store.message(hold.message) : null;

  return [
    stillHeld.length > 0
      ? `- ${hold.id} holds ${stillHeld.join(", ")}`
      : `- ${hold.id} held ${freed.join(", ")}, all freed now`,
    stillHeld.length > 0 && freed.length > 0 && `freed ${freed.join(", ")}`,
    `by ${name(hold.by)}, ${when(hold.at, zone)}`,
    hold.until !== undefined && hold.until !== ""
      ? `until ${when(hold.until, zone)} or my word`
      : "until my word",
    `why: ${clip(hold.why, 200)}`,
    said !== null && `my words [${hold.message}]: "${clip(said.body, 160)}"`,
  ]
    .filter((part) => part !== false)
    .join(" · ");
}
