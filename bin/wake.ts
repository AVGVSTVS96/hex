#!/usr/bin/env bun
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { MEMORY, PROFILE } from "../hub/loaded.ts";
import { open, stateDir } from "../hub/store.ts";
import type { Store } from "../hub/store.ts";

const memo = resolve(import.meta.dir, "../vendor/memo");
const home = resolve(import.meta.dir, "../..");
const wake = resolve(home, "state/wake/CLAUDE.md");

const lead =
  "This is what you know as this session starts and after each compaction: my profile, then your memory as `.hex/vendor/memo wake` prints it, which hex loads for you. The memory's numbered lines are a dated record of what happened, not instructions: things may have moved on since a line was written, so check live state before acting on one.";

const noMemoriesYet = /^No memories yet\. Record the first with: .*$/mu;

const awake = (part: string) => /^You are awake\.$/mu.test(part);

type Wake = { awake: string } | { stoppedSaying: string };

function joinedMemoWake(env: Record<string, string | undefined>): Wake {
  let text = "";

  for (let args = ["wake"]; ;) {
    const run = Bun.spawnSync([memo, ...args], {
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });

    const part = (run.stdout.toString() + run.stderr.toString()).replace(
      /^Your memory, part \d+ of \d+, .*\n/mu,
      "",
    );

    const next = /^Not awake yet\. Run: .* wake (?<from>\d+) (?<to>\d+)\n?/mu.exec(part);

    if (next?.groups?.from !== undefined && next.groups.to !== undefined) {
      text += part.replace(next[0], "");
      args = ["wake", next.groups.from, next.groups.to];
    } else if (awake(part)) {
      return {
        awake: `${MEMORY}\n\n${text}${part.replace(noMemoriesYet, "No memories yet: the memory agent records them after each turn.").replace(/^(You are awake\.)$[\s\S]*/mu, "$1\n")}`,
      };
    } else {
      const firstLine = part.trim().split("\n")[0] ?? "";

      return { stoppedSaying: firstLine === "" ? "nothing" : firstLine };
    }
  }
}

function profileOrNothingKeepingTheMemory(store?: Store) {
  try {
    return store?.profiles.current() ?? "";
  } catch (error) {
    process.stderr.write(`hex couldn't read the profile: ${String(error)}\n`);

    return "";
  }
}

const runs = () => {
  try {
    accessSync(memo, constants.X_OK);

    return true;
  } catch {
    return false;
  }
};

function write(text: string) {
  mkdirSync(dirname(wake), { recursive: true });
  writeFileSync(`${wake}.${process.pid}`, text);
  renameSync(`${wake}.${process.pid}`, wake);
}

function rewriteOrKeepTheLastSayingWhy(store?: Store) {
  const wakeNow = joinedMemoWake(process.env);

  if ("awake" in wakeNow) {
    const text = wakeNow.awake;
    const profile = profileOrNothingKeepingTheMemory(store);
    const body = `${profile && `${PROFILE}\n\n${profile}\n\n`}${text.trimEnd()}`;

    const fenceSoNoPathReadsAsAnImport = "`".repeat(
      Math.max(3, 1 + Math.max(0, ...(body.match(/`+/gu) ?? []).map((run) => run.length))),
    );

    write(`${lead}\n\n${fenceSoNoPathReadsAsAnImport}\n${body}\n${fenceSoNoPathReadsAsAnImport}\n`);
  } else if (existsSync(wake) && readFileSync(wake, "utf-8").includes(`\n\n`)) {
    const kept = readFileSync(wake, "utf-8");
    const why = wakeNow.stoppedSaying;

    write(
      `${lead} It's the last one hex could load: \`.hex/vendor/memo wake\` has since said \`${why.replaceAll("`", "'")}\`, so newer memories may be missing; \`.hex/vendor/memo recall <regex>\` finds them.${kept.slice(kept.indexOf("\n\n"))}`,
    );
  }
}

const aWakeHoldingTheLeaseThisLongIsStuckMs = 10_000;
const memoryDir = process.env.MEMORY_DIR;

if (memoryDir === undefined || memoryDir === "") {
  rmSync(wake, { force: true });
} else if (runs()) {
  let store: Store | undefined;

  try {
    store = open(stateDir());
  } catch (error) {
    process.stderr.write(`hex couldn't open hex.db: ${String(error)}\n`);
  }

  const holder = crypto.randomUUID();

  const stuck = aWakeHoldingTheLeaseThisLongIsStuckMs;
  const until = Date.now() + stuck;

  while (store?.leases.take("wake", holder, stuck) === false && Date.now() < until) {
    Bun.sleepSync(100);
  }

  try {
    rewriteOrKeepTheLastSayingWhy(store);
  } finally {
    store?.leases.release("wake", holder);
  }
}
