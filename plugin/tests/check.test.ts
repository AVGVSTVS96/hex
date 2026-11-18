import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HEX = join(import.meta.dir, "../..");
const root = mkdtempSync(join(tmpdir(), "check-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test("bin/check's tests find nothing of the hex it runs beside: not its folder, store, channels, memory, sessions or machine, however the check was started", () => {
  const hex = join(root, "checked/.hex");
  const live = join(root, "live");
  const stubs = join(root, "stubs");
  const seen = join(root, "seen");
  mkdirSync(join(hex, "bin"), { recursive: true });
  mkdirSync(join(hex, "channels/.claude-plugin"), { recursive: true });
  mkdirSync(stubs);
  cpSync(join(HEX, "bin/check"), join(hex, "bin/check"));
  writeFileSync(join(hex, "channels/.claude-plugin/marketplace.json"), '{ "plugins": [] }');

  for (const tool of ["bun", "bunx"]) {
    writeFileSync(
      join(stubs, tool),
      `#!/bin/sh\n[ "$1" != test ] || env >> ${JSON.stringify(seen)}\n`,
    );
    chmodSync(join(stubs, tool), 0o755);
  }

  const theLiveHex = {
    HEX_DIR: live,
    HEX_STORE: join(live, "state"),
    HEX_THREAD: "telegram:-100:1",
    TELEGRAM_STATE_DIR: join(live, "state/telegram"),
    T3_STATE_DIR: join(live, "state/t3"),
    TELEGRAM_BOT_TOKEN: "the live bot",
    MEMORY_DIR: join(live, "memory"),
    CLAUDE_CONFIG_DIR: join(live, "claude"),
    XDG_STATE_HOME: join(live, "xdg"),
    NOTIFY_SOCKET: join(live, "notify"),
  };

  const check = Bun.spawnSync([join(hex, "bin/check")], {
    env: { ...process.env, ...theLiveHex, PATH: `${stubs}:${process.env.PATH}` },
  });

  expect(check.exitCode).toBe(0);

  const env = readFileSync(seen, "utf-8");

  expect(env.match(/^HEX_STORE=/gmu)).toBeNull();
  expect(env).not.toContain(live);
  expect(env).not.toContain("the live bot");
});
