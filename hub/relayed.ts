import { z } from "zod";

import { served } from "./running.ts";
import { open, stateDir } from "./store.ts";

// T3 Code records a message's sender only as user, agent or system, so the relay keeps which hex thread sent it: https://github.com/pingdotgg/t3code/blob/ade473018d32003658b7d38693e083ee2e314bd8/packages/contracts/src/orchestrationV2.ts#L89
const from = served();
const at = new Date().toISOString();

const Ran = z.object({ threadId: z.string(), runId: z.string() });

const T3Answer: z.ZodType<z.infer<typeof Ran> | undefined> = z.lazy(() =>
  z
    .union([
      Ran,
      z.string().transform((text, context) => {
        try {
          return T3Answer.parse(JSON.parse(text));
        } catch {
          context.issues.push({ code: "custom", message: "not JSON", input: text });

          return z.NEVER;
        }
      }),
      z
        .array(z.object({ text: T3Answer }).catch({ text: undefined }))
        .transform((blocks) => blocks.find((block) => block.text !== undefined)?.text),
      z.object({ structuredContent: T3Answer }).transform((answer) => answer.structuredContent),
    ])
    .catch(undefined),
);

const ToolUse = z.object({ tool_response: T3Answer });

if (from !== undefined && from !== "") {
  const run = ToolUse.parse(JSON.parse((await Bun.stdin.text()) || "{}")).tool_response;

  if (run) {
    open(stateDir()).relayed(from, run.threadId, run.runId, at);
  }
}
