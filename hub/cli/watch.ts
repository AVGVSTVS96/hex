import { appendFileSync, existsSync, mkdirSync, statSync, watch } from "node:fs";
import { dirname, join } from "node:path";

import { command } from "../command.ts";
import { awayFile } from "../store.ts";
import type { Store } from "../store.ts";

export default command({
  usage: "hex watch",
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // While hex's records are in hex.db, watch opens no store, so a restore can replace hex.db underneath it.
  async run(hex) {
    await (existsSync(awayFile(hex.state))
      ? followAway(hex.store)
      : follow(join(hex.state, "hex.bell")));
  },
});

function follow(bell: string): Promise<never> {
  mkdirSync(dirname(bell), { recursive: true });
  appendFileSync(bell, "");
  let size = -1;
  let timer: Timer | undefined;

  const check = () => {
    timer = undefined;
    const now = statSync(bell).size;

    if (now === size) {
      return;
    }

    size = now;
    process.stdout.write(`${new Date().toISOString()}\n`, (error) => {
      if (error) {
        process.exit("code" in error && error.code === "EPIPE" ? 0 : 1);
      }
    });
    // Bun's fs.watch can drop a change right after the last one: https://github.com/oven-sh/bun/issues/45954
    timer = setTimeout(check, 50);
  };

  return new Promise(() => {
    watch(bell, () => {
      timer ??= setTimeout(check, 50);
    });
    check();
  });
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Records that live in an object ring over its socket, once as it connects and after every write.
function followAway(away: Store): Promise<never> {
  return new Promise(() => {
    away.watch(() => {
      process.stdout.write(`${new Date().toISOString()}\n`, (error) => {
        if (error) {
          process.exit("code" in error && error.code === "EPIPE" ? 0 : 1);
        }
      });
    });
  });
}
