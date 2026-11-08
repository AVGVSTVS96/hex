import { dirname } from "node:path";

import { z } from "zod";

import { clip, fit, ROOM } from "./fit.ts";
import { line as holdLine } from "./holds.ts";
import { served } from "./running.ts";
import { open, stateDir } from "./store.ts";
import type { Question, Task } from "./store.ts";
import { zoneOf } from "./zone.ts";

const given = (value: string | undefined): value is string => value !== undefined && value !== "";

function facts(task: Task, named: Record<string, string>, said?: string) {
  const parts = [
    task.status,
    named[task.owner] ?? task.owner,
    given(task.project) ? `project ${task.project}` : "",
    given(task.mergedInto) ? `merged into ${task.mergedInto}` : "",
    said,
  ];

  return `${task.id} (${parts.filter(Boolean).join(", ")})`;
}

export function render(task: Task, named: Record<string, string> = {}): string {
  const lines = [`${facts(task, named)}: ${task.title}`];

  if (given(task.doneWhen)) {
    lines.push(`  done when: ${task.doneWhen}`);
  }

  if (given(task.proof)) {
    lines.push(`  proof: ${task.proof}`);
  }

  for (const words of task.words) {
    lines.push(
      `  [${words.message} · ${words.who} · ${words.at.slice(0, 16).replace("T", " ")}Z]`,
      ...words.text.split("\n").map((line) => `    ${line}`),
    );
  }

  return lines.join("\n");
}

export function entry(task: Task, named: Record<string, string>, withDoneLines = true) {
  const messages = new Set(task.words.map((words) => words.message)).size;
  const line = `${facts(task, named, messages > 1 ? `${messages} messages` : undefined)}: ${clip(task.title, 150)}`;

  if (!withDoneLines) {
    return line;
  }

  return [
    line,
    given(task.doneWhen) ? `  done when: ${clip(task.doneWhen, 200)}` : "",
    task.status === "done" && given(task.proof) ? `  proof: ${clip(task.proof, 200)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function waiting(question: Question, named: Record<string, string> = {}): string {
  const whereItWaits =
    question.asker === "owner" ? (question.answer?.message ?? question.message) : question.message;

  const ref =
    question.app === "telegram"
      ? `telegram:${question.thread.split(":")[0] ?? ""}:${whereItWaits}`
      : `message ${whereItWaits}`;

  const text =
    question.asker === "owner"
      ? `answered my question: ${clip(question.text, 200)}`
      : `${clip(question.text, 200)}${question.options.length ? ` [${question.options.join(" | ")}]` : ""}`;

  return `- ${question.app} · ${named[question.thread] ?? question.thread} · ${ref} · ${question.at.slice(0, 16).replace("T", " ")}Z: ${text}`;
}

export function pending(state: string, thread?: string, room = ROOM) {
  const store = open(state);

  const tasks =
    thread === undefined
      ? store.tasks.list({ status: ["open"] })
      : store.tasks.list({ owner: thread, status: ["open"] });

  const questions =
    thread === undefined
      ? store.questions.list({ waiting: true })
      : store.questions.list({ thread, waiting: true });

  const zone = zoneOf(dirname(state));
  const holds = store.holds.list().map((hold) => [hold.id, holdLine(hold, store, zone)] as const);
  const named = store.threads.names();
  const whose = thread === undefined || thread === "" ? "Every thread" : "This thread";

  const sections = [
    {
      header:
        "Work on hold, which every session sees: a thread on hold finishes the step it's on and starts nothing new. A hold ends by itself at its time; when my words in any thread lift one, end it with `.hex/bin/hex hold end <hold> [<thread>…] --why '<what lifts it>' --key <my message>`, and hex wakes each thread it frees that worked while held, a couple at a time:",
      items: holds.map(([, text]) => [text]),
      gap: "\n",
      rest: "`.hex/bin/hex holds` lists them all",
    },
    {
      header: `${whose}'s questions still waiting on me: yours, and mine you answered that I haven't come back to (remind me with reply, reply_to set to its key, from any thread; edit_message with settled: true and the key closes one my words show I've dealt with, or that no longer stands):`,
      items: questions.map((question) => [waiting(question, named)]),
      gap: "\n",
      rest: "`.hex/bin/hex questions` lists them all",
    },
    {
      header: `${whose}'s open tasks (\`.hex/bin/hex task <id>\` has my words in full, adds to them and closes them):`,
      items: tasks.map((task) => [entry(task, named), entry(task, named, false)]),
      gap: "\n",
      rest: "`.hex/bin/hex tasks` lists them all",
    },
  ];

  const seenEvenIfCut: Record<string, string> = Object.fromEntries([
    ...holds,
    ...questions.map(
      (question) =>
        [
          `${question.app}:${question.thread}:${question.message}`,
          waiting(question, named),
        ] as const,
    ),
    ...tasks.map((task) => [task.id, entry(task, named)] as const),
  ]);

  return {
    text: fit(
      sections.filter((section) => section.items.length),
      room,
    ),
    seen: seenEvenIfCut,
  };
}

export function changes(before: Record<string, string>, now: Record<string, string>): string {
  const fresh = Object.entries(now)
    .filter(([id, shown]) => before[id] !== shown)
    .map(([, shown]) => shown);

  const gone = Object.entries(before)
    .filter(([id]) => !(id in now))
    .map(([, shown]) => (shown.split("\n")[0] ?? "").replace(/^- /u, ""));

  return [
    fresh.length > 0 ? `New or changed since you last saw the list:\n${fresh.join("\n")}` : "",
    gone.length > 0
      ? `No longer open or waiting:\n${gone.map((first) => `- ${first}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const PromptHook = z.object({ session_id: z.string().optional(), source: z.string().optional() });

const Pushed = z.object({ seen: z.record(z.string(), z.string()), sent: z.number() });

const nonEmpty = (value: string | undefined) => (value === "" ? undefined : value);

if (import.meta.main) {
  try {
    const { session_id: session, source } = PromptHook.parse(
      JSON.parse((await Bun.stdin.text()) || "{}"),
    );

    if (session !== undefined && session !== "") {
      const store = open(stateDir());

      if (source === "compact" || source === "clear") {
        store.seen.unshow(session, "tasks");
      }

      const worksFor = nonEmpty(process.env.HEX_THREAD) ?? served();
      const isMain = nonEmpty(process.env.HEX_MAIN) !== undefined;

      const thread =
        isMain || worksFor === undefined || worksFor === ""
          ? undefined
          : store.threads.key(worksFor);

      const { text, seen } = pending(stateDir(), thread);
      const whole = text || "No open tasks or questions waiting on me now.";
      const last = store.seen.get(session, "tasks");

      const before = last.startsWith("{")
        ? (Pushed.safeParse(JSON.parse(last)).data ?? null)
        : null;

      const diff = before === null ? "" : changes(before.seen, seen);
      const diffsSinceWholeList = before === null ? 0 : before.sent + diff.length;
      const sendWhole = diff === "" || diffsSinceWholeList >= whole.length;
      const out = sendWhole ? whole : diff;

      const record =
        Object.keys(seen).length > 0
          ? JSON.stringify({ seen, sent: sendWhole ? 0 : diffsSinceWholeList })
          : "";

      if (before === null ? record !== last : diff !== "") {
        store.seen.show(session, "tasks", record);
        console.log(out);
      }
    }
  } catch (error) {
    console.error(`hex couldn't read its tasks: ${String(error)}`);
  }
}
