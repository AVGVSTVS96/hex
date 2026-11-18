import { GrammyError } from "grammy";

// A backfill, or many questions redrawn at once, is more than Telegram lets a bot send in a minute, so each call waits out the limit Telegram names. https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this
// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Given `within`, a call that must answer in time gives up at once on a wait it can't fit, and its request is cut off when time runs out, so it never lands later than that.
export async function paced<T>(
  send: (signal?: AbortSignal) => Promise<T>,
  within?: number,
): Promise<T> {
  const ends = within === undefined ? undefined : Date.now() + within;

  for (;;) {
    const signal =
      ends === undefined ? undefined : AbortSignal.timeout(Math.max(0, ends - Date.now()));

    try {
      return await send(signal);
    } catch (error) {
      if (signal?.aborted === true) {
        throw new Error(`Telegram didn't answer within ${String((within ?? 0) / 1000)}s`, {
          cause: error,
        });
      }

      const limited = error instanceof GrammyError && error.error_code === 429 ? error : undefined;
      const wait = limited?.parameters.retry_after;

      if (limited === undefined || wait === undefined) {
        throw error;
      }

      if (ends !== undefined && Date.now() + wait * 1000 > ends) {
        process.stderr.write(
          `telegram hub: Telegram asked ${limited.method} to wait ${wait}s, more than it has, so it fails\n`,
        );

        throw new Error(
          `Telegram asks this chat to wait ${wait}s before its next ${limited.method}`,
          {
            cause: error,
          },
        );
      }

      process.stderr.write(`telegram hub: Telegram asked ${limited.method} to wait ${wait}s\n`);
      await Bun.sleep(wait * 1000);
    }
  }
}
