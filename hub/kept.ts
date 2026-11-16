import { join } from "node:path";

import type { Store } from "./store.ts";

export type Keep = <T>(use: (store: Store) => T, otherwise: T) => T;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The store while it opens and writes; without it the hub goes on from memory, as it did before it had one, so a failing disk never leaves hex deaf.
export function keeping(db: Store, storeDir: string): Keep {
  return (use, otherwise) => {
    try {
      return use(db);
    } catch (error) {
      process.stderr.write(
        `hub: ${join(storeDir, "hex.db")} failed, so the hub goes on from memory: ${String(error)}\n`,
      );

      return otherwise;
    }
  };
}
