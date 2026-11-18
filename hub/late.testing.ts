import { mock } from "bun:test";

import * as real from "./store.ts";
import type { Store } from "./store.ts";
import { answering, client } from "./store/wire.ts";

const LATE_MS = 2;

const ignore = (): void => undefined;

// WARNING: Bun's mock.module replaces the exports of a module already loaded, so the real ones are copied first.
const { file } = real;
const exports = { ...real };
const lateStores = new Map<string, Store>();

function late(dir: string): Store {
  const kept = lateStores.get(dir);

  if (kept) {
    return kept;
  }

  const home = file(dir);
  const { store } = home;
  const answer = answering(home);
  let last: Promise<unknown> = Promise.resolve();

  const inTurn = <T>(call: () => T | Promise<T>): Promise<T> => {
    const answered = last.then(async () => {
      await Bun.sleep(LATE_MS);
      const value = await call();
      await Bun.sleep(LATE_MS);

      return value;
    });

    last = answered.catch(ignore);

    return answered;
  };

  const made: Store = {
    ...store,
    ...client(async (call) => await inTurn(() => JSON.stringify(answer(call)))),
    synced: async () => {
      await last;
      await store.synced();
    },
    read: async (text, ...bound) => await inTurn(() => store.read(text, ...bound)),
    copy: async (to) => {
      await inTurn(() => store.copy(to));
    },
  };

  lateStores.set(dir, made);

  return made;
}

await mock.module("./store.ts", () => ({ ...exports, open: late }));
