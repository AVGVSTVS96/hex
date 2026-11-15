import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeClaude, flags } from "@hex/hub/testing";

let home: string;
let hex: string;
let state: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "check-")));
  hex = join(home, "hex");
  state = join(hex, "state");
  mkdirSync(join(state, "voice", "check"), { recursive: true });
  mkdirSync(join(hex, ".hex", "bin"), { recursive: true });

  for (const [bin, says] of Object.entries({
    instructions: "The owner's rules.",
    hex: "# Every message",
  })) {
    writeFileSync(join(hex, ".hex", "bin", bin), `#!/bin/sh\necho "${says}"\n`);
    chmodSync(join(hex, ".hex", "bin", bin), 0o755);
  }
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const verdict = {
  asks: [],
  settle: [],
  back: [],
  fixed: [{ title: "The login page", text: "Shipped on Oct 20." }],
  flagged: [],
  stuck: [],
};

async function pass() {
  writeFileSync(join(state, "voice", "check", "next"), "a call ended");

  const run = Bun.spawn([process.execPath, join(import.meta.dir, "check.ts"), state], {
    env: { ...process.env, HOME: home, HEX_DIR: hex },
    stdout: "ignore",
    stderr: "ignore",
  });

  await run.exited;
}

test("a pass asks claude in a folder of its own holding hex's messages and threads, with hex's rules and read-only tools, no session or hex variables, and keeps its verdict", async () => {
  using claude = fakeClaude({ structured_output: verdict });

  await pass();

  expect(JSON.parse(readFileSync(join(state, "voice", "check.json"), "utf-8"))).toMatchObject({
    why: "a call ended",
    fixed: verdict.fixed,
  });

  const [call] = claude.calls();
  const { "--json-schema": schema, ...rest } = flags(call?.argv ?? []);

  expect(rest).toEqual({
    "-p": [],
    "--safe-mode": [],
    "--model": ["opus"],
    "--effort": ["medium"],
    "--tools": ["Read,Grep,Glob"],
    "--append-system-prompt": ["The owner's rules.\n"],
    "--add-dir": [hex, join(home, ".claude", "projects")],
    "--output-format": ["json"],
    "--no-session-persistence": [],
  });
  expect(JSON.parse(schema?.[0] ?? "")).toMatchObject({
    required: ["asks", "settle", "back", "fixed", "flagged", "stuck"],
  });
  expect(call?.stdin).toStartWith("You're hex's check.");
  expect(call?.cwd).toStartWith(join(realpathSync(tmpdir()), "hex-check-"));
  expect(existsSync(call?.cwd ?? "")).toBe(false);
  expect(call).toMatchObject({
    files: ["messages.md", "threads.json"],
    helper: "check",
    entrypoint: "hex",
  });
  expect(call?.env.filter((name) => /^(?:HEX_|CLAUDECODE)/u.test(name))).toEqual(["HEX_HELPER"]);
});

test("a pass whose claude fails keeps the error and no verdict", async () => {
  using _claude = fakeClaude({ is_error: true, result: "API Error: 529 Overloaded" }, { code: 1 });

  await pass();

  expect(existsSync(join(state, "voice", "check.json"))).toBe(false);
  expect(readFileSync(join(state, "voice", "check", "error"), "utf-8")).toContain("a call ended");
});
