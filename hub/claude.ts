import { execFile, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  watch,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import { sleep } from "./clock.ts";

const ListedAgent = z.object({
  sessionId: z.string(),
  id: z.string().optional(),
  pid: z.number(),
  status: z.string().optional(),
  state: z.string().optional(),
  startedAt: z.number().optional(),
});

export type Agent = z.infer<typeof ListedAgent>;

const Listed = z
  .array(z.unknown())
  .transform((entries) =>
    entries
      .flatMap((entry) => ListedAgent.safeParse(entry).data ?? [])
      .filter(({ pid }) => pid !== 0),
  );

export type Usage = { sent: number; at?: number | undefined; short?: boolean; failed?: number };

const home = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const short = (session: string) => session.slice(0, 8);

const NOT_INHERITED = /_BOT_TOKEN$|^HEX_|^BUZZ_|^CLAUDE_CODE_ENTRYPOINT$/u;

export function inherited(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !NOT_INHERITED.test(name)),
  );
}

// systemd 254 added --expand-environment and plans to expand ${VARIABLE}s in a scope's command by default: https://github.com/systemd/systemd/blob/v254/NEWS
let keepVariablesVerbatim: string[] | undefined;

// Each claude command goes in the sessions slice, since `claude agents` and `claude --bg` start the supervisor that parents every session: https://code.claude.com/docs/en/agent-view#manage-sessions-from-the-shell
// There OOMPolicy=continue keeps one session's out-of-memory kill from ending the rest: https://www.freedesktop.org/software/systemd/man/latest/systemd.scope.html#OOMPolicy=
export function contained(command: string, args: string[]): [string, string[]] {
  const slice = process.env.HEX_SESSIONS_SLICE;

  if (slice === undefined || slice === "") {
    return [command, args];
  }

  keepVariablesVerbatim ??= Bun.spawnSync(["systemd-run", "--help"])
    .stdout.toString()
    .includes("--expand-environment")
    ? ["--expand-environment=no"]
    : [];

  return [
    "systemd-run",
    [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      `--slice=${slice}`,
      "--property=OOMPolicy=continue",
      ...keepVariablesVerbatim,
      command,
      ...args,
    ],
  ];
}

const runningCommands = new Set<Promise<unknown>>();

function tracked<T>(command: Promise<T>): Promise<T> {
  runningCommands.add(command);

  const forget = () => {
    runningCommands.delete(command);
  };

  void command.then(forget).catch(forget);

  return command;
}

export async function settled() {
  for (;;) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    if (runningCommands.size === 0) {
      return;
    }

    await Promise.allSettled(runningCommands);
  }
}

function run(args: string[]): Promise<string | undefined> {
  const [command, argv] = contained("claude", args);

  return tracked(
    new Promise((resolve) => {
      execFile(command, argv, { env: inherited(), timeout: 15_000 }, (error, stdout) => {
        resolve(error ? undefined : stdout);
      });
    }),
  );
}

async function listed(): Promise<Agent[] | undefined> {
  try {
    return Listed.safeParse(JSON.parse((await run(["agents", "--json"])) ?? "")).data;
  } catch {
    return undefined;
  }
}

const ignore = (): undefined => undefined;

// Sessions stop unless a new supervisor connects within about a minute of the old one ending: https://code.claude.com/docs/en/agent-view#keep-sessions-running-after-the-supervisor-stops
// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A supervisor that's down lists no sessions even while some run, so an empty list is trusted only once it answers.
async function awake(asking: () => boolean) {
  if ((await run(["daemon", "status"])) !== undefined) {
    return true;
  }

  if (!asking()) {
    return false;
  }

  process.stderr.write("hub: Claude's daemon isn't answering, so the hub starts it\n");
  const [command, args] = contained("claude", ["daemon", "run"]);
  spawn(command, args, { detached: true, stdio: "ignore", env: inherited() })
    .on("error", ignore)
    .unref();

  return false;
}

const neverAnswered = () => new Promise<never>(ignore);

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A caller that stops asking (a closed hub) gets no answer at all, even to a question already asked.
export async function agents(asking = () => true): Promise<Agent[]> {
  for (let tries = 0; asking(); tries++) {
    const answer = await listed();

    if (!asking()) {
      break;
    }

    if (answer !== undefined && (answer.length > 0 || ((await awake(asking)) && asking()))) {
      return answer;
    }

    if (!asking()) {
      break;
    }

    if (answer === undefined && tries === 0) {
      process.stderr.write("hub: claude agents didn't answer, so the hub asks again\n");
    }

    await sleep(Math.min(1000 * 2 ** tries, 30_000));
  }

  return await neverAnswered();
}

