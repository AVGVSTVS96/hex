import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "hands-off-"));
const hex = join(home, ".hex");
const GUARD = join(hex, "bin/hands-off");

mkdirSync(join(hex, "bin"), { recursive: true });

copyFileSync(join(import.meta.dir, "../../bin/hands-off"), GUARD);

const git = (...args: string[]) => Bun.spawnSync(["git", "-C", hex, ...args]);

git("init", "-q");

writeFileSync(join(hex, "HEX.md"), "");

git("add", "-A");

git(
  "-c",
  "user.name=t",
  "-c",
  "user.email=t@t",
  "-c",
  "commit.gpgsign=false",
  "commit",
  "-qm",
  "init",
);

git("worktree", "add", "-q", "--detach", join(hex, "worktrees/fix"));

interface HookInput {
  agent_id?: string;
  cwd?: string;
  tool_name: string;
  tool_input: { command?: string; file_path?: string };
}

const guard = (input: HookInput) =>
  Bun.spawnSync([GUARD], {
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    env: { ...process.env, MEMORY_DIR: "" },
  });

test.each([
  ".hex/vendor/memo recall foo",
  "MEMORY_DIR=~/hex/memory ~/hex/.hex/vendor/memo recall x",
  "cd ~/hex && .hex/vendor/memo wake",
  "memo note hi",
  "x=$(memo recall y)",
])("a subagent's %p is refused", (command) => {
  const run = guard({ agent_id: "a1", tool_name: "Bash", tool_input: { command } });

  expect(run.exitCode).toBe(2);
  expect(run.stderr.toString()).toContain("hex recall");
});

test.each([
  ".hex/bin/hex recall foo",
  "cat .hex/vendor/memo",
  "rg memo bin",
  'git commit -m "fix: memo recall flags"',
  "ls memos",
])("a subagent's %p goes through", (command) => {
  expect(guard({ agent_id: "a1", tool_name: "Bash", tool_input: { command } }).exitCode).toBe(0);
});

test("a session's own memo goes through", () => {
  expect(
    guard({ tool_name: "Bash", tool_input: { command: ".hex/vendor/memo recall x" } }).exitCode,
  ).toBe(0);
});

test.each([
  join(home, "memory/log"),
  join(hex, "HEX.md"),
  join(hex, "hub/new.ts"),
  join(hex, "worktrees/new/x.ts"),
])("an edit to %p is refused", (file_path) => {
  const run = guard({ tool_name: "Edit", tool_input: { file_path } });

  expect(run.exitCode).toBe(2);
  expect(run.stderr.toString()).not.toBe("");
});

test("a relative path resolves from the session's folder", () => {
  expect(
    guard({ tool_name: "Write", cwd: home, tool_input: { file_path: "memory/x" } }).exitCode,
  ).toBe(2);
});

test.each([
  join(hex, "worktrees/fix/HEX.md"),
  join(home, "AGENTS.md"),
  join(home, "state/x"),
  join(home, ".hex-other/x"),
])("an edit to %p goes through", (file_path) => {
  expect(guard({ tool_name: "Write", tool_input: { file_path } }).exitCode).toBe(0);
});
