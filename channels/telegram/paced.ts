import { HeldBackError } from "@hex/hub";
import { GrammyError } from "grammy";

export async function paced<T>(
  send: (signal?: AbortSignal) => Promise<T>,
  answerWithin?: number,
): Promise<T> {
  const ends = answerWithin === undefined ? undefined : Date.now() + answerWithin;

  for (;;) {
    const signal =
      ends === undefined ? undefined : AbortSignal.timeout(Math.max(0, ends - Date.now()));

    try {
      return await send(signal);
    } catch (error) {
      if (signal?.aborted === true) {
        throw new Error(`Telegram didn't answer within ${String((answerWithin ?? 0) / 1000)}s`, {
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

        throw new HeldBackError(
          `Telegram asks this chat to wait ${wait}s before its next ${limited.method}`,
          wait,
          { cause: error },
        );
      }

      process.stderr.write(`telegram hub: Telegram asked ${limited.method} to wait ${wait}s\n`);
      await Bun.sleep(wait * 1000);
    }
  }
}
