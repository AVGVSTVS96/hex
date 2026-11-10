import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checks, jobChecks, research, watch } from "./ideas.ts";
import type { Found } from "./ideas.ts";
import { open, Store } from "./store.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ideas-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const minute = Date.UTC(2026, 10, 9, 17) / 60_000;

const sent = () =>
  open(dir)
    .messages.untaken()
    .filter((row) => row.from === "schedule");

const fail = () => Promise.reject(new Error("rate limited"));
const neverAsked = () => Promise.resolve({ news: true, finding: "never asked" });

const job = { cron: "0 9 * * 1", idea: "t-1", prompt: "Is GPT Live 1.1 on the API yet?" };

function idea() {
  const store = new Store(dir);

  store.messages.deliver({
    key: "telegram:-100:5",
    to: "-100:7",
    from: "telegram",
    author: "owner",
    body: "swap in GPT Live 1.1 once it is on the API",
    meta: { user: "owner" },
  });

  return store.tasks.create({
    title: "Swap in GPT Live 1.1",
    message: "telegram:-100:5",
    owner: "-100:7",
    status: "idea",
  });
}

test("news reaches the idea's thread; a check without news wakes no one, and the next one starts from both", async () => {
  idea();
  const inputs: string[] = [];

  const ask = (found: Found) => (input: string) => {
    inputs.push(input);

    return Promise.resolve(found);
  };

  await research(
    dir,
    "gpt-live",
    job,
    "general",
    minute,
    ask({ news: false, finding: "Only in ChatGPT so far, per the OpenAI changelog.", tokens: 900 }),
  );
  expect(sent()).toEqual([]);
  await research(
    dir,
    "gpt-live",
    job,
    "general",
    minute + 7 * 1440,
    ask({
      news: true,
      finding: "gpt-live-1.1 is on the API: https://platform.openai.com/docs/models",
    }),
  );

  expect(inputs[0]).toContain("swap in GPT Live 1.1 once it is on the API");
  expect(inputs[0]).toContain("What to look into: Is GPT Live 1.1 on the API yet?");
  expect(inputs[0]).toContain("This is its first check.");
  expect(inputs[1]).toContain("Only in ChatGPT so far, per the OpenAI changelog.");
  expect(sent()).toMatchObject([
    {
      to: "-100:7",
      from: "schedule",
      body: "[gpt-live] News for t-1 (Swap in GPT Live 1.1): gpt-live-1.1 is on the API: https://platform.openai.com/docs/models",
    },
  ]);
  expect(checks(dir, "t-1").map((check) => [check.news, check.tokens])).toEqual([
    [false, 900],
    [true, undefined],
  ]);
});

test("a check that fails is kept with its error; the second failure in a row tells the thread, once", async () => {
  idea();

  await research(dir, "gpt-live", job, "general", minute, fail);
  expect(sent()).toEqual([]);
  expect(checks(dir, "t-1")[0]?.error).toContain("rate limited");
  await research(dir, "gpt-live", job, "general", minute + 1440, fail);
  await research(dir, "gpt-live", job, "general", minute + 2 * 1440, fail);
  expect(sent()).toMatchObject([
    {
      to: "-100:7",
      body: "[gpt-live] t-1's idea check failed twice in a row, and tries again at its next slot: Error: rate limited",
    },
  ]);
});

test("an idea that's done has nothing to look into: its thread hears once to take the job out", async () => {
  const { id } = idea();
  open(dir).tasks.edit(id, { status: "done", proof: "shipped" });
  await research(dir, "gpt-live", job, "general", minute, neverAsked);
  await research(dir, "gpt-live", job, "general", minute + 1440, neverAsked);
  expect(sent()).toMatchObject([
    {
      to: "-100:7",
      body: "[gpt-live] t-1 is done, so its check in schedules.json has nothing left to look into: take the job out.",
    },
  ]);
  expect(checks(dir, "t-1").map((check) => [check.ended, check.input])).toEqual([
    ["done", undefined],
    ["done", undefined],
  ]);
});

test("each check keeps the input it was given, so a prompt can be replayed against it", async () => {
  idea();
  await research(dir, "gpt-live", job, "general", minute, () =>
    Promise.resolve({ news: false, finding: "nothing yet" }),
  );
  expect(checks(dir, "t-1")[0]?.input).toContain(
    "What to look into: Is GPT Live 1.1 on the API yet?",
  );
});

const heartbeat = {
  cron: "45 8-22 * * *",
  check: true,
  prompt:
    "Check my mail. If something's worth telling me now, message me; if not, answer HEARTBEAT_OK.",
};

test("a job's check wakes its thread only with news, and each check starts from what the last ones found", async () => {
  const inputs: string[] = [];

  const see = (found: Found) => (input: string) => {
    inputs.push(input);

    return Promise.resolve(found);
  };

  await watch(
    dir,
    "heartbeat",
    heartbeat,
    "general",
    minute,
    see({ news: false, finding: "Inbox: nothing new." }),
  );
  expect(sent()).toEqual([]);
  await watch(
    dir,
    "heartbeat",
    heartbeat,
    "general",
    minute + 60,
    see({
      news: true,
      finding: "The landlord wrote about the lease: https://mail.example/1",
      tokens: 60_000,
    }),
  );
  await watch(
    dir,
    "heartbeat",
    heartbeat,
    "general",
    minute + 120,
    see({ news: false, finding: "Nothing since the lease mail." }),
  );

  expect(inputs[0]).toContain("[heartbeat] Check my mail.");
  expect(inputs[0]).toContain(".hex/bin/hex log -- 'general'");
  expect(inputs[0]).toContain("This is its first check.");
  expect(inputs[2]).toContain("Inbox: nothing new.");
  expect(inputs[2]).toContain(", told the thread: The landlord wrote about the lease");
  expect(sent()).toMatchObject([
    {
      to: "general",
      body: "[heartbeat] News from its check: The landlord wrote about the lease: https://mail.example/1",
      meta: { schedule: "heartbeat" },
    },
  ]);
  expect(jobChecks(dir, "heartbeat").map((check) => [check.news, check.tokens])).toEqual([
    [false, undefined],
    [true, 60_000],
    [false, undefined],
  ]);
  expect(checks(dir)).toEqual([]);
});

test("a job whose check can't run runs in its thread instead, so no slot goes unchecked", async () => {
  await watch(dir, "heartbeat", { ...heartbeat, thread: "-100:7" }, "general", minute, fail);
  expect(sent()).toMatchObject([
    {
      to: "-100:7",
      body: `[heartbeat] ${heartbeat.prompt}\n\n(Its check couldn't run, so it runs here this time: Error: rate limited)`,
    },
  ]);
  expect(jobChecks(dir, "heartbeat")[0]?.error).toContain("rate limited");
});
