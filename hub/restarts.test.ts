import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { restarts } from "./restarts.ts";
import { open } from "./store.ts";
import type { Store } from "./store.ts";
import { until } from "./until.ts";

let dir: string;
let store: Store;

const restart = (unit: string, count: number) =>
  JSON.stringify({
    USER_UNIT: unit,
    N_RESTARTS: String(count),
    __CURSOR: `s=1;i=${unit}-${count}`,
    MESSAGE: `${unit}: Scheduled restart job, restart counter is at ${count}.`,
  });

const journal = (...lines: string[]) => {
  const file = join(dir, "journal");
  writeFileSync(file, `${lines.join("\n")}\n`);

  return ["sh", "-c", `cat ${file}; exec sleep 60`];
};

const prompts = () =>
  store.messages
    .since()
    .filter((message) => message.from === "restarts" && message.to === "-100:1");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "restarts-"));
  store = open(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("a unit that keeps failing reaches General once, when systemd has restarted it as many times as its start limit allows", async () => {
  const stop = restarts(
    dir,
    "-100:1",
    journal(...[1, 2, 3, 4, 5, 6, 7].map((count) => restart("klarity.service", count)), "not json"),
    5,
  );

  await until(() => prompts().length > 0);
  await Bun.sleep(50);
  stop();

  expect(prompts().map((message) => message.body)).toEqual([
    "[restarts] klarity.service keeps failing: systemd has restarted it 5 times in a row and goes on restarting it. `journalctl --user -u klarity.service` shows why.",
  ]);
});

test("a unit that recovers before the limit, or a restart read again after the hub restarts, adds nothing", async () => {
  const lines = [
    restart("netwatcher.service", 1),
    restart("netwatcher.service", 2),
    restart("hex-web.service", 5),
  ];

  const first = restarts(dir, "-100:1", journal(...lines), 5);

  await until(() => prompts().length > 0);
  first();

  const again = restarts(dir, "-100:1", journal(...lines), 5);

  await Bun.sleep(200);
  again();

  expect(prompts().map((message) => message.body.split(" ")[1])).toEqual(["hex-web.service"]);
});
