import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { startHub } from "../../hub/hub.ts";

const Args = z.array(z.string());

const Settings = z.looseObject({
  claudeMdExcludes: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()),
});

const ClaudeJson = z.looseObject({ projects: z.record(z.string(), z.unknown()) });

const HEX = join(import.meta.dir, "../..");
const saved = { ...process.env };

let home: string;
let hub: ReturnType<typeof startHub>;
let listener: ReturnType<typeof Bun.serve>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "session-"));

  for (const dir of ["bin", "chat", "hub"]) {
    cpSync(join(HEX, dir), join(home, ".hex", dir), { recursive: true });
  }

  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, "state"));
  writeFileSync(
    join(home, ".claude/settings.json"),
    JSON.stringify({
      env: { HEX_MAIN_MODEL: "claude-opus-5-5", MEMORY_DIR: join(home, "memory") },
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
  listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 404 }),
  });
});

afterEach(() => {
  hub?.close();
  void listener.stop(true);

  for (const name of Object.keys(process.env)) {
    if (!(name in saved)) {
      Reflect.deleteProperty(process.env, name);
    }
  }

  Object.assign(process.env, saved);
  rmSync(home, { recursive: true, force: true });
});

const flagValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1] ?? "";

async function launch(
  channel: string,
  thread: string,
  options: Partial<Parameters<typeof startHub>[0]> = {},
  cwd?: string,
) {
  const stateOfItsOwnSoNoEarlierHubsThreadsRelaunchAndRace = mkdtempSync(join(home, "state/hub-"));

  hub = startHub({
    stateDir: stateOfItsOwnSoNoEarlierHubsThreadsRelaunchAndRace,
    channel,
    server: { title: "Test", instructions: "Messages arrive as <channel>.", tools: [] },
    port: listener.port ?? 0,
    hexDir: home,
    launcher: join(home, ".hex/bin/session"),
    call: () => Promise.resolve("sent"),
    state: () => {},
    failed: (_, reason) => {
      throw new Error(reason);
    },
    ...options,
  });

  if (cwd !== undefined && cwd !== "") {
    hub.open(thread, thread, "hi", cwd);
  } else {
    hub.deliver(thread, thread, { content: "hi", author: "owner", meta: {} });
  }

  for (let i = 0; i < 200 && !existsSync(join(home, "launched")); i++) {
    await Bun.sleep(25);
  }

  const args = Args.parse(JSON.parse(readFileSync(join(home, "launched"), "utf-8")));
  const file = flagValue(args, "--settings");

  return { args, file, settings: Settings.parse(JSON.parse(readFileSync(file, "utf-8"))) };
}

test("a DM session the hub starts gets the chat prompt, its view's tail and wake through its settings, since Claude's daemon starts a --bg session with the daemon's environment rather than the launcher's, and its settings, token included, stay in an owner-only file", async () => {
  const { args, file, settings } = await launch("plugin:telegram@hex", "6296842341", {
    fresh: () => true,
  });

  const system = readFileSync(flagValue(args, "--system-prompt-file"), "utf-8");
  expect(system).toStartWith("You are hex");
  expect(system).not.toContain("#0 a memory");
  expect(settings.claudeMdExcludes).toContain(join(home, "AGENTS.md"));
  expect(settings.claudeMdExcludes).not.toContain(join(home, "state/wake/CLAUDE.md"));
  expect(args[args.indexOf("--add-dir") + 1]).toBe(join(home, "state/wake"));
  expect(settings.env).toMatchObject({
    HEX_FRESH: "1",
    HEX_THREAD: "6296842341",
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1",
  });
  expect(settings.env.HEX_TOKEN).toBeString();
  expect(args.join(" ")).not.toContain(settings.env.HEX_TOKEN);
  expect(statSync(file).mode.toString(8)).toEndWith("600");
});

