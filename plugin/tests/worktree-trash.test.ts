import { afterAll, beforeAll, expect, test } from "bun:test";
import {
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

const withoutFdRgGh = join(root, "without-fd-rg-gh");

mkdirSync(withoutFdRgGh);

for (const tool of ["git", "awk", "sed", "find", "grep", "readlink", "lsof", "sh"]) {
  const path = Bun.which(tool);

  if (path !== null) {
    symlinkSync(path, join(withoutFdRgGh, tool));
  }
}

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

  for (const name of ["dirty", "in-use", "recent", "worked", "unmerged", "locked"]) {
    git(repo, "worktree", "add", "-qb", name, wt(name), "origin/main");
  }

  commit(wt("unmerged"), "c");
  git(repo, "worktree", "lock", wt("locked"));
  writeFileSync(join(wt("dirty"), "notes"), "work");
  mkdirSync(join(wt("worked"), "src"));

  for (const name of ["merged", "dirty", "in-use", "worked", "unmerged", "locked"]) {
    age(wt(name));
  }

  const transcripts = join(home, ".claude/projects/worked");
  mkdirSync(transcripts, { recursive: true });
  writeFileSync(
    join(transcripts, "session.jsonl"),
    `${JSON.stringify({ type: "user", cwd: join(wt("worked"), "src") })}\n`,
  );

  sleeper = Bun.spawn(["sleep", "60"], { cwd: wt("in-use") });
});

afterAll(() => {
  sleeper.kill();
  rmSync(root, { recursive: true, force: true });
});

const trash = (path: string, ...args: string[]) =>
  Bun.spawnSync([TRASH, repo, ...args], {
    env: { PATH: path, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });

test.each([
  ["with fd, rg and gh", process.env.PATH ?? ""],
  ["with only git and the POSIX tools", withoutFdRgGh],
])("worktree-trash %s lists only the merged worktree nobody is working in", (_, path) => {
  const run = trash(path);

  expect(run.stderr.toString()).toBe("");
  expect(run.stdout.toString()).toBe(`${wt("merged")}\n`);
});

test("worktree-trash --remove removes only what it lists", () => {
  const run = trash(withoutFdRgGh, "--remove");

  expect(run.stdout.toString()).toBe(`removed ${wt("merged")}\n`);
  expect(readdirSync(join(root, "wt")).toSorted()).toEqual([
    "dirty",
    "in-use",
    "locked",
    "recent",
    "unmerged",
    "worked",
  ]);
});
