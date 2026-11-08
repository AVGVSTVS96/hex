import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import { open } from "../../hub/store.ts";

const BIN = join(import.meta.dir, "../../bin");
const SESSION = "addfa113-0000-4000-8000-000000000000";

const Told = z.object({
  systemMessage: z.string(),
  hookSpecificOutput: z.object({ additionalContext: z.string() }).optional(),
});

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rules-"));
  mkdirSync(join(home, ".hex/bin"), { recursive: true });
  mkdirSync(join(home, ".claude"));

  for (const script of ["rules", "identity", "instructions"]) {
    copyFileSync(join(BIN, script), join(home, ".hex/bin", script));
  }

  symlinkSync(join(BIN, "../hub"), join(home, ".hex/hub"));
  writeFileSync(join(home, "AGENTS.md"), "@.hex/HEX.md\n\n- Keep it short.\n");
  writeFileSync(join(home, ".hex/HEX.md"), "# How you work\n\nAnswer in plain words.\n");
  writeFileSync(join(home, ".claude/CLAUDE.md"), "# Global\n");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function hook(
  event: "SessionStart" | "UserPromptSubmit" | "SessionEnd",
  source?: string,
  env: Record<string, string> = {},
) {
  const run = Bun.spawnSync([join(home, ".hex/bin/rules")], {
    stdin: Buffer.from(JSON.stringify({ session_id: SESSION, hook_event_name: event, source })),
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: home,
      HEX_STORE: join(home, "state"),
      CLAUDE_CONFIG_DIR: undefined,
      ...env,
    },
  });

  expect(run.exitCode).toBe(0);

  return run.stdout.toString();
}

test("says nothing while the rules are the ones the session loaded", () => {
  expect(hook("SessionStart")).toBe("");
  expect(hook("UserPromptSubmit")).toBe("");
});

test("an edit to an imported file reaches the session once, as a diff", () => {
  hook("SessionStart");
  writeFileSync(
    join(home, ".hex/HEX.md"),
    "# How you work\n\nAnswer in plain words, with a link.\n",
  );
  const out = hook("UserPromptSubmit");
  expect(out).toContain(".hex/HEX.md");
  expect(out).toContain("-Answer in plain words.");
  expect(out).toContain("+Answer in plain words, with a link.");
  expect(hook("UserPromptSubmit")).toBe("");
});

test("the global CLAUDE.md is watched too", () => {
  hook("SessionStart");
  writeFileSync(join(home, ".claude/CLAUDE.md"), "# Global\n\n- Sign every commit.\n");
  expect(hook("UserPromptSubmit")).toContain("+- Sign every commit.");
});

test("a session that loads the rules again starts from them", () => {
  hook("SessionStart");
  writeFileSync(join(home, "AGENTS.md"), "@.hex/HEX.md\n\n- Keep it shorter.\n");
  hook("SessionStart");
  expect(hook("UserPromptSubmit")).toBe("");
});

test("a hub thread's session keeps its copy of the rules through a resume, hears what changed as a diff, and takes them again as it compacts", () => {
  const held = join(home, "held");
  const env = { HEX_HELD: held };
  Bun.spawnSync([join(home, ".hex/bin/instructions"), "hold", held], {
    env: { ...process.env, HOME: home },
  });
  const copy = readFileSync(join(held, "CLAUDE.md"), "utf-8");
  expect(copy).toContain("Answer in plain words.");
  hook("SessionStart", "startup", env);
  writeFileSync(
    join(home, ".hex/HEX.md"),
    "# How you work\n\nAnswer in plain words, with a link.\n",
  );
  expect(hook("SessionStart", "resume", env)).toBe("");
  expect(readFileSync(join(held, "CLAUDE.md"), "utf-8")).toBe(copy);
  expect(hook("UserPromptSubmit", undefined, env)).toContain(
    "+Answer in plain words, with a link.",
  );
  expect(hook("UserPromptSubmit", undefined, env)).toBe("");
  hook("SessionEnd", undefined, env);
  expect(hook("SessionStart", "resume", env) + hook("UserPromptSubmit", undefined, env)).toBe("");
  writeFileSync(join(home, "AGENTS.md"), "@.hex/HEX.md\n\n- Keep it shorter.\n");
  hook("SessionStart", "compact", env);
  expect(readFileSync(join(held, "CLAUDE.md"), "utf-8")).toContain("- Keep it shorter.");
  expect(hook("UserPromptSubmit", undefined, env)).toBe("");
});

test("a change too long to show points to the files instead", () => {
  hook("SessionStart");
  writeFileSync(join(home, "AGENTS.md"), `@.hex/HEX.md\n\n${"- A long rule.\n".repeat(1000)}`);
  const out = hook("UserPromptSubmit");
  expect(out).toContain("read them again");
  expect(out.length).toBeLessThan(10_000);
});

test("a session's end forgets what it loaded", () => {
  hook("SessionStart");
  expect(open(join(home, "state")).seen.get(SESSION, "rules")).toContain("Answer in plain words.");
  hook("SessionEnd");
  expect(open(join(home, "state")).seen.get(SESSION, "rules")).toBe("");
});

test("a memory pass rewriting the wake HEX.md imports is no change to the rules", () => {
  mkdirSync(join(home, "state/wake"), { recursive: true });
  writeFileSync(join(home, ".hex/HEX.md"), "# How you work\n\n@../state/wake/CLAUDE.md\n");
  writeFileSync(join(home, "state/wake/CLAUDE.md"), "#0 a memory\n");
  hook("SessionStart");
  writeFileSync(join(home, "state/wake/CLAUDE.md"), "#0 a memory\n#1 another\n");
  expect(hook("UserPromptSubmit")).toBe("");
});

