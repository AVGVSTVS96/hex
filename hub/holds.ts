import { clock } from "./clock.ts";
import { clip } from "./fit.ts";
import { open, type Hold, type Store } from "./store.ts";

// Threads a hold frees wake this many at a time, the next once a woken one's turn ends, or once it
// has waited PATIENCE for one that never does, so a hold over a dozen threads doesn't end in a dozen
// sessions starting work together.
const AT_ONCE = 2;
const PATIENCE = 15 * 60_000;

// A time as the owner writes it: an instant with its offset, or else "YYYY-MM-DD HH:MM" on their clock.
export function instant(text: string, zone = Temporal.Now.timeZoneId()): string {
  const iso = text.trim().replace(" ", "T");
  try {
    return Temporal.Instant.from(iso).toString({ smallestUnit: "millisecond" });
  } catch {}
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

// Puts the threads on hold, and tells each one that's at work now (working: their keys) to stop
// starting more. One at rest isn't woken just to hear it: its next prompt shows the hold.
export function place(
  store: Store,
  hold: Parameters<Store["hold"]>[0],
  { zone, working }: { zone?: string; working: Set<string> },
): Hold {
  return store.write(() => {
    const placed = store.hold(hold);
    const by = store.names()[placed.by] ?? placed.by;
    const ends = `${placed.until ? `at ${when(placed.until, zone)}, or ` : ""}when my word lifts it`;
    for (const { thread } of placed.threads.filter(({ thread }) => working.has(thread)))
      store.deliver({
        key: `hold:${placed.id}@${thread}`,
        to: thread,
        from: "hold",
        author: "prompt",
        body: `[hold ${placed.id}] ${by} put this thread on hold: ${placed.why}. Finish the step you're on, commit it, and start nothing new until the hold ends; hex wakes this thread when it does, ${ends}.`,
        meta: { user: "hold" },
      });
    return placed;
  });
}

// Wakes the threads holds have freed, as many as there's room for; returns when the oldest wake
// still counted runs out of patience.
export function wake(store: Store, at = new Date(clock.now()).toISOString()): string | undefined {
  return store.write(() => {
    const waking = store.waking(PATIENCE, at);
    let room = AT_ONCE - waking.count;
    const woken = new Set<string>();
    for (const { id, thread, why, ending } of store.freed()) {
      if (woken.has(thread)) continue;
      if (room-- <= 0) break;
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
    return woken.size ? new Date(Date.parse(at) + PATIENCE).toISOString() : waking.until;
  });
}

// The hub's part, in the hex that runs General: each hold ends as its time comes, and at every
// change to hex.db the threads freed so far wake as room allows. A timer waits for the next hold's
// time, or a wake's patience, whichever comes first.
export function holding(storeDir: string): () => void {
  let store: Store;
  try {
    store = open(storeDir);
  } catch (error) {
    process.stderr.write(`hub: holds can't move on until hex.db opens: ${error}\n`);
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
        patience ? Date.parse(patience) : Infinity,
        ...store.holds().flatMap((hold) => (hold.until ? [Date.parse(hold.until)] : [])),
      );
    } catch (error) {
      process.stderr.write(`hub: holds couldn't move on: ${error}\n`);
      next = clock.now() + 60_000;
    } finally {
      clock.clearTimeout(timer);
      if (next < Infinity)
        timer = clock.setTimeout(step, Math.min(2 ** 31 - 1, Math.max(0, next - clock.now())));
    }
  };
  const unwatch = store.watch(step);
  step();
  return () => {
    unwatch();
    clock.clearTimeout(timer);
  };
}

// A hold as every session's prompt shows it: the threads it still holds, those it freed, who held
// them and when, when it ends by itself, why, and the owner's words it came from.
export function line(hold: Hold, store: Store, zone?: string): string {
  const names = store.names();
  const name = (thread: string) => names[thread] ?? thread;
  const holding = hold.threads.filter((held) => !held.ended).map((held) => name(held.thread));
  const freed = hold.threads.filter((held) => held.ended).map((held) => name(held.thread));
  const said = hold.message && store.message(hold.message);
  return [
    holding.length
      ? `- ${hold.id} holds ${holding.join(", ")}`
      : `- ${hold.id} held ${freed.join(", ")}, all freed now`,
    holding.length && freed.length && `freed ${freed.join(", ")}`,
    `by ${name(hold.by)}, ${when(hold.at, zone)}`,
    hold.until ? `until ${when(hold.until, zone)} or my word` : "until my word",
    `why: ${clip(hold.why, 200)}`,
    said && `my words [${hold.message}]: "${clip(said.body, 160)}"`,
  ]
    .filter(Boolean)
    .join(" · ");
}
