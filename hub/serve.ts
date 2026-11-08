import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { nightly } from "./backup.ts";
import { clients, free, listen, up } from "./hub.ts";
import { hexDir } from "./store.ts";

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
