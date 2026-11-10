import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { clip } from "./fit.ts";
import type { IdeaJob, Job } from "./schedule.ts";
import { hexDir, open } from "./store.ts";
import { render } from "./tasks.ts";

const MODEL = "opus";
const CALL = 10 * 60_000;
const PAST_FINDINGS_GIVEN = 5;

const SYSTEM = `You keep one of my ideas moving while it waits on me. Below are my words for it, what to look into, and what your last checks found. Look for what's new since then: on the web, and in what's happened here when the idea touches it (\`.hex/bin/hex log -- '<thread>'\` prints a thread's conversation; pipe it to rg). When there's something I'd want to hear, answer news: true with a finding of a line or two and its links. Otherwise answer news: false, with what you looked at as the finding, so the next check goes further.`;

const JOB = `You run one of my timed jobs as a check, on your own: only your answer reaches the thread the job belongs to. Look into what the job asks; acting on what you find is the thread's. When there's something the thread should act on or tell me, answer news: true with a finding it can act on alone: what's new, with its links and ids, and what the job says to do about it. Where the job says to message me, that message is your finding, and where it says what to answer when there's nothing, answer news: false, with what you looked at as the finding. Anything the job needs that you couldn't reach is news.`;

const SCHEMA = {
  type: "object",
  properties: { news: { type: "boolean" }, finding: { type: "string" } },
  required: ["news", "finding"],
};

const Answer = z.object({ news: z.boolean(), finding: z.string() });

const ClaudeResult = z.object({
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  structured_output: z.unknown(),
  total_cost_usd: z.number().optional(),
  usage: z
    .object({
      input_tokens: z.number().default(0),
      output_tokens: z.number().default(0),
      cache_read_input_tokens: z.number().default(0),
      cache_creation_input_tokens: z.number().default(0),
    })
    .optional(),
});

export type Found = z.infer<typeof Answer> & { tokens?: number; cost?: number | undefined };

const CheckSchema = z.object({
  at: z.string(),
  schedule: z.string(),
  idea: z.string().optional(),
  input: z.string().optional(),
  news: z.boolean().optional(),
  finding: z.string().optional(),
  tokens: z.number().optional(),
  cost: z.number().optional(),
  error: z.string().optional(),
  ended: z.string().optional(),
});

export type Check = z.infer<typeof CheckSchema>;

async function spawnCheck(helper: string, command: string[], input: string): Promise<Found> {
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !name.startsWith("HEX_") && !name.startsWith("CLAUDECODE"),
      ),
    ),
    CLAUDE_CODE_ENTRYPOINT: "hex",
    HEX_HELPER: helper,
  };

  const run = Bun.spawn(
    [
      ...command,
      "--effort",
      "low",
      "--json-schema",
      JSON.stringify(SCHEMA),
      "--output-format",
      "json",
      "--no-session-persistence",
    ],
    { cwd: hexDir(), env, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe", timeout: CALL },
  );

  const [out, code] = await Promise.all([new Response(run.stdout).text(), run.exited]);
  const result = ClaudeResult.parse(JSON.parse(out === "" ? "{}" : out));

  const answer = Answer.safeParse(result.structured_output);

  if (code !== 0 || result.is_error === true || !answer.success) {
    throw new Error(`claude exited ${code}: ${(result.result ?? "").slice(0, 300)}`);
  }

  const {
    input_tokens = 0,
    output_tokens = 0,
    cache_read_input_tokens = 0,
    cache_creation_input_tokens = 0,
  } = result.usage ?? {};

  return {
    ...answer.data,
    tokens: input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens,
    cost: result.total_cost_usd,
  };
}

export const look = (input: string) =>
  spawnCheck(
    "ideas",
    [
      "claude",
      "-p",
      "--safe-mode",
      "--model",
      MODEL,
      "--tools",
      "WebSearch,WebFetch,Bash",
      "--allowedTools",
      "WebSearch",
      "WebFetch",
      "Bash(.hex/bin/hex log:*)",
      "Bash(rg:*)",
      "--system-prompt",
      SYSTEM,
    ],
    input,
  );

export const see = (input: string) =>
  spawnCheck(
    "schedule",
    [join(import.meta.dir, "..", "bin", "session"), "-p", "--append-system-prompt", JOB],
    input,
  );

