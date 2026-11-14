import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { JobState, settingsFlag } from "./claude.ts";
import type { Store } from "./store.ts";

export type Session = {
  id: string;
  pid: number;
  job?: string;
  status: string;
  state?: string;
  detail?: string;
  needs?: string;
  kind?: string | undefined;
  name?: string | undefined;
  cwd?: string | undefined;
  started: number;
  updated?: number;
  thread?: string | undefined;
  parent?: string;
  helper?: string;
  beside?: string;
  began?: string;
  ended?: string;
};

const SessionRecord = z.object({
  sessionId: z.string().min(1),
  pid: z.number(),
  procStart: z.string().optional(),
  jobId: z.string().optional(),
  status: z.string().default("idle"),
  kind: z.string().optional(),
  name: z.string().optional(),
  cwd: z.string().optional(),
  startedAt: z.number().optional(),
  statusUpdatedAt: z.number().optional(),
});

const configured = process.env.CLAUDE_CONFIG_DIR;

export const CLAUDE =
  configured === undefined || configured === "" ? join(homedir(), ".claude") : configured;

const BUSY = new Set(["busy", "shell"]);

export const busy = (session?: Session) => session !== undefined && BUSY.has(session.status);
const busyness = (status: string) => (status === "busy" ? 2 : status === "shell" ? 1 : 0);

function outranks(kept: Session, status: string, updated: number) {
  const ranks = busyness(kept.status) - busyness(status);

  return ranks > 0 || (ranks === 0 && (kept.updated ?? kept.started) >= updated);
}

const nonEmpty = (value: string | undefined) =>
  value !== undefined && value !== "" ? value : undefined;

export function running(store: Store, claude = CLAUDE): Map<string, Session> {
  const sessions = new Map<string, Session>();
  const pids = new Map<number, string>();
  const dir = join(claude, "sessions");

  for (const file of list(dir)) {
    const record = file.endsWith(".json") ? readJson(join(dir, file), SessionRecord) : undefined;

    if (record === undefined || !alive(record.pid, record.procStart)) {
      continue;
    }

    const {
      sessionId: id,
      pid,
      jobId,
      status,
      kind,
      name,
      cwd,
      startedAt: started = 0,
      statusUpdatedAt: updated,
    } = record;

    pids.set(pid, id);
    const kept = sessions.get(id);

    if (kept !== undefined && outranks(kept, status, updated ?? started)) {
      continue;
    }

    const job = nonEmpty(jobId) ?? kept?.job;

    const { state, detail, needs, respawnFlags } =
      readJson(join(claude, "jobs", job ?? id.slice(0, 8), "state.json"), JobState) ?? {};

    const progress = Object.fromEntries(
      Object.entries({ state, detail, needs }).filter(([, value]) => nonEmpty(value) !== undefined),
    );

    // A background session runs with the supervisor's environment, not its dispatcher's, so its thread comes from its settings' env: https://code.claude.com/docs/en/agent-view#llm-gateway
    const env = kind === "bg" ? launched(respawnFlags) : environ(pid);
    const helper = nonEmpty(env.HEX_HELPER);
    const beside = nonEmpty(env.HEX_BESIDE);
    sessions.set(id, {
      id,
      pid,
      ...(job !== undefined && { job }),
      status,
      ...progress,
      kind,
      name,
      cwd,
      started,
      ...(updated !== undefined && { updated }),
      thread: served(env),
      ...(helper !== undefined && { helper }),
      ...(beside !== undefined && { beside }),
      ...store.turns.get(id),
    });
  }

  for (const session of sessions.values()) {
    const parent =
      session.kind === "bg" ? undefined : nearestSessionAbove(session.pid, pids, session.id);

    if (parent !== undefined) {
      session.parent = parent;
    }
  }

  return sessions;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A background session's record starts when its job takes a spare process, which is when it loads plugins; a /clear keeps the process and gives the record the new session's id.
export function own(
  session: string,
  claude = CLAUDE,
  pid = process.ppid,
): { started: number; cwd: string | undefined } | undefined {
  for (let above = pid; above > 0; above = parentOf(above)) {
    const record = readJson(join(claude, "sessions", `${above}.json`), SessionRecord);

    if (
      record?.sessionId === session &&
      record.pid === above &&
      record.startedAt !== undefined &&
      alive(above, record.procStart)
    ) {
      return { started: record.startedAt, cwd: record.cwd };
    }
  }

  return undefined;
}

type OwnershipOptions = {
  owners?: Map<string, string>;
  boundary?: (id: string) => boolean;
  display?: (thread: string) => string;
};

export function ownership(
  session: Session,
  held: Map<string, string>,
  sessions: Map<string, Session>,
  { owners = held, boundary = () => false, display = (thread) => thread }: OwnershipOptions = {},
) {
  const chain: Session[] = [];
  const seen = new Set<string>();
  let cyclic = false;

  for (
    let one: Session | undefined = session;
    one !== undefined;
    one = one.parent === undefined ? undefined : sessions.get(one.parent)
  ) {
    if (seen.has(one.id)) {
      cyclic = true;
      break;
    }

    seen.add(one.id);
    chain.push(one);

    if (held.has(one.id) || one.helper !== undefined || boundary(one.id)) {
      break;
    }
  }

  let thread: string | undefined;
  let top = session;
  let parent: Session | undefined;
  let t3 = false;

  for (const one of chain.toReversed()) {
    t3 ||= boundary(one.id);

    let owner =
      owners.get(one.id) ??
      (one.helper === undefined ? (t3 ? thread : (one.thread ?? thread)) : undefined);

    if (owner !== undefined && owner !== "" && !held.has(one.id)) {
      owner = display(owner);
    }

    if (parent === undefined || held.has(parent.id) || owner !== thread) {
      top = one;
    }

    thread = owner;
    parent = one;
  }

  return { thread, top: cyclic ? session : top };
}

export function serving(
  session: Session,
  held: Map<string, string>,
  sessions = new Map<string, Session>(),
): string | undefined {
  return ownership(session, held, sessions).thread;
}

export function served(env = process.env): string | undefined {
  const app = env.HEX_CHANNEL?.match(/^plugin:([^@]+)/u)?.[1];

  if (app !== undefined && nonEmpty(env.HEX_THREAD) !== undefined) {
    return `${app}:${env.HEX_THREAD}`;
  }

  return env.HEX_OWNER?.includes(":") === true ? env.HEX_OWNER : undefined;
}

const LaunchSettings = z.object({ env: z.record(z.string(), z.unknown()) });
const Text = z.string();

function launched(respawnFlags: string[] | undefined): Record<string, string> {
  const settings = settingsFlag(respawnFlags);

  const launch = settings.startsWith("{")
    ? parse(settings, LaunchSettings)
    : settings.startsWith("/")
      ? readRegularJson(settings, LaunchSettings)
      : undefined;

  return Object.fromEntries(
    Object.entries(launch?.env ?? {}).filter(
      (entry): entry is [string, string] => Text.safeParse(entry[1]).success,
    ),
  );
}

function environ(pid: number): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(`/proc/${pid}/environ`, "utf-8")
        .split("\0")
        .map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]),
    );
  } catch {
    return {};
  }
}

