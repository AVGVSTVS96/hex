import { closeSync, fstatSync, mkdirSync, openSync, readSync, statSync, watch } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  stripLocalCommandMetadata,
  toAcpNotifications,
} from "@agentclientprotocol/claude-agent-acp";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { z } from "zod";

const PROJECTS = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");

const askedNothingOnReplay = () =>
  Promise.reject(new Error("a replayed transcript asks nothing of the client"));

const client: Parameters<typeof toAcpNotifications>[4] = {
  sessionUpdate: () => Promise.resolve(),
  requestPermission: askedNothingOnReplay,
  readTextFile: askedNothingOnReplay,
  writeTextFile: askedNothingOnReplay,
  createElicitation: askedNothingOnReplay,
  completeElicitation: askedNothingOnReplay,
  extNotification: askedNothingOnReplay,
};

const logger = {
  // oxlint-disable-next-line eslint/no-empty-function -- a replay's progress lines are noise in the hub's log
  log: () => {},
  error: (...args: unknown[]) => {
    process.stderr.write(`t3 hub: transcript: ${args.join(" ")}\n`);
  },
};

const origin = z.looseObject({ kind: z.string().optional() }).nullish();

const entrySchema = z.looseObject({
  type: z.string().optional(),
  subtype: z.string().optional(),
  timestamp: z.string().optional(),
  uuid: z.string().optional(),
  origin,
  attachment: z
    .looseObject({
      origin,
      type: z.string().optional(),
      content: z.array(z.string()).optional().catch(undefined),
    })
    .nullish(),
  compactMetadata: z.looseObject({ trigger: z.string().optional() }).nullish(),
  content: z.string().optional(),
  isMeta: z.boolean().optional(),
  isSidechain: z.boolean().optional(),
  message: z.looseObject({ id: z.string().optional(), content: z.unknown().optional() }).nullish(),
  toolUseResult: z.unknown().optional(),
});

const contentSchema = z.union([
  z.string(),
  z.custom<Exclude<Parameters<typeof toAcpNotifications>[0], string>>((value) =>
    Array.isArray(value),
  ),
]);

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A message that came mid-turn reaches the session through hub/held.ts, as a tool call's hook context.
function heldForTheTurn(attachment: z.infer<typeof entrySchema>["attachment"]) {
  return (
    attachment?.type === "hook_additional_context" &&
    attachment.content?.some((text) => text.includes('<channel source="')) === true
  );
}

export function transcriptPath(cwd: string, session: string) {
  return join(PROJECTS, cwd.replaceAll(/[^a-zA-Z0-9]/gu, "-"), `${session}.jsonl`);
}

export function follow({
  path,
  sessionId,
  cwd,
  since,
  done,
  emit,
  end,
}: {
  path: string;
  sessionId: string;
  cwd: string;
  since?: number | undefined;
  done: () => boolean;
  emit: (notification: SessionNotification) => void;
  end: (error?: string) => void;
}) {
  const tools = {};
  const tasks = new Map();
  let offset = since === undefined ? sizeOf(path) : 0;
  let rest = Buffer.alloc(0);
  let asked = false;
  let open = false;
  let ended = false;

  mkdirSync(dirname(path), { recursive: true });

  const watcher = watch(dirname(path), (_, file) => {
    if (file === basename(path)) {
      catchUp();
    }
  });

  catchUp();

  function catchUp() {
    if (ended) {
      return;
    }

    let fd;

    try {
      fd = openSync(path, "r");
    } catch {
      return;
    }

    try {
      const size = fstatSync(fd).size;

      if (size <= offset) {
        return;
      }

      const chunk = Buffer.alloc(size - offset);
      readSync(fd, chunk, 0, chunk.length, offset);
      offset = size;
      const data = Buffer.concat([rest, chunk]);
      const last = data.lastIndexOf(10);
      rest = data.subarray(last + 1);

      if (last !== -1) {
        for (const line of data.subarray(0, last).toString("utf-8").split("\n")) {
          if (!ended) {
            convert(line);
          }
        }
      }
    } finally {
      closeSync(fd);
    }
  }

  function convert(line: string) {
    let entry;

    try {
      entry = entrySchema.parse(JSON.parse(line));
    } catch {
      return;
    }

    if (since !== undefined && Date.parse(entry.timestamp ?? "") < since) {
      return;
    }

    if (
      (entry.type === "user" && entry.origin?.kind === "channel") ||
      entry.attachment?.origin?.kind === "channel" ||
      heldForTheTurn(entry.attachment)
    ) {
      asked = true;
    }

    if (entry.type === "system" && entry.subtype === "turn_duration") {
      open = false;

      settle();

      return;
    }

    if (
      entry.type === "system" &&
      entry.subtype === "compact_boundary" &&
      entry.compactMetadata?.trigger === "manual"
    ) {
      stop();

      return;
    }

    const failed =
      entry.type === "system" && entry.subtype === "local_command"
        ? /<local-command-stderr>([\s\S]*)<\/local-command-stderr>/u.exec(entry.content ?? "")?.[1]
        : undefined;

    if (failed !== undefined && failed !== "") {
      stop(failed);

      return;
    }

    if ((entry.type !== "assistant" && entry.type !== "user") || entry.isSidechain === true) {
      return;
    }

    open = true;
    const raw = entry.message?.content;

    if (
      entry.type === "user" &&
      (entry.isMeta === true || entry.origin || /^\/\S/u.test(String(raw)))
    ) {
      return;
    }

    const content = contentSchema.safeParse(
      entry.type === "user" ? stripLocalCommandMetadata(raw) : raw,
    );

    if (!content.success) {
      return;
    }

    const messageId = entry.type === "assistant" ? entry.message?.id : entry.uuid;

    const notifications = toAcpNotifications(
      content.data,
      entry.type,
      sessionId,
      tools,
      client,
      logger,
      {
        registerHooks: false,
        replay: true,
        cwd,
        taskState: tasks,
        ...(messageId !== undefined && { messageId }),
        toolUseResult: entry.toolUseResult,
      },
    );

    for (const notification of notifications) {
      emit(notification);
    }
  }

  function settle() {
    if (!ended && asked && !open && done()) {
      stop();
    }
  }

  function stop(error?: string) {
    ended = true;
    watcher.close();
    end(error);
  }

  return {
    settle() {
      catchUp();
      settle();
    },
    asked: () => asked,
    close() {
      ended = true;
      watcher.close();
    },
  };
}

function sizeOf(path: string) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
