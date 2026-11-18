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

function lastWrite(cwd: string, session: string) {
  const file = transcript(cwd, session);
  const agents = join(file.replace(/\.jsonl$/u, ""), "subagents");
  const times = [file, ...inside(agents)].flatMap((each) => writtenAt(each) ?? []);

  return times.length > 0 ? Math.max(...times) : undefined;
}

export async function stalled(store: Store, sessions: Iterable<Session>, now = Date.now()) {
  for (const session of sessions) {
    if (!busy(session) || session.thread === undefined || session.cwd === undefined) {
      continue;
    }

    const last = lastWrite(session.cwd, session.id);

    if (last === undefined || now - last < QUIET_MS) {
      continue;
    }

    await store.scheduler.signal(
      "stalled",
      `${session.name ?? session.id} (session ${session.id}, thread ${session.thread}) is mid-turn and has written nothing since ${new Date(last).toISOString()}`,
      `${session.id}@${Math.floor(last)}`,
    );
  }
}
