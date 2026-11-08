import { execFile, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
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

// systemd 254 began expanding ${VARIABLE} in a scope's command and added --expand-environment to turn that off: https://github.com/systemd/systemd/blob/v254/NEWS
let keepVariablesVerbatim: string[] | undefined;

function contained(command: string, args: string[]): [string, string[]] {
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

const PAST_ATTACHING_LINE = /Attaching[^\n]*\n[^]/u;
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

            if (!PAST_ATTACHING_LINE.test(shown)) {
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

export const rm = (session: string) => run(["rm", short(session)]);

export const respawn = (session: Agent) => run(["respawn", job(session)]);

let staleDaemonCheck: Promise<void> | undefined;

function restartStaleDaemon() {
  return (staleDaemonCheck ??= (async () => {
    const [status, version] = await Promise.all([run(["daemon", "status"]), run(["--version"])]);
    const daemon = status?.match(/^version:\s*(\S+)/mu)?.[1];
    const installed = version?.match(/^\S+/u)?.[0];

    if (daemon === undefined || installed === undefined || daemon === installed) {
      return;
    }

    process.stderr.write(
      `hub: Claude's daemon runs ${daemon} while claude is ${installed}, so the hub restarts it\n`,
    );
    await run(["daemon", "stop", "--any", "--keep-workers"]);
  })().finally(() => {
    staleDaemonCheck = undefined;
  }));
}

export async function start(
  launcher: string,
  args: string[],
  options: { cwd: string; env: Record<string, string | undefined> },
): Promise<string> {
  await restartStaleDaemon();

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
