import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HEX = join(import.meta.dir, "../..");

let home: string;
let hex: string;

function seed(folder: string) {
  home = folder;
  hex = join(home, ".hex");
  mkdirSync(join(hex, "bin"), { recursive: true });
  mkdirSync(join(hex, "vendor"));
  cpSync(join(HEX, "defaults"), join(hex, "defaults"), { recursive: true });
  cpSync(join(HEX, "bin/hex"), join(hex, "bin/hex"));
  cpSync(join(HEX, "bin/settings"), join(hex, "bin/settings"));

  for (const stub of ["bin/optmem", "bin/wake", "vendor/memo"]) {
    writeFileSync(join(hex, stub), "#!/bin/sh\n");
    chmodSync(join(hex, stub), 0o755);
  }

  chmodSync(join(hex, "bin/hex"), 0o755);
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "init-"));
  seed(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const noGitIdentity = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "user.useConfigOnly",
  GIT_CONFIG_VALUE_0: "true",
};

function init() {
  const run = Bun.spawnSync([join(hex, "bin/hex"), "init"], {
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
      ),
      ...noGitIdentity,
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, "claude"),
    },
  });

  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

const log = () =>
  Bun.spawnSync(["git", "-C", home, "log", "--format=%s"], { env: noGitIdentity })
    .stdout.toString()
    .trim();

test("init sets up a folder on a machine with no git identity, and a second run changes nothing", () => {
  const first = init();
  expect(first.out).toBe(`hex is set up in ${home}\n`);
  expect(log()).toBe("chore: a new hex");
  expect(readFileSync(join(home, "PROACTIVE.md"), "utf-8")).toStartWith("# Proactive preferences");
  expect(readFileSync(join(home, ".gitignore"), "utf-8")).toContain("scratch/\n");

  const second = init();
  expect(second.code).toBe(0);
  expect(log()).toBe("chore: a new hex");
});

test("init run again commits a folder that a first run left without a commit", () => {
  Bun.spawnSync(["git", "-C", home, "init", "-q"]);
  expect(init().code).toBe(0);
  expect(log()).toBe("chore: a new hex");
});

test("init leaves a folder that has commits alone", () => {
  expect(init().code).toBe(0);
  writeFileSync(join(home, "AGENTS.md"), "mine\n");
  expect(init().code).toBe(0);
  expect(log()).toBe("chore: a new hex");
  expect(existsSync(join(home, ".git"))).toBe(true);
});

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    env: noGitIdentity,
  })
    .stdout.toString()
    .trim();

test("init gives a folder inside another git repo its own repo, and commits there", () => {
  git(root, "init", "-q");
  git(root, "commit", "-q", "--allow-empty", "-m", "outer");
  seed(join(root, "hex"));
  expect(init().code).toBe(0);
  expect(existsSync(join(home, ".git"))).toBe(true);
  expect(log()).toBe("chore: a new hex");
  expect(git(root, "log", "--format=%s")).toBe("outer");
});
