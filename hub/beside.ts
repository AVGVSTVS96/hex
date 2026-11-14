import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync } from "node:fs";

import { contained, inherited } from "./claude.ts";
import { local } from "./mcp.ts";
import type { Row } from "./store.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Where hex's own work for a thread goes: a timer, an alarm, a job's report. A session of its own takes each, beside the thread's conversation, and speaks in its chat; one that took a row is reached again at its own session id.
const BESIDE = "beside:";

export const besideOf = (thread: string) => `${BESIDE}${thread}`;

export const besideWhat = (address: string) =>
  address.startsWith(BESIDE) ? address.slice(BESIDE.length) : undefined;

const WORDS_KEPT = 400;

const attribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The row as Claude Code shows a channel's message, key first, so the session's prompt hook takes it (hub/state.ts).
export function prompt(app: string, row: Row, zone: string) {
  const meta = local({ key: row.key, ...row.meta, ts: row.at }, zone);

  const attributes = Object.entries(meta)
    .map(([name, value]) => ` ${name}="${attribute(value)}"`)
    .join("");

  return `<channel source="${app}"${attributes}>\n${row.body}\n</channel>`;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What a run printed last, where an API error says why it failed, and the log it was in is gone.
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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Runs a session to its end the way the hub runs every session it starts (contained), so it outlives a hub restart, with background agents it starts let finish. What it prints goes to log.
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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Waits for a run another hub started, which this one isn't the parent of, to end.
export function exited(pid: number): Promise<void> {
  return new Promise((resolve) => {
    spawn("tail", [`--pid=${pid}`, "-f", "/dev/null"], { stdio: "ignore" }).on("close", () => {
      resolve();
    });
  });
}
