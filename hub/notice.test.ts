import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { tellOwner } from "./notice.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "notice-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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
