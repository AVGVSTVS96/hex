import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { followed } from "./kept.ts";

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
