import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import { above } from "../../hub/fit.ts";
import type { Question as Asked, MessageId } from "../../hub/ledger.ts";
import { open as openStore, shown } from "../../hub/store.ts";
import type { Row, Store } from "../../hub/store.ts";
import { generalOf, nameOf } from "./activity.ts";
import { savedCall } from "./calls.ts";
import type { Answer, CheckResult, Curated, Ref, Source } from "./questions.ts";
import { relay } from "./relay.ts";
import { T3 } from "./t3.ts";
import type { Stuck } from "./t3.ts";

type Verdict = Pick<CheckResult, "asks" | "fixed" | "flagged" | "stuck"> & {
  settle: (Ref & { note: string })[];
};

type Known = {
  threads: Record<string, string>;
  calls: { id: string }[];
  pins?: Ref[];
  answered?: Record<string, Pick<Answer, "label" | "at">>;
};

const filled = (text: string | undefined) => text !== undefined && text !== "";

const answeredOrSettled = (question: Asked) =>
  question.answer !== undefined || question.settled !== undefined;

const messageIdSchema = z.union([z.number(), z.string()]);
const refSchema = z.object({ app: z.string(), thread: z.string(), message: messageIdSchema });

const markedAnswers = z.object({
  answers: z
    .record(
      z.string(),
      z.object({
        label: z.string(),
        at: z.string(),
        question: z.string().exactOptional(),
        told: z.array(z.string()).exactOptional(),
        refs: z.array(refSchema).exactOptional(),
        missed: z.array(refSchema).exactOptional(),
        undoing: z.boolean().exactOptional(),
      }),
    )
    .optional(),
});

const previousPass = z.object({
  inputs: z.string().optional(),
  asks: z.array(z.object({ id: z.string(), question: z.string() })).optional(),
  stuck: z.array(z.object({ id: z.string(), title: z.string() })).optional(),
});

const MODEL = process.env.HEX_CHECK_MODEL ?? "opus";
const CALLS = join(homedir(), ".claude", "channels", "voice", "calls");
const RECENT = 3 * 24 * 60 * 60_000;
const LONG = 2400;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// One pass runs at a time, in a process of its own so it outlives the voice session that started it; events landing meanwhile leave one mark, so a burst costs one more pass at most.
export class Check {
  private readonly dir: string;
  private readonly state: string;

  constructor(state: string) {
    this.state = state;
    this.dir = join(state, "voice", "check");
    mkdirSync(this.dir, { recursive: true });
  }

  get running() {
    const pid = Number(read(join(this.dir, "lock")));

    return pid !== 0 && !Number.isNaN(pid) && alive(pid);
  }

  start(why: string) {
    writeFileSync(join(this.dir, "next"), why);

    if (!this.running) {
      spawn(process.execPath, [import.meta.path, this.state], {
        detached: true,
        stdio: "ignore",
      }).unref();
    }
  }
}

