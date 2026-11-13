import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const room = join(import.meta.dir, "../../bin/room");
const home = mkdtempSync(join(tmpdir(), "room-"));

afterAll(() => {
  rmSync(home, { recursive: true });
});

function mac(name: string, { battery, heat }: { battery: boolean; heat: boolean }) {
  const bin = join(home, name);
  mkdirSync(bin);

  const script = (tool: string, body: string) => {
    writeFileSync(join(bin, tool), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, tool), 0o755);
  };

  script("uname", "echo Darwin");
  script("top", 'echo "CPU usage: 10.0% user, 5.0% sys, 85.0% idle"');
  script("memory_pressure", 'echo "System-wide memory free percentage: 80%"');
  script(
    "df",
    'echo "Filesystem 1024-blocks Used Available Capacity Mounted"; echo "/dev/disk3 500000000 100000000 400000000 20% /"',
  );
  script(
    "pmset",
    `case "$2" in
  batt) echo "Now drawing from '${battery ? "Battery Power" : "AC Power"}'" ;;
  therm) ${heat ? 'echo "CPU_Speed_Limit = 70"' : 'echo "No thermal warning level has been recorded"'} ;;
esac`,
  );

  return Bun.spawnSync(["sh", room], {
    env: { HOME: home, PATH: `${bin}:${process.env.PATH}` },
  });
}

test("an idle Mac on battery has room", () => {
  const run = mac("battery", { battery: true, heat: false });

  expect(run.stdout.toString()).toContain("on battery");
  expect(run.exitCode).toBe(0);
});

test("a Mac slowed by heat has no room, on power or not", () => {
  expect(mac("hot", { battery: false, heat: true }).exitCode).toBe(1);
  expect(mac("hot-battery", { battery: true, heat: true }).exitCode).toBe(1);
});
