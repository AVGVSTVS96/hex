import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { open } from "../../hub/store.ts";

const HEX = join(import.meta.dir, "../..");
const home = mkdtempSync(join(tmpdir(), "update-"));
const hex = join(home, ".hex");
const state = join(home, "state");

afterAll(() => {
  rmSync(home, { recursive: true });
});

const git = (...args: string[]) =>
  Bun.spawnSync(
    ["git", "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { cwd: hex },
  )
    .stdout.toString()
    .trim();

test("an update tells each thread that asked for it once what it asked for is live, and keeps the rest waiting", () => {
  for (const file of ["bin/update", "bin/job", "hub"]) {
    cpSync(join(HEX, file), join(hex, file), { recursive: true, dereference: true });
  }

  open(state).threads.keep("telegram", { "-100:1": { name: "one" }, "-100:2": { name: "two" } });
  Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", join(home, "origin.git")]);
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-qm", "hex");
  git("remote", "add", "origin", join(home, "origin.git"));
  git("push", "-q", "origin", "main");
  const live = git("rev-parse", "HEAD");
  const later = "0".repeat(40);
  writeFileSync(
    join(state, "update-askers"),
    `a@1 telegram:-100:1 ${live}\nb@2 telegram:-100:1 ${live}\nc@3 telegram:-100:2 ${later}\n`,
  );

  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("HEX_") && name !== "CLAUDE_CODE_SESSION_ID",
    ),
  );

  const done = Bun.spawnSync([join(hex, "bin/update")], { env: { ...env, HEX_STORE: state } });
  expect(done.stdout.toString()).toStartWith("up to date at");

  const told = z
    .array(z.object({ to: z.string(), body: z.string() }))
    .parse(new Database(join(state, "hex.db")).query('select "to", body from messages').all());

  expect(told.map(({ to }) => to)).toEqual(["-100:1"]);
  expect(told[0]?.body).toContain(`[job] hex-update shipped: hex is live at ${live.slice(0, 7)}`);
  expect(readFileSync(join(state, "update-askers"), "utf-8")).toBe(
    `c@3 telegram:-100:2 ${later}\n`,
  );
});