test("a launch writes the wake only when there is none, and removes it once memory is off, not when settings do not parse", async () => {
  const wake = join(home, "state/wake/CLAUDE.md");
  await launch("plugin:telegram@hex", "-100:5");
  expect(readFileSync(wake, "utf-8")).toContain("#0 a memory");
  writeFileSync(wake, "kept\n");
  rmSync(join(home, "launched"));
  hub.close();
  await launch("plugin:telegram@hex", "-100:6");
  expect(readFileSync(wake, "utf-8")).toBe("kept\n");
  writeFileSync(join(home, ".claude/settings.json"), '{ "env": ');
  rmSync(join(home, "launched"));
  hub.close();
  await launch("plugin:telegram@hex", "-100:8");
  expect(readFileSync(wake, "utf-8")).toBe("kept\n");
  writeFileSync(join(home, ".claude/settings.json"), "{}");
  rmSync(join(home, "launched"));
  hub.close();
  await launch("plugin:telegram@hex", "-100:7");
  expect(existsSync(wake)).toBe(false);
});

test("General, started by the hub, runs the main model", async () => {
  const { args } = await launch("plugin:telegram@hex", "-100:1", { main: "-100:1", general: true });
  expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-5-5");
  expect(args).not.toContain("--system-prompt-file");
});

test("a voice session, started by the hub, runs the fast model on the 1-hour cache", async () => {
  const { settings } = await launch("plugin:voice@hex", "voice", {
    main: "voice",
    fresh: () => true,
    limits: { capacity: 0 },
  });

  expect(settings).toMatchObject({
    model: "sonnet",
    effortLevel: "low",
    env: { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" },
  });
});

test("a topic session, started by the hub, gets none of the chat or main additions", async () => {
  const { args, settings } = await launch("plugin:telegram@hex", "-100:5", { fresh: () => false });
  expect(args).not.toContain("--system-prompt-file");
  expect(settings.env.HEX_THREAD).toBe("-100:5");
});

test("a topic session loads its rules and wake from its own copy, which a resume keeps and a new session takes again", async () => {
  const wake = join(home, "state/wake/CLAUDE.md");
  const { args, file, settings } = await launch("plugin:telegram@hex", "-100:5");
  const held = z.string().parse(settings.env.HEX_HELD);
  expect(args[args.indexOf("--add-dir") + 1]).toBe(held);
  expect(settings.claudeMdExcludes).toEqual([
    join(home, ".claude/CLAUDE.md"),
    join(home, "AGENTS.md"),
    wake,
  ]);
  const copy = readFileSync(join(held, "CLAUDE.md"), "utf-8");
  expect(copy).toContain(`Contents of ${join(home, "AGENTS.md")}`);
  expect(copy).toContain("- Keep it short.");
  expect(copy).toContain("#0 a memory");
  writeFileSync(wake, "a newer wake\n");
  writeFileSync(join(home, "AGENTS.md"), "- Keep it shorter.\n\n@state/wake/CLAUDE.md\n");

  const again = (...flags: string[]) =>
    Bun.spawnSync([join(home, ".hex/bin/session"), "--bg", ...flags, "--settings", file], {
      cwd: home,
      env: process.env,
    });

  writeFileSync(file, JSON.stringify({ env: settings.env }));
  again("--resume", "abc");
  expect(readFileSync(join(held, "CLAUDE.md"), "utf-8")).toBe(copy);
  writeFileSync(file, JSON.stringify({ env: settings.env }));
  again();
  expect(readFileSync(join(held, "CLAUDE.md"), "utf-8")).toContain("a newer wake");
  expect(readFileSync(join(held, "CLAUDE.md"), "utf-8")).toContain("- Keep it shorter.");
});

test("a session started in another project gets the hex folder's settings under the hub's, in its file", async () => {
  writeFileSync(
    join(home, ".claude/settings.json"),
    JSON.stringify({
      model: "opus",
      permissions: { deny: ["Read(./.env)"] },
      env: { MEMORY_DIR: join(home, "memory") },
    }),
  );
  const project = join(home, "project");
  mkdirSync(project);
  const { args, settings } = await launch("plugin:t3@hex", "t3:1", {}, project);
  expect(settings).toMatchObject({
    model: "opus",
    permissions: { deny: [`Read(/${home}/.env)`] },
    enabledPlugins: { "t3@hex": true },
    env: { MEMORY_DIR: join(home, "memory"), HEX_THREAD: "t3:1" },
  });
  expect(args).toContain("--append-system-prompt");
});

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
