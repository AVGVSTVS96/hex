import { appendFileSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { z } from "zod";

import { served } from "./running.ts";
import { hexDir, open, spoken, stateDir } from "./store.ts";
import type { Row, Store } from "./store.ts";
import { render } from "./tasks.ts";

const MODEL = "opus";
const JUDGE_TIMEOUT_MS = 90_000;
const REWRITE_WINDOW_MS = 15 * 60_000;
const SENDBACKS_BEFORE_IT_GOES_THROUGH = 2;
const CHECKER_AUDIT_LOG = "intent.jsonl";

const SYSTEM = `One of my hex sessions wrote this brief to hand my work to another agent, and you read it before that agent gets it, so the work hex proposes is the work I asked for: my words for the task and my newest messages, my rules below, and what hex's memory says was decided.

The agent that gets it is as capable as you, loads my rules itself, and gets a link to my conversation. Every wall a brief puts up costs it performance: a plan for how to do the work, a guess or lead handed over as where to look, a limit or caution I didn't give for this ask. Those steer a smarter agent away from solving what I asked, even when worded as something to check. So the brief that works carries every part of what I asked, my words where the wording matters, the facts it has checked, and where the result goes, and leaves the how to the agent.

Answer ok when it does, or when it only reports or answers and hands over no work; wording, order and a stray wrong detail are the session's call. Answer revise when the brief drops or changes part of my ask, steers the how, or goes against my rules or a decision in memory: a note per problem, a line or two each, quoting my words where they settle it.`;

const Judged = z.object({ verdict: z.enum(["ok", "revise"]), notes: z.string() });

export type Verdict = z.infer<typeof Judged>;

// claude --json-schema rejects the draft 2020-12 $schema zod emits by default: https://github.com/anthropics/claude-code/issues/80402
const VERDICT_JSON_SCHEMA = z.toJSONSchema(Judged, { target: "draft-07" });

const ClaudeOutput = z.object({
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  structured_output: Judged.optional(),
});

const textOrNothing = z.string().optional().catch(undefined);

const ToolHook = z.object({
  session_id: z.string().optional(),
  cwd: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.looseObject({ command: textOrNothing, prompt: textOrNothing }).optional(),
});

type Hook = z.infer<typeof ToolHook>;

const named = (text: string) => [...new Set(text.match(/\bt-\d+\b/gu))];

const HANDOFF_COMMAND =
  /(?:^|[;&|(\n]|\$\()\s*(?:\w+=\S*\s+)*(?:ssh\s+\S+\s+['"]?)?(?:\S*\/)?(?:job\s+\S+\s+(?:\S+\s+)?(?:claude|codex)\b|claude\b[^;&|\n]*\s(?:-p|--print)\b|codex\s+exec\b|hex\s+deliver\b)/u;

const HANDOFF_TOOL =
  /^SendMessage$|new_thread$|^mcp__t3.code__(t3_thread_launch|t3_thread_send|delegate_task|create_threads)$/u;

export function brief({
  tool_name: tool = "",
  tool_input: input = {},
  cwd = process.cwd(),
}: Hook): string | undefined {
  if (tool === "Bash") {
    const command = input.command ?? "";

    if (!HANDOFF_COMMAND.test(command)) {
      return;
    }

    return [
      command,
      ...promptFilesNow(command, cwd).map(([path, text]) => `${path}:\n${text}`),
    ].join("\n\n");
  }

  if (tool === "Agent") {
    const prompt = input.prompt ?? "";
    const sentToWorkOnATask = named(prompt).length > 0;

    return sentToWorkOnATask ? prompt : undefined;
  }

  if (HANDOFF_TOOL.test(tool)) {
    return JSON.stringify(input, null, 1);
  }
}

function promptFilesNow(command: string, cwd: string): [string, string][] {
  const paths = [...new Set(command.match(/[\w.~-]*\/[\w.~/-]+/gu))].map((path) =>
    resolve(cwd, path.replace(/^~/u, homedir())),
  );

  return paths.flatMap((path): [string, string][] => {
    try {
      return statSync(path).isFile() && statSync(path).size < 100_000 && !path.includes("/bin/")
        ? [[path, readFileSync(path, "utf-8")]]
        : [];
    } catch {
      return [];
    }
  });
}

const quote = (rows: Row[]) =>
  rows.map((row) => `[${row.key} · ${row.at.slice(0, 16)}Z]\n${spoken(row)}`).join("\n\n");

export function asked(store: Store, thread: string | undefined, text: string): string {
  const tasks = named(text)
    .map((id) => store.task(id))
    .filter((task) => task !== null);

  const cited = [...new Set(text.match(/\b(?:telegram|discord|buzz|t3|voice):[\w@.:-]*\w/gu))]
    .flatMap((key) => {
      const row = store.message(key);

      return row !== null && spoken(row) !== "" ? [row] : [];
    })
    .slice(0, 12);

  const newest = (where: string) =>
    store
      .said(where, 40)
      .filter((row) => spoken(row) !== "" && !cited.some(({ key }) => key === row.key))
      .slice(-4);

  const from = thread === undefined || thread === "" ? undefined : store.key(thread);
  const to = deliveredTo(store, text);
  const fromNewest = from === undefined || from === "" ? [] : newest(from);
  const toNewest = to === undefined || to === "" || to === from ? [] : newest(to);

  return [
    tasks.length > 0
      ? `The tasks it names, with his words:\n\n${tasks.map((task) => render(task, store.names())).join("\n\n")}`
      : "",
    cited.length > 0 ? `His messages it cites:\n\n${quote(cited)}` : "",
    fromNewest.length > 0
      ? `His newest messages in the thread it comes from:\n\n${quote(fromNewest)}`
      : "",
    toNewest.length > 0
      ? `His newest messages in the thread it goes to:\n\n${quote(toNewest)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function deliveredTo(store: Store, text: string): string | undefined {
  const to = /\bhex\s+deliver\b.*?--to[= ]['"]?([^'"\s]+)/su.exec(text)?.[1];

  if (to === undefined) {
    return;
  }

  const threads = store.threads();

  return (
    threads.find(({ thread }) => thread === store.key(to)) ??
    threads.find(({ name }) => name === to)
  )?.thread;
}

export async function judge(input: string): Promise<Verdict> {
  const rules = Bun.spawnSync([join(import.meta.dir, "../bin/instructions")], {
    stdout: "pipe",
    stderr: "ignore",
  }).stdout.toString();

  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !name.startsWith("HEX_") && !name.startsWith("CLAUDECODE"),
      ),
    ),
    CLAUDE_CODE_ENTRYPOINT: "hex",
    HEX_HELPER: "intent",
  };

  const run = Bun.spawn(
    [
      "claude",
      "-p",
      "--safe-mode",
      "--model",
      MODEL,
      "--effort",
      "medium",
      "--tools",
      "",
      "--json-schema",
      JSON.stringify(VERDICT_JSON_SCHEMA),
      "--system-prompt",
      `${SYSTEM}\n\n${rules}`,
      "--output-format",
      "json",
      "--no-session-persistence",
    ],
    {
      cwd: hexDir(),
      env,
      stdin: new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
      timeout: JUDGE_TIMEOUT_MS,
    },
  );

  const [out, code] = await Promise.all([new Response(run.stdout).text(), run.exited]);
  const result = ClaudeOutput.safeParse(JSON.parse(out || "{}")).data;

  if (code !== 0 || result?.is_error === true || result?.structured_output === undefined) {
    throw new Error(`claude exited ${code}: ${(result?.result ?? "").slice(0, 300)}`);
  }

  return result.structured_output;
}

const SentBack = z.object({
  at: z.number(),
  rounds: z.number(),
  brief: z.string(),
  notes: z.string(),
});

type Sent = z.infer<typeof SentBack>;

export type Checked = {
  verdict: Verdict | "failed";
  text: string;
  round: number;
  through?: boolean;
  error?: string;
};

export async function check(
  hook: Hook,
  store: Store,
  thread: string | undefined,
  decide = judge,
): Promise<Checked | undefined> {
  const text = brief(hook);

  if (text === undefined || text === "") {
    return;
  }

  const session = hook.session_id ?? "";
  const sent = SentBack.safeParse(JSON.parse(store.seen(session, "intent") || "null")).data;

  const last =
    sent !== undefined && sent.rounds > 0 && Date.now() - sent.at < REWRITE_WINDOW_MS
      ? sent
      : undefined;

  const round = (last?.rounds ?? 0) + 1;

  const before =
    last !== undefined &&
    `This session's last brief, ${Math.round((Date.now() - last.at) / 60_000)} min ago, went back with your notes, and this one may be its rewrite. That brief:\n\n${last.brief}\n\nYour notes on it:\n\n${last.notes}`;

  const words =
    asked(store, thread, text) ||
    "No task or message of his was found for this brief; judge it by his rules and memory.";

  try {
    const verdict = await decide(
      [words, before, `The brief (${hook.tool_name}):\n\n${text.slice(0, 40_000)}`]
        .filter(Boolean)
        .join("\n\n"),
    );

    const through = verdict.verdict === "revise" && round > SENDBACKS_BEFORE_IT_GOES_THROUGH;

    if (verdict.verdict === "revise" && !through) {
      store.show(
        session,
        "intent",
        JSON.stringify({
          at: Date.now(),
          rounds: round,
          brief: text.slice(0, 8000),
          notes: verdict.notes,
        } satisfies Sent),
      );
    } else {
      store.unshow(session, "intent");
    }

    return { verdict, text, round, ...(through && { through }) };
  } catch (error) {
    return { verdict: "failed", text, round, error: String(error) };
  }
}

if (import.meta.main) {
  try {
    const hook = ToolHook.parse(JSON.parse((await Bun.stdin.text()) || "{}"));

    const thread =
      served({ HEX_CHANNEL: process.env.HEX_CHANNEL, HEX_THREAD: process.env.HEX_THREAD }) ??
      process.env.HEX_FROM ??
      process.env.HEX_OWNER;

    const began = Date.now();
    const result = await check(hook, open(stateDir()), thread);

    if (result) {
      const { verdict, text, round, through, error } = result;

      const record = {
        at: new Date().toISOString(),
        ms: Date.now() - began,
        session: hook.session_id,
        thread,
        tool: hook.tool_name,
        tasks: named(text),
        round,
        verdict: verdict === "failed" ? verdict : verdict.verdict,
        ...(through === true && { through }),
        notes: verdict === "failed" ? error : verdict.notes,
        brief: text.slice(0, 4000),
      };

      appendFileSync(join(stateDir(), CHECKER_AUDIT_LOG), `${JSON.stringify(record)}\n`);

      if (verdict !== "failed" && verdict.verdict === "revise" && through !== true) {
        const next =
          round < SENDBACKS_BEFORE_IT_GOES_THROUGH
            ? "The check reads your rewrite next to these notes."
            : "This is its last sendback: your next version goes through whatever the check says, so weigh these notes yourself.";

        const reason = `Intent check: this brief drifts from what the owner asked.\n\n${verdict.notes}\n\nRewrite the brief and start it again. ${next}`;
        console.log(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: reason,
            },
          }),
        );
      }
    }
  } catch (error) {
    console.error(`hex couldn't check this brief: ${String(error)}`);
  }
}
