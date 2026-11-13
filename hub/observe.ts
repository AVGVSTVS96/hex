import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { cut, holds, keysOf, owners, problems, quotesOf, verdict } from "./notes.ts";
import { hexDir, open, replied, shown, stateDir } from "./store.ts";
import type { Row, Store } from "./store.ts";
import { zoneOf } from "./zone.ts";

export const PROFILE = 6500;

// hex's memory agent is the observer from https://dhravya.dev/writing/memory-on-the-harness-level/
const MODEL = "sonnet";
const BYTES = 280;
const NEWEST_NOTES = 40;
const MESSAGES_BEFORE_THE_TURN = 10;
const PROFILE_TRIES = 3;
const SUMMARY_TRIES = 3;
const CALL_TIMEOUT = 5 * 60_000;
const LEASE_OUTLASTS_EVERY_TRY = (PROFILE_TRIES + 1) * CALL_TIMEOUT;
const MEMO = join(import.meta.dir, "..", "vendor", "memo");

const NUMBER_AND_DATE_MEMO_ADDS = /^(#\d+ )?\d{4}-\d\d-\d\d /u;
const COMPRESSION_ASKED = /^Compress memories #(\d+-\d+)/u;

const given = (value: string | undefined): value is string => value !== undefined && value !== "";

const logIndented = (entry: string) =>
  process.stderr.write(`${new Date().toISOString()} ${entry.replaceAll("\n", "\n  ")}\n`);

const SYSTEM = `You are the memory agent of hex, the owner's personal assistant. A session just finished a turn. You get the owner's profile, the newest memories, and the messages of that turn in order, the owner's, others' (jobs, schedules, other sessions) and what hex replied; an owner's message a memory already names is marked so. You keep two things.

Memories: one line each, appended forever. Sessions write none, so every memory comes from you. Write the ones worth keeping: from the owner's messages no memory names yet, what they decided, asked for, corrected, taught, or said about their life, their work or how they want things done; and from the whole turn, anything of lasting effect that happened, like work shipped, a fact found or a plan changed. Most turns need one memory or none; a message that only answers the turn, like "ok" or "go", needs none. Each is at most ${BYTES} bytes (a memory too big for one note becomes two or three, so the owner's words survive), written like the newest memories: the owner's local time, then what happened in plain words. One that rests on the owner's words quotes them in double quotes exactly as the owner wrote them ("…" skips a part) and ends with the message's key in brackets; quote and key only the owner's messages, and name anything else in plain words, without double quotes. When the owner corrects or changes something a memory says, the new line starts with "Correction:". A memory that's already there doesn't need writing again.

The profile: a small markdown file every session reads, who the owner is: their life, health, home, people, work, and plans that hold for a while, like a trip. Each fact has one home, and the others are elsewhere: how they want things done is in their AGENTS.md, what they want brought up on its own, and when, in PROACTIVE.md, what they want done and when it's due is in tasks, and what happened, like a project's latest numbers or where a claim stands, is in memories. When a message changes a fact, rewrite its line so only the current truth stays; a line stays until a message says it's no longer true or it has ended, like a trip that's over. Keep it short and never over ${PROFILE} characters; over it, merge and tighten lines, then drop the facts that matter least. A line that rests on the owner's words quotes them exactly and names the message's key in brackets. Return the whole profile when it changes, or null when nothing in it needs to change.

In both, quote the words that carry what the owner meant; anger and curses stay in the log. What came before the turn in its thread is there for what a message answers: write about the turn's own messages.`;

const ANSWER = z.object({ notes: z.array(z.string()), profile: z.string().nullable() });

export type Answer = z.infer<typeof ANSWER>;

const PASS = z.object({ session: z.string(), by: z.string(), thread: z.string().optional() });

export type Pass = z.infer<typeof PASS>;

const CLAUDE_RESULT = z.object({
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  structured_output: z.unknown(),
});

const SUMMARY = z.object({ line: z.string() });

type Look = {
  ask?: (input: string) => Promise<Answer>;
  memo?: string;
  by?: string;
  thread?: string | undefined;
};

const whose = (row: Row) =>
  given(row.meta?.unsent)
    ? "hex, in its terminal, which the owner does not see,"
    : replied(row)
      ? "hex replied,"
      : row.author === "prompt"
        ? "hex's words to the session,"
        : `From ${row.meta?.user ?? row.from}, not the owner,`;

export async function observe(
  state: string,
  session: string,
  { ask = claude, memo = MEMO, by = new Date().toISOString(), thread }: Look = {},
) {
  const recall = (pattern: string) =>
    Bun.spawnSync([memo, "recall", pattern], {
      stdout: "pipe",
      stderr: "ignore",
    }).stdout.toString();

  const named = (rows: Row[]) =>
    rows.length > 0 ? recall(rows.map((row) => `\\[${escape(row.key)}\\]`).join("|")) : "";

  const store = open(state);
  const taken = store.messages.observe(session, by, thread, LEASE_OUTLASTS_EVERY_TRY);
  const rows = owners(taken);
  const written: string[] = [];

  try {
    const noted = named(rows);
    const fresh = rows.filter((row) => !noted.includes(`[${row.key}]`));
    let wanted = false;
    let wrong = "";
    let reasons = "";

    if (taken.length > 0) {
      const zone = zoneOf(hexDir()) ?? Temporal.Now.timeZoneId();
      const threads = store.threads.names();
      const place = taken[0]?.to ?? thread;
      const earliest = [by, ...taken.map((row) => row.at)].toSorted()[0] ?? by;

      const before = given(place)
        ? store.messages.said(place, MESSAGES_BEFORE_THE_TURN, earliest).filter(shown)
        : [];

      const turn = [
        ...(before.length > 0
          ? [
              `<before>\n${before.map((row) => `${row.author === "owner" ? "The owner," : whose(row)} ${clock(row.at, zone)}:\n${cut(row.body, 1000)}`).join("\n\n")}\n</before>`,
            ]
          : []),
        `<turn thread="${given(place) ? (threads[place] ?? place) : "none"}">`,
        ...taken
          .filter(shown)
          .map((row) =>
            rows.includes(row)
              ? `${ownerMessage(row, zone)}${noted.includes(`[${row.key}]`) ? "\n(a note already names this message: write no note for it)" : ""}`
              : `${whose(row)} ${clock(row.at, zone)}:\n${cut(row.body, 2000)}`,
          ),
        "</turn>",
      ].join("\n\n");

      const ours = new Set(fresh.map((row) => row.key));

      for (let tries = 0; tries < PROFILE_TRIES; tries++) {
        const profileBefore = store.profiles.current();

        const answer = await ask(
          `<profile>\n${profileBefore || "(none yet)"}\n</profile>\n\n<newest memories>\n${newestNotes(recall("."))}\n</newest memories>\n\n${turn}${wrong}`,
        );

        const now = named(fresh);

        for (const note of tries > 0 ? [] : answer.notes.map(asMemoTakesIt).filter(Boolean)) {
          const keys = keysOf(note);

          const kept =
            keys.length > 0
              ? keys.every((key) => ours.has(key) && !now.includes(`[${key}]`)) &&
                holds(verdict(note, store))
              : quotesOf(note).length === 0;

          if (Buffer.byteLength(note) > BYTES || !kept) {
            continue;
          }

          if (
            Bun.spawnSync([memo, "note", note], { stdout: "ignore", stderr: "ignore" }).exitCode ===
            0
          ) {
            written.push(note);
          }
        }

        wanted = answer.profile !== null;

        if (answer.profile === null) {
          break;
        }

        const bad = misquoted(answer.profile, store);
        reasons = bad.join("\n");
        wrong = bad.length > 0 ? retry(bad, answer.profile) : "";

        if (wrong !== "" || !store.profiles.profiled(profileBefore, answer.profile)) {
          continue;
        }

        wanted = false;
        break;
      }

      if (wanted) {
        logIndented(
          `hex left the profile as it was after ${PROFILE_TRIES} tries:${reasons ? `\n${reasons}` : " another pass kept rewriting it"}`,
        );
      }
    }

    const lostOnlyToOtherPasses = wanted && wrong === "" && written.length === 0;

    store.messages.observed(
      taken.map((row) => row.key),
      !lostOnlyToOtherPasses,
    );

    return written;
  } catch (error) {
    store.messages.observed(
      taken.map((row) => row.key),
      written.length > 0,
    );
    logIndented(`hex couldn't look over this turn for memories: ${String(error)}`);

    return written;
  }
}

function misquoted(profile: string | null, store: Store): string[] {
  if (profile === null || profile.trim() === "") {
    return ["(empty)"];
  }

  if (profile.length > PROFILE) {
    return [
      `(${profile.length} characters: cut it by merging and tightening lines, then dropping the facts that matter least)`,
    ];
  }

  return profile.split("\n").flatMap((each) => {
    if (keysOf(each).length === 0) {
      return quotesOf(each).length > 0
        ? [`${each}\n  names no message of the owner's for its quote`]
        : [];
    }

    const found = verdict(each, store);

    if (!holds(found)) {
      return [`${each}\n  ${problems(found, false).join("\n  ")}`];
    }

    const foreign = found.keys.filter((row) => owners([row]).length === 0);

    return foreign.length > 0
      ? [`${each}\n  ${foreign.map((row) => `[${row.key}]`).join(", ")} isn't the owner's message`]
      : [];
  });
}

const retry = (bad: string[], draft: string) =>
  `\n\nYour last profile wasn't kept. It must stay under ${PROFILE} characters, and a line that quotes the owner must name the message it quotes, quoting it as written:\n${bad.join("\n")}\n\nFix that draft rather than starting over:\n<draft>\n${draft.trim()}\n</draft>`;

const newestNotes = (recalled: string) =>
  recalled
    .split("\n")
    .filter((each) => each.startsWith("#"))
    .slice(-NEWEST_NOTES)
    .join("\n");

const asMemoTakesIt = (note: string) =>
  note.replaceAll(/\s+/gu, " ").trim().replace(NUMBER_AND_DATE_MEMO_ADDS, "");

function ownerMessage(row: Row, zone: string) {
  const replyingTo = row.meta?.reply_to_text;
  const replying = given(replyingTo) ? `, replying to "${replyingTo.slice(0, 300)}"` : "";

  return `[${row.key}] ${clock(row.meta?.ts ?? row.at, zone)}${replying}:\n${row.body}`;
}

export function clock(at: string, zone: string) {
  const time = Temporal.Instant.from(at).toZonedDateTimeISO(zone);
  const hour = time.hour % 12 || 12;
  const month = time.toLocaleString("en-US", { month: "short" });

  return `${month} ${time.day} ${hour}:${String(time.minute).padStart(2, "0")}${time.hour < 12 ? "am" : "pm"}`;
}

const escape = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

async function callWithNoTools<T>(
  input: string,
  system: string,
  effort: "high" | "low",
  output: z.ZodType<T>,
) {
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !name.startsWith("HEX_") && !name.startsWith("CLAUDECODE"),
      ),
    ),
    CLAUDE_CODE_ENTRYPOINT: "hex",
    HEX_HELPER: "memory",
  };

  const run = Bun.spawn(
    [
      "claude",
      "-p",
      "--safe-mode",
      "--model",
      MODEL,
      "--effort",
      effort,
      "--tools",
      "",
      "--json-schema",
      JSON.stringify(z.toJSONSchema(output, { target: "draft-07" })),
      "--system-prompt",
      system,
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
      timeout: CALL_TIMEOUT,
    },
  );

  const [out, err, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);

  const result = CLAUDE_RESULT.parse(JSON.parse(out || "{}"));

  if (code !== 0 || result.is_error === true) {
    throw new Error(`claude exited ${code}: ${result.result ?? err.slice(-500)}`);
  }

  return { answer: output.safeParse(result.structured_output).data, result: result.result };
}

