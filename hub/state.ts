import { connect } from "node:net";

import { z } from "zod";

import { open, stateDir } from "./store.ts";

const { HEX_HUB, HEX_THREAD, HEX_OWNER, HEX_BESIDE } = process.env;
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
  error: z.string().optional(),
  error_details: z.string().optional(),
});

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
  error: apiError,
  error_details,
} = await input();

const fromChat = prompt?.startsWith("<channel source=") === true;

const fromAnAgent =
  prompt !== undefined &&
  /^<(task-notification|(agent|cross-session|teammate)-message[\s>])/u.test(prompt);

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The hub holds the owner's words for a turn it's told began until that turn's Stop hook, and a command that runs no model turn has none.
const mayRunNoTurn =
  prompt === undefined || /^([/!]|<(local-command|command-|bash-|system-reminder))/u.test(prompt);

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
    const said = open(stateDir()).turns.unanswered(session_id, lastWordsReachTheOwner ? 1 : 0);

    if (said.length > 0) {
      const lines = said.map(
        (row) => `- ${row.key}: ${row.body.replaceAll(/\s+/gu, " ").slice(0, 160)}`,
      );

      console.log(
        JSON.stringify({
          decision: "block",
          reason: `Your user sent these during this turn, through hex:\n${lines.join("\n")}`,
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

if (key !== undefined) {
  try {
    const store = open(stateDir());
    let took: boolean;

    try {
      const takenAsOneTurn = () =>
        store.messages.take(key, session_id) &&
        (!session_id || (store.turns.turned(session_id, busy, at), true));

      took = store.write(takenAsOneTurn);
      recorded = took && !!session_id;
    } catch (error) {
      console.error(`hex couldn't record this turn: ${String(error)}`);
      const mine = store.messages.get(key)?.taken?.by === session_id;
      took = mine || store.messages.take(key, session_id);
      recorded = mine;
    }

    const secondCopyTheHubResent = !took && store.messages.get(key) !== null;

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

if (session_id && !recorded) {
  try {
    const store = open(stateDir());
    store.write(() => {
      // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
      // bin/quiet trusts this record over Claude Code's busy status once it says the turn ended, so an update lands between turns.
      store.turns.turned(session_id, busy, at);

      if (answered && background) {
        store.turns.waitsOnAgents(session_id, at);
      } else if (answered) {
        store.turns.handled(session_id, at);
      }
    });
  } catch (error) {
    console.error(`hex couldn't record this turn: ${String(error)}`);
  }
}

const typedInTheTerminal =
  busy && prompt !== undefined && !fromChat && !fromAnAgent && !mayRunNoTurn ? prompt : undefined;

if (typedInTheTerminal !== undefined && typedInTheTerminal !== "" && session_id) {
  try {
    const store = open(stateDir());
    const to = HEX_THREAD ?? session_id;

    const author = given(HEX_OWNER) && !given(HEX_THREAD) ? "prompt" : "owner";

    const theHubStartedTheSessionWithIt =
      author === "owner" &&
      store.messages
        .said(to, 20)
        .some((row) => row.from === "hub" && row.body.trim() === typedInTheTerminal.trim());

    if (!theHubStartedTheSessionWithIt) {
      store.messages.deliver(
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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A session beside the thread isn't the thread's own, so its turns are never the thread's state, whatever its settings say.
if (given(HEX_HUB) && given(HEX_THREAD) && !given(HEX_BESIDE) && (!busy || !mayRunNoTurn)) {
  const socket = connect(HEX_HUB);

  socket
    .on("connect", () => {
      socket.end(
        `${JSON.stringify({
          type: "state",
          thread: HEX_THREAD,
          busy,
          ...(background && { background }),
          ...(hook_event_name === "StopFailure" && {
            failed: true,
            error: apiError,
            said: given(last_assistant_message) ? last_assistant_message : error_details,
          }),
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
