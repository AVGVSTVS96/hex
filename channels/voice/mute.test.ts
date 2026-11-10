import { expect, test } from "bun:test";

import { until } from "@hex/hub/testing";

import { muting } from "./mute.ts";

function judge(wants: (said: string, muted: boolean) => number) {
  const asked: string[] = [];
  const flips: string[] = [];

  const mute = muting(
    async ({ said = "" }, question) => {
      asked.push(said);
      await Bun.sleep(5);

      return wants(said, question.startsWith("hex is muted"));
    },
    (muted, second) => {
      flips.push(muted ? "muted" : second ? "not after all" : "unmuted");
    },
    (error) => {
      flips.push(error.message);
    },
  );

  return { mute, asked, flips };
}

const command = (said: string) => (/^ ?(mute|unmute)\b/iu.test(said) ? 0.9 : 0.1);

test("a command to mute mutes, and one to unmute in a later breath unmutes", async () => {
  const { mute, flips } = judge(command);
  mute.heard("Mute", 0, 200);
  mute.heard(" yourself", 200, 400);
  await until(() => flips.length === 1);
  expect(mute.muted).toBe(true);
  mute.heard("Unmute", 5000, 5200);
  await until(() => flips.length === 2);
  expect(flips).toEqual(["muted", "unmuted"]);
  expect(mute.muted).toBe(false);
});

test("a sentence that only began like a command takes the mute back once Jev reads the rest of it", async () => {
  const { mute, flips } = judge((said) =>
    said.includes("when I say") ? 0.1 : said.includes("mute yourself") ? 0.8 : 0.1,
  );

  mute.heard("Can we make it so you mute yourself", 0, 1600);
  await until(() => flips.length === 1);

  mute.heard(" when I say so?", 1800, 2400);
  await until(() => flips.length === 2);

  expect(flips).toEqual(["muted", "not after all"]);
});

test("Jev reads only words that could be about muting, and only the newest of a sentence still coming in", async () => {
  const { mute, asked, flips } = judge(command);
  mute.heard("What's the capital of Australia?", 0, 1500);
  mute.heard("Mute", 5000, 5200);
  mute.heard(" yourself", 5200, 5400);
  mute.heard(" now", 5400, 5600);
  await until(() => flips.length === 1);
  expect(asked).toEqual(["Mute", "Mute yourself now"]);
});

test("Jev failing leaves the voice as it was", async () => {
  const flips: string[] = [];

  const mute = muting(
    () => Promise.reject(new Error("Jev 502")),
    () => {
      flips.push("flipped");
    },
    (error) => {
      flips.push(error.message);
    },
  );

  mute.heard("Mute yourself", 0, 400);
  await until(() => flips.length === 1);
  expect(flips).toEqual(["Jev 502"]);
  expect(mute.muted).toBe(false);
});
