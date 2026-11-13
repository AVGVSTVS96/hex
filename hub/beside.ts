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
// Runs a session to its end the way the hub runs every session it starts (contained), so it outlives a hub restart, with background agents it starts let finish. What it printed on stderr goes to log, and comes back as its last words.
export function run(
  command: string[],
  { cwd, env, log }: { cwd: string; env: Record<string, string>; log: string },
): Promise<{ code: number; said: string }> {
  const [program = "", ...args] = command;
  const [contain, within] = contained(program, args);
  const err = openSync(log, "w", 0o600);

  return new Promise((resolve) => {
    const said = () => {
      try {
        return readFileSync(log, "utf-8").trim().slice(-WORDS_KEPT);
      } finally {
        rmSync(log, { force: true });
      }
    };

    const child = spawn(contain, within, {
      cwd,
      env: { ...inherited(), CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0", ...env },
      stdio: ["ignore", "ignore", err],
    });

    closeSync(err);
    child.on("error", (error) => {
      resolve({ code: 1, said: `${said()} ${String(error)}`.trim() });
    });
    child.on("close", (exit) => {
      resolve({ code: exit ?? 1, said: said() });
    });
  });
}
