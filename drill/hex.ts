import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cp } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import { until } from "../hub/until.ts";
import { KEY } from "./cloudflare.ts";
import { GENERAL, OWNER } from "./telegram.ts";

const repo = join(import.meta.dir, "..");
const fakes = join(import.meta.dir, "bin");

const Job = z.object({
  sessionId: z.string(),
  pid: z.number().optional(),
  respawnFlags: z.array(z.string()).default([]),
});

const cache = process.env.BUN_INSTALL_CACHE_DIR ?? join(homedir(), ".bun", "install", "cache");

const caches = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");

mkdirSync(caches, { recursive: true });

for (const left of readdirSync(caches).filter((name) => name.startsWith("hex-drill-"))) {
  const runner = join(caches, left, "runner");

  if (existsSync(runner) && !alive(Number(readFileSync(runner, "utf-8")))) {
    const running = runningIn(join(caches, left));

    for (const pid of running) {
      process.kill(pid, "SIGKILL");
    }

    await until(() => !running.some(alive));
    rmSync(join(caches, left), { recursive: true, force: true });
  }
}

const root = mkdtempSync(join(caches, "hex-drill-"));

writeFileSync(join(root, "runner"), String(process.pid));

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

function alive(pid: number) {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
}

function runningIn(sandbox: string) {
  const inside = (pid: string) => {
    try {
      return `${readlinkSync(`/proc/${pid}/cwd`)}/`.startsWith(`${sandbox}/`);
    } catch {
      return false;
    }
  };

  return existsSync("/proc")
    ? readdirSync("/proc")
        .filter((name) => /^\d+$/u.test(name) && inside(name))
        .map(Number)
    : [];
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

export function removeSandbox() {
  rmSync(root, { recursive: true, force: true });
}

const copyOfHex = async (to: string) => {
  const files = (
    await sh(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repo })
  )
    .split("\0")
    .filter((file) => file !== "" && !file.endsWith("/") && existsSync(join(repo, file)));

  for (const file of files) {
    await cp(join(repo, file), join(to, file), { verbatimSymlinks: true });
  }
};

export async function folder(
  name: string,
  { telegramUrl, storeUrl }: { telegramUrl: string; storeUrl: string },
) {
  const dir = join(root, `${++made}-${name}`);
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

  writeFileSync(join(claude, "runner"), String(process.pid));

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
    faults: () =>
      existsSync(join(claude, "faults"))
        ? readFileSync(join(claude, "faults"), "utf-8").trim()
        : "",
    sessionLogs: () =>
      (existsSync(join(claude, "jobs")) ? readdirSync(join(claude, "jobs")) : []).map((id) => {
        const { respawnFlags } = Job.parse(
          JSON.parse(readFileSync(join(claude, "jobs", id, "state.json"), "utf-8")),
        );

        return {
          name: respawnFlags[respawnFlags.indexOf("--name") + 1] ?? id,
          log: readFileSync(join(claude, "jobs", id, "log"), "utf-8"),
        };
      }),
    hub: async () =>
      Number(
        await sh(["pgrep", "-P", String(run?.pid), "-f", "hub/serve.ts"], { cwd: dir }).catch(
          () => "0",
        ),
      ),
    hold: (held: boolean, what: "answers" | "channel" = "answers") => {
      const file = join(claude, what === "answers" ? "hold" : "hold.channel");

      if (held) {
        writeFileSync(file, "");
      } else {
        rmSync(file, { force: true });
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
    },
  };
}

export type Folder = Awaited<ReturnType<typeof folder>>;
