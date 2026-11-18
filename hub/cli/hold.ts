import { dirname } from "node:path";

import { command, filled, heldBySession, named, usage } from "../command.ts";
import type { Hex } from "../command.ts";
import { instant, line, place } from "../holds.ts";
import { busy, running, served, serving } from "../running.ts";
import { zoneOf } from "../zone.ts";

export default command({
  usage: `hex hold <thread…> --why '<what the hold is for>' [--until 'YYYY-MM-DD HH:MM'] [--key <the owner's message>]
hex hold end <hold> [<thread…>] --why '<what ends it>' [--key <the owner's message>]`,
  flags: {
    why: { type: "string" },
    until: { type: "string" },
    key: { type: "string" },
  },
  wordsBeforeFlags: () => Infinity,
  async run(hex) {
    const { flags, store } = hex;
    const zone = zoneOf(dirname(hex.state));

    if (filled(flags.key) && !(await store.messages.get(flags.key))) {
      throw new Error(`no message ${flags.key}`);
    }

    if (hex.args[0] === "end") {
      const [, id, ...threads] = hex.args;

      if (!filled(id) || !filled(flags.why)) {
        usage(hex);
      }

      const existing = await store.holds.get(id);

      if (!existing) {
        throw new Error(`no hold ${id}`);
      }

      const freed = await store.holds.unhold(
        id,
        `${flags.why}${filled(flags.key) ? ` [${flags.key}]` : ""}`,
        threads.length > 0
          ? await holdable(
              hex,
              threads,
              existing.threads.map(({ thread }) => thread),
            )
          : undefined,
      );

      const names = await store.threads.names();
      console.log(
        freed.length > 0
          ? `${id} freed ${freed.map((thread) => names[thread] ?? thread).join(", ")}; hex wakes each that worked while held, a couple at a time`
          : `${id} held none of them any more`,
      );

      return;
    }

    if (hex.args.length === 0 || !filled(flags.why)) {
      usage(hex);
    }

    const by = await store.threads.key(
      [process.env.HEX_THREAD, served()].find(filled) ?? "terminal",
    );

    const placed = await place(
      store,
      {
        threads: await holdable(hex, hex.args),
        by,
        why: flags.why,
        message: flags.key,
        until: filled(flags.until) ? instant(flags.until, zone) : undefined,
      },
      { working: await working(hex), ...(zone !== undefined && { zone }) },
    );

    console.log(await line(placed, store, zone));
  },
});

async function holdable(hex: Hex, names: string[], among?: string[]) {
  return await Promise.all(
    names.map(async (given) => {
      const all = await named(hex, given);

      const matches = among
        ? all.filter(({ thread }) => among.includes(thread))
        : all.some(({ open }) => open)
          ? all.filter(({ open }) => open)
          : all;

      const [first] = matches;

      if (first !== undefined && matches.length === 1) {
        return first.thread;
      }

      if (matches.length > 0) {
        throw new Error(
          `more than one thread is named "${given}", so name one by its id: ${matches.map(({ app, thread }) => `${app}:${thread}`).join(", ")}`,
        );
      }

      throw new Error(
        all.length > 0
          ? `that hold doesn't hold "${given}"`
          : `no thread is "${given}" (hex threads lists them; quote every value that has spaces)`,
      );
    }),
  );
}

async function working(hex: Hex) {
  const threads = await hex.store.threads.list({ open: true });
  const held = heldBySession(threads);

  const sessions = await running(hex.store);

  const busyNow = [...sessions.values()]
    .filter((session) => busy(session) || session.state === "working")
    .flatMap((session) => serving(session, held, sessions) ?? []);

  const atWork = await Promise.all(
    threads.map(async ({ session }) => filled(session) && (await hex.store.turns.atWork(session))),
  );

  return new Set([
    ...(await Promise.all(busyNow.map((thread) => hex.store.threads.key(thread)))),
    ...threads.filter((_, at) => atWork[at] === true).map(({ thread }) => thread),
  ]);
}
