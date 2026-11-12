import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const work = join(import.meta.dir, "../../bin/work");
const fake = mkdtempSync(join(tmpdir(), "work-"));
const ran = join(fake, "ran");

writeFileSync(
  join(fake, "systemd-run"),
  `#!/bin/sh\nprintf '%s\\n' "$@" > "${ran}"\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n`,
);

chmodSync(join(fake, "systemd-run"), 0o755);

afterAll(() => {
  rmSync(fake, { recursive: true });
});

function through(command: string) {
  rmSync(ran, { force: true });

  const done = Bun.spawnSync([work, command], {
    env: { ...process.env, PATH: `${fake}:${process.env.PATH}`, SHELL: "/bin/bash" },
  });

  return { out: done.stdout.toString(), slice: readFileSync(ran, { flag: "a+" }).toString() };
}

test("a command an agent runs goes in the work slice, bound to the agent's unit, and keeps its output", () => {
  const unit = readFileSync("/proc/self/cgroup", "utf-8").trim().split("/").at(-1);

  const { out, slice } = through(
    `source /nowhere 2>/dev/null || true && eval 'echo built' < /dev/null && pwd -P >| ${join(fake, "cwd")}`,
  );

  expect(out).toBe("built\n");

  for (const arg of ["--scope", "--slice=hex-work.slice", `BindsTo=${unit}`, "/bin/bash", "-c"]) {
    expect(slice.split("\n")).toContain(arg);
  }
});

test("a hook stays with the agent", () => {
  expect(through("echo hooked")).toEqual({ out: "hooked\n", slice: "" });
});
