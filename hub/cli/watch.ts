import { appendFileSync, existsSync, mkdirSync, statSync, watch } from "node:fs";
import { dirname, join } from "node:path";

import { command } from "../command.ts";
import { awayFile } from "../store.ts";
import type { Store } from "../store.ts";

export default command({
  usage: "hex watch",
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
    // WARNING: Bun's fs.watch can drop a change right after the last one: https://github.com/oven-sh/bun/issues/45954
    timer = setTimeout(check, 50);
  };

  return new Promise(() => {
    watch(bell, () => {
      timer ??= setTimeout(check, 50);
    });
    check();
  });
}

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