function kept(state: string, file: string): Check[] {
  try {
    return readFileSync(join(state, file), "utf-8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => CheckSchema.parse(JSON.parse(line)));
  } catch {
    return [];
  }
}

export function checks(state: string, idea?: string): Check[] {
  return kept(state, "ideas.jsonl").filter(
    (check) => idea === undefined || idea === "" || check.idea === idea,
  );
}

export const jobChecks = (state: string, name: string) =>
  kept(state, "checks.jsonl").filter((check) => check.schedule === name);

export async function research(
  state: string,
  name: string,
  job: IdeaJob,
  main: string,
  minute: number,
  ask = look,
) {
  const store = open(state);
  const id = job.idea;
  const task = store.tasks.get(id);
  const to = job.thread ?? task?.owner ?? main;
  const record: Check = { at: new Date().toISOString(), schedule: name, idea: id };

  if (!task || task.status === "done" || task.status === "dropped") {
    record.ended = task?.status ?? "gone";

    const body = `[${name}] ${id} is ${record.ended}, so its check in schedules.json has nothing left to look into: take the job out.`;
    store.messages.deliver({
      key: `schedule:${name}:${id}-${record.ended}`,
      to,
      from: "schedule",
      author: "prompt",
      body,
      meta: { user: "schedule", schedule: name },
    });
  } else {
    const all = checks(state, id);

    const past = all
      .filter((check) => check.finding !== undefined && check.finding !== "")
      .slice(-PAST_FINDINGS_GIVEN);

    record.input = [
      render(task, store.threads.names()),
      `What to look into: ${job.prompt}`,
      past.length
        ? `What the last checks found:\n${past.map((check) => `- ${check.at.slice(0, 10)}: ${check.finding}`).join("\n")}`
        : "This is its first check.",
      `Today is ${new Date(minute * 60_000).toISOString().slice(0, 10)}.`,
    ].join("\n\n");

    try {
      Object.assign(record, await ask(record.input));

      if (record.news === true) {
        store.scheduler.fire(
          name,
          minute,
          to,
          `[${name}] News for ${id} (${task.title}): ${record.finding}`,
        );
      }
    } catch (error) {
      record.error = String(error);

      const [last, before] = [all.at(-1), all.at(-2)];
      const failed = (check: Check | undefined) => check?.error !== undefined && check.error !== "";
      const secondFailureInARow = failed(last) && !failed(before);

      if (secondFailureInARow) {
        store.scheduler.fire(
          name,
          minute,
          to,
          `[${name}] ${id}'s idea check failed twice in a row, and tries again at its next slot: ${clip(record.error, 300)}`,
        );
      }
    }
  }

  appendFileSync(join(state, "ideas.jsonl"), `${JSON.stringify(record)}\n`);
}

export async function watch(
  state: string,
  name: string,
  job: Job,
  main: string,
  minute: number,
  check = see,
) {
  const store = open(state);
  const to = job.thread ?? main;
  const record: Check = { at: new Date().toISOString(), schedule: name };

  const past = jobChecks(state, name)
    .filter((earlier) => earlier.finding !== undefined && earlier.finding !== "")
    .slice(-PAST_FINDINGS_GIVEN);

  record.input = [
    `[${name}] ${job.prompt}`,
    `It belongs to the thread ${store.threads.names()[store.threads.key(to)] ?? to}: \`.hex/bin/hex log -- '${to}'\` prints its conversation.`,
    past.length
      ? `What the last checks found:\n${past.map((earlier) => `- ${earlier.at.slice(0, 16)}Z${earlier.news === true ? ", told the thread" : ""}: ${earlier.finding}`).join("\n")}`
      : "This is its first check.",
    `It's now ${record.at.slice(0, 16)}Z.`,
  ].join("\n\n");

  try {
    Object.assign(record, await check(record.input));

    if (record.news === true) {
      store.scheduler.fire(name, minute, to, `[${name}] News from its check: ${record.finding}`);
    }
  } catch (error) {
    record.error = String(error);
    store.scheduler.fire(
      name,
      minute,
      to,
      `[${name}] ${job.prompt}\n\n(Its check couldn't run, so it runs here this time: ${clip(record.error, 300)})`,
    );
  }

  appendFileSync(join(state, "checks.jsonl"), `${JSON.stringify(record)}\n`);
}

const busy = new Set<string>();
let oneCheckAtATime = Promise.resolve();

export function study(state: string, name: string, job: Job, main: string, slot?: number) {
  if (busy.has(name)) {
    return;
  }

  const { idea } = job;

  const dueOrIdeaNeverChecked =
    slot !== undefined ||
    (idea !== undefined && !checks(state).some((check) => check.schedule === name));

  if (!dueOrIdeaNeverChecked) {
    return;
  }

  busy.add(name);

  const previous = oneCheckAtATime;
  const minute = slot ?? Math.floor(Date.now() / 60_000);

  oneCheckAtATime = (async () => {
    await previous;

    try {
      await (idea === undefined
        ? watch(state, name, job, main, minute)
        : research(state, name, { ...job, idea }, main, minute));
    } catch (error) {
      process.stderr.write(`hub: ${name}'s check failed: ${String(error)}\n`);
    } finally {
      busy.delete(name);
    }
  })();
}