async function passPerMarkWhileHoldingTheLock(state: string) {
  const dir = join(state, "voice", "check");

  while (existsSync(join(dir, "next")) && hold(join(dir, "lock"))) {
    try {
      for (let why = take(join(dir, "next")); why !== undefined; why = take(join(dir, "next"))) {
        try {
          await pass(state, why);
          rmSync(join(dir, "error"), { force: true });
        } catch (error) {
          failed(
            state,
            `${new Date().toISOString()} ${why}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } finally {
      rmSync(join(dir, "lock"), { force: true });
    }
  }
}

export function failed(state: string, error: string) {
  const file = join(state, "voice", "check", "error");
  const first = !existsSync(file);
  writeFileSync(file, `${error}\n`);
  const general = first ? generalOf(openStore(state).threads()) : undefined;

  if (general) {
    openStore(state).deliver({
      key: `check:failed:${createHash("sha256").update(error).digest("hex").slice(0, 12)}`,
      to: general.thread,
      from: "check",
      author: "prompt",
      body: `[check] hex's question check failed, so nothing on the owner's Needs you list settles until it runs again: ${clip(error, 600)}. Its next failures stay in ${file} until a pass succeeds.`,
      meta: { user: "check" },
    });
  }
}

function hold(lock: string): boolean {
  try {
    writeFileSync(lock, String(process.pid), { flag: "wx" });

    return true;
  } catch {
    if (alive(Number(read(lock)))) {
      return false;
    }

    rmSync(lock, { force: true });

    return hold(lock);
  }
}

async function pass(state: string, why: string) {
  const started = new Date().toISOString();
  const records = gather(state);
  const inputs = digest(records);

  if (records.previous?.inputs === inputs) {
    return;
  }

  const hexDir = dirname(state);

  const verdict = vet(await claude(prompt(records, hexDir), hexDir, state), records.ledgers, {
    threads: records.threads,
    calls: records.calls,
    pins: records.pins.map(({ pin }) => pin),
    answered: records.answered,
  });

  for (const ref of verdict.settle) {
    try {
      await relay(state, ref.app, {
        type: "settle",
        thread: ref.thread,
        message: ref.message,
        note: ref.note,
      });
    } catch (error) {
      process.stderr.write(`voice: check: ${String(error)}\n`);
    }
  }

  const result: CheckResult = {
    at: started,
    why,
    read: {
      "pinned posts": records.pins.length,
      questions: records.open.length,
      "T3 items": records.t3.stuck.length + records.t3.fresh.length,
      calls: records.calls.length,
    },
    asks: verdict.asks,
    fixed: verdict.fixed,
    flagged: verdict.flagged,
    stuck: verdict.stuck,
    inputs,
  };

  const file = join(state, "voice", "check.json");
  writeFileSync(`${file}.tmp`, `${JSON.stringify(result, null, 1)}\n`);
  renameSync(`${file}.tmp`, file);
}

function gather(state: string) {
  const now = Date.now();
  const recent = new Date(now - RECENT).toISOString();
  const names: Record<string, string> = {};
  const pins: { pin: Ref; topic: string; text: string }[] = [];
  const questions = openStore(state).questions({ asker: "hex" });
  const threads = openStore(state).threads();
  const general = generalOf(threads);

  for (const thread of threads) {
    if (thread.app !== "voice") {
      names[`${thread.app}:${thread.thread}`] = nameOf(thread, general);
    }
  }

  const ledgers: Record<string, Asked[]> = {};

  for (const question of questions) {
    if (question.app !== "voice" && question.options.length > 0) {
      (ledgers[question.app] ??= []).push(question);
    }
  }

  const openThreads = new Set(
    threads.filter((thread) => thread.open).map((thread) => `${thread.app}:${thread.thread}`),
  );

  for (const pin of openStore(state).pins()) {
    if (pin.note !== "" && openThreads.has(`${pin.app}:${pin.thread}`)) {
      pins.push({
        pin: { app: pin.app, thread: pin.thread, message: pin.message },
        topic: names[`${pin.app}:${pin.thread}`] ?? pin.thread,
        text: clip(pin.note, LONG),
      });
    }
  }

  const entry = (app: string, question: Asked) => ({
    ref: { app, thread: question.thread, message: question.message },
    topic: names[`${app}:${question.thread}`] ?? question.thread,
    at: question.at,
    text: clip(question.text, 700),
    options: question.options,
    ...(filled(question.poll) && { poll: true }),
    ...(question.answer && { answer: question.answer }),
    ...(question.settled && { settled: question.settled }),
  });

  const open = Object.entries(ledgers).flatMap(([app, asked]) =>
    asked
      .filter((question) => !answeredOrSettled(question))
      .map((question) => ({
        ...entry(app, question),
        before: before(openStore(state), app, question),
      })),
  );

  const closed = Object.entries(ledgers).flatMap(([app, asked]) =>
    asked
      .filter((question) => answeredOrSettled(question) && question.at > recent)
      .map((question) => entry(app, question)),
  );

  // oxlint-disable-next-line eslint/no-empty-function -- the check reads T3 Code once and listens to none of its changes
  const t3 = new T3(() => {});
  const t3Now = t3.query(now);
  t3.close();

  const calls = list(CALLS)
    .filter((file) => file.endsWith(".json") && statSync(join(CALLS, file)).mtimeMs > now - RECENT)
    .flatMap((file) => json(join(CALLS, file), savedCall) ?? [])
    .filter(
      (call) => filled(call.ended) && (filled(call.summary) || (call.waiting?.length ?? 0) > 0),
    )
    .map((call) => ({
      id: call.id,
      title: call.title,
      ended: call.ended,
      summary: call.summary,
      waiting: call.waiting ?? [],
    }));

  const answers = json(join(state, "voice", "marks.json"), markedAnswers)?.answers ?? {};

  const answered = Object.fromEntries(
    Object.entries(answers).flatMap(([id, answer]) =>
      final(answer)
        ? [
            [
              id,
              {
                label: answer.label,
                at: answer.at,
                ...(filled(answer.question) && { question: answer.question }),
                ...(answer.told && { told: answer.told }),
              },
            ],
          ]
        : [],
    ),
  );

  return {
    now: new Date(now).toISOString(),
    threads: names,
    open,
    closed,
    answered,
    pins,
    calls,
    t3: t3Now,
    previous: json(join(state, "voice", "check.json"), previousPass),
    ledgers,
  };
}

export function before(store: Store, app: string, question: Asked, max = 700) {
  const rows = store.said(
    question.thread,
    -1,
    question.at,
    new Date(Date.parse(question.at) - 60 * 60_000).toISOString(),
  );

  const asked = Date.parse(
    rows.find((row) => messageIdOf(row) === String(question.message))?.at ?? question.at,
  );

  const questions = new Set(
    store.questions({ app, thread: question.thread }).map((other) => String(other.message)),
  );

  const part = (row: Row) =>
    withoutPartFences(row.body) !== "" &&
    Date.parse(row.at) > asked - 60_000 &&
    withoutPartFences(question.text).includes(withoutPartFences(row.body));

  return rows
    .filter(
      (row) =>
        row.from === app &&
        row.author === "hex" &&
        shown(row) &&
        !/^\(file: .*\)$/u.test(row.body) &&
        !filled(row.meta?.forwarded) &&
        above(row.body) === row.body.trim(),
    )
    .filter((row) => !questions.has(messageIdOf(row)) && !part(row))
    .slice(-2)
    .map((row) => clip(row.body, max));
}

function messageIdOf(row: Row) {
  return row.key.slice(row.key.lastIndexOf(":") + 1);
}

function withoutPartFences(text: string) {
  return text.replaceAll(/^```.*$/gmu, "").trim();
}

export function digest({ open, closed, answered, pins, calls, t3 }: ReturnType<typeof gather>) {
  return createHash("sha256")
    .update(JSON.stringify({ open, closed, answered, pins, calls, t3 }))
    .digest("hex");
}

function prompt(
  { ledgers: _ledgers, previous, ...records }: ReturnType<typeof gather>,
  hexDir: string,
) {
  const ids = {
    asks: (previous?.asks ?? []).map(({ id, question }) => ({ id, question })),
    stuck: (previous?.stuck ?? []).map(({ id, title }) => ({ id, title })),
  };

  return `You're hex's check. hex is a personal assistant (its owner, and their rules, are in ${hexDir}/AGENTS.md): it works for its owner in many threads at once (Telegram topics, Discord threads, T3 Code threads, calls with its voice app), and each thread asks them things: questions with buttons, polls, the "waiting on you" part of its pinned status post, and the waiting lines of a call's wrap-up. They pile up in dozens of places and many go stale. Your pass turns them into one honest list in their voice app, where they answer each in place.

It's there so the owner can manage their tasks with hex: by going through the transcripts, gathering, auditing and checking on work other agents did, including older work from a day or two ago that might not be done, it shows what needs to get done so they can ship more and get unblocked.

The records are below as JSON: every open question asked with buttons or a poll (open, each with its ref and before: what hex said in its thread just before asking), the ones answered or settled lately (closed), the asks they answered in the app or on a call (answered, by id: their answer, when, the question and the threads told), each thread's pinned post (pins, each with its own ref), calls' wrap-ups (calls, each with its id), what T3 Code shows as stuck or newly finished (t3; the app lists those already), and the ids your previous pass gave (previous). To confirm something before you settle it, read their records: every message hex.db holds in messages.md in your folder (one heading per message: author, app, thread, time, key; rg it), every thread hex has had in threads.json in your folder (app, thread, name, open, session, cwd, link), session transcripts under ~/.claude/projects/, project notes under ${hexDir}/projects/. In a transcript, the owner's messages arrive as <channel source="..." chat_id="..." message_id="..."> and hex's own replies come back as "sent (id: N)", so a question asked in plain words has a message id there.

Return:
- asks: one entry per decision or action that is still theirs, however many places asked it. from lists every place that asked it, so they can open each one: an open question (copy its ref), a pinned post (copy the pin's ref), a plain message you found ({app, thread, message} with its id, or {app, thread} when you can't find the id), or a call ({app: "voice", call: its id}); thread is a key of threads without its "<app>:" prefix. Leave none out: an ask from a pinned post and a call has both. id is "check:" plus a short slug, the same slug as in your previous pass for the same thing, never one in answered. task is the thread it belongs to ("<app>:<thread id>", from threads). question is one short plain line (60 characters at most). context is a few short plain sentences they can follow cold, without opening the thread: what the thing is, what its terms mean, and what each option means for them, in words rather than message numbers. options are their possible answers, as short labels, each one telling the thread something; each option's detail is one plain sentence on what answering with it does for them, what it costs and what it gives up, so they can decide from the options alone; mark the thread's own pick with pick (one at most, only where the thread made one), and say in why, in a sentence or two, why it's the pick; when an option stands for a button, value is that button's exact text from the first open question in from. links are the pages it points to, never answers: label names the page in one to three words without a verb ("Apple Store", "PR #2", "Paper file"), url opens it. kind is pick (one of several), yesno (two ways), do (only their hands can do it, like a sign-in, a purchase, a recording: options like Done and Later, its page in links) or look (something to watch or read: options like Seen and Later, its page in links). tag is "money" when an option spends money, or "unblocks N" when N other things wait on it. Order: what unblocks the most first, even when it costs money, then the quickest; other money and anything sent in their name last. An ask's task is the thread it belongs to, even when only a pinned post or a call asked it.
- settle: open questions the records show are already decided or done: decided in a conversation or a call, replaced by a later question, or the thing already happened. note is what the question's buttons in Telegram or Discord will say instead, like "Settled: Pro is on" (40 characters at most). Settle only what the records show; anything you're unsure of stays an ask.
- fixed: what you settled or merged, the way they'd read it: title (the thing), text (the evidence in plain words: who said or did what, and when), did (what you did, in a few words).
- flagged: what they should look at that you can't settle yourself, like the same thing asked with different options, or a question days old whose work has stalled: title and text.
- stuck: work stopped with nobody moving it that the t3 list doesn't already show, like a failing service a pinned post mentions: id (a short slug), title, why (one sentence), action (one or two words, like Restore or Look), mark (paused or failed), at, and request: what hex should do when they tap the action, as a message to hex.

Every answer is theirs, and an ask stays only while a place still asks it: an open question, a pinned post, a call, or a message from the last three days. One that only an older message asked is no longer theirs. One in answered is answered: leave it out. Anything new, and a thread asking it again after the answer, gets an id that isn't in answered. Leave health details and phone numbers out of everything you write.

${JSON.stringify({ ...records, previous: ids })}`;
}

const noteSchema = z.object({
  title: z.string(),
  text: z.string(),
  did: z.string().exactOptional(),
});

const sourceSchema = z.object({
  app: z.string(),
  thread: z.string().exactOptional(),
  message: messageIdSchema.exactOptional(),
  call: z.string().exactOptional(),
});

const verdictOfThePass: z.ZodType<Verdict> = z.object({
  asks: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["pick", "yesno", "do", "look"]),
      task: z.string(),
      at: z.string(),
      question: z.string(),
      context: z.string().exactOptional(),
      why: z.string().exactOptional(),
      options: z.array(
        z.object({
          label: z.string(),
          value: z.string().exactOptional(),
          pick: z.boolean().exactOptional(),
          detail: z.string().exactOptional(),
        }),
      ),
      links: z.array(z.object({ label: z.string(), url: z.string() })).exactOptional(),
      tag: z.string().exactOptional(),
      from: z.array(sourceSchema),
    }),
  ),
  settle: z.array(refSchema.extend({ note: z.string() })),
  fixed: z.array(noteSchema),
  flagged: z.array(noteSchema),
  stuck: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      why: z.string(),
      action: z.string(),
      mark: z.enum(["paused", "failed"]),
      at: z.string(),
      request: z.string().exactOptional(),
    }),
  ),
});

