import { join } from "node:path";

import type { Store } from "./store.ts";

export type Keep = <T>(use: (store: Store) => Promise<T> | T, otherwise: T) => Promise<T>;

const underWay = new Set<Promise<unknown>>();

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Resolves once every store call the hubs in this process had started has been answered, so what they wrote is the store's before the process says so or exits.
export async function landed() {
  await Promise.allSettled(underWay);
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The store while it opens and writes; without it the hub goes on from memory, as it did before it had one, so a failing disk never leaves hex deaf.
export function keeping(db: Store, storeDir: string): Keep {
  return (use, otherwise) => {
    const call = (async () => {
      try {
        return await use(db);
      } catch (error) {
        process.stderr.write(
          `hub: ${join(storeDir, "hex.db")} failed, so the hub goes on from memory: ${String(error)}\n`,
        );

        return otherwise;
      }
    })();

    underWay.add(call);
    void call.finally(() => {
      underWay.delete(call);
    });

    return call;
  };
}
