import { clock } from "./clock.ts";
import { clip } from "./fit.ts";
import { open, when } from "./store.ts";
import type { Held, Hold, NewHold, Store } from "./store.ts";

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

export function place(
  store: Store,
  hold: NewHold,
  { zone, working }: { zone?: string; working: Set<string> },
): Promise<Hold> {
  return store.holds.place(hold, { zone, working: [...working] });
}

export function wake(
  store: Store,
  at = new Date(clock.now()).toISOString(),
): Promise<string | undefined> {
  return store.holds.wake(at, {
    patience: PATIENCE_FOR_A_WOKEN_TURN_TO_END,
    atOnce: FREED_THREADS_WOKEN_AT_ONCE,
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
  let moving = false;
  let again = false;
  let stopped = false;

  const move = async () => {
    let next = Infinity;

    try {
      const at = new Date(clock.now()).toISOString();
      await store.holds.due(at);
      const patience = await wake(store, at);

      next = Math.min(
        patience !== undefined && patience !== "" ? Date.parse(patience) : Infinity,
        ...(await store.holds.list()).flatMap((hold) =>
          hold.until !== undefined && hold.until !== "" ? [Date.parse(hold.until)] : [],
        ),
      );
    } catch (error) {
      process.stderr.write(`hub: holds couldn't move on: ${String(error)}\n`);
      next = clock.now() + 60_000;
    } finally {
      clock.clearTimeout(timer);

      if (next < Infinity && !stopped) {
        timer = clock.setTimeout(step, Math.min(2 ** 31 - 1, Math.max(0, next - clock.now())));
      }
    }
  };

  const moveOnceAtATime = async () => {
    if (stopped) {
      return;
    }

    if (moving) {
      again = true;

      return;
    }

    moving = true;

    do {
      again = false;
      await move();
    } while (again);

    moving = false;
  };

  const step = () => {
    void moveOnceAtATime();
  };

  const unwatch = store.watch(step);

  step();

  return () => {
    stopped = true;
    again = false;
    unwatch();
    clock.clearTimeout(timer);
  };
}

function ended(held: Held) {
  return held.ended !== undefined && held.ended !== "";
}

export async function line(hold: Hold, store: Store, zone?: string): Promise<string> {
  const names = await store.threads.names();
  const name = (thread: string) => names[thread] ?? thread;
  const stillHeld = hold.threads.filter((held) => !ended(held)).map((held) => name(held.thread));
  const freed = hold.threads.filter((held) => ended(held)).map((held) => name(held.thread));

  const said =
    hold.message !== undefined && hold.message !== ""
      ? await store.messages.get(hold.message)
      : null;

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
