import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync } from "node:fs";

import { contained, inherited } from "./claude.ts";
import type { Row } from "./store.ts";
import { tag } from "./tag.ts";

const BESIDE = "beside:";

export const besideOf = (thread: string) => `${BESIDE}${thread}`;

export const besideWhat = (address: string) =>
  address.startsWith(BESIDE) ? address.slice(BESIDE.length) : undefined;

const WORDS_KEPT = 400;

export function prompt(app: string, row: Row, zone: string) {
  const { stalled: _stalled, ...shown } = row.meta ?? {};

  return tag(app, { key: row.key, ...shown, ts: row.at }, row.body, zone);
}

export function lastWords(log: string) {
  try {
    return readFileSync(log, "utf-8").trim().slice(-WORDS_KEPT);
  } catch {
    return "";
  } finally {
    rmSync(log, { force: true });
  }
}

export const jobOf = (row: Row) =>
  row.meta?.schedule ?? row.meta?.job ?? row.meta?.user ?? "beside";

export function run(
  command: string[],
  { cwd, env, log }: { cwd: string; env: Record<string, string>; log: string },
): Promise<number> {
  const [program = "", ...args] = command;
  const [contain, within] = contained(program, args);
  const out = openSync(log, "w", 0o600);

  return new Promise((resolve) => {
    const child = spawn(contain, within, {
      cwd,
      env: { ...inherited(), CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0", ...env },
      stdio: ["ignore", out, out],
    });

    closeSync(out);
    child.on("error", () => {
      resolve(1);
    });
    child.on("close", (exit) => {
      resolve(exit ?? 1);
    });
  });
}