function nearestSessionAbove(
  pid: number,
  sessions: Map<number, string>,
  self: string,
): string | undefined {
  for (let above = parentOf(pid); above > 0; above = parentOf(above)) {
    const id = sessions.get(above);

    if (id !== undefined && id !== self) {
      return id;
    }
  }

  return undefined;
}

const STATE = 0;
const PARENT = 1;
const START_TIME = 19;

function parentOf(pid: number) {
  return Number(statAfterName(pid)?.[PARENT]) || 0;
}

function statAfterName(pid: number): string[] | undefined {
  try {
    const line = readFileSync(`/proc/${pid}/stat`, "utf-8");

    return line.slice(line.lastIndexOf(")") + 2).split(" ");
  } catch {
    return undefined;
  }
}

// Sessions are this user's processes, so one the user can't signal (EPERM) is another's: https://man7.org/linux/man-pages/man2/kill.2.html
// A start time (field 22) other than the record's procStart means a dead session's pid was reused, and state Z is a zombie: https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html
function alive(pid: number, procStart: string | undefined) {
  try {
    if (!Number.isInteger(pid) || pid <= 0 || !process.kill(pid, 0)) {
      return false;
    }
  } catch {
    return false;
  }

  const fields = statAfterName(pid);

  if (fields?.[STATE] === "Z") {
    return false;
  }

  return (
    procStart === undefined ||
    statAfterName(process.pid) === undefined ||
    fields?.[START_TIME] === procStart
  );
}

function list(dir: string) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readJson<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
): z.infer<Schema> | undefined {
  try {
    return parse(readFileSync(path, "utf-8"), schema);
  } catch {
    return undefined;
  }
}

function readRegularJson<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
): z.infer<Schema> | undefined {
  let fd: number | undefined;

  try {
    // oxlint-disable-next-line eslint/no-bitwise -- open flags are a bit set
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);

    return fstatSync(fd).isFile() ? parse(readFileSync(fd, "utf-8"), schema) : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function parse<Schema extends z.ZodType>(
  text: string,
  schema: Schema,
): z.infer<Schema> | undefined {
  try {
    return schema.safeParse(JSON.parse(text)).data;
  } catch {
    return undefined;
  }
}
