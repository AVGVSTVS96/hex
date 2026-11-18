import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type { Note, Owing } from "./kept.ts";
import type { NewRow } from "./store.ts";
import type { Threads } from "./threads.ts";
import type { Message } from "./waiting.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What hex said in the app's threads, each kept under the session that said it. callingAs runs a tool call as its session, so what the tool sends, into any thread, is kept as that session's words.
export function wordsSent({
  threads,
  owing,
  app,
}: {
  threads: Threads;
  owing: Owing;
  app: string;
}) {
  const { kept, must } = owing;

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The session that made the tool call in progress.
  const caller = new AsyncLocalStorage<string | undefined>();

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // What hex said in a thread, kept as its session sent it: a reply, a post, a failed send with meta.failed. The session that wrote it has it already, so it wakes nothing.
  async function sent(
    thread: string,
    { key, content, meta = {} }: Partial<Message> & { content: string },
  ) {
    const row: NewRow = {
      key: `${app}:${key ?? randomUUID()}`,
      to: thread,
      from: app,
      author: "hex",
      body: content,
      meta,
    };

    const by = caller.getStore() ?? threads.current(thread) ?? "hub";
    await must({ kind: "deliver", row, by }, false);
  }

  return {
    sent,
    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // The questions ledger's note of what hex said, owed like the words themselves, so a store that doesn't answer never fails a reply the owner already has.
    noted: async (note: Note) => {
      await must(note, undefined);
    },
    said: (key: string) => kept((store) => store.messages.latest(`${app}:${key}`), null),
    callingAs: <Result>(session: string | undefined, run: () => Result) => caller.run(session, run),
  };
}
