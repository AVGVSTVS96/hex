import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { transcript } from "./claude.ts";
import { busy } from "./running.ts";
import type { Session } from "./running.ts";
import type { Store } from "./store.ts";

const QUIET_MS = 30 * 60_000;

const writtenAt = (file: string) => statSync(file, { throwIfNoEntry: false })?.mtimeMs;

const inside = (dir: string) => {
  try {
    return readdirSync(dir).map((name) => join(dir, name));
  } catch {
    return [];
  }
};

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A session waiting on its agents writes nothing itself while they work, so their transcripts count as its own.
function lastWrite(cwd: string, session: string) {
  const file = transcript(cwd, session);
  const agents = join(file.replace(/\.jsonl$/u, ""), "subagents");
  const times = [file, ...inside(agents)].flatMap((each) => writtenAt(each) ?? []);

  return times.length > 0 ? Math.max(...times) : undefined;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A session of hex's that's mid-turn and has written nothing for a while signals stalled once for each quiet stretch, keyed by its last write.
export function stalled(store: Store, sessions: Iterable<Session>, now = Date.now()) {
  for (const session of sessions) {
    if (!busy(session) || session.thread === undefined || session.cwd === undefined) {
      continue;
    }

    const last = lastWrite(session.cwd, session.id);

    if (last === undefined || now - last < QUIET_MS) {
      continue;
    }

    store.scheduler.signal(
      "stalled",
      `${session.name ?? session.id} (session ${session.id}, thread ${session.thread}) is mid-turn and has written nothing since ${new Date(last).toISOString()}`,
      `${session.id}@${Math.floor(last)}`,
    );
  }
}
