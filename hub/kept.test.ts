import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { answered, followed, keeping, payOwedFacts } from "./kept.ts";
import { MovedError } from "./store.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kept-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("a hook's call that a move overtook, as it waited on the move's lock, is made again on the store the records moved to", async () => {
  const calls: string[] = [];

  const object = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      calls.push(await request.text());

      return Response.json({ value: true });
    },
  });

  try {
    let moved = false;

    const kept = await followed(dir, async (store) => {
      if (!moved) {
        moved = true;
        writeFileSync(
          join(dir, "store.json"),
          JSON.stringify({ url: object.url.origin, name: "hex", key: "k".repeat(32) }),
          { mode: 0o600 },
        );
      }

      return await store.messages.deliver({
        key: "terminal:1",
        to: "dm",
        from: "terminal",
        author: "hex",
        body: "Done.",
      });
    });

    expect(kept).toBe(true);
    expect(calls.some((call) => call.includes("terminal:1"))).toBe(true);
  } finally {
    await object.stop(true);
  }
});

test("a hub whose store hasn't answered for a while as it starts tells the owner once and goes on waiting, even for a hex.db whose records moved without store.json", async () => {
  const told: string[] = [];
  let tries = 0;

  const value = await answered(
    dir,
    "it starts",
    // oxlint-disable-next-line typescript/require-await -- a store call, which rejects
    async () => {
      tries++;

      if (tries < 3) {
        throw new MovedError("hex's records moved, and store.json isn't here");
      }

      return "started";
    },
    {
      tell: (why) => {
        told.push(why);
      },
      tellAfter: 0,
    },
  );

  expect(value).toBe("started");
  expect(told).toEqual(["hex's records moved, and store.json isn't here"]);
});

const owedMessage = (n: number) => ({
  kind: "deliver" as const,
  row: {
    key: `telegram:1:${n}`,
    to: "chat:7",
    from: "telegram",
    author: "owner" as const,
    body: "hi",
  },
});

const owing = (earlier: string[] = []) =>
  keeping(dir, {
    app: "telegram",
    earlier,
    queue: async () => {
      await Promise.resolve();
    },
  });

test("a start whose disk can't take its spool leaves the files it read what's owed from where they are", () => {
  const earlier = join(dir, "telegram", "owed.telegram.json");
  const refused = join(dir, "refused.telegram.json");
  mkdirSync(join(dir, "telegram"));
  writeFileSync(earlier, JSON.stringify([owedMessage(1)]));
  writeFileSync(refused, `${JSON.stringify({ write: owedMessage(2) })}\n`);
  mkdirSync(join(dir, "owed.telegram.json.next"));

  const started = owing([earlier]);

  expect([1, 2].map((n) => started.owes(owedMessage(n)))).toEqual([true, true]);
  expect([existsSync(earlier), existsSync(refused)]).toEqual([true, true]);
});

test("a spool line cut short costs only itself", () => {
  const spool = join(dir, "owed.telegram.json");
  const lines = [1, 2, 3, 4].map((n) => JSON.stringify({ write: owedMessage(n) }));
  writeFileSync(spool, `${[lines[0], lines[1]?.slice(0, 20), lines[2], lines[3]].join("\n")}\n`);

  const started = owing();

  expect([1, 2, 3, 4].map((n) => started.owes(owedMessage(n)))).toEqual([true, false, true, true]);
  expect(readFileSync(spool, "utf-8").trim().split("\n")).toHaveLength(3);
});

const StoreCall = z.object({
  method: z.string(),
  args: z.tuple([z.looseObject({ key: z.string().optional() })], z.unknown()),
});

type Call = z.infer<typeof StoreCall>;

async function withObject(answer: (call: Call) => Response, use: (calls: Call[]) => Promise<void>) {
  const calls: Call[] = [];

  const object = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const call = StoreCall.parse(JSON.parse(await request.text()));
      calls.push(call);

      return answer(call);
    },
  });

  writeFileSync(
    join(dir, "store.json"),
    JSON.stringify({ url: object.url.origin, name: "hex", key: "k".repeat(32) }),
  );

  try {
    await use(calls);
  } finally {
    await object.stop(true);
  }
}

const spoolOf = (...writes: object[]) =>
  writes.map((write) => `${JSON.stringify({ write })}\n`).join("");

test("a fact a lost hub owed that the store refuses is set aside whole, and the owner hears which", async () => {
  writeFileSync(join(dir, "owed.telegram.json"), spoolOf(owedMessage(1), owedMessage(2)));
  const told: string[] = [];

  await withObject(
    ({ args: [row] }) =>
      row.key === "telegram:1:1"
        ? Response.json({ error: "too big" })
        : Response.json({ value: true }),
    async (calls) => {
      expect(
        await payOwedFacts(dir, (why) => {
          told.push(why);
        }),
      ).toBe(true);
      expect(calls.some(({ args: [row] }) => row.key?.startsWith("hub:refused:") === true)).toBe(
        true,
      );
    },
  );

  expect(readFileSync(join(dir, "refused.telegram.json"), "utf-8")).toContain("telegram:1:1");
  expect(told).toHaveLength(1);
  expect(told[0]).toContain("telegram:1:1");
  expect(existsSync(join(dir, "owed.telegram.json"))).toBe(false);
});

test("a fact a lost hub owed stays owed when the store answers something other than a refusal", async () => {
  writeFileSync(join(dir, "owed.telegram.json"), spoolOf(owedMessage(1)));

  await withObject(
    () => Response.json({ prototype: "not one hex sends" }),
    async () => {
      expect(await payOwedFacts(dir)).toBe(false);
    },
  );

  expect(readFileSync(join(dir, "owed.telegram.json"), "utf-8")).toContain("telegram:1:1");
});

test("a lost hub's memory pass is only queued in the store, and what a hex before this one owed in its app's folder is paid too", async () => {
  mkdirSync(join(dir, "telegram"));
  writeFileSync(join(dir, "telegram", "owed.telegram.json"), JSON.stringify([owedMessage(3)]));
  writeFileSync(
    join(dir, "owed.terminal.json"),
    spoolOf({ kind: "pass", pass: { session: "s", by: "hook" } }),
  );

  await withObject(
    ({ method }) => Response.json({ value: method === "deliver" ? true : null }),
    async (calls) => {
      expect(await payOwedFacts(dir)).toBe(true);
      expect(calls.map(({ method }) => method).toSorted()).toEqual(["deliver", "wait"]);
    },
  );

  expect(existsSync(join(dir, "telegram", "owed.telegram.json"))).toBe(false);
});