const { $schema: _schema, ...SCHEMA } = z.toJSONSchema(verdictOfThePass, { io: "input" });

const claudeResult = z.object({
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  structured_output: z.unknown(),
});

function messages(hexDir: string) {
  try {
    const run = Bun.spawnSync([join(hexDir, ".hex", "bin", "hex"), "log"]);

    return run.success ? run.stdout : `The messages couldn't be read: ${run.stderr.toString()}`;
  } catch (error) {
    return `The messages couldn't be read: ${String(error)}`;
  }
}

function claude(input: string, hexDir: string, state: string) {
  const args = [
    "-p",
    "--model",
    MODEL,
    "--effort",
    "medium",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(SCHEMA),
    "--tools",
    "Read,Grep,Glob",
    "--safe-mode",
    "--no-session-persistence",
    "--add-dir",
    hexDir,
    join(homedir(), ".claude", "projects"),
  ];

  const cwd = mkdtempSync(join(tmpdir(), "hex-check-"));
  writeFileSync(join(cwd, "messages.md"), messages(hexDir));
  writeFileSync(join(cwd, "threads.json"), JSON.stringify(openStore(state).threads(), null, 1));

  return new Promise<Verdict>((resolve, reject) => {
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => !name.startsWith("HEX_") && !name.startsWith("CLAUDECODE"),
        ),
      ),
      CLAUDE_CODE_ENTRYPOINT: "hex",
      HEX_HELPER: "check",
    };

    const child = spawn("claude", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      rmSync(cwd, { recursive: true, force: true });

      try {
        const result = claudeResult.parse(JSON.parse(out));

        if (
          result.is_error === true ||
          result.structured_output === undefined ||
          result.structured_output === null
        ) {
          throw new Error(result.result ?? "no result");
        }

        resolve(verdictOfThePass.parse(result.structured_output));
      } catch (error) {
        reject(
          new Error(
            `the check's claude exited ${String(code)}: ${String(error)} ${err.slice(-500)}`,
          ),
        );
      }
    });
    child.stdin.end(input);
  });
}

