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

const restart = (unit: string, at: string, counter: number) =>
  JSON.stringify({
    USER_UNIT: unit,
    N_RESTARTS: String(counter),
    __REALTIME_TIMESTAMP: String(Date.parse(at) * 1000),
    MESSAGE: `${unit}: Scheduled restart job, restart counter is at ${counter}.`,
  });

const loop = (unit: string, day: string, times: number, from = 1) =>
  Array.from({ length: times }, (_, i) =>
    restart(unit, `${day}T15:55:${String(10 + i * 3).padStart(2, "0")}Z`, from + i),
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

test("a service that keeps failing reaches General once, at its fifth restart of the day, however many it had before", async () => {
  const stop = restarts(
    dir,
    "-100:1",
    journal(...loop("api.service", "2026-11-10", 8, 41), "not json"),
    5,
  );

  await until(() => prompts().length > 0);
  await Bun.sleep(50);
  stop();

  expect(prompts()).toEqual([
    "[restarts] api.service keeps failing: systemd has restarted it 5 times today. `journalctl --user -u api.service` shows why.",
  ]);
});

test("a few restarts add nothing, a day read again after the hub restarts adds nothing, and the next day still failing is told again", async () => {
  const lines = [
    ...loop("tunnel.service", "2026-11-09", 3),
    ...loop("tunnel.service", "2026-11-10", 2, 4),
    ...loop("web.service", "2026-11-10", 5),
  ];

  const first = restarts(dir, "-100:1", journal(...lines), 5);

  await until(() => prompts().length > 0);
  first();

  const again = restarts(
    dir,
    "-100:1",
    journal(...lines, ...loop("web.service", "2026-11-11", 5)),
    5,
  );

  await until(() => prompts().length > 1);
  await Bun.sleep(50);
  again();

  expect(prompts().map((body) => body.split(" ")[1])).toEqual(["web.service", "web.service"]);
});
