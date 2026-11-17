import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checks, look, research } from "./ideas.ts";
import type { Found } from "./ideas.ts";
import { open, Store } from "./store.ts";
import { fakeClaude, flags } from "./testing.ts";

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

async function idea() {
  const store = new Store(dir);

  await store.messages.deliver({
    key: "telegram:-100:5",
    to: "-100:7",
    from: "telegram",
    author: "owner",
    body: "swap in GPT Live 1.1 once it is on the API",
    meta: { user: "owner" },
  });

  return await store.tasks.create({
    title: "Swap in GPT Live 1.1",
    message: "telegram:-100:5",
    owner: "-100:7",
    status: "idea",
  });
}

test("news reaches the idea's thread; a check without news wakes no one, and the next one starts from both", async () => {
  await idea();
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
  await idea();

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
  const { id } = await idea();
  await open(dir).tasks.edit(id, { status: "done", proof: "shipped" });
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
  await idea();
  await research(dir, "gpt-live", job, "general", minute, () =>
    Promise.resolve({ news: false, finding: "nothing yet" }),
  );
  expect(checks(dir, "t-1")[0]?.input).toContain(
    "What to look into: Is GPT Live 1.1 on the API yet?",
  );
});

test("news of an idea General owns goes beside General, not into its conversation", async () => {
  const { id } = await idea();
  await open(dir).tasks.edit(id, { owner: "general" });

  await research(dir, "fan", { ...job, idea: id }, "general", minute, () =>
    Promise.resolve({ news: true, finding: "A 12 dB fan is out: https://example.com/fan" }),
  );

  expect(sent()).toMatchObject([{ to: "beside:general" }]);
});

test("a look asks claude in hex's folder with the web and hex's log, no session, hex variables or bot tokens, and returns its finding and cost", async () => {
  using claude = fakeClaude(
    {
      structured_output: { news: true, finding: "It shipped: https://example.com/live" },
      usage: {
        input_tokens: 3,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 7,
        output_tokens: 11,
      },
      total_cost_usd: 0.04,
    },
    { env: { HEX_DIR: dir, TELEGRAM_BOT_TOKEN: "secret", BUZZ_SECRET: "secret" } },
  );

  expect(await look("Is GPT Live 1.1 on the API yet?")).toEqual({
    news: true,
    finding: "It shipped: https://example.com/live",
    tokens: 26,
    cost: 0.04,
  });

  const [call] = claude.calls();
  const { "--system-prompt": system, "--json-schema": schema, ...rest } = flags(call?.argv ?? []);

  expect(rest).toEqual({
    "-p": [],
    "--safe-mode": [],
    "--model": ["opus"],
    "--effort": ["low"],
    "--tools": ["WebSearch,WebFetch,Bash"],
    "--allowedTools": ["WebSearch", "WebFetch", "Bash(.hex/bin/hex log:*)", "Bash(rg:*)"],
    "--output-format": ["json"],
    "--no-session-persistence": [],
  });
  expect(system).toHaveLength(1);
  expect(JSON.parse(schema?.[0] ?? "")).toMatchObject({ required: ["news", "finding"] });
  expect(call).toMatchObject({
    stdin: "Is GPT Live 1.1 on the API yet?",
    cwd: realpathSync(dir),
    helper: "ideas",
    entrypoint: "hex",
  });
  expect(call?.env.filter((name) => /^(?:HEX_|CLAUDECODE|BUZZ_)|_BOT_TOKEN$/u.test(name))).toEqual([
    "HEX_HELPER",
  ]);
});

test("a look whose claude fails throws", async () => {
  using _claude = fakeClaude({ is_error: true, result: "API Error: 529 Overloaded" }, { code: 1 });

  expect(
    await look("Is GPT Live 1.1 on the API yet?").then(
      () => "answered",
      () => "threw",
    ),
  ).toBe("threw");
});
