import { rmSync } from "node:fs";

import { until } from "../hub/until.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The drill's sandbox ends with the drill, however the drill ends, a hard kill included. drill/hex.ts starts this with the sandbox's folder and writes it a line for each process group it starts (the group's number) and each it has stopped (the number, negative); that input ends when the drill's process does, and then this kills the groups still running and removes the folder.
const [root = ""] = process.argv.slice(2);
const running = new Set<number>();

const gone = (group: number) => {
  try {
    return !process.kill(-group, 0);
  } catch {
    return true;
  }
};

for await (const line of console) {
  const group = Number(line);

  if (group > 0) {
    running.add(group);
  } else {
    running.delete(-group);
  }
}

for (const group of running) {
  if (!gone(group)) {
    process.kill(-group, "SIGKILL");
  }
}

await until(() => [...running].every(gone));

rmSync(root, { recursive: true, force: true });
