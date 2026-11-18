import { afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Every test file's preload (bunfig.toml). Tests run where hex runs, often from one of its sessions or jobs, whose environment names hex's folder and store, its channels' state and tokens, its memory, its sessions and the machine it runs on. None of it reaches a test, and Claude Code's folder, the machine's state folder and the temp folder are the test file's own, so a test only ever finds the hex it makes.
const OF_THE_HEX_THAT_RUNS_HERE =
  /^(?:HEX_|BUZZ_|IIKB_|VOICE_)|_(?:STATE_DIR|TOKEN)$|^(?:MEMORY_DIR|NOTIFY_SOCKET|INVOCATION_ID)$/u;

for (const name of Object.keys(process.env)) {
  if (OF_THE_HEX_THAT_RUNS_HERE.test(name)) {
    Reflect.deleteProperty(process.env, name);
  }
}

const sandbox = mkdtempSync(join(tmpdir(), "hex-test-"));

Object.assign(process.env, {
  TMPDIR: sandbox,
  CLAUDE_CONFIG_DIR: join(sandbox, "claude"),
  XDG_STATE_HOME: join(sandbox, "state"),
});

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Bun preloads this once for each file only when it runs each in a world of its own, which bin/check's --parallel does and a single file is. Several files in one world would share the first one's sandbox.
const mine = Bun.main;

beforeEach(() => {
  if (Bun.main !== mine) {
    throw new Error(
      `${Bun.main} runs in one process with ${mine}, without a sandbox of its own: run several test files as \`bun test --isolate <files>\`, or \`bin/check <package>\``,
    );
  }
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});
