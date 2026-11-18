import { expect, spyOn, test } from "bun:test";

import type { Update } from "grammy/types";
import { z } from "zod";

import { confirmingWhatsKept } from "./confirmed.ts";

const Updates = z.object({ result: z.array(z.object({ update_id: z.number() })) });

test("Telegram is told updates arrived only once hex's store has them, and meanwhile the hub is given only those it hasn't had", async () => {
  let kept = true;
  let confirmedBelow = 0;
  const telegram: Update[] = [{ update_id: 1 }, { update_id: 2 }, { update_id: 3 }];
  const asked: (number | undefined)[] = [];

  const transform = confirmingWhatsKept(
    async () => {
      await Promise.resolve();

      if (!kept) {
        throw new Error("hex's store didn't answer");
      }
    },
    { lookAgainMs: 0 },
  );

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

const ignore = (): undefined => undefined;

test("a deaf hub's last getUpdates goes at once while hex's store is still busy, confirming only what the store already had", async () => {
  let deaf = false;
  let busy = false;
  const asked: (number | undefined)[] = [];

  const transform = confirmingWhatsKept(
    async () => {
      if (busy) {
        await new Promise<never>(ignore);
      }
    },
    { deaf: () => deaf, lookAgainMs: 0 },
  );

  // SAFETY: the fake answers getUpdates as Telegram does when it holds no updates.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- grammY's transformer is generic over every method at once
  const previous = (async (_method: string, payload: { offset?: number }) => {
    await Promise.resolve();
    asked.push(payload.offset);

    return { ok: true, result: [] };
  }) as never;

  await transform(previous, "getUpdates", { offset: 3 });
  busy = true;
  deaf = true;
  const last = transform(previous, "getUpdates", { offset: 7, limit: 1 });

  expect(await Promise.race([last.then(() => "asked"), Bun.sleep(1000).then(() => "waited")])).toBe(
    "asked",
  );
  expect(asked).toEqual([3, 3]);
});

test("a getUpdates that fails on its way to Telegram fails as it is, asked once, without blaming hex's store", async () => {
  const logged = spyOn(process.stderr, "write");
  let asked = 0;

  const transform = confirmingWhatsKept(
    async () => {
      await Promise.resolve();
    },
    { lookAgainMs: 0 },
  );

  // SAFETY: the fake fails as grammY does when the request doesn't reach Telegram.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above
  const previous = (async () => {
    await Promise.resolve();
    asked++;

    throw new Error("Network request for 'getUpdates' failed!");
  }) as never;

  try {
    const failed = await transform(previous, "getUpdates", { offset: 1 }).then(
      () => "it answered",
      String,
    );

    expect(failed).toContain("Network request for 'getUpdates' failed!");
    expect(asked).toBe(1);
    expect(logged.mock.calls.flat().join("")).not.toContain("hex's store");
  } finally {
    logged.mockRestore();
  }
});
