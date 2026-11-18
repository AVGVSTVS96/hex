import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

// WARNING: the real claude starts a daemon for any CLAUDE_CONFIG_DIR a test left set, and never stops it.
export const noClaude = () => `${join(import.meta.dir, "no-claude")}:${process.env.PATH}`;

export const ATTACH = `[ "$1" = attach ] && [ -f "$CLAUDE_CONFIG_DIR/gone" ] && { echo "No job matching $2"; exit 1; }
[ "$1" = attach ] && [ -f "$CLAUDE_CONFIG_DIR/idle" ] && { stty raw -echo; printf 'Attaching\\r\\nscreen'; dd bs=1 count=1 >/dev/null 2>&1; echo '{"type":"api-request-blob","message":{"content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}' >> "$(ls "$CLAUDE_CONFIG_DIR"/projects/*/"$2"*.jsonl | head -1)"; exec sleep 60; }
[ "$1" = attach ] && { stty raw -echo; printf 'Attaching\\r\\nscreen'; [ "$(dd bs=1 count=1 2>/dev/null)" = "$(printf '\\033')" ] && echo '{"type":"user","message":{"content":"[Request interrupted by user for tool use]"}}' >> "$(ls "$CLAUDE_CONFIG_DIR"/projects/*/"$2"*.jsonl | head -1)"; exec sleep 60; }`;

const Call = z.object({
  argv: z.array(z.string()),
  stdin: z.string(),
  cwd: z.string(),
  files: z.array(z.string()),
  env: z.array(z.string()),
  helper: z.string().optional(),
  entrypoint: z.string().optional(),
});

export type Reply = {
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  usage?: Record<string, number>;
  total_cost_usd?: number;
};

type Faked = { code?: number; env?: Record<string, string> };

export function fakeClaude(reply: Reply, { code = 0, env = {} }: Faked = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const calls = join(dir, "calls");
  const set = { PATH: `${dir}:${process.env.PATH}`, CLAUDECODE: "1", ...env };
  const before = Object.entries(set).map(([name]) => [name, process.env[name]] as const);

  writeFileSync(
    join(dir, "claude"),
    `#!/usr/bin/env bun
import { appendFileSync, readdirSync } from "node:fs";
const stdin = await Bun.stdin.text();
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd(), files: readdirSync(".").toSorted(), env: Object.keys(process.env).toSorted(), helper: process.env.HEX_HELPER, entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT }) + "\\n");
console.log(${JSON.stringify(JSON.stringify(reply))});
process.exit(${code});
`,
  );
  chmodSync(join(dir, "claude"), 0o755);
  Object.assign(process.env, set);

  return {
    [Symbol.dispose]: () => {
      for (const [name, value] of before) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, name);
        } else {
          process.env[name] = value;
        }
      }

      rmSync(dir, { recursive: true, force: true });
    },
    calls: () =>
      existsSync(calls)
        ? readFileSync(calls, "utf-8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => Call.parse(JSON.parse(line)))
        : [],
  };
}

export function flags(argv: string[]) {
  const named: Record<string, string[]> = {};
  let last: string[] = [];

  for (const arg of argv) {
    if (arg.startsWith("-")) {
      last = [];
      named[arg] = last;
    } else {
      last.push(arg);
    }
  }

  return named;
}
