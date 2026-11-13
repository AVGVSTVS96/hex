import { appendFileSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { z } from "zod";

import { files } from "../bin/instructions";
import { served } from "./running.ts";
import { hexDir, open, replied, spoken, stateDir } from "./store.ts";
import type { Row, Store } from "./store.ts";
import { render } from "./tasks.ts";

const MODEL = "opus";
const JUDGE_TIMEOUT_MS = 90_000;
const REWRITE_WINDOW_MS = 15 * 60_000;
const SENDBACKS_BEFORE_IT_GOES_THROUGH = 2;
const CHECKER_AUDIT_LOG = "intent.jsonl";

const SYSTEM = `One of my hex sessions wrote this brief to hand my work to another agent, and you read it before that agent gets it, so the work hex proposes is the work I asked for: my words for the task, the newest of mine this session got and the work hex handed it, my rules below, and what hex's memory says was decided.

A session works on what hex hands it too: a request from General or another session, or a job's own prompt, each carrying work of mine. A brief for that work answers to it, even when my newest words there are about something else. What the session has said since shows where that work stands now: an ask it already settled there is done, and its newer facts replace older ones.

The agent that gets it is as capable as you, loads my rules itself, and gets a link to my conversation. Every wall a brief puts up costs it performance: a plan for how to do the work, a guess or lead handed over as where to look, a limit or caution I didn't give for this ask. Those steer a smarter agent away from solving what I asked, even when worded as something to check. So the brief that works carries every part of what I asked, my words where the wording matters, the facts it has checked, and where the result goes, and leaves the how to the agent.

Answer ok when it does, or when it only reports or answers and hands over no work; wording, order and a stray wrong detail are the session's call. Answer revise when the brief drops or changes part of my ask, steers the how, or goes against my rules or a decision in memory: a note per problem, a line or two each, quoting my words where they settle it.`;

const RULES = `One of my hex sessions is about to change one of my rule files: the instructions every session of mine loads, or what I want hex to bring up on its own. You read the change before it lands, next to my newest words that session got, the work hex handed it, and my rules below.

My rules change when I ask for a change, and then the edit carries my intent into the line it belongs to, editing or cutting what's there before adding. When I point out a mistake, I expect it fixed and hex to reflect on why it happened; that alone doesn't call for a new rule.

Answer ok when my words ask for this change, or it carries out one I asked for, like taking back an edit I objected to; a standing instruction in my rules counts as asking, like adding a word voice transcripts mishear. A command that only reads the file is ok too. Answer revise when the change is the session's own idea or goes past what I asked: a note per problem, a line or two each, quoting my words where they settle it.`;

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
  tool_input: z
    .looseObject({
      command: textOrNothing,
      prompt: textOrNothing,
      file_path: textOrNothing,
      content: textOrNothing,
      old_string: textOrNothing,
      new_string: textOrNothing,
      edits: z
        .array(z.looseObject({ old_string: z.string(), new_string: z.string() }))
        .optional()
        .catch(undefined),
    })
    .optional(),
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

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

export const ruleFiles = (): string[] =>
  [...files().map(({ path }) => path), join(hexDir(), "PROACTIVE.md")].map(real);

const INTO = /(?:(?:^|[^\d&>=-])\d?>>?|\btee\s+(?:-\S+\s+)*)\s*(\S+)/gu;

const PROGRAM =
  /^\(?\s*(?:sudo(?:\s+-[pug]\s+\S+|\s+-\w+)*\s+)?(?:\w+=\S*\s+)*(?:\S*\/)?([^\s/]+)/u;

const READS =
  /^(?:rg|grep|cat|head|tail|less|wc|ls|lsattr|stat|diff|file|bat|realpath|readlink|echo|printf)$/u;

const GIT_WRITES =
  /^(?:checkout|switch|restore|apply|am|revert|stash|merge|pull|cherry-pick|rm|mv)$/u;

const place = (path: string, from: string) =>
  resolve(
    from,
    path.replaceAll(/^['"]|['"]$/gu, "").replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/u, homedir()),
  );

function parts(command: string): string[] {
  const out = [""];
  let quote = "";

  for (let i = 0; i < command.length; i++) {
    const char = command[i] ?? "";
    const pair = char + (command[i + 1] ?? "");

    if (quote === "" && (/[;\n|]/u.test(char) || pair === "&&")) {
      out.push("");
      i += pair === "&&" || pair === "||" ? 1 : 0;
      continue;
    }

    quote = quote === char ? "" : quote === "" && /['"]/u.test(char) ? char : quote;
    out[out.length - 1] += char;
  }

  return out.flatMap((part) => (part.trim() === "" ? [] : [part.trim()]));
}

function writes(part: string, program: string, path: string, here: string): boolean {
  const bare = part.replaceAll(/'[^']*\s[^']*'|"[^"]*\s[^"]*"/gu, "''");

  if ([...bare.matchAll(INTO)].some(([, into = ""]) => real(place(into, here)) === path)) {
    return true;
  }

  if (/^(?:cp|mv|install|ln)$/u.test(program)) {
    return real(place(bare.split(/\s+/u).at(-1) ?? "", here)) === path;
  }

  if (program === "git") {
    const sub = /\bgit(?:\s+-[Cc]\s+\S+)*\s+([\w-]+)/u.exec(bare)?.[1] ?? "";

    return (
      (GIT_WRITES.test(sub) && !/\s--staged\b/u.test(bare)) || /\breset\s+--hard\b/u.test(bare)
    );
  }

  if (program === "sed" || program === "perl") {
    return /\s(?:-\w*i|--in-place)/u.test(bare);
  }

  if (program === "chattr") {
    return /\s-\w*i/u.test(bare);
  }

  return !READS.test(program);
}

export function written(command: string, cwd: string, rules: string[]): string[] {
  let dir = cwd;
  const out: string[] = [];

  for (const part of parts(command)) {
    const program = PROGRAM.exec(part)?.[1] ?? "";
    const git = program === "git" ? /\s-C\s+(\S+)/u.exec(part)?.[1] : undefined;
    const here = git === undefined ? dir : place(git, dir);

    const touched = [...part.matchAll(/[\w.~${}/-]*[\w-]\.md\b/gu)].flatMap(([path]) => {
      const file = real(place(path, here));

      return rules.includes(file) ? [file] : [];
    });

    if (program === "cd") {
      dir = place(part.split(/\s+/u)[1] ?? "~", dir);
    }

    out.push(...touched.filter((path) => writes(part, program, path, here)));
  }

  return out;
}

export function ruleEdit(
  { tool_name: tool = "", tool_input: input = {}, cwd = process.cwd() }: Hook,
  rules = ruleFiles(),
): string | undefined {
  const isRule = (path: string) =>
    rules.includes(real(resolve(cwd, path.replace(/^~(?=\/)/u, homedir()))));

  if (/^(Edit|Write|MultiEdit)$/u.test(tool)) {
    const path = input.file_path ?? "";

    if (!isRule(path)) {
      return;
    }

    const edits = input.edits ?? [
      { old_string: input.old_string ?? "", new_string: input.new_string ?? "" },
    ];

    return tool === "Write"
      ? `${tool} ${path}, all of it:\n\n${input.content ?? ""}`
      : `${tool} ${path}:\n\n${edits.map((edit) => `replacing:\n${edit.old_string}\n\nwith:\n${edit.new_string}`).join("\n\n")}`;
  }

  const command = tool === "Bash" ? (input.command ?? "") : "";

  return written(command, cwd, rules).length > 0 ? command : undefined;
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

const unshown = (rows: Row[], shown: Row[]) =>
  rows.filter((row) => !shown.some(({ key }) => key === row.key));

const newest = (rows: Row[], shown: Row[]) =>
  unshown(rows, shown)
    .filter((row) => spoken(row) !== "")
    .slice(-4);

const handed = (rows: Row[], shown: Row[]) =>
  unshown(rows, shown)
    .filter((row) => row.author === "prompt")
    .slice(-3);

const saidSince = (rows: Row[]) =>
  rows
    .slice(rows.findLastIndex((row) => spoken(row) !== "" || row.author === "prompt") + 1)
    .filter(replied)
    .slice(-6);

const said = (row: Row) =>
  row.author === "prompt"
    ? `${row.from === "terminal" ? "the prompt it started with" : `handed to it by ${row.meta?.user ?? row.from}`}:\n${row.body.slice(0, 4000)}`
    : `me:\n${spoken(row)}`;

const got = (rows: Row[]) =>
  rows.map((row) => `[${row.key} · ${row.at.slice(0, 16)}Z] ${said(row)}`).join("\n\n");

export function asked(store: Store, session: string, text: string): string {
  const tasks = [...new Set([...named(text), store.tasks.agentTasks()[session]?.id ?? ""])].flatMap(
    (id) => store.tasks.get(id) ?? [],
  );

  const cited = [...new Set(text.match(/\b(?:telegram|discord|buzz|t3|voice):[\w@.:-]*\w/gu))]
    .flatMap((key) => {
      const row = store.messages.get(key);

      return row !== null && spoken(row) !== "" ? [row] : [];
    })
    .slice(0, 12);

  const taken = store.messages.taken(session, 40);
  const picked = new Set([...newest(taken, cited), ...handed(taken, cited)]);
  const given = taken.filter((row) => picked.has(row));
  const since = saidSince(taken);
  const to = deliveredTo(store, text);

  const toNewest =
    to === undefined || to === "" ? [] : newest(store.messages.said(to, 40), [...cited, ...given]);

  return [
    tasks.length > 0
      ? `The tasks it names or this session works on, with my words:\n\n${tasks.map((task) => render(task, store.threads.names())).join("\n\n")}`
      : "",
    cited.length > 0 ? `My messages it cites:\n\n${quote(cited)}` : "",
    given.length > 0
      ? `The newest words this session got, oldest first, mine and the work hex handed it:\n\n${got(given)}`
      : "",
    since.length > 0
      ? `What this session has said since, newest last:\n\n${since.map((row) => `[${row.key} · ${row.at.slice(0, 16)}Z]\n${row.body.slice(0, 1000)}`).join("\n\n")}`
      : "",
    toNewest.length > 0
      ? `My newest messages in the thread it goes to, which that thread's own session answers:\n\n${quote(toNewest)}`
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

  const threads = store.threads.list();

  return (
    threads.find(({ thread }) => thread === store.threads.key(to)) ??
    threads.find(({ name }) => name === to)
  )?.thread;
}

export async function judge(input: string, kind: Kind = "brief"): Promise<Verdict> {
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
      `${kind === "rules" ? RULES : SYSTEM}\n\n${rules}`,
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

export type Kind = "brief" | "rules";

export type Checked = {
  kind: Kind;
  verdict: Verdict | "failed";
  text: string;
  round: number;
  through?: boolean;
  error?: string;
};

export async function check(
  hook: Hook,
  store: Store,
  decide = judge,
  rules?: string[],
): Promise<Checked | undefined> {
  const handoff = brief(hook);
  const edit = handoff === undefined ? ruleEdit(hook, rules) : undefined;
  const kind: Kind = edit === undefined ? "brief" : "rules";
  const text = edit ?? handoff;

  if (text === undefined || text === "") {
    return;
  }

  const session = hook.session_id ?? "";
  const key = kind === "rules" ? "intent:rules" : "intent";
  const sent = SentBack.safeParse(JSON.parse(store.seen.get(session, key) || "null")).data;

  const last =
    sent !== undefined && sent.rounds > 0 && Date.now() - sent.at < REWRITE_WINDOW_MS
      ? sent
      : undefined;

  const round = (last?.rounds ?? 0) + 1;

  const before =
    last !== undefined &&
    `This session's last ${kind === "rules" ? "change to my rules" : "brief"}, ${Math.round((Date.now() - last.at) / 60_000)} min ago, went back with your notes, and this one may be its rewrite. That one:\n\n${last.brief}\n\nYour notes on it:\n\n${last.notes}`;

  const words =
    asked(store, session, text) ||
    "No task or message of mine was found for this session; judge it by my rules and memory.";

  const what = kind === "rules" ? "The change to my rules" : "The brief";

  try {
    const verdict = await decide(
      [words, before, `${what} (${hook.tool_name}):\n\n${text.slice(0, 40_000)}`]
        .filter(Boolean)
        .join("\n\n"),
      kind,
    );

    const through = verdict.verdict === "revise" && round > SENDBACKS_BEFORE_IT_GOES_THROUGH;

    if (verdict.verdict === "revise" && !through) {
      store.seen.show(
        session,
        key,
        JSON.stringify({
          at: Date.now(),
          rounds: round,
          brief: text.slice(0, 8000),
          notes: verdict.notes,
        } satisfies Sent),
      );
    } else {
      store.seen.unshow(session, key);
    }

    return { kind, verdict, text, round, ...(through && { through }) };
  } catch (error) {
    return { kind, verdict: "failed", text, round, error: String(error) };
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
    const result = await check(hook, open(stateDir()));

    if (result) {
      const { kind, verdict, text, round, through, error } = result;

      const record = {
        at: new Date().toISOString(),
        ms: Date.now() - began,
        session: hook.session_id,
        thread,
        tool: hook.tool_name,
        kind,
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

        const reason =
          kind === "rules"
            ? `Intent check: the owner didn't ask for this change to their rules.\n\n${verdict.notes}\n\nWhere their words do ask for it, make the change again. ${next}`
            : `Intent check: this brief drifts from what the owner asked.\n\n${verdict.notes}\n\nRewrite the brief and start it again. ${next}`;

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
