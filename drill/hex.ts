import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import { until } from "../hub/until.ts";
import { KEY } from "./cloudflare.ts";
import { GENERAL, OWNER } from "./telegram.ts";

const repo = join(import.meta.dir, "..");
const fakes = join(import.meta.dir, "bin");
const Job = z.object({ sessionId: z.string(), pid: z.number().optional() });

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The sandbox sits beside bun's own cache, on the same disk, so each copy of hex installs by linking from it and downloads nothing.
const cache = process.env.BUN_INSTALL_CACHE_DIR ?? join(homedir(), ".bun", "install", "cache");

const caches = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");

mkdirSync(caches, { recursive: true });

const root = mkdtempSync(join(caches, "hex-drill-"));

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What ends the sandbox when this process does (drill/leash.ts), in a session of its own so that nothing that stops this process stops it.
const leash = Bun.spawn([process.execPath, join(import.meta.dir, "leash.ts"), root], {
  stdio: ["pipe", "ignore", "ignore"],
  detached: true,
});

leash.unref();

function tell(line: string) {
  void leash.stdin.write(`${line}\n`);
  void leash.stdin.flush();
}

let made = 0;

async function sh(command: string[], options: { cwd: string; env?: Record<string, string> }) {
  const child = Bun.spawn(command, { ...options, stdout: "pipe", stderr: "pipe" });

  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (code !== 0) {
    throw new Error(`${command.join(" ")} exited ${code}: ${err || out}`);
  }

  return out.trim();
}

function freePort() {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const { port } = server;
  void server.stop(true);

  return port;
}

const gone = (group: number) => {
  try {
    return !process.kill(-group, 0);
  } catch {
    return true;
  }
};

const kill = (group: number) => {
  if (!gone(group)) {
    process.kill(-group, "SIGKILL");
  }
};

export function place(name: string) {
  const dir = join(root, `${++made}-${name}`);
  mkdirSync(dir, { recursive: true });

  return dir;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// For a drill that ends in a process that goes on: bun test stops what a test file left running, the leash included, as the file ends.
export function removeSandbox() {
  rmSync(root, { recursive: true, force: true });
}

const copyOfHex = async (to: string) => {
  const files = (
    await sh(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repo })
  )
    .split("\0")
    .filter((file) => file !== "" && existsSync(join(repo, file)));

  for (const file of files) {
    cpSync(join(repo, file), join(to, file), { verbatimSymlinks: true });
  }
};

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A machine's hex folder, with a home, Claude Code and services of its own: this checkout's files as the one commit of its .hex, installed, and settings that keep its records in the store at storeUrl and reach Telegram at telegramUrl.
export async function folder(
  name: string,
  { telegramUrl, storeUrl }: { telegramUrl: string; storeUrl: string },
) {
  const dir = place(name);
  const hex = join(dir, ".hex");
  const user = join(dir, "user");
  const claude = join(user, "claude");
  const state = join(dir, "state");

  for (const each of [hex, claude, join(user, "run"), join(state, "telegram")]) {
    mkdirSync(each, { recursive: true, mode: 0o700 });
  }

  const env = {
    PATH: `${fakes}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
    HOME: user,
    SHELL: "/bin/sh",
    LANG: "C.UTF-8",
    TMPDIR: user,
    XDG_STATE_HOME: join(user, "state"),
    XDG_CONFIG_HOME: join(user, "config"),
    XDG_CACHE_HOME: join(user, "cache"),
    XDG_RUNTIME_DIR: join(user, "run"),
    CLAUDE_CONFIG_DIR: claude,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: claude,
    BUN_INSTALL_CACHE_DIR: cache,
  };

  const git = async (...args: string[]) =>
    await sh(
      [
        "git",
        "-c",
        "user.name=drill",
        "-c",
        "user.email=drill@localhost",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      {
        cwd: hex,
        env,
      },
    );

  await copyOfHex(hex);
  await git("init", "-q");
  await git("add", "-A");
  await git("commit", "-qm", "hex as the drill found it");
  await sh(["bun", "install", "--no-summary"], { cwd: hex, env });

  writeFileSync(
    join(dir, ".env"),
    [
      "TELEGRAM_BOT_TOKEN=1:drill",
      `TELEGRAM_API_ROOT=${telegramUrl}`,
      `HEX_MAIN_THREAD=${GENERAL}`,
      `HEX_PORT=${freePort()}`,
      `HEX_STORE_KEY=${KEY}`,
      `IIKB_PORT=${freePort()}`,
      "VOICE_PORT=0",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(state, "telegram", "access.json"),
    JSON.stringify({ allowFrom: [String(OWNER)] }),
  );

  const login = await sh(["/bin/sh", "-ilc", "command -v claude"], { cwd: dir, env });

  if (login !== join(fakes, "claude")) {
    throw new Error(
      `a login shell here finds claude at ${login}, ahead of the drill's, so hex could start the real Claude Code: the drill won't run here`,
    );
  }

  const bin = async (...args: string[]) =>
    await sh([join(hex, "bin", "hex"), ...args], { cwd: dir, env });

  const mine = new Set<number>();
  let run: ReturnType<typeof Bun.spawn> | undefined;

  return {
    dir,
    hex,
    env,
    git,
    bin,
    log: () =>
      existsSync(join(state, "hub.log")) ? readFileSync(join(state, "hub.log"), "utf-8") : "",
    moveInto: async () => {
      await bin("threads");
      await bin("store", "move", storeUrl, "hex");
    },
    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // `hex run`, as hex's service starts it, leading a process group that holds everything it starts: its hubs, and the sessions they start through the drill's claude.
    start: () => {
      const log = openSync(join(state, "hub.log"), "a");
      run = Bun.spawn([join(hex, "bin", "hex"), "run"], {
        cwd: dir,
        env,
        stdio: ["ignore", log, log],
        detached: true,
      });
      closeSync(log);
      tell(String(run.pid));
      mine.add(run.pid);

      return run;
    },
    connected: () => existsSync(join(state, "good")),
    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // Each hook of a session here that failed, as the drill's claude wrote it down.
    hooksFailed: () =>
      existsSync(join(claude, "hooks.failed"))
        ? readFileSync(join(claude, "hooks.failed"), "utf-8").trim()
        : "",
    hub: async () =>
      Number(
        await sh(["pgrep", "-P", String(run?.pid), "-f", "hub/serve.ts"], { cwd: dir }).catch(
          () => "0",
        ),
      ),
    hold: (held: boolean) => {
      if (held) {
        writeFileSync(join(claude, "hold"), "");
      } else {
        rmSync(join(claude, "hold"), { force: true });
      }
    },
    sessions: () =>
      readdirSync(join(claude, "jobs")).map((id) => ({
        ...Job.parse(JSON.parse(readFileSync(join(claude, "jobs", id, "state.json"), "utf-8"))),
        channel: existsSync(join(claude, "jobs", id, "channel"))
          ? readFileSync(join(claude, "jobs", id, "channel"), "utf-8")
          : "",
      })),
    stop: async () => {
      mine.forEach(kill);
      await until(() => [...mine].every(gone));

      for (const group of mine) {
        tell(String(-group));
      }

      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type Folder = Awaited<ReturnType<typeof folder>>;