export function vet(
  verdict: Verdict,
  ledgers: Record<string, Asked[]>,
  { threads, calls, pins = [], answered = {} }: Known,
): Verdict {
  const find = (ref: { app: string; thread: string; message: MessageId | undefined }) =>
    ledgers[ref.app]?.find(
      (question) =>
        question.thread === ref.thread && String(question.message) === String(ref.message),
    );

  const open = (ref: Ref) => {
    const question = find(ref);

    return question !== undefined && !answeredOrSettled(question);
  };

  const real = ({ app, thread, message, call }: Source) =>
    filled(call)
      ? calls.some((one) => one.id === call)
      : thread !== undefined &&
        thread !== "" &&
        (`${app}:${thread}` in threads || find({ app, thread, message }) !== undefined);

  const curated: Curated[] = verdict.asks.map(({ from = [], ...question }) => {
    const places: Source[] = from.filter(real).map(({ app, thread, message, call }) =>
      call !== undefined && call !== ""
        ? { app: "voice", call }
        : {
            app,
            ...(thread !== undefined && { thread }),
            ...(message !== undefined && { message }),
          },
    );

    const refs: Ref[] = places.flatMap(({ app, thread, message }) =>
      thread !== undefined &&
      thread !== "" &&
      message !== undefined &&
      open({ app, thread, message })
        ? [{ app, thread, message }]
        : [],
    );

    const [first] = refs;
    const buttons = first ? (find(first)?.options ?? []) : [];

    return {
      ...question,
      id: question.id.startsWith("check:") ? question.id : `check:${question.id}`,
      options: question.options.map(({ value, ...option }) => ({
        ...option,
        ...(value !== undefined && value !== "" && buttons.includes(value) && { value }),
      })),
      ...(question.links && { links: question.links.filter((link) => opens(link.url)) }),
      from: places,
      refs,
    };
  });

  const pinned = ({ app, thread, message }: Source) =>
    pins.some(
      (pin) => pin.app === app && pin.thread === thread && String(pin.message) === String(message),
    );

  const asked = (question: Curated) =>
    (question.refs?.length ?? 0) > 0 ||
    question.from?.some((place) => filled(place.call) || pinned(place)) === true ||
    Date.parse(question.at) > Date.now() - RECENT;

  const again = (question: Curated) =>
    answered[question.id] !== undefined && (question.refs?.length ?? 0) === 0;

  const listed = new Set(
    curated
      .flatMap((question) => question.refs ?? [])
      .map((ref) => `${ref.app} ${ref.thread} ${ref.message}`),
  );

  return {
    asks: curated.filter((question) => asked(question) && !again(question)),
    settle: verdict.settle
      .filter((ref) => open(ref) && !listed.has(`${ref.app} ${ref.thread} ${ref.message}`))
      .map((ref) => ({ ...ref, note: ref.note.slice(0, 60) })),
    fixed: verdict.fixed,
    flagged: [
      ...verdict.flagged,
      ...curated.flatMap((question) => {
        const answer = answered[question.id];

        return answer && asked(question) && again(question)
          ? [
              {
                title: question.question,
                text: `You answered this "${answer.label}" on ${answer.at.slice(0, 10)}, and the check found it asked again.`,
              },
            ]
          : [];
      }),
    ],
    stuck: verdict.stuck.map((item: Omit<Stuck, "app">) => ({
      ...item,
      id: item.id.startsWith("check-") ? item.id : `check-${item.id}`,
    })),
  };
}

