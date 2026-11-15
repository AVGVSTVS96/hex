/* oxlint-disable eslint/no-template-curly-in-string -- the test checks that ${VARIABLE}s reach the session unexpanded */
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { refused, start } from "./claude.ts";
import { noClaude } from "./testing.ts";

const scopes =
  Bun.which("systemd-run") !== null &&
  Bun.spawnSync(["systemd-run", "--user", "--scope", "--quiet", "true"]).success;

test.skipIf(!scopes)(
  "a session started in the sessions slice gets its name and prompt as written, ${VARIABLE}s and all",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-"));
    const launcher = join(dir, "session");
    writeFileSync(
      launcher,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\necho "backgrounded · job12345 · test"\n`,
    );
    chmodSync(launcher, 0o755);
    const path = process.env.PATH;
    process.env.HEX_SESSIONS_SLICE = "hex-sessions.slice";
    process.env.PATH = noClaude();

    try {
      expect(
        await start(launcher, ["--name", "cost of ${HOME}", "echo $PATH ${PATH}"], {
          cwd: dir,
          env: process.env,
        }),
      ).toBe("job12345");
      expect(readFileSync(join(dir, "args"), "utf-8")).toBe(
        "--bg\n--name\ncost of ${HOME}\necho $PATH ${PATH}\n",
      );
    } finally {
      delete process.env.HEX_SESSIONS_SLICE;
      process.env.PATH = path;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A transcript as Claude Code writes it: each entry points to the one before it, and the last one is the newest.
function transcript(entries: object[]) {
  const folder = mkdtempSync(join(tmpdir(), "refused-"));
  const file = join(folder, "session.jsonl");
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n"));

  return {
    file,
    [Symbol.dispose]: () => {
      rmSync(folder, { recursive: true });
    },
  };
}

const channel = (key: string, uuid: string, parentUuid: string) => ({
  type: "user",
  uuid,
  parentUuid,
  message: { content: `<channel source="telegram" key="${key}">…</channel>` },
});

const reply = (uuid: string, parentUuid: string, stop = "end_turn") => ({
  type: "assistant",
  uuid,
  parentUuid,
  message: {
    content: [],
    stop_reason: stop,
    ...(stop === "refusal" && { stop_details: { category: "cyber" } }),
  },
});

test("a transcript whose last reply was refused goes on from before its messages first came in, past the turns they came back in", () => {
  using refusedAgain = transcript([
    { type: "user", uuid: "u0", parentUuid: null, message: { content: "drones?" } },
    reply("a0", "u0"),
    channel("telegram:1:5", "m1", "a0"),
    { type: "attachment", uuid: "h1", parentUuid: "m1" },
    { type: "system", uuid: "s1", parentUuid: "h1" },
    reply("a1", "s1"),
    channel("telegram:1:5", "m2", "a1"),
    channel("telegram:1:6", "m3", "m2"),
    reply("a2", "m3", "refusal"),
    { type: "system", uuid: "s2", parentUuid: "a2" },
  ]);

  expect(refused(refusedAgain.file)).toEqual({ category: "cyber", at: "a0" });

  using answered = transcript([
    { type: "user", uuid: "u0", parentUuid: null, message: { content: "drones?" } },
    reply("a0", "u0", "refusal"),
    channel("telegram:1:5", "m1", "a0"),
    reply("a1", "m1"),
  ]);

  expect(refused(answered.file)).toBeUndefined();
  expect(refused(join(tmpdir(), "no-such-transcript.jsonl"))).toBeUndefined();
});
