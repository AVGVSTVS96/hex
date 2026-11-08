import { appendFileSync, readFileSync } from "fs";
import { join } from "path";

import { clip } from "./fit.ts";
import type { Job } from "./schedule.ts";
import { hexDir, open } from "./store.ts";
import { render } from "./tasks.ts";

// An idea's check: a schedules.json job that names an idea runs this instead of waking a session,
// once as soon as the job appears and then at each slot. A small model reads the idea, what its
// last checks found and what the job asks it to look into, searches the web and hex's own logs,
// and says whether there's news. Only news reaches the idea's thread. Every check goes in
// ideas.jsonl with the input it was given, what it found and what it spent, so a prompt can be
// replayed against past checks, and the next check starts from there.

const MODEL = "opus";
const CALL = 10 * 60_000;
const KEPT = 5;

const SYSTEM = `You keep one of my ideas moving while it waits on me. Below are my words for it, what to look into, and what your last checks found. Look for what's new since then: on the web, and in what's happened here when the idea touches it (\`.hex/bin/hex log -- '<thread>'\` prints a thread's conversation; pipe it to rg). When there's something I'd want to hear, answer news: true with a finding of a line or two and its links. Otherwise answer news: false, with what you looked at as the finding, so the next check goes further.`;

const SCHEMA = {
  type: "object",
  properties: { news: { type: "boolean" }, finding: { type: "string" } },
  required: ["news", "finding"],
};

export type Found = { news: boolean; finding: string; tokens?: number; cost?: number };
export type Check = {
  at: string;
  schedule: string;
  idea: string;
  input?: string;
  news?: boolean;
  finding?: string;
  tokens?: number;
  cost?: number;
  error?: string;
  ended?: string;
};

export async function look(input: string): Promise<Found> {
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !name.startsWith("HEX_") && !name.startsWith("CLAUDECODE"),
      ),
    ),
    CLAUDE_CODE_ENTRYPOINT: "hex",
    HEX_HELPER: "ideas",
  };
  const run = Bun.spawn(
    [
      "claude",
      "-p",
      "--safe-mode",
      "--model",
      MODEL,
      "--effort",
      "low",
      "--tools",
      "WebSearch,WebFetch,Bash",
      "--allowedTools",
      "WebSearch",
      "WebFetch",
      "Bash(.hex/bin/hex log:*)",
      "Bash(rg:*)",
      "--json-schema",
      JSON.stringify(SCHEMA),
      "--system-prompt",
      SYSTEM,
      "--output-format",
      "json",
      "--no-session-persistence",
    ],
    { cwd: hexDir(), env, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe", timeout: CALL },
  );
  const [out, code] = await Promise.all([new Response(run.stdout).text(), run.exited]);
  const result = JSON.parse(out || "{}");
  if (code !== 0 || result.is_error || !result.structured_output)
    throw new Error(`claude exited ${code}: ${String(result.result ?? "").slice(0, 300)}`);
  const {
    input_tokens = 0,
    output_tokens = 0,
    cache_read_input_tokens = 0,
    cache_creation_input_tokens = 0,
  } = result.usage ?? {};
  return {
    ...result.structured_output,
    tokens: input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens,
    cost: result.total_cost_usd,
  };
}

export function checks(state: string, idea?: string): Check[] {
  try {
    return readFileSync(join(state, "ideas.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Check)
      .filter((check) => !idea || check.idea === idea);
  } catch {
    return [];
  }
}

// One check of the idea a job names. An idea that's done, dropped or gone has nothing left to
// look into, and its thread hears once to take the job out.
export async function research(
  state: string,
  name: string,
  job: Job,
  main: string,
  minute: number,
  ask = look,
) {
  const store = open(state);
  const id = job.idea!;
  const task = store.task(id);
  const to = job.thread ?? task?.owner ?? main;
  const record: Check = { at: new Date().toISOString(), schedule: name, idea: id };
  if (!task || task.status === "done" || task.status === "dropped") {
    record.ended = task?.status ?? "gone";
    const body = `[${name}] ${id} is ${record.ended}, so its check in schedules.json has nothing left to look into: take the job out.`;
    store.deliver({
      key: `schedule:${name}:${id}-${record.ended}`,
      to,
      from: "schedule",
      author: "prompt",
      body,
      meta: { user: "schedule", schedule: name },
    });
  } else {
    const all = checks(state, id);
    const past = all.filter((check) => check.finding).slice(-KEPT);
    record.input = [
      render(task, store.names()),
      `What to look into: ${job.prompt}`,
      past.length
        ? `What the last checks found:\n${past.map((check) => `- ${check.at.slice(0, 10)}: ${check.finding}`).join("\n")}`
        : "This is its first check.",
      `Today is ${new Date(minute * 60_000).toISOString().slice(0, 10)}.`,
    ].join("\n\n");
    try {
      Object.assign(record, await ask(record.input));
      if (record.news)
        store.fire(name, minute, to, `[${name}] News for ${id} (${task.title}): ${record.finding}`);
    } catch (error) {
      record.error = String(error);
      // The second failure in a row is told once, so a check that stopped working isn't silent.
      const [last, before] = [all.at(-1), all.at(-2)];
      if (last?.error && !before?.error)
        store.fire(
          name,
          minute,
          to,
          `[${name}] ${id}'s idea check failed twice in a row, and tries again at its next slot: ${clip(record.error, 300)}`,
        );
    }
  }
  appendFileSync(join(state, "ideas.jsonl"), `${JSON.stringify(record)}\n`);
}

// The scheduler hands every idea job over each minute, with its slot when one came due. A job
// never checked yet runs now, so an idea's research starts the moment its job is added. Checks run
// one at a time, in the order they came due, and a job already running skips its turn.
const busy = new Set<string>();
let line = Promise.resolve();

export function study(state: string, name: string, job: Job, main: string, slot?: number) {
  if (
    busy.has(name) ||
    (slot === undefined && checks(state).some((check) => check.schedule === name))
  )
    return;
  busy.add(name);
  line = line
    .then(() => research(state, name, job, main, slot ?? Math.floor(Date.now() / 60_000)))
    .catch((error) => process.stderr.write(`hub: ${name}'s idea check failed: ${error}\n`))
    .finally(() => busy.delete(name));
}
