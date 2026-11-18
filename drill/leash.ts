import { rmSync } from "node:fs";

import { until } from "../hub/until.ts";

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
