import { z } from "zod";

import { local } from "./mcp.ts";
import { open, stateDir } from "./store.ts";
import type { Row } from "./store/messages.ts";

const { HEX_THREAD } = process.env;

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

const { session_id, hook_event_name, agent_id } = ToolUse.parse(
  JSON.parse((await Bun.stdin.text()) || "{}"),
);

if (HEX_THREAD !== undefined && HEX_THREAD !== "" && session_id !== "" && agent_id === undefined) {
  const rows = open(stateDir()).messages.takeHeld(HEX_THREAD, session_id);

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
