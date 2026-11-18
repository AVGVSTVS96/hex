import { connect } from "node:net";

import { z } from "zod";

import type { HubLine } from "./hub.ts";
import { followed } from "./kept.ts";
import { local } from "./mcp.ts";
import { stateDir, UnaskedError, unclaimed, UnreachedError } from "./store.ts";
import type { Store } from "./store.ts";
import type { Row } from "./store/messages.ts";

const { HEX_THREAD, HEX_HUB } = process.env;

const ToolUse = z.object({
  session_id: z.string().catch(""),
  hook_event_name: z.string().catch("PostToolUse"),
  agent_id: z.string().optional().catch(undefined),
});

const attribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

function tag(row: Row, zone: string) {
  const meta = Object.entries(local({ key: row.key, ...row.meta }, zone))
    .map(([name, value]) => ` ${name}="${attribute(value)}"`)
    .join("");

  return `<channel source="${row.from}"${meta}>\n${row.body.replaceAll("</channel>", "<\\/channel>")}\n</channel>`;
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The store marks what it gives taken before it answers, so a take that went out and got no answer is asked again at once under the same time, through a client of its own, which gives what that take took; a store already known down fails it at once, unasked (UnaskedError), so a tool call never waits on it. What the store still doesn't answer is left to the hub, which gives what it held from memory once the turn ends.
async function takeHeld(thread: string, session: string) {
  const at = new Date().toISOString();
  const take = async (store: Store) => await store.messages.takeHeld(thread, session, at);

  try {
    try {
      return await followed(stateDir(), take);
    } catch (error) {
      if (error instanceof UnreachedError && !(error instanceof UnaskedError)) {
        return await take(unclaimed(stateDir()));
      }

      throw error;
    }
  } catch (error) {
    process.stderr.write(
      `hex couldn't give this session the words held for it: ${String(error)}\n`,
    );

    return [];
  }
}

const { session_id, hook_event_name, agent_id } = ToolUse.parse(
  JSON.parse((await Bun.stdin.text()) || "{}"),
);

if (HEX_THREAD !== undefined && HEX_THREAD !== "" && session_id !== "" && agent_id === undefined) {
  const rows = await takeHeld(HEX_THREAD, session_id);

  if (rows.length > 0 && HEX_HUB !== undefined && HEX_HUB !== "") {
    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // The hub keeps the words it had held in memory, for a turn that ends while the store can't let them go: these no longer wait.
    const line: HubLine = {
      type: "tookHeld",
      thread: HEX_THREAD,
      keys: rows.map(({ key }) => key),
    };

    const socket = connect(HEX_HUB);
    await new Promise<void>((resolve) => {
      socket
        .on("connect", () => {
          socket.end(`${JSON.stringify(line)}\n`, resolve);
        })
        .on("error", () => {
          resolve();
        });
    });
    socket.destroy();
  }

  if (rows.length > 0) {
    const zone = Temporal.Now.timeZoneId();
    const one = rows.length === 1;

    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: hook_event_name,
          additionalContext: `The user sent ${one ? "a new message" : "new messages"} while you were working:\n${rows.map((row) => tag(row, zone)).join("\n")}`,
        },
      }),
    );
  }
}