async function claude(input: string): Promise<Answer> {
  const { answer, result } = await callWithNoTools(input, SYSTEM, "high", ANSWER);

  if (!answer) {
    throw new Error(`claude answered without the schema: ${String(result)}`);
  }

  return answer;
}

// OptMem leaves due compressions to whoever writes a note, and only this agent writes notes: https://github.com/VictorTaelin/OptMem/blob/1fb164cf39028047781f72ac3bb1e5a691c1dcb0/README.md#while-working-register-memories-mandatory
export async function nap(memo = MEMO, compress = summarize, stillHoldsLease = () => true) {
  while (stillHoldsLease()) {
    const asked = Bun.spawnSync([memo, "nap"], {
      stdout: "pipe",
      stderr: "ignore",
    }).stdout.toString();

    if (!asked.startsWith("Compress")) {
      return;
    }

    const block = COMPRESSION_ASKED.exec(asked)?.[1];

    if (block === undefined) {
      throw new Error(`memo asked for a compression hex can't read: ${asked}`);
    }

    let why = "";

    for (let tries = 0; ; tries++) {
      const lastTry = tries === SUMMARY_TRIES - 1;
      const summary = await compress(asked.slice(0, asked.lastIndexOf("\nRun:")) + why);

      const kept = Bun.spawnSync([memo, "nap", block, lastTry ? within(summary, BYTES) : summary], {
        stdout: "pipe",
        stderr: "pipe",
      });

      if (kept.exitCode === 0) {
        break;
      }

      const said = `${kept.stdout.toString()}${kept.stderr.toString()}`;

      if (lastTry) {
        throw new Error(`memo kept no summary of #${block}: ${said}`);
      }

      why = `\n\nThat line wasn't kept: ${said}`;
    }
  }
}