export async function agent(session: string, asking?: () => boolean): Promise<Agent | undefined> {
  return (await agents(asking)).find((candidate) => candidate.sessionId === session);
}

export async function listing(session: string): Promise<Agent | undefined> {
  return (await listed())?.find((candidate) => candidate.sessionId === session);
}

export const stop = (session: string) => run(["stop", short(session)]);

const KEYS_REACH_SESSION_AFTER_ATTACHING_LINE = /Attaching[^\n]*\n[^]/u;
const ESC = "\u001B";

export function interrupt(
  cwd: string,
  session: string,
  until: AbortSignal,
): Promise<"interrupted" | "exited" | "let go"> {
  const file = transcript(cwd, session);
  const from = sizeOf(file);

  if (from === undefined) {
    return Promise.resolve("exited");
  }

  if (until.aborted) {
    return Promise.resolve("let go");
  }

  return new Promise((resolve, reject) => {
    let attach: ReturnType<typeof Bun.spawn> | undefined;

    const watcher = watch(dirname(file), (_, name) => {
      if (name === `${session}.jsonl` && interruptedSince(file, from)) {
        finish("interrupted");
      }
    });

    let over = false;

    const finish = (how: "interrupted" | "exited" | "let go") => {
      if (over) {
        return;
      }

      over = true;
      watcher.close();
      until.removeEventListener("abort", letGo);
      attach?.kill("SIGHUP");
      attach?.terminal?.close();
      resolve(how);
    };

    watcher.on("error", () => {
      finish("exited");
    });

    const letGo = () => {
      finish("let go");
    };

    let shown = "";
    let pressed = false;

    try {
      // No shell command interrupts a session's turn (https://code.claude.com/docs/en/agent-view#manage-sessions-from-the-shell), so attach presses Esc, which stops the turn: https://code.claude.com/docs/en/interactive-mode#general-controls
      // The Stop hook doesn't run on an interrupt: https://code.claude.com/docs/en/hooks#stop
      const [command, args] = contained("claude", ["attach", short(session)]);
      attach = Bun.spawn([command, ...args], {
        env: inherited(),
        terminal: {
          cols: 120,
          rows: 40,
          data: (terminal, output) => {
            if (pressed) {
              return;
            }

            shown += Buffer.from(output).toString("latin1");

            if (!KEYS_REACH_SESSION_AFTER_ATTACHING_LINE.test(shown)) {
              return;
            }

            pressed = true;
            terminal.write(ESC);
          },
        },
      });
    } catch (error) {
      watcher.close();

      reject(error instanceof Error ? error : new Error(String(error)));

      return;
    }

    until.addEventListener("abort", letGo);
    void attach.exited.finally(() => {
      finish(interruptedSince(file, from) ? "interrupted" : "exited");
    });
  });
}

function sizeOf(file: string): number | undefined {
  try {
    return statSync(file).size;
  } catch {
    return undefined;
  }
}

function interruptedSince(file: string, from: number) {
  try {
    const size = statSync(file).size;

    if (size <= from) {
      return false;
    }

    const added = Buffer.alloc(size - from);
    const fd = openSync(file, "r");

    try {
      readSync(fd, added, 0, added.length, from);
    } finally {
      closeSync(fd);
    }

    return added.toString("utf-8").split("\n").some(interruption);
  } catch {
    return false;
  }
}

const INTERRUPTED = "[Request interrupted by user";

const TokenUsage = z.object({
  input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation: z
    .object({
      ephemeral_5m_input_tokens: z.number().optional(),
      ephemeral_1h_input_tokens: z.number().optional(),
    })
    .optional(),
});

const TranscriptEntry = z.object({
  type: z.string().optional(),
  subtype: z.string().optional(),
  timestamp: z.string().optional(),
  isSidechain: z.boolean().optional(),
  content: z.unknown().optional(),
  compactMetadata: z.object({ postTokens: z.number().optional() }).optional(),
  message: z.object({ content: z.unknown().optional(), usage: TokenUsage.optional() }).optional(),
});

