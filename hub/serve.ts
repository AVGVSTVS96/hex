import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { ahead } from "./ahead.ts";
import { clients, engine } from "./apps.ts";
import { nightly } from "./backup.ts";
import { besideOf } from "./beside.ts";
import { free } from "./calls.ts";
import { up } from "./hub.ts";
import { answered, payOwedFacts, takeOver, whenLost, whenMoved } from "./kept.ts";
import { listen } from "./listen.ts";
import { cantStart, tellOwner } from "./notice.ts";
import { hexDir, open, stateDir, syncInBackground } from "./store.ts";
import { sent } from "./transcripts.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Before the clients load: Telegram's bot module awaits its polling loop, which never ends. A restart (HUP) and a stop (TERM, INT) end the hub alike: live calls hang up, the clients sign off, a call that came in while they did hangs up too, and once each hub's store has what was written to it, and what the sessions wrote of their transcripts, it exits for bin/hex to start the next one, so two never run at once. A stop also ends a hub still waiting for the port, and the clients stop taking in messages first, since the next hub may already be running elsewhere, with a live call's caller told that nothing answers here meanwhile.
let stopping: Promise<void> | undefined;

function tellACallAndDeafen() {
  engine.stops?.();

  return [...clients.values()].map(async (client) => await client.deafen?.());
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A hub hex's store refused for an older tenure lost hex to another machine: it stops as for a stop, and exits with this, for bin/hex to leave it stopped.
const LOST_HEX = 3;

const hangUpSignOffAndExit = (signal: NodeJS.Signals | "lost") =>
  (stopping ??= Promise.allSettled(signal === "SIGHUP" ? [] : tellACallAndDeafen())
    .then(free)
    .then(() =>
      Promise.allSettled(
        [...clients.values()].map(async (client) => {
          await client.close?.();
        }),
      ),
    )
    .then(free)
    .then(sent)
    .then(() =>
      Promise.allSettled(
        [...clients.values()].map(async (client) => {
          try {
            await client.hub.synced();
          } catch (error) {
            process.stderr.write(
              `hub: exits with what hex's store didn't take: ${String(error)}\n`,
            );
          }
        }),
      ),
    )
    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // A hub refused before any hub of its own read its spool still lands what it owed as fact.
    .then(async () =>
      signal === "lost" ? await payOwedFacts(stateDir(), (why) => void tellOwner(why)) : true,
    )
    .then(() => process.exit(signal === "lost" ? LOST_HEX : 0)));

for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void hangUpSignOffAndExit(signal));
}

whenLost((why) => {
  if (stopping === undefined) {
    process.stderr.write(`hub: another machine holds hex now (${why}), so this hub stops\n`);
    void hangUpSignOffAndExit("lost");
  }
});

whenMoved(() => {
  void hangUpSignOffAndExit("SIGHUP");
});

const hex = join(import.meta.dir, "..");
const channels = join(hex, "channels");

const Marketplace = z.object({ plugins: z.array(z.object({ source: z.string() })) });

const { plugins } = Marketplace.parse(
  JSON.parse(readFileSync(join(channels, ".claude-plugin/marketplace.json"), "utf-8")),
);

const sources = plugins.map((plugin) => join(channels, plugin.source));
const waiting = process.env.HEX_AHEAD;

if (waiting !== undefined && waiting !== "") {
  await ahead(waiting, sources);
}

syncInBackground();

const commit = Bun.spawnSync(["git", "-C", hex, "rev-parse", "-q", "--verify", "HEAD"])
  .stdout.toString()
  .trim();

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The hub takes hex over before it takes any message: every hub that claimed the store before it is refused from then on, and the store says which commit this one runs.
await answered(
  stateDir(),
  "this hub takes hex over",
  async (store) => {
    await takeOver(store, commit);
  },
  { tell: cantStart(stateDir()) },
);

await listen();

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Once General connects, hex works on the commit this hub runs, and bin/hex rolls a later one that can't start back to it. General then hears about a rollback that brought this hub up, or that hex is back after bin/hex told it hex couldn't start (state/down.<host>), and this hub backs up hex.db each night (backup.ts).

const home = hexDir();
const state = join(home, "state");
const rollback = join(state, "rollback");
const down = join(state, `down.${hostname()}`);

void (async () => {
  let doing = "waiting for General to connect";

  try {
    const general = await up;
    doing = "marking this hub's commit good";

    if (commit) {
      writeFileSync(join(state, "good"), `${commit}\n`);
    }

    const { main } = general;

    if (main === undefined) {
      return;
    }

    doing = "starting the nightly backup";
    nightly(state, home, main);

    const tell = async (what: string, body: string) =>
      await open(state).messages.deliver({
        key: `hub:${what}@${Date.now()}`,
        to: besideOf(main),
        from: "hub",
        author: "prompt",
        body,
        meta: { user: "hub" },
      });

    if (existsSync(down)) {
      const since = new Date(Number(readFileSync(down, "utf-8")) * 1000);
      const from = Number.isNaN(since.getTime()) ? "" : ` from ${since.toLocaleString()}`;
      doing = "telling General hex is back";
      await tell("back", `hex is back, on ${hostname()}: it couldn't start${from} until now.`);
      rmSync(down);
    }

    if (existsSync(rollback)) {
      doing = "telling General about the rollback";
      await tell("rollback", readFileSync(rollback, "utf-8").trim());
      rmSync(rollback);
    }
  } catch (error) {
    process.stderr.write(`hub: failed ${doing}: ${String(error)}\n`);
  }
})();

await Promise.all(sources.map((source) => import(join(source, "bot.ts"))));
