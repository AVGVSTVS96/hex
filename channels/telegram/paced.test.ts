import { expect, test } from "bun:test";

import { GrammyError } from "grammy";

import { paced } from "./paced.ts";

const rejection = <T>(promise: Promise<T>) => promise.then(() => "resolved", String);

const limited = (wait: number) =>
  new GrammyError(
    "Call to 'editMessageText' failed!",
    {
      ok: false,
      error_code: 429,
      description: `Too Many Requests: retry after ${wait}`,
      parameters: { retry_after: wait },
    },
    "editMessageText",
    {},
  );

test("a call Telegram holds back waits out the limit it names and goes again", async () => {
  let sent = 0;

  const answer = await paced(() => {
    sent += 1;

    return sent === 1 ? Promise.reject(limited(0)) : Promise.resolve("edited");
  });

  expect(answer).toBe("edited");
  expect(sent).toBe(2);
});

test("a call that must answer in time fails at once on a wait it can't fit, and says how long Telegram asked", async () => {
  let sent = 0;

  const failed = await rejection(
    paced(() => {
      sent += 1;

      return Promise.reject(limited(600));
    }, 60_000),
  );

  expect(failed).toContain("wait 600s before its next editMessageText");
  expect(sent).toBe(1);
});

test("a call that must answer in time is cut off when its time runs out, so it can't land later", async () => {
  let cut = false;

  const failed = await rejection(
    paced(
      async (signal) =>
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            cut = true;
            reject(new Error("aborted", { cause: signal.reason }));
          });
        }),
      10,
    ),
  );

  expect(failed).toContain("didn't answer within");
  expect(cut).toBe(true);
});
