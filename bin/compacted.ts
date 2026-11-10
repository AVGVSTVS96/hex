#!/usr/bin/env bun
import { join } from "node:path";

import { z } from "zod";

import { ROOM } from "../hub/fit.ts";
import { open, stateDir } from "../hub/store.ts";

const Hook = z.object({ session_id: z.string().optional(), source: z.string().optional() });

const hook = Hook.parse(JSON.parse((await Bun.stdin.text()) || "{}"));
const hubThreadOrTerminalSession = [process.env.HEX_THREAD, hook.session_id].find(Boolean);
const takesOverFrom = process.env.HEX_HANDOFF;
const handoff = hook.source === "startup" && takesOverFrom !== undefined && takesOverFrom !== "";

if (hubThreadOrTerminalSession === undefined || (hook.source !== "compact" && !handoff)) {
  process.exit(0);
}

const hex = join(import.meta.dir, "hex");
const thread = hubThreadOrTerminalSession;

function statusPost() {
  try {
    const note = open(stateDir())
      .pins.list({ thread })
      .at(0)
      ?.note.slice(0, ROOM / 3);

    return note === undefined || note === "" ? "" : `This thread's status post:\n\n${note}\n\n`;
  } catch {
    return "";
  }
}

const lead = handoff
  ? `You're a new session taking over this thread from one whose prompt cache had expired, so its context wasn't carried over. ${statusPost()}These are the conversation's newest messages, word for word, from \`${hex} log\`; the open tasks and questions waiting on me come with them. \`${hex} log -- '${thread}'\` has the messages before these, and the old session's transcript, ${takesOverFrom}, has what its tools did and showed, like what an agent or job it started was for. Read back only what the next message needs.`
  : `Your context was just compacted. These are the conversation's newest messages, word for word, from \`${hex} log\`; \`${hex} log -- '${thread}'\` has any before them, and the summary above has what you did in the turn in progress.`;

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
} else if (handoff) {
  console.log(lead);
}