export function within(summary: string, bytes: number) {
  const flat = summary.replaceAll(/\s+/gu, " ").trim();

  if (Buffer.byteLength(flat) <= bytes) {
    return flat;
  }

  // oxlint-disable-next-line typescript/no-misused-spread -- a cut by code point never splits a UTF-8 sequence, which is all memo's byte limit needs
  let codePoints = [...flat];

  while (codePoints.length > 0 && Buffer.byteLength(`${codePoints.join("")}…`) > bytes) {
    const lastSpace = codePoints.lastIndexOf(" ");
    codePoints = codePoints.slice(0, lastSpace > 0 ? lastSpace : codePoints.length - 1);
  }

  return `${codePoints.join("").trimEnd()}…`;
}

async function summarize(prompt: string) {
  const { answer } = await callWithNoTools(
    prompt,
    'You compress the memories of an AI assistant into one line: a dated record of what happened and what is still open. A rule or caution the owner stated goes in as something they said on its date, like "Oct 3: owner asked for fewer agents", rather than as an instruction, since their standing rules live in their AGENTS.md.',
    "low",
    SUMMARY,
  );

  return answer?.line.trim() ?? "";
}

// A session re-reads its memory file from disk after compacting, so each pass leaves it current: https://code.claude.com/docs/en/memory#instructions-seem-lost-after-compact
export function refresh() {
  Bun.spawnSync([join(import.meta.dir, "..", "bin", "wake")], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

async function pass(state: string, turn: Pass, stillHoldsLease: () => boolean) {
  await observe(state, turn.session, turn);

  try {
    await nap(MEMO, summarize, stillHoldsLease);
  } finally {
    refresh();
  }
}

export async function drain(
  state: string,
  run: (turn: Pass, stillHoldsLease: () => boolean) => Promise<void> = (turn, stillHoldsLease) =>
    pass(state, turn, stillHoldsLease),
) {
  const store = open(state);
  const holder = crypto.randomUUID();
  const holdsLease = () => store.leases.take("observe", holder, LEASE_OUTLASTS_EVERY_TRY);

  while (store.passes.waiting() && holdsLease()) {
    try {
      for (let next; (next = store.passes.waiting());) {
        try {
          await run(PASS.parse(next.pass), holdsLease);
        } catch (error) {
          logIndented(`hex couldn't look over a turn for memories: ${String(error)}`);
        }

        store.passes.passed(next.n);

        if (!holdsLease()) {
          return;
        }
      }
    } finally {
      store.leases.release("observe", holder);
    }
  }
}

export function queue(state: string, turn: Pass) {
  if (!given(process.env.MEMORY_DIR) || !existsSync(MEMO)) {
    return;
  }

  try {
    open(state).passes.wait(turn);
    const observeLog = openSync(join(state, "observe.log"), "a");

    try {
      // Claude Code kills a hook still running when a -p session ends, so the pass runs detached: https://code.claude.com/docs/en/hooks#run-hooks-in-the-background
      spawn(process.execPath, [import.meta.path], {
        detached: true,
        stdio: ["ignore", "ignore", observeLog],
        env: { ...process.env, HEX_STORE: state, HEX_PASS: "1" },
      })
        .on("error", (error) => {
          process.stderr.write(`hex couldn't start the memory agent: ${String(error)}\n`);
        })
        .unref();
    } finally {
      closeSync(observeLog);
    }
  } catch (error) {
    process.stderr.write(`hex couldn't queue a turn for memories: ${String(error)}\n`);
  }
}

export function ended(state: string, session: string, last?: string) {
  const { HEX_THREAD, HEX_CHANNEL, HEX_BESIDE } = process.env;
  const t3 = HEX_CHANNEL?.startsWith("plugin:t3@") === true;
  const from = t3 ? "t3" : "terminal";
  const answer = last?.trim();
  const heldByAnotherApp = given(HEX_CHANNEL) && !t3;

  try {
    if (given(answer)) {
      open(state).messages.deliver(
        {
          key: `${from}:${crypto.randomUUID()}`,
          to: given(HEX_BESIDE) ? HEX_BESIDE : (HEX_THREAD ?? session),
          from,
          author: "hex",
          body: answer,
          meta: { session, ...(heldByAnotherApp && { unsent: "true" }) },
        },
        session,
      );
    }
  } catch (error) {
    process.stderr.write(`hex couldn't keep this turn's answer: ${String(error)}\n`);
  }

  queue(state, {
    session,
    by: new Date().toISOString(),
    thread: given(HEX_BESIDE) ? HEX_BESIDE : HEX_THREAD,
  });
}

export function record(memory: string | undefined, home = hexDir()) {
  if (!given(memory)) {
    return;
  }

  const git = (...args: string[]) => {
    const run = Bun.spawnSync(["git", "-C", memory, ...args], {
      timeout: 30_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });

    return {
      ok: run.exitCode === 0,
      out: run.stdout.toString().trim(),
      err: run.stderr.toString().trim(),
    };
  };

  const top = git("rev-parse", "--show-toplevel");

  if (
    !top.ok ||
    realpathSync(top.out) !== realpathSync(home) ||
    !git("symbolic-ref", "--quiet", "HEAD").ok
  ) {
    return;
  }

  if (!git("add", "--all", "--", ".").ok || git("diff", "--cached", "--quiet", "--", ".").ok) {
    return;
  }

  const identity = git("var", "GIT_COMMITTER_IDENT").ok
    ? []
    : ["-c", "user.name=hex", "-c", "user.email=hex@localhost"];

  const commit = git(
    ...identity,
    "commit",
    "--quiet",
    "--message",
    "chore(memory): record what happened",
    "--",
    ".",
  );

  if (!commit.ok) {
    git("reset", "--quiet", "--", ".");
    logIndented(`hex couldn't commit its memory: ${commit.err}`);
  }
}

if (import.meta.main && given(process.env.HEX_PASS)) {
  await drain(stateDir());
  record(process.env.MEMORY_DIR);
}