function entryOf(line: string): z.infer<typeof TranscriptEntry> | undefined {
  try {
    return TranscriptEntry.safeParse(JSON.parse(line)).data;
  } catch {
    return undefined;
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A transcript's request records repeat earlier interrupts, so only the session's own user line counts.
function interruption(line: string) {
  if (!line.includes(INTERRUPTED)) {
    return false;
  }

  const entry = entryOf(line);

  return entry !== undefined && interrupted(entry);
}

const Texts = z
  .union([
    z.string().transform((text) => [text]),
    z.array(
      z
        .object({ text: z.string().default("") })
        .catch({ text: "" })
        .transform(({ text }) => text),
    ),
  ])
  .catch([]);

export function interrupted(entry: {
  type?: string | undefined;
  isSidechain?: boolean | undefined;
  message?: { content?: unknown } | undefined;
}) {
  return (
    entry.type === "user" &&
    entry.isSidechain !== true &&
    Texts.parse(entry.message?.content).some((text) => text.startsWith(INTERRUPTED))
  );
}

// `claude --bg --resume` can start a copy under a new ID, which happens while the old session's job record exists: https://code.claude.com/docs/en/agent-view#dispatch-an-agent-from-your-shell
export const rm = (session: string) => run(["rm", short(session)]);

export const respawn = async (session: Agent) => {
  await restartStaleDaemon();

  return await run(["respawn", job(session)]);
};

// A supervisor on another version than the claude invoked picks up the new one after `claude daemon stop --any`: https://code.claude.com/docs/en/agent-view#where-state-is-stored
// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A session the supervisor restarts gets the supervisor's PATH, not the hub's, so one started on an older PATH is stale too.
let staleDaemonCheck: Promise<void> | undefined;

export function restartStaleDaemon() {
  return (staleDaemonCheck ??= (async () => {
    const [status, version] = await Promise.all([run(["daemon", "status"]), run(["--version"])]);
    const daemon = status?.match(/^version:\s*(\S+)/mu)?.[1];
    const installed = version?.match(/^\S+/u)?.[0];
    const pid = status?.match(/^pid:\s*(\d+)/mu)?.[1];
    const missing = pid === undefined ? [] : await missingFromPath(pid);

    if (daemon === undefined || installed === undefined) {
      return;
    }

    const why =
      daemon === installed
        ? missing.length > 0
          ? `runs without ${missing.join(":")} on its PATH`
          : undefined
        : `runs ${daemon} while claude is ${installed}`;

    if (why === undefined) {
      return;
    }

    process.stderr.write(`hub: Claude's daemon ${why}, so the hub restarts it\n`);
    await run(["daemon", "stop", "--any", "--keep-workers"]);
  })().finally(() => {
    staleDaemonCheck = undefined;
  }));
}

// `ps e` prints a process's environment after its command on Linux and macOS: https://man7.org/linux/man-pages/man1/ps.1.html
function missingFromPath(pid: string): Promise<string[]> {
  return tracked(
    new Promise((resolve) => {
      execFile("ps", ["eww", "-o", "command=", "-p", pid], (error, stdout) => {
        const theirs = error ? undefined : / PATH=(\S*)/u.exec(stdout)?.[1];

        resolve(theirs === undefined ? [] : lackingFrom(theirs.split(":")));
      });
    }),
  );
}

function lackingFrom(theirs: string[]): string[] {
  const ours = (process.env.PATH ?? "").split(":").filter(Boolean);
  const shared = new Set(theirs.map(real));

  return ours.filter(
    (each) =>
      !shared.has(real(each)) &&
      commands(each).some((command) => found(command, ours) !== found(command, theirs)),
  );
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function found(command: string, path: string[]): string | undefined {
  for (const each of path) {
    try {
      return realpathSync(join(each, command));
      // oxlint-disable-next-line eslint/no-empty -- a directory without the command leaves it to the next
    } catch {}
  }

  return undefined;
}

function commands(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

export async function start(
  launcher: string,
  args: string[],
  options: { cwd: string; env: Record<string, string | undefined> },
  daemonChecked = restartStaleDaemon(),
): Promise<string> {
  await daemonChecked;

  return await tracked(
    new Promise((resolve, reject) => {
      const [command, argv] = contained(launcher, ["--bg", ...args]);
      const child = spawn(command, argv, { ...options, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        const backgrounded = /backgrounded · (\w+)/u.exec(output)?.[1];

        if (backgrounded === undefined) {
          reject(new Error(output.trim() || `claude --bg exited with code ${code}`));
        } else {
          resolve(backgrounded);
        }
      });
    }),
  );
}

// Only a parent can wait on a process (https://man7.org/linux/man-pages/man2/waitpid.2.html) and pidwait isn't on macOS (https://man7.org/linux/man-pages/man1/pidwait.1.html), so this polls.
export function exited(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      try {
        process.kill(pid, 0);
        setTimeout(check, 100);
      } catch {
        resolve();
      }
    };

    check();
  });
}

const SystemError = z.object({ code: z.string().optional() });

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return SystemError.safeParse(error).data?.code === "EPERM";
  }
}