export function final(answer: Pick<Answer, "refs" | "missed" | "undoing">) {
  return (
    (answer.refs?.length ?? 0) === 0 &&
    (answer.missed?.length ?? 0) === 0 &&
    answer.undoing !== true
  );
}

export function opens(url: string) {
  return /^(?:https?|tg|buzz|t3code(?:-[a-z]+)?):\/\/\S/iu.test(url);
}

function take(file: string) {
  const why = read(file);
  rmSync(file, { force: true });

  return why || undefined;
}

function read(file: string) {
  try {
    return readFileSync(file, "utf-8").trim();
  } catch {
    return "";
  }
}

function json<T>(file: string, schema: z.ZodType<T>): T | undefined {
  try {
    return schema.safeParse(JSON.parse(readFileSync(file, "utf-8"))).data;
  } catch {
    return undefined;
  }
}

function list(dir: string) {
  return existsSync(dir) ? readdirSync(dir) : [];
}

function clip(text: string, max: number) {
  return text.length > max
    ? `${text
        .slice(0, max - 1)
        .replace(/[\uD800-\uDBFF]$/u, "")
        .trimEnd()}…`
    : text;
}

function alive(pid: number) {
  try {
    return process.kill(pid, 0);
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

const stateOfThisRun = process.argv[2];

if (import.meta.main && stateOfThisRun !== undefined) {
  await passPerMarkWhileHoldingTheLock(stateOfThisRun);
}
