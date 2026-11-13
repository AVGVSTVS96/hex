import { join } from "node:path";

import { z } from "zod";

import { besideWhat } from "./beside.ts";
import { served } from "./running.ts";
import { open, spoken, stateDir } from "./store.ts";
import type { Row, Store } from "./store.ts";

const wordlessKinds = ["reaction", "deleted", "vote_removed", "took_back"];

function saysWords(row: Row): boolean {
  return spoken(row) !== "" && !wordlessKinds.some((kind) => (row.meta?.[kind] ?? "") !== "");
}

function keyOfEditedMessageOrOwn(row: Row | undefined): string | undefined {
  const edited = row?.meta?.edited ?? "";

  return row !== undefined && edited !== ""
    ? row.key.slice(0, row.key.lastIndexOf(":") + 1) + String(row.meta?.message_id)
    : row?.key;
}

const present = (text: string | undefined): text is string => text !== undefined && text !== "";

export function origin(
  store: Store,
  owner: string | undefined,
  takenBefore?: string,
  hex = join(import.meta.dir, ".."),
): string | undefined {
  if (!present(owner)) {
    return;
  }

  const thread = store.threads.key(owner);
  const names = store.threads.names();

  if (!(thread in names)) {
    return besideRun(store, thread, names, hex);
  }

  const newestWords = store.messages
    .said(thread, -1, takenBefore)
    .findLast(
      (row) =>
        row.taken !== undefined &&
        (!present(takenBefore) || row.taken.at < takenBefore) &&
        saysWords(row),
    );

  const message = keyOfEditedMessageOrOwn(newestWords);
  const name = names[thread];
  const log = `\`${hex}/bin/hex log --last 100 -- '${thread}'\` prints its newest 100 messages (without --last, all of it)`;

  return `This work comes from my conversation${present(name) ? ` in ${name}` : ""}: ${present(message) ? `${log}, and \`${hex}/bin/hex message ${message}\` my newest message there, word for word.` : `${log}.`}`;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A session beside a thread worked for the row it was started for, not for the owner's newest words there.
function besideRun(store: Store, session: string, names: Record<string, string>, hex: string) {
  const ran = store.messages.ranFor(session);
  const thread = ran === null ? undefined : besideWhat(ran.to);

  if (ran === null || thread === undefined) {
    return;
  }

  return `This work comes from hex's run beside my conversation in ${names[thread] ?? thread}: \`${hex}/bin/hex message ${ran.key}\` prints what it was started for, and \`${hex}/bin/hex log -- '${session}'\` what reached it since.`;
}

const JOB =
  "You are a job, so your memory isn't loaded: work from your prompt, and leave `memo` to the session that started you.";

const HookInput = z.object({ hook_event_name: z.string().optional() });

function handoffLine(event: string | undefined): string | undefined {
  const thread = served({
    HEX_CHANNEL: process.env.HEX_CHANNEL,
    HEX_THREAD: process.env.HEX_THREAD,
  });

  const { HEX_BESIDE } = process.env;

  const runBeside =
    thread !== undefined && present(HEX_BESIDE) ? `${thread.split(":")[0]}:${HEX_BESIDE}` : thread;

  const owner = runBeside ?? process.env.HEX_FROM;
  const threadSubagentOrJob = event === "SubagentStart" || thread === undefined;

  const from =
    present(owner) && threadSubagentOrJob
      ? origin(open(stateDir()), owner, thread === undefined ? process.env.HEX_FROM_AT : undefined)
      : undefined;

  const job = thread === undefined && event !== "SubagentStart" && present(process.env.HEX_OWNER);

  return job ? [JOB, from].filter(present).join(" ") : from;
}

if (import.meta.main) {
  try {
    const input = (await Bun.stdin.text()) || "{}";
    const { hook_event_name: event } = HookInput.parse(JSON.parse(input));
    const line = handoffLine(event);

    if (present(line)) {
      console.log(
        JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: line } }),
      );
    }
  } catch (error) {
    console.error(`hex couldn't say where this work came from: ${String(error)}`);
  }
}
