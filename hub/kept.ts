import { join } from "node:path";

import { LostError, UnreachedError } from "./store.ts";
import type { Store } from "./store.ts";

export type Keep = <T>(use: (store: Store) => Promise<T> | T, otherwise: T) => Promise<T>;

export type Write<T = unknown> = (store: Store) => Promise<T>;

const underWay = new Set<Promise<unknown>>();

const losing = new Set<(why: string) => void>();

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A store call a hub started, counted until it's answered (landed).
export function tracked<T>(call: Promise<T>): Promise<T> {
  const answered = () => {
    underWay.delete(call);
  };

  underWay.add(call);
  void call.then(answered, answered);

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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The store while it opens and writes. Without it the hub goes on from memory, as it did before it had one, so a failing disk never leaves hex deaf. What the hub must keep (must) and a home across the network didn't answer is owed: made again by its key, in the order it was first made and before anything after it, once that home answers, and until then nothing the hub was given is safe (synced).
export function keeping(db: Store, storeDir: string) {
  const owed = new Map<string, Write>();
  let refusal: LostError | undefined;
  let paying: Promise<void> | undefined;

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- whatever a store call threw
  const failed = (error: unknown) => {
    if (lost(error)) {
      refusal ??= error;

      return;
    }

    process.stderr.write(
      error instanceof UnreachedError
        ? `hub: hex's store didn't answer, so the hub goes on from memory: ${String(error)}\n`
        : `hub: ${join(storeDir, "hex.db")} failed, so the hub goes on from memory: ${String(error)}\n`,
    );
  };

  const kept: Keep = (use, otherwise) =>
    tracked(
      (async () => {
        try {
          return await use(db);
        } catch (error) {
          failed(error);

          return otherwise;
        }
      })(),
    );

  function owe(key: string, write: Write) {
    if (refusal === undefined) {
      owed.set(key, write);
    }
  }

  async function payInTurn() {
    for (const [key, write] of owed) {
      try {
        await write(db);
      } catch (error) {
        if (error instanceof UnreachedError) {
          return;
        }

        failed(error);
      }

      owed.delete(key);
    }
  }

  function pay(): Promise<void> {
    if (paying === undefined) {
      const made = tracked(payInTurn());
      paying = made;
      void made.finally(() => {
        paying = undefined;
      });
    }

    return paying;
  }

  function must<T>(key: string, write: Write<T>, otherwise: T): Promise<T> {
    return tracked(
      (async () => {
        if (owed.size > 0) {
          await pay();
        }

        if (owed.size > 0) {
          owe(key, write);

          return otherwise;
        }

        try {
          return await write(db);
        } catch (error) {
          failed(error);

          if (error instanceof UnreachedError) {
            owe(key, write);
          }

          return otherwise;
        }
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
        `${owed.size} of hex's records the hub holds in memory wait for hex's store to answer`,
      );
    }

    try {
      await tracked(db.synced());
    } catch (error) {
      if (error instanceof UnreachedError) {
        throw error;
      }

      failed(error);

      if (error instanceof LostError) {
        throw error;
      }
    }
  }

  return {
    kept,
    must,
    owe: (key: string, write: Write) => {
      owe(key, write);
      void pay();
    },
    pay,
    synced,
    lost: () => refusal !== undefined,
  };
}
