import { expect, test } from "bun:test";

import type { Update } from "grammy/types";
import { z } from "zod";

import { confirmingWhatsKept } from "./confirmed.ts";

const Updates = z.object({ result: z.array(z.object({ update_id: z.number() })) });

test("Telegram is told updates arrived only once hex's store has them, and meanwhile the hub is given only those it hasn't had", async () => {
  let kept = true;
  let confirmedBelow = 0;
  const telegram: Update[] = [{ update_id: 1 }, { update_id: 2 }, { update_id: 3 }];
  const asked: (number | undefined)[] = [];

  const transform = confirmingWhatsKept(async () => {
    await Promise.resolve();

    if (!kept) {
      throw new Error("hex's store didn't answer");
    }
  }, 0);

  const getUpdates = async (offset: number) => {
    // SAFETY: the fake answers getUpdates as Telegram does, with the updates it still holds from the offset asked.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- grammY's transformer is generic over every method at once
    const previous = (async (_method: string, payload: { offset: number }) => {
      await Promise.resolve();
      asked.push(payload.offset);
      confirmedBelow = Math.max(confirmedBelow, payload.offset);

      return { ok: true, result: telegram.filter(({ update_id }) => update_id >= confirmedBelow) };
    }) as never;

    return Updates.parse(await transform(previous, "getUpdates", { offset })).result.map(
      ({ update_id }) => update_id,
    );
  };

  expect(await getUpdates(1)).toEqual([1, 2, 3]);

  kept = false;
  telegram.push({ update_id: 4 });
  expect(await getUpdates(4)).toEqual([4]);
  expect(await getUpdates(5)).toEqual([]);
  expect(confirmedBelow).toBe(1);

  kept = true;
  expect(await getUpdates(5)).toEqual([]);
  expect(asked).toEqual([1, 1, 1, 5]);
  expect(confirmedBelow).toBe(5);
});