function job(session: Agent) {
  return session.id ?? short(session.sessionId);
}

export const JobState = z.object({
  state: z.string().optional(),
  detail: z.string().optional(),
  needs: z.string().optional(),
  sessionId: z.string().optional(),
  respawnFlags: z.array(z.string()).optional(),
});

export type Job = z.infer<typeof JobState>;

export function record(id: string): Job {
  try {
    return JobState.parse(
      JSON.parse(readFileSync(join(home(), "jobs", id, "state.json"), "utf-8")),
    );
  } catch {
    return {};
  }
}

export function watchJob(id: string, change: () => void) {
  return watch(join(home(), "jobs", id), change);
}

const Launch = z.looseObject({
  enabledPlugins: z.record(z.string(), z.unknown()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export function settingsFlag(respawnFlags: string[] = []) {
  const at = respawnFlags.lastIndexOf("--settings");

  return at === -1 ? "" : (respawnFlags[at + 1] ?? "");
}

export function settingsOf(session: Agent): z.infer<typeof Launch> | undefined {
  try {
    const file = settingsFlag(record(job(session)).respawnFlags);

    return Launch.parse(JSON.parse(readFileSync(file, "utf-8")));
  } catch {
    return undefined;
  }
}

export function transcript(cwd: string, session: string) {
  return join(home(), "projects", cwd.replaceAll(/[^a-zA-Z0-9]/gu, "-"), `${session}.jsonl`);
}

export function saved(session: string) {
  const projects = join(home(), "projects");

  try {
    return readdirSync(projects).some((project) =>
      existsSync(join(projects, project, `${session}.jsonl`)),
    );
  } catch (error) {
    return SystemError.safeParse(error).data?.code !== "ENOENT";
  }
}

const COMPACTION_FAILED = "Error during compaction";
const NEWEST_BYTES = 2 ** 20;

export function usage(cwd: string, session: string): Usage {
  let file: number;

  try {
    file = openSync(transcript(cwd, session), "r");
  } catch {
    return { sent: 0 };
  }

  try {
    const size = fstatSync(file).size;
    const tail = Buffer.alloc(Math.min(size, NEWEST_BYTES));
    readSync(file, tail, 0, tail.length, size - tail.length);
    let failed: number | undefined;

    for (const line of tail.toString("utf-8").split("\n").toReversed()) {
      if (
        !line.includes('"usage"') &&
        !line.includes('"compact_boundary"') &&
        !line.includes(COMPACTION_FAILED)
      ) {
        continue;
      }

      const entry = entryOf(line);

      if (entry === undefined) {
        continue;
      }

      const at =
        entry.timestamp === undefined || entry.timestamp === ""
          ? undefined
          : Date.parse(entry.timestamp);

      if (entry.type === "system" && entry.subtype === "compact_boundary") {
        return { sent: entry.compactMetadata?.postTokens ?? 0, at };
      }

      if (
        entry.type === "system" &&
        entry.subtype === "local_command" &&
        String(entry.content).includes(COMPACTION_FAILED)
      ) {
        failed ??= at ?? 0;
      }

      const tokens =
        entry.type === "assistant" && entry.isSidechain !== true ? entry.message?.usage : undefined;

      const sent =
        tokens === undefined
          ? 0
          : (tokens.input_tokens ?? 0) +
            (tokens.cache_creation_input_tokens ?? 0) +
            (tokens.cache_read_input_tokens ?? 0);

      if (sent !== 0 && tokens !== undefined) {
        const cache = tokens.cache_creation;

        return {
          sent,
          at,
          short:
            (cache?.ephemeral_5m_input_tokens ?? 0) !== 0 &&
            (cache?.ephemeral_1h_input_tokens ?? 0) === 0,
          ...(failed !== undefined && { failed }),
        };
      }
    }

    return { sent: 0 };
  } finally {
    closeSync(file);
  }
}
