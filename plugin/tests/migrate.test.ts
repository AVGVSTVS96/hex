import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HEX = join(import.meta.dir, "../..");

let home: string;
let hex: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "migrate-"));
  hex = join(home, ".hex");
  mkdirSync(join(hex, "bin"), { recursive: true });
  mkdirSync(join(home, "state"));
  cpSync(join(HEX, "defaults"), join(hex, "defaults"), { recursive: true });
  cpSync(join(HEX, "bin/migrate"), join(hex, "bin/migrate"));
  chmodSync(join(hex, "bin/migrate"), 0o755);
  writeFileSync(join(home, "state/migrated"), "3\n");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const migrate = () => {
  const run = Bun.spawnSync([join(hex, "bin/migrate")]);
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
};

const read = (file: string) => readFileSync(join(home, file), "utf-8");

const wrote = (file: string, text: string) => {
  writeFileSync(join(home, file), text);
};

test("migrate seeds PROACTIVE.md where it is missing, and leaves an existing one byte for byte", () => {
  migrate();
  expect(read("PROACTIVE.md")).toBe(read(".hex/defaults/PROACTIVE.md"));

  const mine = "# Mine\n\n- Tell me about the weather. [telegram:1:2]\n";
  wrote("PROACTIVE.md", mine);
  wrote("state/migrated", "3\n");
  migrate();
  expect(read("PROACTIVE.md")).toBe(mine);
});
