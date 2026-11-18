import { connect } from "node:net";

import { z } from "zod";

import type { HubLine } from "./hub.ts";
import { followed } from "./kept.ts";
import { MovedError, stateDir, UnreachedError } from "./store.ts";
import type { NewRow } from "./store.ts";

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

let leftForTheHubToTake = key;
let recorded = false;

if (key !== undefined) {
  try {
    const { took, secondCopyTheHubResent } = await followed(stateDir(), async (store) => {
      let taken: boolean;

      try {
        taken = await store.turns.took(key, session_id, busy, at);
        recorded = taken && !!session_id;
      } catch (error) {
        if (error instanceof MovedError) {
          throw error;
        }

        console.error(`hex couldn't record this turn: ${String(error)}`);
        const mine = (await store.messages.get(key))?.taken?.by === session_id;
        taken = mine || (await store.messages.take(key, session_id));
        recorded = mine;
      }

      return {
        took: taken,
        secondCopyTheHubResent: !taken && (await store.messages.get(key)) !== null,
      };
    });

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
    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // bin/quiet trusts this record over Claude Code's busy status once it says the turn ended, so an update lands between turns.
    await followed(stateDir(), async (store) => {
      await store.turns.recorded(
        session_id,
        busy,
        at,
        answered ? (background ? "waitsOnAgents" : "handled") : undefined,
      );
    });
  } catch (error) {
    console.error(`hex couldn't record this turn: ${String(error)}`);
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What hex's store didn't answer goes to the hub, which keeps it once the store answers.
const owed: Extract<HubLine, { type: "owed" }> = { type: "owed", thread: HEX_THREAD ?? session_id };

const typedInTheTerminal =
  busy && prompt !== undefined && !fromChat && !fromAnAgent && !mayRunNoTurn ? prompt : undefined;

if (typedInTheTerminal !== undefined && typedInTheTerminal !== "" && session_id) {
  const author = given(HEX_OWNER) && !given(HEX_THREAD) ? "prompt" : "owner";

  const row: NewRow = {
    key: `terminal:${crypto.randomUUID()}`,
    to: HEX_THREAD ?? session_id,
    from: "terminal",
    author,
    body: typedInTheTerminal,
    meta: { session: session_id },
    at,
  };

  try {
    await followed(stateDir(), async (store) => {
      const theHubStartedTheSessionWithIt =
        author === "owner" &&
        (await store.messages.said(row.to, 20)).some(
          (said) => said.from === "hub" && said.body.trim() === typedInTheTerminal.trim(),
        );

      if (!theHubStartedTheSessionWithIt) {
        await store.messages.deliver(row, session_id);
      }
    });
  } catch (error) {
    if (error instanceof UnreachedError) {
      owed.said = [{ row, by: session_id }];
    }
  }
}

if (!busy && session_id && answered) {
  try {
    const { ended } = await import("./observe.ts");
    const { said, pass } = await ended(stateDir(), session_id, last_assistant_message);

    if (said) {
      owed.said = [...(owed.said ?? []), said];
    }

    if (pass) {
      owed.pass = pass;
    }
  } catch (error) {
    process.stderr.write(`hex couldn't keep this turn: ${String(error)}\n`);
  }
}

const lines: HubLine[] = [];

if (owed.said !== undefined || owed.pass !== undefined) {
  lines.push(owed);
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A session beside the thread isn't the thread's own, so its turns are never the thread's state, whatever its settings say.
if (given(HEX_THREAD) && !given(HEX_BESIDE) && (!busy || !mayRunNoTurn)) {
  lines.push({
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
  });
}

if (lines.includes(owed) && !given(HEX_HUB)) {
  process.stderr.write("hex's store didn't answer, and no hub runs this session to keep it\n");
}

if (given(HEX_HUB) && lines.length > 0) {
  const socket = connect(HEX_HUB);

  socket
    .on("connect", () => {
      socket.end(lines.map((line) => `${JSON.stringify(line)}\n`).join(""), () => {
        socket.destroy();
      });
    })
    .on("error", ignore);
}
