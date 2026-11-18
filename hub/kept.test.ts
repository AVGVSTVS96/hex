import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { answered, followed } from "./kept.ts";
import { tellOwner } from "./notice.ts";
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

test("the owner hears that hex can't start once until it's back, straight from Telegram", async () => {
  const sent: string[] = [];

  const telegram = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      sent.push(new URLSearchParams(await request.text()).get("text") ?? "");

      return Response.json({ ok: true });
    },
  });

  const before = { token: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.HEX_MAIN_THREAD };
  process.env.TELEGRAM_BOT_TOKEN = "token";
  process.env.HEX_MAIN_THREAD = "-100";

  try {
    const api = telegram.url.origin;
    expect(await tellOwner("hex can't start.", { down: dir, api })).toBe(true);
    expect(await tellOwner("hex can't start.", { down: dir, api })).toBe(false);
    expect(sent).toEqual(["hex can't start. General hears here once it's back."]);
    expect(existsSync(join(dir, `down.${hostname()}`))).toBe(true);
  } finally {
    process.env.TELEGRAM_BOT_TOKEN = before.token ?? "";
    process.env.HEX_MAIN_THREAD = before.chat ?? "";
    await telegram.stop(true);
  }
});
