import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

import { z } from "zod";

import { isAuthor, LostError, MovedError, open, RefusedError, UnreachedError } from "./store.ts";
import type { Author, Kept, NewRow as NewRowType, Row, Store, Told } from "./store.ts";

export type Keep = <T>(use: (store: Store) => Promise<T> | T, otherwise: T) => Promise<T>;

const FIRST_LOOK_AGAIN = 1000;
const LONGEST_WAIT = 30_000;

const ignore = (): void => undefined;

const underWay = new Set<Promise<unknown>>();

const losing = new Set<(why: string) => void>();

const moving = new Set<() => void>();

const AnyNewRow = z.object({
  key: z.string(),
  to: z.string(),
  from: z.string(),
  author: z.custom<Author>(isAuthor),
  body: z.string(),
  meta: z.record(z.string(), z.string()).optional(),
  at: z.string().optional(),
});

const NewRow = z.custom<NewRowType>((value) => AnyNewRow.safeParse(value).success);

const PASS = z.object({ session: z.string(), by: z.string(), thread: z.string().optional() });

export type Pass = z.infer<typeof PASS>;

const MessageId = z.union([z.number(), z.string()]);

const AnyTold = z.union([
  z.object({
    answered: z.object({
      message: MessageId,
      label: z.string(),
      via: z.string(),
      again: z.boolean().optional(),
    }),
    always: z.boolean().optional(),
  }),
  z.object({
    reopened: z.object({ message: MessageId, label: z.string().optional() }),
    always: z.boolean().optional(),
  }),
]);

const AnyKept = z.record(
  z.string(),
  z.looseObject({ name: z.string(), session: z.string().optional() }),
);

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A write the hub owes hex's store, as it's kept on disk until the store takes it, so a restart meanwhile loses nothing.
export const OwedWrite = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("deliver"), row: NewRow, by: z.string().optional() }),
  z.object({
    kind: z.literal("told"),
    app: z.string(),
    thread: z.string(),
    change: z.custom<Told>((value) => AnyTold.safeParse(value).success),
    row: NewRow,
  }),
  z.object({ kind: z.literal("take"), key: z.string(), by: z.string(), at: z.string().optional() }),
  z.object({
    kind: z.literal("threads"),
    app: z.string(),
    threads: z.custom<Record<string, Kept>>((value) => AnyKept.safeParse(value).success),
  }),
  z.object({ kind: z.literal("letHeldGo"), thread: z.string() }),
  z.object({ kind: z.literal("pass"), pass: PASS }),
]);

