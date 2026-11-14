import { z } from "zod";

import { besideWhat } from "./beside.ts";
import { ROOM } from "./fit.ts";
import { open, stateDir } from "./store.ts";
import type { Row, Store } from "./store.ts";

const Hook = z.object({
  session_id: z.string().optional(),
  prompt: z.string().optional().catch(undefined),
});

const KEY_ON_OPENING_CHANNEL_TAG = /^<channel source="[^"]*" key="([^"]+)"/u;
const WORDS_A_MESSAGE_SHOWS = 600;

const words = (body: string) => {
  const text = body.trim();

  const shown =
    text.length > WORDS_A_MESSAGE_SHOWS ? `${text.slice(0, WORDS_A_MESSAGE_SHOWS - 1)}…` : text;

  return shown.replaceAll("\n", "\n  ");
};

const line = (row: Row & { job?: string; ended?: boolean }) =>
  `- ${row.at.slice(0, 16).replace("T", " ")}Z${row.job === undefined ? "" : ` [${row.job}]`}${row.ended === true ? " (its last words, not sent)" : ""}: ${words(row.body)}`;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The newest that fit the room, oldest first.
function newest(rows: (Row & { job?: string; ended?: boolean })[], room: number) {
  const shown: string[] = [];
  let left = room;

  for (const row of rows) {
    const each = line(row);
    left -= each.length + 1;

    if (left < 0) {
      break;
    }

    shown.unshift(each);
  }

  return shown;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What a thread's session is shown at its prompt: what hex's other sessions said in its chat since it was last shown, so it knows what the owner is answering; and for a timed job run beside the thread, what that job's earlier runs said there, so it tells the owner nothing twice.
export function said(store: Store, thread: string, session: string, prompt = ""): string {
  const since = store.seen.get(session, "said");
  const key = KEY_ON_OPENING_CHANNEL_TAG.exec(prompt)?.[1];
  const row = key === undefined ? null : store.messages.get(key);
  const schedule = row?.meta?.schedule;

  const runs =
    row !== null && besideWhat(row.to) !== undefined && schedule !== undefined
      ? store.messages.saidByEarlierRuns(row.to, thread, schedule, session)
      : [];

  const earlier = newest(
    runs.map((run) => ({ ...run, ended: run.to !== thread })),
    ROOM / 2,
  );

  const shownAsRuns = new Set(runs.map((run) => run.key));

  const others = newest(
    store.messages
      .saidByOthers(thread, session, since)
      .filter((each) => !shownAsRuns.has(each.key)),
    ROOM - earlier.join("\n").length,
  );

  store.seen.show(session, "said", new Date().toISOString());

  return [
    others.length > 0
      ? `Said in this chat by hex's other sessions${since === "" ? "" : " since your last turn"}, which the owner may be answering:\n${others.join("\n")}`
      : "",
    earlier.length > 0
      ? `What earlier runs of [${schedule}] said in this chat, and the last words each ended with, so you don't tell the owner again and go on from what they found:\n${earlier.join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

if (import.meta.main) {
  try {
    const { session_id: session, prompt } = Hook.parse(
      JSON.parse((await Bun.stdin.text()) || "{}"),
    );

    const thread = process.env.HEX_THREAD;

    if (session !== undefined && session !== "" && thread !== undefined && thread !== "") {
      const out = said(open(stateDir()), thread, session, prompt);

      if (out !== "") {
        console.log(out);
      }
    }
  } catch (error) {
    console.error(`hex couldn't tell what its other sessions said here: ${String(error)}`);
  }
}
