import { readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

import { z } from "zod";

import { CLAUDE } from "./running.ts";
import { open, stateDir } from "./store.ts";
import type { Store } from "./store.ts";

const { HEX_HUB, HEX_THREAD, HEX_OWNER } = process.env;
const at = new Date().toISOString();
const busy = process.argv[2] === "busy";

const TASKS_CLAUDE_CODE_COUNTS_AS_WORKING = new Set(["subagent", "workflow"]);

const KEY_ON_OPENING_CHANNEL_TAG = /^<channel source="[^"]*" key="([^"]+)"/u;

// https://code.claude.com/docs/en/hooks#exit-code-2-behavior-per-event
const BLOCK_PROMPT = 2;

const given = (value: string | undefined): value is string => value !== undefined && value !== "";
const ignore = (): undefined => undefined;

const HookInput = z.object({
  prompt: z.string().optional().catch(undefined),
  session_id: z.string().optional(),
  background_tasks: z.array(z.object({ type: z.string().optional() })).optional(),
  last_assistant_message: z.string().optional(),
  hook_event_name: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
});

const SessionRecord = z.object({
  sessionId: z.string(),
  status: z.string(),
  statusUpdatedAt: z.number(),
});

const JobRecord = z.object({
  sessionId: z.string().optional(),
  fan: z.array(z.object({ id: z.string(), startedAt: z.number().optional() })).optional(),
});

type Job = z.infer<typeof JobRecord>;

async function input(): Promise<z.infer<typeof HookInput>> {
  try {
    return HookInput.parse(JSON.parse(await Bun.stdin.text()));
  } catch {
    return {};
  }
}

const {
  prompt,
  session_id = "",
  background_tasks,
  last_assistant_message,
  hook_event_name,
  stop_hook_active,
} = await input();

const fromChat = prompt?.startsWith("<channel source=") === true;

const background =
  !busy &&
  background_tasks?.some((task) => TASKS_CLAUDE_CODE_COUNTS_AS_WORKING.has(task.type ?? "")) ===
    true;

const key =
  busy && prompt !== undefined && fromChat
    ? KEY_ON_OPENING_CHANNEL_TAG.exec(prompt)?.[1]
    : undefined;

const answered = hook_event_name === "Stop";

if (answered && stop_hook_active !== true && session_id) {
  const { HEX_CHANNEL } = process.env;

  const lastWordsReachTheOwner =
    given(last_assistant_message?.trim()) &&
    (!given(HEX_CHANNEL) || HEX_CHANNEL.startsWith("plugin:t3@"));

  try {
    const said = open(stateDir()).unanswered(session_id, lastWordsReachTheOwner ? 1 : 0);

    if (said.length > 0) {
      const lines = said.map(
        (row) => `- ${row.key}: ${row.body.replaceAll(/\s+/gu, " ").slice(0, 160)}`,
      );

      console.log(
        JSON.stringify({
          decision: "block",
          reason: `Your user sent these during this turn, through hex:\n${lines.join("\n")}\nThey're your user's own words, even where a chat message that came mid-turn was labeled as from an outside channel. Reply to each one your replies this turn haven't answered yet; when every one has its answer, end the turn.`,
        }),
      );
      process.exit(0);
    }
  } catch (error) {
    console.error(`hex couldn't check this turn's answers: ${String(error)}`);
  }
}

let leftForTheHubToTake = key;
let recorded = false;
let heartbeat = false;

if (key !== undefined) {
  try {
    const store = open(stateDir());
    heartbeat = store.message(key)?.meta?.schedule === "heartbeat";
    const flipped = heartbeat ? busySince(session_id) : undefined;
    let took: boolean;

    try {
      const takenAsOneTurn = () =>
        store.take(key, session_id) &&
        (!session_id || (store.turned(session_id, busy, at, heartbeat, flipped), true));

      took = store.write(takenAsOneTurn);
      recorded = took && !!session_id;
    } catch (error) {
      console.error(`hex couldn't record this turn: ${String(error)}`);
      const mine = store.message(key)?.taken?.by === session_id;
      took = mine || store.take(key, session_id);
      recorded = mine;
    }

    const secondCopyTheHubResent = !took && store.message(key) !== null;

    if (took) {
      leftForTheHubToTake = undefined;
    } else if (secondCopyTheHubResent) {
      console.error(`hex gave this session ${key} already`);
      process.exit(BLOCK_PROMPT);
    }
  } catch {
    leftForTheHubToTake = key;
  }
}

function wokenByHeartbeatTask(store: Store, session: string) {
  const task =
    prompt?.startsWith("<task-notification") === true
      ? /<task-id>([\w-]+)<\/task-id>/u.exec(prompt)?.[1]
      : undefined;

  const beats = task === undefined ? [] : store.beats(session);
  const first = beats.slice(beats.findLastIndex((beat) => beat.after !== undefined) + 1)[0];

  if (!first) {
    return false;
  }

  const fan = job(session)?.fan ?? [];

  return (fan.find((one) => one.id === task)?.startedAt ?? 0) >= Date.parse(first.began);
}

function filesIn(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function busySince(session: string): number | undefined {
  const dir = join(CLAUDE, "sessions");

  const times = filesIn(dir).flatMap((file) => {
    try {
      const record = SessionRecord.parse(JSON.parse(readFileSync(join(dir, file), "utf-8")));

      return record.sessionId === session && record.status === "busy"
        ? [record.statusUpdatedAt]
        : [];
    } catch {
      return [];
    }
  });

  return times.length > 0 ? Math.max(...times) : undefined;
}

function readJob(folder: string): Job {
  try {
    return JobRecord.parse(
      JSON.parse(readFileSync(join(CLAUDE, "jobs", folder, "state.json"), "utf-8")),
    );
  } catch {
    return {};
  }
}

function job(session: string): Job | undefined {
  const folderNamedForItsId = readJob(session.slice(0, 8));

  if (folderNamedForItsId.sessionId === session) {
    return folderNamedForItsId;
  }

  return filesIn(join(CLAUDE, "jobs"))
    .map(readJob)
    .find((keptByARenewedJob) => keptByARenewedJob.sessionId === session);
}

if (session_id && !recorded) {
  try {
    const store = open(stateDir());
    const beat = heartbeat || (busy && wokenByHeartbeatTask(store, session_id));

    store.write(() => {
      // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
      // bin/quiet trusts this record over Claude Code's busy status once it says the turn ended, so an update lands between turns.
      store.turned(session_id, busy, at, beat);

      if (answered && background) {
        store.waitsOnAgents(session_id, at);
      } else if (answered) {
        store.handled(session_id, at);
      }
    });
  } catch (error) {
    console.error(`hex couldn't record this turn: ${String(error)}`);
  }
}

const typedInTheTerminal =
  busy &&
  prompt !== undefined &&
  !fromChat &&
  !/^(\/|<(local-command|command-|system-reminder|task-notification|(agent|cross-session|teammate)-message[\s>]))/u.test(
    prompt,
  )
    ? prompt
    : undefined;

if (typedInTheTerminal !== undefined && typedInTheTerminal !== "" && session_id) {
  try {
    const store = open(stateDir());
    const to = HEX_THREAD ?? session_id;
    const opensAJob = given(HEX_OWNER) && !given(HEX_THREAD) && store.said(to, 1).length === 0;
    const author = opensAJob ? "prompt" : "owner";

    const theHubStartedTheSessionWithIt =
      author === "owner" &&
      store
        .said(to, 20)
        .some((row) => row.from === "hub" && row.body.trim() === typedInTheTerminal.trim());

    if (!theHubStartedTheSessionWithIt) {
      store.deliver(
        {
          key: `terminal:${crypto.randomUUID()}`,
          to,
          from: "terminal",
          author,
          body: typedInTheTerminal,
          meta: { session: session_id },
        },
        session_id,
      );
    }
  } catch {
    ignore();
  }
}

if (!busy && session_id && answered) {
  try {
    const { ended } = await import("./observe.ts");
    ended(stateDir(), session_id, last_assistant_message);
  } catch (error) {
    process.stderr.write(`hex couldn't keep this turn: ${String(error)}\n`);
  }
}

if (given(HEX_HUB) && given(HEX_THREAD) && (!busy || fromChat)) {
  const socket = connect(HEX_HUB);

  socket
    .on("connect", () => {
      socket.end(
        `${JSON.stringify({
          type: "state",
          thread: HEX_THREAD,
          busy,
          ...(background && { background }),
          ...(hook_event_name === "StopFailure" && { failed: true }),
          ...(leftForTheHubToTake !== undefined && { taken: [leftForTheHubToTake] }),
          ...(session_id && { session: session_id }),
        })}\n`,
        () => {
          socket.destroy();
        },
      );
    })
    .on("error", ignore);
}
