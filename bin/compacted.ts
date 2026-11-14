#!/usr/bin/env bun
import { basename, join } from "node:path";

import { z } from "zod";

import { ROOM } from "../hub/fit.ts";
import { stateDir } from "../hub/store.ts";

const Hook = z.object({ session_id: z.string().optional(), source: z.string().optional() });

const hook = Hook.parse(JSON.parse((await Bun.stdin.text()) || "{}"));
const hubThreadOrTerminalSession = [process.env.HEX_THREAD, hook.session_id].find(Boolean);
const takesOverFrom = process.env.HEX_HANDOFF;
const handoff = hook.source === "startup" && takesOverFrom !== undefined && takesOverFrom !== "";

if (hubThreadOrTerminalSession === undefined || (hook.source !== "compact" && !handoff)) {
  process.exit(0);
}

if (handoff) {
  console.log(
    `You're continuing this thread from session ${basename(takesOverFrom, ".jsonl")}: ${takesOverFrom}`,
  );
  process.exit(0);
}

const hex = join(import.meta.dir, "hex");
const thread = hubThreadOrTerminalSession;
const lead = `Your context was just compacted. These are the conversation's newest messages, word for word, from \`${hex} log\`; \`${hex} log -- '${thread}'\` has any before them, and the summary above has what you did in the turn in progress.`;

const newestWholeMessagesThatFitAHook = Bun.spawnSync(
  [
    process.execPath,
    join(import.meta.dir, "../hub/cli.ts"),
    stateDir(),
    "log",
    "--last",
    "200",
    "--taken",
    "--room",
    String(Math.max(0, ROOM - lead.length - 2)),
    "--",
    thread,
  ],
  { stderr: "ignore" },
);

const log = newestWholeMessagesThatFitAHook.stdout.toString().trimEnd();

if (newestWholeMessagesThatFitAHook.exitCode === 0 && log !== "") {
  console.log(`${lead}\n\n${log}`);
}
