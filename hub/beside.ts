import { spawn } from "node:child_process";

import { inherited } from "./claude.ts";
import { local } from "./mcp.ts";
import type { Row } from "./store.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Where hex's own work for a thread goes: a timer, an alarm, a job's report. A session of its own takes each, beside the thread's conversation, and speaks in its chat; one that took a row is reached again at its own session id.
const BESIDE = "beside:";

export const besideOf = (thread: string) => `${BESIDE}${thread}`;

export const besideWhat = (address: string) =>
  address.startsWith(BESIDE) ? address.slice(BESIDE.length) : undefined;

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
// Runs a session to its end: as a systemd unit of its own where hex's sessions have a slice, so it outlives a hub restart and keeps its output in the journal, and otherwise as a child that does. Resolves with its exit code and, when it failed, its last words.
export function run(
  command: string[],
  { session, cwd, env, name }: { session: string; cwd: string; env: Record<string, string>; name: string },
): Promise<{ code: number; said: string }> {
  const slice = process.env.HEX_SESSIONS_SLICE;
  const unit = `hex-beside-${session}`;
  const passed = { ...env, CLAUDE_CODE_SESSION_NAME: name };

  const [program = "", ...args] =
    slice === undefined || slice === ""
      ? command
      : [
          "systemd-run",
          "--user",
          "--wait",
          "--quiet",
          "--collect",
          `--unit=${unit}`,
          `--slice=${slice}`,
          `--working-directory=${cwd}`,
          ...["PATH", "CLAUDE_CONFIG_DIR"].flatMap((each) => {
            const value = process.env[each];

            return value === undefined || value === "" ? [] : ["-E", `${each}=${value}`];
          }),
          ...Object.entries(passed).flatMap(([each, value]) => ["-E", `${each}=${value}`]),
          "--",
          ...command,
        ];

  const journal = slice !== undefined && slice !== "";

  return new Promise((resolve) => {
    const child = spawn(program, args, {
      cwd,
      env: { ...inherited(), ...passed },
      stdio: ["ignore", "ignore", "pipe"],
    });

    let said = "";
    child.stderr.on("data", (chunk: Buffer) => {
      said = (said + chunk.toString()).slice(-400);
    });
    child.on("error", (error) => {
      resolve({ code: 1, said: String(error) });
    });
    child.on("close", (code) => {
      const done = code ?? 1;

      if (done === 0 || !journal) {
        resolve({ code: done, said: said.trim() });

        return;
      }

      const last = spawn("journalctl", ["--user", "-u", unit, "-o", "cat", "-n", "4", "--no-pager"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      last.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
      });
      last.on("error", () => {
        resolve({ code: done, said: said.trim() });
      });
      last.on("close", () => {
        resolve({ code: done, said: (out.trim() || said.trim()).slice(-400) });
      });
    });
  });
}
