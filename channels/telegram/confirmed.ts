import type { Transformer } from "grammy";
import type { Update } from "grammy/types";
import { z } from "zod";

const LOOK_AGAIN_MS = 1000;

const Asked = z.looseObject({ offset: z.number().optional() });

// Each getUpdates confirms to Telegram every update before its offset (https://core.telegram.org/bots/api#getupdates), so it asks with the offset hex's store has every update before: past those its hub has, once synced resolves, and from the first update it couldn't confirm while synced rejects, so Telegram keeps those for whichever hub asks next. Meanwhile the hub is given only the updates it hasn't had, and asks again after a pause when there are none, since Telegram answers at once while it holds any. A deaf hub is stopping, so its last getUpdates confirms only what synced already confirmed, at once, instead of waiting for the store, and the next hub gets the rest again.
export function confirmingWhatsKept(
  synced: () => Promise<void>,
  { deaf = (): boolean => false, lookAgainMs = LOOK_AGAIN_MS } = {},
): Transformer {
  let kept: number | undefined;
  let holding = false;

  return async (previous, method, payload, signal) => {
    if (method !== "getUpdates") {
      return await previous(method, payload, signal);
    }

    const { offset } = Asked.parse(payload);
    kept ??= offset;

    if (deaf()) {
      return await previous(method, { ...payload, offset: kept }, signal);
    }

    try {
      await synced();
      kept = offset;
      holding = false;
    } catch (error) {
      if (!holding) {
        process.stderr.write(
          `telegram hub: Telegram keeps what hex's store doesn't have yet, and sends it again: ${String(error)}\n`,
        );
      }

      holding = true;
    }

    if (!holding) {
      return await previous(method, payload, signal);
    }

    const updates = await previous(method, { ...payload, offset: kept }, signal);

    if (!updates.ok || offset === undefined || kept === offset) {
      return updates;
    }

    // SAFETY: getUpdates answers with updates.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the method was checked above, which narrows only the value, not grammY's generic
    const unseen = (updates.result as Update[]).filter(({ update_id }) => update_id >= offset);

    if (unseen.length === 0) {
      await Bun.sleep(lookAgainMs);
    }

    // SAFETY: as above.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above
    return { ...updates, result: unseen as typeof updates.result };
  };
}
