import { appendFileSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { served } from "./running.ts";
import { hexDir, open, spoken, stateDir } from "./store.ts";
import type { Row, Store } from "./store.ts";
import { render } from "./tasks.ts";

// The intent check: before a session hands the owner's work to another agent, a quick model reads the
// brief next to the owner's words for it, their rules and hex's memory, and says whether the brief
// asks for what they asked. A brief that drifts goes back to its session with notes, and its rewrite
// is checked next to them. After ROUNDS sendbacks the next version goes through, so a wrong note
// costs a rewrite or two, never a stall.

const MODEL = "opus";
const CALL = 90_000;
const AGAIN = 15 * 60_000;
const ROUNDS = 2;

const SYSTEM = `One of my hex sessions wrote this brief to hand my work to another agent, and you read it before that agent gets it, so the work hex proposes is the work I asked for: my words for the task and my newest messages, my rules below, and what hex's memory says was decided.

The agent that gets it is as capable as you, loads my rules itself, and gets a link to my conversation. Every wall a brief puts up costs it performance: a plan for how to do the work, a guess or lead handed over as where to look, a limit or caution I didn't give for this ask. Those steer a smarter agent away from solving what I asked, even when worded as something to check. So the brief that works carries every part of what I asked, my words where the wording matters, the facts it has checked, and where the result goes, and leaves the how to the agent.

Answer ok when it does, or when it only reports or answers and hands over no work; wording, order and a stray wrong detail are the session's call. Answer revise when the brief drops or changes part of my ask, steers the how, or goes against my rules or a decision in memory: a note per problem, a line or two each, quoting my words where they settle it.`;

const SCHEMA = {
  type: "object",
  properties: { verdict: { enum: ["ok", "revise"] }, notes: { type: "string" } },
  required: ["verdict", "notes"],
};

const named = (text: string) => [...new Set(text.match(/\bt-\d+\b/g))];

type Hook = {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
};

export type Verdict = { verdict: "ok" | "revise"; notes: string };

// A command that hands work to another agent: a job or a headless claude or codex run, here or over
// ssh, or a message delivered to a hex thread's session.
const HANDOFF =
  /(?:^|[;&|(\n]|\$\()\s*(?:\w+=\S*\s+)*(?:ssh\s+\S+\s+['"]?)?(?:\S*\/)?(?:job\s+\S+\s+(?:\S+\s+)?(?:claude|codex)\b|claude\b[^;&|\n]*\s(?:-p|--print)\b|codex\s+exec\b|hex\s+deliver\b)/;

// The brief a tool call hands to another agent: an agent job, a delivery to a thread, a new thread,
// a message to a running agent or T3 Code thread, or a subagent sent to work on a task (most
// subagents only read, and name none).
export function brief({
  tool_name: tool = "",
  tool_input: input = {},
  cwd = process.cwd(),
}: Hook): string | undefined {
  if (tool === "Bash") {
    const command = String(input.command ?? "");

    if (!HANDOFF.test(command)) {
      return;
    }
    return [command, ...files(command, cwd).map(([path, text]) => `${path}:\n${text}`)].join(
      "\n\n",
    );
  }

  if (tool === "Agent") {
    const prompt = String(input.prompt ?? "");

    return named(prompt).length ? prompt : undefined;
  }

  if (
    /^SendMessage$|new_thread$|^mcp__t3.code__(t3_thread_launch|t3_thread_send|delegate_task|create_threads)$/.test(
      tool,
    )
  ) {
    return JSON.stringify(input, null, 1);
  }
}

// The files a command reads its prompt from, like "$(cat ~/scratch/x/prompt.md)", as they are now.
function files(command: string, cwd: string): [string, string][] {
  const paths = [...new Set(command.match(/[\w.~-]*\/[\w.~/-]+/g))].map((path) =>
    resolve(cwd, path.replace(/^~/, homedir())),
  );

  return paths.flatMap((path) => {
    try {
      return statSync(path).isFile() && statSync(path).size < 100_000 && !path.includes("/bin/")
        ? [[path, readFileSync(path, "utf-8")] as [string, string]]
        : [];
    } catch {
      return [];
    }
  });
}

// What the owner said this brief should serve: each task it names, in their words, each message of
// theirs it cites by key, and their newest messages in the thread it comes from and the one it goes to.
export function asked(store: Store, thread: string | undefined, text: string): string {
  const tasks = named(text)
    .map((id) => store.task(id))
    .filter((task) => task !== null);

  const cited = [...new Set(text.match(/\b(?:telegram|discord|buzz|t3|voice):[\w@.:-]*\w/g))]
    .map((key) => store.message(key))
    .filter((row) => row && spoken(row))
    .slice(0, 12) as Row[];

  const newest = (key: string) =>
    store
      .said(key, 40)
      .filter((row) => spoken(row) && !cited.some(({ key }) => key === row.key))
      .slice(-4);

  const from = thread ? store.key(thread) : undefined;
  const to = destination(store, text);

  const quote = (rows: Row[]) =>
    rows.map((row) => `[${row.key} · ${row.at.slice(0, 16)}Z]\n${spoken(row)}`).join("\n\n");

  return [
    tasks.length &&
      `The tasks it names, with his words:\n\n${tasks.map((task) => render(task, store.names())).join("\n\n")}`,
    cited.length && `His messages it cites:\n\n${quote(cited)}`,
    from &&
      newest(from).length &&
      `His newest messages in the thread it comes from:\n\n${quote(newest(from))}`,
    to &&
      to !== from &&
      newest(to).length &&
      `His newest messages in the thread it goes to:\n\n${quote(newest(to))}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// The thread a delivery goes to, by the id or name after its --to.
function destination(store: Store, text: string): string | undefined {
  const to = /\bhex\s+deliver\b.*?--to[= ]['"]?([^'"\s]+)/s.exec(text)?.[1];

  if (!to) {
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
      JSON.stringify(SCHEMA),
      "--system-prompt",
      `${SYSTEM}\n\n${rules}`,
      "--output-format",
      "json",
      "--no-session-persistence",
    ],
    { cwd: hexDir(), env, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe", timeout: CALL },
  );

  const [out, code] = await Promise.all([new Response(run.stdout).text(), run.exited]);
  const result = JSON.parse(out || "{}");

  if (code !== 0 || result.is_error || !result.structured_output) {
    throw new Error(`claude exited ${code}: ${String(result.result ?? "").slice(0, 300)}`);
  }
  return result.structured_output;
}

type Sent = { at: number; rounds: number; brief: string; notes: string };

export type Checked = {
  verdict: Verdict | "failed";
  text: string;
  round: number;
  through?: boolean;
  error?: string;
};

// Every brief is checked. One that follows a sendback is read next to the brief and notes it may be
// rewriting, and the one after ROUNDS sendbacks goes through whatever its verdict.
export async function check(
  hook: Hook,
  store: Store,
  thread: string | undefined,
  decide = judge,
): Promise<Checked | undefined> {
  const text = brief(hook);

  if (!text) {
    return;
  }
  const session = hook.session_id ?? "";
  const sent = (JSON.parse(store.seen(session, "intent") || "null") as Sent | null) ?? undefined;
  const last = sent?.rounds && Date.now() - sent.at < AGAIN ? sent : undefined;
  const round = (last?.rounds ?? 0) + 1;

  const before =
    last &&
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

    const through = verdict.verdict === "revise" && round > ROUNDS;

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

// The PreToolUse hook. Every outcome is logged to state/intent.jsonl, so a later audit can check the
// checker too; a check that fails or runs long lets the work start.
if (import.meta.main) {
  try {
    const hook = JSON.parse((await Bun.stdin.text()) || "{}") as Hook;

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
        verdict: typeof verdict === "string" ? verdict : verdict.verdict,
        ...(through && { through }),
        notes: typeof verdict === "string" ? error : verdict.notes,
        brief: text.slice(0, 4000),
      };

      appendFileSync(join(stateDir(), "intent.jsonl"), `${JSON.stringify(record)}\n`);

      if (typeof verdict === "object" && verdict.verdict === "revise" && !through) {
        const next =
          round < ROUNDS
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
    console.error(`hex couldn't check this brief: ${error}`);
  }
}
