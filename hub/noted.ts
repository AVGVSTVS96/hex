import { z } from "zod";

import type { Store } from "./store.ts";

type Questions = Store["questions"];

type Pins = Store["pins"];

export type LedgerWrite =
  | { write: "returned"; args: Parameters<Questions["returned"]> }
  | { write: "answered"; args: Parameters<Questions["answered"]> }
  | { write: "settled"; args: Parameters<Questions["settled"]> }
  | { write: "reopened"; args: Parameters<Questions["reopened"]> }
  | { write: "reworded"; args: Parameters<Questions["reworded"]> }
  | { write: "pinned"; args: Parameters<Pins["pinned"]> }
  | { write: "repinned"; args: Parameters<Pins["repinned"]> }
  | { write: "unpinned"; args: Parameters<Pins["unpinned"]> }
  | { write: "forgotten"; args: Parameters<Pins["forgotten"]> };

const WRITES = new Set<string>([
  "returned",
  "answered",
  "settled",
  "reopened",
  "reworded",
  "pinned",
  "repinned",
  "unpinned",
  "forgotten",
] satisfies LedgerWrite["write"][]);

const Written = z.object({ write: z.string(), args: z.array(z.unknown()) });

export const AnyLedgerWrite = z.custom<LedgerWrite>((value) => {
  const read = Written.safeParse(value);

  return read.success && WRITES.has(read.data.write);
});

export async function written(store: Store, made: LedgerWrite): Promise<boolean> {
  switch (made.write) {
    case "returned": {
      await store.questions.returned(...made.args);

      return true;
    }

    case "answered": {
      return await store.questions.answered(...made.args);
    }

    case "settled": {
      await store.questions.settled(...made.args);

      return true;
    }

    case "reopened": {
      return await store.questions.reopened(...made.args);
    }

    case "reworded": {
      await store.questions.reworded(...made.args);

      return true;
    }

    case "pinned": {
      await store.pins.pinned(...made.args);

      return true;
    }

    case "repinned": {
      await store.pins.repinned(...made.args);

      return true;
    }

    case "unpinned": {
      await store.pins.unpinned(...made.args);

      return true;
    }

    case "forgotten": {
      await store.pins.forgotten(...made.args);

      return true;
    }
  }
}
