import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { nightly } from "./backup.ts";
import { clients, free, listen, up } from "./hub.ts";
import { hexDir } from "./store.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Before the clients load: Telegram's bot module awaits its polling loop, which never ends. A restart (HUP) and a stop (TERM, INT) end the hub alike: live calls hang up, the clients sign off, a call that came in while they did hangs up too, and it exits for bin/hex to start the next one, so two never run at once. A stop also ends a hub still waiting for the port.
let stopping: Promise<void> | undefined;

const hangUpSignOffAndExit = () =>
  (stopping ??= free()
    .then(() =>
      Promise.allSettled(
        [...clients.values()].map(async (client) => {
          await client.close?.();
        }),
      ),
    )
    .then(free)
    .then(() => process.exit(0)));

for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void hangUpSignOffAndExit());
}

await listen();

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Once General connects, hex works on the commit this hub runs, and bin/hex rolls a later one that can't start back to it. General then hears about a rollback that brought this hub up, and this hub backs up hex.db each night (backup.ts).
const hex = join(import.meta.dir, "..");

const commit = Bun.spawnSync(["git", "-C", hex, "rev-parse", "-q", "--verify", "HEAD"])
  .stdout.toString()
  .trim();

const home = hexDir();
const state = join(home, "state");
const rollback = join(state, "rollback");

void (async () => {
  const general = await up;

  if (commit) {
    writeFileSync(join(state, "good"), `${commit}\n`);
  }

  const { main } = general;

  if (main === undefined) {
    return;
  }

  nightly(state, home, main);

  if (!existsSync(rollback)) {
    return;
  }

  general.deliver(main, general.name(main) ?? "hex", {
    content: readFileSync(rollback, "utf-8").trim(),
    author: "prompt",
    meta: { user: "hex" },
  });
  rmSync(rollback);
})();

const channels = join(hex, "channels");

const Marketplace = z.object({ plugins: z.array(z.object({ source: z.string() })) });

const { plugins } = Marketplace.parse(
  JSON.parse(readFileSync(join(channels, ".claude-plugin/marketplace.json"), "utf-8")),
);

await Promise.all(plugins.map((plugin) => import(join(channels, plugin.source, "bot.ts"))));
