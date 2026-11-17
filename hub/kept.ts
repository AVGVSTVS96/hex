import { join } from "node:path";

import type { Store } from "./store.ts";

export type Keep = {
  <T>(use: (store: Store) => T, otherwise: NoInfer<T extends PromiseLike<unknown> ? never : T>): T;
  later: <T>(use: (store: Store) => Promise<T>, otherwise: NoInfer<T>) => Promise<T>;
};

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The store while it opens and writes; without it the hub goes on from memory, as it did before it had one, so a failing disk never leaves hex deaf. later: for a write, which may wait its turn.
export function keeping(db: Store, storeDir: string): Keep {
  const failed = (why: string) => {
    process.stderr.write(
      `hub: ${join(storeDir, "hex.db")} failed, so the hub goes on from memory: ${why}\n`,
    );
  };

  const kept = <T>(use: (store: Store) => T, otherwise: T): T => {
    try {
      return use(db);
    } catch (error) {
      failed(String(error));

      return otherwise;
    }
  };

  return Object.assign(kept, {
    later: async <T>(use: (store: Store) => Promise<T>, otherwise: T): Promise<T> => {
      try {
        return await use(db);
      } catch (error) {
        failed(String(error));

        return otherwise;
      }
    },
  });
}
