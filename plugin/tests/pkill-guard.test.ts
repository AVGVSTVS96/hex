import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

const GUARD = join(import.meta.dir, "../../bin/pkill-guard");

const guard = (command: string) =>
  Bun.spawnSync([GUARD], {
    stdin: new TextEncoder().encode(JSON.stringify({ tool_name: "Bash", tool_input: { command } })),
  });

test.each([
  "pkill -f x",
  "pkill --full x",
  "pkill -9 -f 'bun hub/serve.ts'",
  "pkill -fx bun",
  "sudo pkill -f x",
  "/usr/bin/pkill -f x",
  "cd hub && pkill -f serve.ts",
  "make build; pkill -f x",
  "ssh other 'pkill -f x'",
  'bash -c "pkill -f x"',
  "echo start\npkill -f x",
  "pkill -u someone -f x",
  "pkill -s 9 -f x",
  "pkill -P 1 -f x",
  "pkill -t pts/1 -f x",
  "pkill -G wheel -f x",
  "pkill --signal KILL -f x",
  "pkill x -f",
  'git commit -m "docs: pkill -f kills its own shell"',
])("pkill-guard refuses %p and says why", (command) => {
  const run = guard(command);

  expect(run.exitCode).toBe(2);
  expect(run.stderr.toString()).toContain("Kill by the PID you started or looked up");
  expect(run.stderr.toString()).toContain("git commit -F");
});

test.each([
  "ls -la",
  "kill 4242",
  "pkill -x bun",
  "pkill firefox",
  "pgrep -f x",
  "rg 'pkill -f' bin",
  "mypkill -f x",
  "pkill -x node; tail -f log",
  "pkill firefox; rm -f x",
  "pkill -x node && tail -f log",
  "pkill -x node | tee -f",
  'git commit -m "docs: the -f flag of pkill kills its own shell"',
])("pkill-guard lets %p through", (command) => {
  const run = guard(command);

  expect(run.exitCode).toBe(0);
  expect(run.stderr.toString()).toBe("");
});

const Hooks = z.object({
  hooks: z.object({
    PreToolUse: z.array(
      z.object({ matcher: z.string(), hooks: z.array(z.object({ command: z.string() })) }),
    ),
  }),
});

test("every session runs pkill-guard before Bash", () => {
  const { hooks } = Hooks.parse(
    JSON.parse(readFileSync(join(import.meta.dir, "../hooks/hooks.json"), "utf-8")),
  );

  const commands = hooks.PreToolUse.filter(({ matcher }) => matcher === "^Bash$").flatMap((entry) =>
    entry.hooks.map(({ command }) => command),
  );

  expect(commands.some((command) => command.endsWith("/../bin/pkill-guard"))).toBe(true);
});
