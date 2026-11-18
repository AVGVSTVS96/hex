import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { besideOf } from "../beside.ts";
import { record, settingsOf } from "../claude.ts";
import { command, filled, named, usage } from "../command.ts";
import type { Hex } from "../command.ts";
import { running } from "../running.ts";
import type { Thread } from "../store.ts";

export default command({
  usage: "hex deliver <from>[:<id>] --to <thread> [--beside] [--user <name>] <words…>",
  flags: {
    to: { type: "string" },
    beside: { type: "boolean" },
    user: { type: "string" },
  },
  wordsBeforeFlags: () => Infinity,
  async run(hex) {
    const [given, ...words] = hex.args;
    const from = given?.split(":")[0];

    if (!filled(given) || !filled(from) || !filled(hex.flags.to) || words.length === 0) {
      usage(hex);
    }

    const key = from === given ? `${from}:${crypto.randomUUID()}` : given;
    const thread = await recipient(hex, hex.flags.to);
    await hex.store.messages.deliver({
      key,
      to: hex.flags.beside === true ? besideOf(thread) : thread,
      from,
      author: "prompt",
      body: words.join(" "),
      meta: { user: hex.flags.user ?? from },
    });
  },
});

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// a delivery goes only to a thread, since only a thread's session takes messages; a closed thread takes it once it opens again.
async function recipient(hex: Hex, to: string): Promise<string> {
  const all = await named(hex, to);
  const matches = all.some(({ open }) => open) ? all.filter(({ open }) => open) : all;

  if (matches.length > 1) {
    throw new Error(
      `more than one thread is named "${to}", so send to one by its id: ${matches.map(({ app, thread }) => `${app}:${thread}`).join(", ")}`,
    );
  }

  const thread = matches[0] ?? (await workingFor(hex, to));

  if (!thread.open) {
    console.error(`hex: the thread ${thread.thread} is closed, so this waits until it opens again`);
  }

  return thread.thread;
}

async function workingFor(hex: Hex, given: string) {
  if (!/^[0-9a-f]{8}(-[0-9a-f-]*)?$/iu.test(given)) {
    throw new Error(`no thread is "${given}" (hex threads lists them)`);
  }

  const to = given.toLowerCase();
  const threads = await hex.store.threads.list();

  const held = new Map(
    threads
      .toSorted((a, b) => Number(a.open) - Number(b.open))
      .flatMap((thread): [string, Thread][] =>
        filled(thread.session) ? [[thread.session, thread]] : [],
      ),
  );

  const live = await running(hex.store);
  const nameOf = (id: string) => live.get(id)?.name;

  const labelled = (id: string) => {
    const name = nameOf(id);

    return filled(name) ? `${id} (${name})` : id;
  };

  const matches = [...new Set([...held.keys(), ...live.keys()])]
    .filter((id) => id.startsWith(to))
    .toSorted();

  if (matches.length > 1) {
    throw new Error(
      `${given} starts more than one session's id: ${matches.map(labelled).join(", ")}`,
    );
  }

  const [id] = matches;

  if (!filled(id)) {
    throw new Error(
      `no thread or running session is ${given} (hex threads and hex running list them)`,
    );
  }

  const job = live.get(id)?.job;
  const short = live.has(id) && !filled(job) && record(id.slice(0, 8)).sessionId === id;

  const bound =
    filled(job) || short
      ? settingsOf({ sessionId: id, pid: 0, ...(job !== undefined && { id: job }) })?.env
      : undefined;

  const boundStore = bound?.HEX_STORE;

  const thread =
    held.get(id) ??
    (filled(boundStore) && real(boundStore) === real(hex.state)
      ? threads.find((each) => each.thread === bound?.HEX_THREAD)
      : undefined);

  if (thread) {
    return thread;
  }

  const name = nameOf(id);

  throw new Error(
    `${labelled(id)} is a session no thread holds, so it would never take this message${filled(name) ? `: message it with Claude Code's SendMessage to "${name}"` : ""}`,
  );
}

function real(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
