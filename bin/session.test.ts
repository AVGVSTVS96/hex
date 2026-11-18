import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

const Args = z.array(z.string());

const Settings = z.looseObject({
  claudeMdExcludes: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()),
});

const ClaudeJson = z.looseObject({ projects: z.record(z.string(), z.unknown()) });

const HEX = join(import.meta.dir, "..");
const saved = { ...process.env };

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "session-"));

  for (const dir of ["bin", "chat", "hub"]) {
    cpSync(join(HEX, dir), join(home, ".hex", dir), { recursive: true, verbatimSymlinks: true });
  }

  symlinkSync(join(HEX, "node_modules"), join(home, ".hex/node_modules"));

  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, "state"));
  writeFileSync(
    join(home, ".claude/settings.json"),
    JSON.stringify({
      model: "opus",
      env: {
        HEX_MAIN_MODEL: "claude-opus-5-5",
        HEX_ORCHESTRATOR_MODEL: "fable",
        HEX_ORCHESTRATOR_EFFORT: "high",
        HEX_VOICE_MODEL: "haiku",
        MEMORY_DIR: join(home, "memory"),
      },
    }),
  );
  mkdirSync(join(home, ".hex/vendor"));
  writeFileSync(
    join(home, ".hex/vendor/memo"),
    '#!/bin/sh\necho "#0 a memory"\necho "You are awake."\n',
  );
  chmodSync(join(home, ".hex/vendor/memo"), 0o755);
  writeFileSync(join(home, ".claude/CLAUDE.md"), "# Global\n");
  writeFileSync(join(home, "AGENTS.md"), "- Keep it short.\n\n@state/wake/CLAUDE.md\n");
  mkdirSync(join(home, "fake"));
  mkdirSync(join(home, "config/jobs/job12345"), { recursive: true });
  writeFileSync(
    join(home, "fake/claude"),
    `#!/bin/sh
[ "$1 $2" = "agents --json" ] && echo '[]' && exit 0
[ "$1" = daemon ] || [ "$1" = --version ] && exit 0
jq -cn '$ARGS.positional' --args -- "$@" > "${home}/launched.tmp" && mv "${home}/launched.tmp" "${home}/launched"
echo "backgrounded · job12345 · test"
exit 0
`,
  );
  chmodSync(join(home, "fake/claude"), 0o755);

  for (const name of Object.keys(process.env)) {
    if (name.startsWith("HEX_") || name === "MEMORY_DIR") {
      Reflect.deleteProperty(process.env, name);
    }
  }

  Object.assign(process.env, {
    HOME: home,
    PATH: `${join(home, "fake")}:${process.env.PATH}`,
    CLAUDE_CONFIG_DIR: join(home, "config"),
    CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
    HEX_CHAT_CLAUDE: "true",
  });
});

afterEach(() => {
  for (const name of Object.keys(process.env)) {
    if (!(name in saved)) {
      Reflect.deleteProperty(process.env, name);
    }
  }

  Object.assign(process.env, saved);
  rmSync(home, { recursive: true, force: true });
});

const flagValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1] ?? "";

test("every folder a background session starts in is trusted (a -p run never asks), one started in the home folder works in the hex folder, and one started by hand still gets the hex folder's settings", () => {
  writeFileSync(
    join(home, ".claude/settings.json"),
    JSON.stringify({ model: "opus", permissions: { deny: ["Read(./.env)"] } }),
  );
  writeFileSync(join(home, "config/.claude.json"), JSON.stringify({ numStartups: 3 }));
  const project = join(home, "project");
  mkdirSync(project);
  chmodSync(join(home, "config/.claude.json"), 0o600);

  for (const cwd of [project, home, "/"]) {
    Bun.spawnSync([join(home, ".hex/bin/session"), "--bg", "build it"], { cwd, env: process.env });
  }

  expect(JSON.parse(readFileSync(join(home, "config/.claude.json"), "utf-8"))).toEqual({
    numStartups: 3,
    projects: { [project]: { hasTrustDialogAccepted: true } },
  });
  const other = join(home, "other");
  mkdirSync(other);
  Bun.spawnSync([join(home, ".hex/bin/session"), "-p", "build it"], {
    cwd: other,
    env: process.env,
  });
  expect(
    ClaudeJson.parse(JSON.parse(readFileSync(join(home, "config/.claude.json"), "utf-8"))).projects[
      other
    ],
  ).toBeUndefined();
  expect(statSync(join(home, "config/.claude.json")).mode.toString(8)).toEndWith("600");
  Bun.spawnSync([join(home, ".hex/bin/session"), "-p", "build it"], {
    cwd: project,
    env: process.env,
  });
  const args = Args.parse(JSON.parse(readFileSync(join(home, "launched"), "utf-8")));
  expect(JSON.parse(flagValue(args, "--settings"))).toMatchObject({
    model: "opus",
    permissions: { deny: [`Read(/${home}/.env)`] },
  });
});

test("a job starts without the wake, in the hex folder and in another project, and a run that isn't a job keeps it", () => {
  const wake = join(home, "state/wake/CLAUDE.md");
  const project = join(home, "project");

  mkdirSync(project);

  const launched = (cwd: string, env: Record<string, string> = {}) => {
    Bun.spawnSync([join(home, ".hex/bin/session"), "-p", "build it"], {
      cwd,
      env: { ...process.env, ...env },
    });

    return Args.parse(JSON.parse(readFileSync(join(home, "launched"), "utf-8")));
  };

  for (const cwd of [home, project]) {
    const args = launched(cwd, { HEX_OWNER: "telegram:-100:7" });

    expect(Settings.parse(JSON.parse(flagValue(args, "--settings"))).claudeMdExcludes).toEqual([
      wake,
    ]);
    expect(args).not.toContain(join(home, "state/wake"));
  }

  expect(launched(home)).not.toContain("--settings");
  expect(launched(project)).toContain(join(home, "state/wake"));
});

test("a run with no terminal says it is hex, over the label it inherited, and a background session drops it for its own", () => {
  writeFileSync(
    join(home, "fake/claude"),
    `#!/bin/sh\nprintf '%s' "\${CLAUDE_CODE_ENTRYPOINT:-unset}" > "${home}/entrypoint"\n`,
  );
  const env = { ...process.env, CLAUDE_CODE_ENTRYPOINT: "sdk-cli" };

  const launched = (...args: string[]) => {
    rmSync(join(home, "entrypoint"), { force: true });
    expect(
      Bun.spawnSync([join(home, ".hex/bin/session"), ...args], { cwd: home, env }).exitCode,
    ).toBe(0);

    return readFileSync(join(home, "entrypoint"), "utf-8");
  };

  expect(launched("-p", "build it")).toBe("hex");
  expect(launched("build it")).toBe("hex");
  expect(launched("-p", "--", "--bg")).toBe("hex");
  expect(launched("--bg", "build it")).toBe("unset");
  expect(launched("--bg", "-p")).toBe("unset");
});

test("an agent's commands run in a shell 10 nice levels below the agent, so they give way to it", () => {
  const own = Number(Bun.spawnSync(["sh", "-c", "ps -o ni= -p $$"]).stdout.toString().trim());
  const below = String(Math.min(own + 12, 19));

  for (const shell of ["bash", "zsh"].filter((name) => Bun.which(name) !== null)) {
    const ran = Bun.spawnSync([
      "nice",
      "-n",
      "2",
      join(HEX, "bin/shell", shell),
      "-c",
      "ps -o ni= -p $$; echo $0",
    ]);

    expect(ran.stdout.toString().split(/\s+/u).filter(Boolean)).toEqual([below, shell]);
  }
});
