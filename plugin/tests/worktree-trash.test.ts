import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TRASH = join(import.meta.dir, "../../bin/worktree-trash");
const root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-trash-")));
const repo = join(root, "repo");
const home = join(root, "home");
const wt = (name: string) => join(root, "wt", name);

const git = (cwd: string, ...args: string[]) => {
  const run = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });

  if (!run.success) {
    throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  }
};

const commit = (cwd: string, file: string) => {
  writeFileSync(join(cwd, file), file);
  git(cwd, "add", file);
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", file);
};

const age = (path: string) => {
  const old = new Date(Date.now() - 2 * 86_400_000);

  for (const entry of readdirSync(path, { recursive: true })) {
    utimesSync(join(path, String(entry)), old, old);
  }
};

const toolbox = (name: string, { missing = "", broken = "" } = {}) => {
  const dir = join(root, name);

  mkdirSync(dir);

  for (const tool of ["git", "awk", "find", "grep", "readlink", "lsof", "sh"]) {
    const path = Bun.which(tool);

    if (tool === broken) {
      writeFileSync(join(dir, tool), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
    } else if (tool !== missing && path !== null) {
      symlinkSync(path, join(dir, tool));
    }
  }

  return dir;
};

const withoutFdRgGh = toolbox("without-fd-rg-gh");
const plain = join(root, "plain");

let sleeper: ReturnType<typeof Bun.spawn>;

beforeAll(() => {
  git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(root, "clone", "-q", "origin.git", "repo");
  git(repo, "symbolic-ref", "HEAD", "refs/heads/main");
  commit(repo, "a");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "remote", "set-head", "origin", "main");

  git(repo, "worktree", "add", "-qb", "merged", wt("merged"));
  commit(wt("merged"), "b");
  git(wt("merged"), "push", "-q", "origin", "merged:main");

  for (const name of [
    "dirty",
    "in-use",
    "recent",
    "worked",
    "worked-codex",
    "unmerged",
    "locked",
  ]) {
    git(repo, "worktree", "add", "-qb", name, wt(name), "origin/main");
  }

  commit(wt("unmerged"), "c");
  git(repo, "worktree", "lock", wt("locked"));
  writeFileSync(join(wt("dirty"), "notes"), "work");
  mkdirSync(join(wt("worked"), "src"));

  for (const name of [
    "merged",
    "dirty",
    "in-use",
    "worked",
    "worked-codex",
    "unmerged",
    "locked",
  ]) {
    age(wt(name));
  }

  const claude = join(home, ".claude/projects/worked");
  const codex = join(home, ".codex/sessions/2026/11/10");

  mkdirSync(claude, { recursive: true });
  mkdirSync(codex, { recursive: true });
  writeFileSync(
    join(claude, "session.jsonl"),
    `${JSON.stringify({ type: "user", cwd: join(wt("worked"), "src") })}\n`,
  );
  writeFileSync(
    join(codex, "rollout.jsonl"),
    `${JSON.stringify({ type: "session_meta", payload: { cwd: wt("worked-codex") } })}\n`,
  );

  git(root, "init", "-q", "-b", "main", "plain");
  commit(plain, "a");
  git(plain, "worktree", "add", "-qb", "done", join(plain, "done"));
  commit(join(plain, "done"), "b");
  git(plain, "merge", "-q", "done");
  git(plain, "worktree", "add", "-qb", "open", join(plain, "open"));
  commit(join(plain, "open"), "c");
  age(join(plain, "done"));
  age(join(plain, "open"));

  sleeper = Bun.spawn(["sleep", "60"], { cwd: wt("in-use") });
});

afterAll(() => {
  sleeper.kill();
  rmSync(root, { recursive: true, force: true });
});

const trash = (path: string, ...args: string[]) =>
  Bun.spawnSync([TRASH, ...args], {
    env: { PATH: path, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });

test.each([
  ["with fd, rg and gh", process.env.PATH ?? ""],
  ["with only git and the POSIX tools", withoutFdRgGh],
])("worktree-trash %s lists only the merged worktree nobody is working in", (_, path) => {
  const run = trash(path, repo);

  expect(run.stderr.toString()).toBe("");
  expect(run.stdout.toString()).toBe(`${wt("merged")}\n`);
});

test("worktree-trash on a repo with no origin counts what its checked-out branch has as merged", () => {
  const run = trash(withoutFdRgGh, plain);

  expect(run.stderr.toString()).toBe("");
  expect(run.stdout.toString()).toBe(`${join(plain, "done")}\n`);
});

test.each([
  ...(existsSync("/proc/self") ? [{ missing: "readlink" }, { broken: "readlink" }] : []),
  { missing: "grep" },
  { broken: "grep" },
  { missing: "find" },
  { missing: "awk" },
])("worktree-trash lists nothing and says why when a check can't run: %o", (change) => {
  const run = trash(toolbox(Object.entries(change).flat().join("-"), change), repo);

  expect(run.exitCode).not.toBe(0);
  expect(run.stdout.toString()).toBe("");
  expect(run.stderr.toString()).toContain("so it lists nothing");
});

test("worktree-trash --remove removes only what it lists", () => {
  const run = trash(withoutFdRgGh, repo, "--remove");

  expect(run.stdout.toString()).toBe(`removed ${wt("merged")}\n`);
  expect(readdirSync(join(root, "wt")).toSorted()).toEqual([
    "dirty",
    "in-use",
    "locked",
    "recent",
    "unmerged",
    "worked",
    "worked-codex",
  ]);
});
