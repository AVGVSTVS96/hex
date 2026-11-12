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

const restart = (unit: string, at: number, counter: number) =>
  JSON.stringify({
    USER_UNIT: unit,
    N_RESTARTS: String(counter),
    __REALTIME_TIMESTAMP: String(at * 1000),
    MESSAGE: `${unit}: Scheduled restart job, restart counter is at ${counter}.`,
  });

const loop = (unit: string, times: number, { from = 1, before = false } = {}) =>
  Array.from({ length: times }, (_, i) =>
    restart(unit, Date.now() + (before ? -1000 - (times - i) * 10 : 1000 + i * 10), from + i),
  );

const journal = (...lines: string[]) => {
  const file = join(dir, "journal");
  writeFileSync(file, `${lines.join("\n")}\n`);

  return () => ["sh", "-c", `cat ${file}; exec sleep 60`];
};

const prompts = () =>
  store.messages
    .since()
    .filter((message) => message.from === "restarts" && message.to === "-100:1")
    .map((message) => message.body);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "restarts-"));
  store = open(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("a service that keeps failing reaches General once, however many restarts it had before", async () => {
  const stop = restarts(
    dir,
    "-100:1",
    journal(...loop("api.service", 8, { from: 41 }), "not json"),
  );

  await until(() => prompts().length > 0);
  await Bun.sleep(50);
  stop();

  expect(prompts()).toEqual([
    "[restarts] api.service keeps failing: systemd has restarted it 5 times today. `journalctl --user -u api.service` shows why.",
  ]);
});

test("restarts from before the hub followed the journal count toward today, but only a unit still restarting since it was last started reaches General", async () => {
  const stop = restarts(
    dir,
    "-100:1",
    journal(
      ...loop("stopped.service", 9, { before: true }),
      ...loop("restarted.service", 9, { before: true }),
      ...loop("restarted.service", 1),
      ...loop("tunnel.service", 3, { before: true }),
      ...loop("tunnel.service", 2, { from: 4 }),
      ...loop("web.service", 4),
    ),
    5,
  );

  await until(() => prompts().length > 0);
  await Bun.sleep(50);
  stop();

  expect(prompts()).toEqual([
    "[restarts] tunnel.service keeps failing: systemd has restarted it 5 times today. `journalctl --user -u tunnel.service` shows why.",
  ]);
});

test("a unit still failing after the hub restarts is told once", async () => {
  const lines = [
    ...loop("web.service", 5, { before: true }),
    ...loop("web.service", 2, { from: 6 }),
  ];

  const first = restarts(dir, "-100:1", journal(...lines), 5);
  await until(() => prompts().length > 0);
  first();

  const again = restarts(
    dir,
    "-100:1",
    journal(...lines, ...loop("web.service", 1, { from: 8 })),
    5,
  );

  await Bun.sleep(300);
  again();

  expect(prompts()).toHaveLength(1);
});
