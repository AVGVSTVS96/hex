import { rmSync } from "node:fs";
import { createServer } from "node:net";

import { z } from "zod";

import type { ThreadInbox } from "./inbox.ts";
import { OwedRow } from "./kept.ts";
import type { Owing } from "./kept.ts";
import { PASS } from "./observe.ts";
import { ordered } from "./ordered.ts";
import type { ThreadSessions } from "./sessions.ts";
import type { StalledTurns } from "./stalls.ts";
import { isAuthor } from "./store.ts";
import type { Author, MessageId } from "./store.ts";
import type { Threads } from "./threads.ts";
import { wentThrough } from "./through.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What another process (the voice app, hex's check) can do with a question the client asked with buttons: answer it for the owner, settle it as no longer asked, or take an answer back.
export type Questions = {
  answer: (thread: string, message: MessageId, label: string, via: string) => void;
  settle: (thread: string, message: MessageId, note: string) => void;
  reopen: (thread: string, message: MessageId, via: string) => void;
};

const messageId = z.union([z.number(), z.string()]);

const HubRequestLine = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("state"),
    thread: z.string(),
    busy: z.boolean(),
    background: z.boolean().optional(),
    failed: z.boolean().optional(),
    error: z.string().optional(),
    said: z.string().optional(),
    taken: z.array(z.string()).optional(),
    session: z.string().optional(),
  }),
  z.object({
    type: z.literal("open"),
    thread: z.string(),
    name: z.string(),
    prompt: z.string().optional(),
  }),
  z.object({
    type: z.literal("answer"),
    thread: z.string(),
    message: messageId,
    label: z.string(),
    via: z.string(),
  }),
  z.object({ type: z.literal("settle"), thread: z.string(), message: messageId, note: z.string() }),
  z.object({ type: z.literal("reopen"), thread: z.string(), message: messageId, via: z.string() }),
  z.object({
    type: z.literal("inbound"),
    thread: z.string(),
    content: z.string(),
    meta: z.record(z.string(), z.string()).optional(),
    key: z.string().optional(),
    author: z.custom<Author>(isAuthor).catch("prompt"),
  }),
  z.object({
    type: z.literal("mirror"),
    thread: z.string(),
    to: z.string(),
    where: z.string().optional(),
  }),
  z.object({ type: z.literal("tookHeld"), thread: z.string(), keys: z.array(z.string()) }),
  z.object({
    type: z.literal("owed"),
    thread: z.string(),
    said: z
      .array(
        z.object({
          row: OwedRow,
          by: z.string(),
        }),
      )
      .optional(),
    pass: PASS.optional(),
  }),
]);

type HubRequest = z.output<typeof HubRequestLine>;

export type HubLine = z.input<typeof HubRequestLine>;

const ignore = (): void => undefined;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What a session's hooks couldn't keep while hex's store didn't answer, which the hub keeps once it does.
function owedByHooks(
  owing: Owing,
  { said = [], pass: turn }: Extract<HubRequest, { type: "owed" }>,
) {
  for (const { row, by } of said) {
    owing.owe({ kind: "deliver", row, by });
  }

  if (turn) {
    owing.owe({ kind: "pass", pass: turn });
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Where a session's hooks and hex's own tools reach the hub, one JSON line each, and which owner hears each line. mirror: shows a thread in another app too, and resolves with where.
export function hubSocket({
  socketPath,
  threads,
  sessions,
  inbox,
  stalls,
  owing,
  questions,
  turnBegan,
  turnEnded,
  mirror,
}: {
  socketPath: string;
  threads: Threads;
  sessions: ThreadSessions;
  inbox: ThreadInbox;
  stalls: StalledTurns;
  owing: Owing;
  questions: Questions | undefined;
  turnBegan: (thread: string) => void;
  turnEnded: (thread: string, background?: boolean) => Promise<void>;
  mirror: (thread: string, to: string, where?: string) => Promise<string>;
}) {
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A thread's lines are handled one at a time, in the order they came, each once the store has answered what the one before it asked.
  const handling = ordered();

  function inOrder(request: HubRequest) {
    void handling(request.thread, async () => {
      try {
        await handle(request);
      } catch (error) {
        process.stderr.write(
          `hub: a ${request.type} line for ${request.thread} failed: ${String(error)}\n`,
        );
      }
    });
  }

  async function handle(request: HubRequest) {
    switch (request.type) {
      case "state": {
        await inbox.took(request.taken, request.session);

        if (request.failed === true) {
          stalls.stall(request.thread, request.error, request.said);
        } else {
          stalls.passed(request.thread, request.busy);
        }

        if (request.busy) {
          turnBegan(request.thread);
        } else {
          await turnEnded(request.thread, request.background === true);
        }

        if (!request.busy && request.failed !== true) {
          wentThrough("turn");
        }

        return;
      }

      case "open": {
        sessions.launch(request.thread, request.name, { prompt: request.prompt });

        return;
      }

      case "answer": {
        questions?.answer(request.thread, request.message, request.label, request.via);

        return;
      }

      case "settle": {
        questions?.settle(request.thread, request.message, request.note);

        return;
      }

      case "reopen": {
        questions?.reopen(request.thread, request.message, request.via);

        return;
      }

      case "inbound": {
        await inbox.inbound(request.thread, {
          content: request.content,
          meta: request.meta ?? {},
          ...(request.key !== undefined && { key: request.key }),
          author: request.author,
        });

        return;
      }

      case "tookHeld": {
        inbox.tookHeld(request.thread, request.keys);

        return;
      }

      case "owed": {
        owedByHooks(owing, request);

        return;
      }

      case "mirror": {
        const thread = threads.find(request.thread);

        void (async () => {
          try {
            const mirrored = await mirror(thread, request.to, request.where);
            process.stderr.write(`hub: mirrored ${request.thread} to ${mirrored}\n`);
          } catch (error) {
            process.stderr.write(
              `hub: couldn't mirror ${request.thread} to ${request.to}: ${String(error)}\n`,
            );
          }
        })();
      }
    }
  }

  rmSync(socketPath, { force: true });

  return createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf-8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;

      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);

        try {
          inOrder(HubRequestLine.parse(JSON.parse(raw)));
        } catch (error) {
          process.stderr.write(`hub: dropped a bad line: ${String(error)}\n`);
        }
      }
    });
    socket.on("error", ignore);
  }).listen(socketPath);
}
