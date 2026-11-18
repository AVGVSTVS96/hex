import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { command, commands, flagsOf } from "./command.ts";

const all = await commands();
const names = [...all.keys()];

test("the cli's usage lists every command in hub/cli/, and bin/hex hands each one to the cli", async () => {
  const usage = await new Response(
    Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), mkdtempSync(join(tmpdir(), "state-"))], {
      stderr: "pipe",
    }).stderr,
  ).text();

  const cases = new Map(
    [
      ...readFileSync(join(import.meta.dir, "../bin/hex"), "utf-8").matchAll(
        /^ {2}([^ \n]+)\)\n(.*?)^ {4};;$/gmsu,
      ),
    ].flatMap(([, labels = "", body = ""]) => labels.split("|").map((label) => [label, body])),
  );

  const handed = (name: string) =>
    (cases.get(name) ?? cases.get("*") ?? "").includes(
      'exec bun "$hex/hub/cli.ts" "$home/state" "$@"',
    );

  expect(names).toContain("thread");
  expect([
    ...new Set([...usage.matchAll(/^ {2}hex (\w+)/gmu)].flatMap(([, name]) => name ?? [])),
  ]).toEqual(names);
  expect(names.filter((name) => !handed(name))).toEqual([]);
});

test("a flag two commands take means the same in both, or no command runs", () => {
  const json = { type: "boolean" } as const;
  const one = command({ usage: "hex one", flags: { json }, run: async () => {} });
  const same = command({ usage: "hex same", flags: { json }, run: async () => {} });

  const other = command({
    usage: "hex other",
    flags: { json: { type: "string" } },
    run: async () => {},
  });

  expect(
    flagsOf(
      new Map([
        ["one", one],
        ["same", same],
      ]),
    ),
  ).toEqual({ json });
  expect(() =>
    flagsOf(
      new Map([
        ["one", one],
        ["other", other],
      ]),
    ),
  ).toThrow("--json is declared one way in hub/cli/one.ts and another in hub/cli/other.ts");
  expect(() => flagsOf(all)).not.toThrow();
});

test("bin/hex answers --help, -h and a command it doesn't know with the usage at once, even while hex moves", async () => {
  const home = mkdtempSync(join(tmpdir(), "hex-"));
  mkdirSync(join(home, ".hex/bin"), { recursive: true });
  cpSync(join(import.meta.dir, "../bin/hex"), join(home, ".hex/bin/hex"));
  symlinkSync(import.meta.dir, join(home, ".hex/hub"));
  const xdg = join(home, "xdg");
  mkdirSync(join(xdg, "hex"), { recursive: true });
  writeFileSync(join(xdg, "hex/elsewhere"), "");

  for (const asked of [["--help"], ["-h"], ["nosuch"], ["../cli"], []]) {
    const hex = Bun.spawn([join(home, ".hex/bin/hex"), ...asked], {
      env: { ...process.env, XDG_STATE_HOME: xdg },
      stderr: "pipe",
    });

    const said = await new Response(hex.stderr).text();

    expect([asked, await hex.exited]).toEqual([asked, 2]);
    expect(said).toStartWith("usage: hex init|");
    expect(said).toContain("\n  hex deliver ");
  }
});