function commit(atSeconds: number, path: string, text: string) {
  const git = (...args: string[]) =>
    Bun.spawnSync(
      [
        "git",
        "-C",
        join(home, ".hex"),
        "-c",
        "user.name=hex",
        "-c",
        "user.email=hex@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      {
        env: {
          ...process.env,
          GIT_COMMITTER_DATE: `@${atSeconds} +0000`,
          GIT_AUTHOR_DATE: `@${atSeconds} +0000`,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
        },
      },
    );

  mkdirSync(dirname(join(home, ".hex", path)), { recursive: true });
  writeFileSync(join(home, ".hex", path), text);
  git("add", path);
  git("commit", "-qm", path);
}

function updates(
  sessionStartedAtSeconds: number,
  ...changes: [atSeconds: number, path: string, text: string][]
) {
  Bun.spawnSync(["git", "init", "-q", join(home, ".hex")]);

  for (const change of changes) {
    commit(...change);
  }

  mkdirSync(join(home, ".claude/sessions"), { recursive: true });
  writeFileSync(
    join(home, ".claude/sessions", `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId: SESSION,
      startedAt: sessionStartedAtSeconds * 1000,
      cwd: home,
    }),
  );
}

test("a session started before an update to its hooks hears so once, and its owner is shown how to load them", () => {
  updates(
    2000,
    [1000, "plugin/hooks/hooks.json", '{"hooks":{}}'],
    [3000, "plugin/hooks/hooks.json", '{"hooks":{"Stop":[]}}'],
  );
  hook("SessionStart");
  const out = Told.parse(JSON.parse(hook("UserPromptSubmit")));
  expect(out.systemMessage).toContain("/reload-plugins for its new hooks");
  expect(out.hookSpecificOutput?.additionalContext).toContain(
    "Claude Code reads hex's hooks only at start",
  );
  expect(hook("UserPromptSubmit")).toBe("");
});

test("a hub thread's session hears its hub renews it, and nothing goes on its screen", () => {
  updates(
    2000,
    [1000, "plugin/skills/echo/SKILL.md", "Restate the ask."],
    [3000, "bin/session", "exec claude"],
  );
  open(join(home, "state")).threads.keep("telegram", {
    "-100:7": { name: "Desk", session: SESSION },
  });
  const out = hook("UserPromptSubmit");
  expect(out).toContain("hex's launch flags only at start");
  expect(out).toContain("hex resumes it on the new hex at its next rest");
});

test("after hearing once, a session hears again only of a later update to what it loads at start", () => {
  updates(
    2000,
    [1000, "plugin/hooks/hooks.json", '{"hooks":{}}'],
    [3000, "plugin/hooks/hooks.json", '{"hooks":{"Stop":[]}}'],
  );
  expect(hook("UserPromptSubmit")).toContain("/reload-plugins");
  commit(4000, "README.md", "hex");
  expect(hook("UserPromptSubmit")).toBe("");
  commit(5000, "plugin/skills/echo/SKILL.md", "Restate the ask.");
  const out = Told.parse(JSON.parse(hook("UserPromptSubmit")));
  expect(out.systemMessage).toContain("/reload-plugins for its new hooks and skills.");
});

test("a session older than git's record of hex says nothing, since git can't say what it started on", () => {
  updates(
    500,
    [1000, "plugin/hooks/hooks.json", '{"hooks":{}}'],
    [3000, "plugin/hooks/hooks.json", '{"hooks":{"Stop":[]}}'],
  );
  expect(hook("UserPromptSubmit")).toBe("");
});

test("an update that leaves what a session loads at start alone says nothing", () => {
  updates(2000, [1000, "plugin/hooks/hooks.json", '{"hooks":{}}'], [3000, "bin/budget", "echo ok"]);
  expect(hook("UserPromptSubmit")).toBe("");
});

test("a session started after the update says nothing", () => {
  updates(
    4000,
    [1000, "plugin/hooks/hooks.json", '{"hooks":{}}'],
    [3000, "plugin/hooks/hooks.json", '{"hooks":{"Stop":[]}}'],
  );
  expect(hook("UserPromptSubmit")).toBe("");
});

test("a launcher change tells the owner to quit and resume through bin/session, in the folder the session started in", () => {
  updates(2000, [1000, "bin/session", "exec claude"], [3000, "bin/session", 'exec claude "$@"']);
  const out = Told.parse(JSON.parse(hook("UserPromptSubmit")));
  expect(out.systemMessage).toContain(
    `quit it and run cd '${home}' && '${home}/.hex/bin/session' --resume ${SESSION} for its new launch flags`,
  );
});

test("a session told two days ago still hears nothing more of the same update", () => {
  updates(
    2000,
    [1000, "plugin/hooks/hooks.json", '{"hooks":{}}'],
    [3000, "plugin/hooks/hooks.json", '{"hooks":{"Stop":[]}}'],
  );
  hook("UserPromptSubmit");
  open(join(home, "state")).seen.show(
    "another",
    "tasks",
    "x",
    new Date(Date.now() + 3 * 86_400_000).toISOString(),
  );
  expect(hook("UserPromptSubmit")).toBe("");
});