export type Owed = z.infer<typeof OwedWrite>;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Each write once, by what it writes: a message by its key, the threads of an app by the app, so a later one takes an earlier one's place.
function keyOf(owed: Owed) {
  switch (owed.kind) {
    case "deliver":
    case "told": {
      return owed.row.key;
    }

    case "take": {
      return `taken:${owed.key}`;
    }

    case "threads": {
      return `threads:${owed.app}`;
    }

    case "letHeldGo": {
      return `held:${owed.thread}`;
    }

    case "pass": {
      return `pass:${owed.pass.session}:${owed.pass.by}`;
    }
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The time the hub was given what it owes, so it's kept as of then, not as of when the store came back, and the turn's memory pass finds it.
function asOf(owed: Owed, at: string): Owed {
  switch (owed.kind) {
    case "deliver":
    case "told": {
      return { ...owed, row: { ...owed.row, at: owed.row.at ?? at } };
    }

    case "take": {
      return { ...owed, at: owed.at ?? at };
    }

    case "threads":
    case "letHeldGo":
    case "pass": {
      return owed;
    }
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What the store keeps of a message it refused, such as one over its size limit: a note under the message's key, so the message isn't lost without a trace and the app sending it again changes nothing. A change to hex's records the store refused tells nothing (told).
function noteOf(owed: Owed, why: string): Owed | undefined {
  if (owed.kind !== "deliver") {
    return undefined;
  }

  const { row } = owed;

  return {
    kind: "deliver",
    row: {
      ...row,
      body: `[hub] hex's store refused this message, so only this note of it is kept (its session was given it): ${why.slice(0, 400)}`,
      meta: { ...row.meta, refused: "true" },
    },
    ...(owed.by !== undefined && { by: owed.by }),
  };
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A store call a hub started, counted until it's answered (landed).
export function tracked<T>(call: Promise<T>): Promise<T> {
  const forget = () => {
    underWay.delete(call);
  };

  underWay.add(call);
  void call.then(forget, forget);

  return call;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Resolves once every store call the hubs in this process had started has been answered, so what they wrote is the store's before the process says so or exits. Whether there were any.
export async function landed() {
  const answering = [...underWay];
  await Promise.allSettled(answering);

  return answering.length > 0;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Told once a store refuses this process's tenure: another machine holds hex, and the process stops as a hub that lost it.
export function whenLost(listener: (why: string) => void) {
  losing.add(listener);

  return () => {
    losing.delete(listener);
  };
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Told once the hex.db a hub opened has had its records moved to a store across the network, so the process starts again on it.
export function whenMoved(listener: () => void) {
  moving.add(listener);

  return () => {
    moving.delete(listener);
  };
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Whether the error says another machine holds hex, telling whoever waits for that.
export const lost = (error: unknown): error is LostError => {
  if (!(error instanceof LostError)) {
    return false;
  }

  for (const listener of losing) {
    listener(error.message);
  }

  return true;
};

function tellMoved() {
  for (const listener of moving) {
    listener();
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Whether the error says the hex.db the process opened has moved, telling whoever waits for that. open() hands out the store it moved to from then on.
const moved = (error: unknown): error is MovedError => {
  if (!(error instanceof MovedError)) {
    return false;
  }

  tellMoved();

  return true;
};

function rings(store: Store, wait: number) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      unwatch();
      resolve();
    };

    const timer = setTimeout(done, wait);
    const unwatch = store.watch(done);
  });
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What the hub can't start without, from a store that may not answer as it starts: it waits, saying so, instead of exiting as a hub that can't start, which bin/hex would take for a bad commit, and looks again once the store's bell rings, as it does when it reconnects, or after a wait. One whose store says another machine holds hex never starts.
export async function answered<T>(
  storeDir: string,
  what: string,
  use: (store: Store) => Promise<T>,
): Promise<T> {
  for (let wait = FIRST_LOOK_AGAIN; ; wait = Math.min(wait * 2, LONGEST_WAIT)) {
    try {
      const value = await use(open(storeDir));

      if (wait > FIRST_LOOK_AGAIN) {
        process.stderr.write(`hub: hex's store answers again, so ${what}\n`);
      }

      return value;
    } catch (error) {
      if (lost(error)) {
        return await new Promise<never>(ignore);
      }

      if (moved(error)) {
        continue;
      }

      if (!(error instanceof UnreachedError)) {
        throw error;
      }

      if (wait === FIRST_LOOK_AGAIN) {
        process.stderr.write(
          `hub: hex's store doesn't answer, so the hub waits for it before ${what}: ${String(error)}\n`,
        );
      }

      await rings(open(storeDir), wait);
    }
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The store while it opens and writes. What the hub must keep (must) and the store couldn't take is owed: kept on disk (spool), made again by its key, in the order it was first made and before anything after it, once the store answers, and until then nothing the hub was given is safe (synced); meanwhile the hub goes on from memory, so an outage never leaves hex deaf. What the store refuses outright is dropped, a message keeping a note in its place. A hex.db that moved is followed to where it went (open), and a store that says another machine holds hex stops the hub (lost).
export function keeping(
  storeDir: string,
  {
    spool,
    letGo,
    queue,
  }: {
    spool: string;
    letGo: (thread: string, rows: Row[]) => void;
    queue: (pass: Pass) => Promise<void>;
  },
) {
  const owed = new Map<string, Owed>();
  let home = open(storeDir);

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // open() hands out the store across the network once a move has written store.json, so the hub follows it from its next call, and restarts to listen there.
  function current() {
    const now = open(storeDir);

    if (now !== home) {
      home = now;
      process.stderr.write(
        `hub: hex's records moved from ${storeDir}/hex.db to the store state/store.json names, so the hub goes on there and restarts on it\n`,
      );
      tellMoved();
    }

    return now;
  }

  let refusal: LostError | undefined;
  let paying: Promise<void> | undefined;

  if (existsSync(spool)) {
    try {
      for (const each of z.array(z.unknown()).parse(JSON.parse(readFileSync(spool, "utf-8")))) {
        const parsed = OwedWrite.safeParse(each);

        if (parsed.success) {
          owed.set(keyOf(parsed.data), parsed.data);
        } else {
          process.stderr.write(
            `hub: dropped a write owed to hex's store it can't read: ${JSON.stringify(each)}\n`,
          );
        }
      }
    } catch (error) {
      process.stderr.write(
        `hub: couldn't read what it owes hex's store (${spool}): ${String(error)}\n`,
      );
    }
  }

  function saveOwed() {
    if (owed.size === 0) {
      rmSync(spool, { force: true });

      return;
    }

    writeFileSync(`${spool}.next`, JSON.stringify([...owed.values()]));
    renameSync(`${spool}.next`, spool);
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- whatever a store call threw
  const failed = (error: unknown): "lost" | "unreached" | "refused" => {
    if (lost(error)) {
      refusal ??= error;

      return "lost";
    }

    if (moved(error)) {
      return "unreached";
    }

    if (error instanceof UnreachedError) {
      process.stderr.write(
        `hub: hex's store can't take anything now, so the hub goes on from memory and keeps it once it can: ${String(error)}\n`,
      );

      return "unreached";
    }

    process.stderr.write(
      `hub: hex's store refused a call, which won't ever land: ${error instanceof RefusedError ? error.message : String(error)}\n`,
    );

    return "refused";
  };

  async function made(write: Owed): Promise<boolean> {
    const store = current();

    switch (write.kind) {
      case "deliver": {
        return await store.messages.deliver(write.row, write.by);
      }

      case "told": {
        return await store.questions.told(write.app, write.thread, write.change, write.row);
      }

      case "take": {
        return await store.messages.take(write.key, write.by, write.at);
      }

      case "threads": {
        await store.threads.keep(write.app, write.threads);

        return true;
      }

      case "letHeldGo": {
        letGo(write.thread, await store.messages.letHeldGo(write.thread));

        return true;
      }

      case "pass": {
        await queue(write.pass);

        return true;
      }
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A write the store refused once is refused again, so a message keeps a note in its place, and anything else is dropped. Whether the store answered: what it couldn't take is owed.
  async function attempt(
    write: Owed,
    noted = false,
  ): Promise<{ answered: boolean; value?: boolean }> {
    try {
      return { answered: true, value: await made(write) };
    } catch (error) {
      const how = failed(error);

      if (how === "unreached") {
        return { answered: false };
      }

      const note = how === "refused" && !noted ? noteOf(write, String(error)) : undefined;

      return note ? await attempt(note, true) : { answered: true };
    }
  }

  function owe(write: Owed) {
    if (refusal === undefined) {
      owed.set(keyOf(write), write);
      saveOwed();
    }
  }

  async function payInTurn() {
    for (const [key, write] of owed) {
      if (!(await attempt(write)).answered) {
        return;
      }

      owed.delete(key);
      saveOwed();
    }
  }

  function pay(): Promise<void> {
    if (paying === undefined && owed.size > 0) {
      const turn = tracked(payInTurn());
      paying = turn;
      void turn.finally(() => {
        paying = undefined;
      });
    }

    return paying ?? Promise.resolve();
  }

  const kept: Keep = (use, otherwise) =>
    tracked(
      (async () => {
        try {
          return await use(current());
        } catch (error) {
          failed(error);

          return otherwise;
        }
      })(),
    );

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // What the store answered, or otherwise when it didn't (owed) or refused it.
  function must<T>(write: Owed, otherwise: T): Promise<boolean | T> {
    const given = asOf(write, new Date().toISOString());

    return tracked(
      (async () => {
        await pay();

        if (owed.size > 0) {
          owe(given);

          return otherwise;
        }

        const { answered: took, value } = await attempt(given);

        if (!took) {
          owe(given);
        }

        return value ?? otherwise;
      })(),
    );
  }

  async function synced() {
    await pay();

    if (refusal !== undefined) {
      throw refusal;
    }

    if (owed.size > 0) {
      throw new UnreachedError(
        `${owed.size} of hex's records the hub holds wait for hex's store to take them`,
      );
    }

    try {
      await tracked(current().synced());
    } catch (error) {
      if (failed(error) !== "refused") {
        throw error;
      }
    }
  }

  return {
    kept,
    must,
    owe: (write: Owed) => {
      owe(asOf(write, new Date().toISOString()));
      void pay();
    },
    pay,
    synced,
    lost: () => refusal !== undefined,
  };
}

export type Owing = ReturnType<typeof keeping>;
