import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import * as claude from "./claude.ts";
import { clock } from "./clock.ts";
import type { SessionFiles } from "./files.ts";
import type { Keep } from "./kept.ts";
import { toolList } from "./mcp.ts";
import type { ChannelServer } from "./mcp.ts";
import { present } from "./present.ts";
import type { Threads } from "./threads.ts";
import { sessionTranscripts } from "./transcripts.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What a session reads only as it starts: its launch arguments, its channel's instructions and tools, and the files and folders its launcher loads that way. hex.db keeps a digest of what each thread's session started with.
export function stamp(args: string[], server?: ChannelServer, startup: string[] = []) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        args,
        server ? { ...server, tools: toolList(server.tools) } : null,
        ...(startup.length ? [startup.map(contentsOf)] : []),
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// An update rewrites these while the hub runs, so a file gone midway reads as missing.
type Read = string | [string, Read][] | null;

function contentsOf(path: string): Read {
  try {
    if (!statSync(path).isDirectory()) {
      return readFileSync(path, "utf-8");
    }

    return readdirSync(path)
      .toSorted()
      .map((name) => [name, contentsOf(join(path, name))]);
  } catch {
    return null;
  }
}

export type SessionStarts = ReturnType<typeof sessionStarts>;

export function sessionStarts({
  threads,
  files,
  kept,
  launcher,
  channel,
  server,
  startup,
  args,
  handoffAbove,
  fresh,
}: {
  threads: Threads;
  files: SessionFiles;
  kept: Keep;
  launcher: string;
  channel: string;
  server: ChannelServer;
  startup: string[];
  args: (thread: string) => string[];
  handoffAbove: number;
  fresh: (thread: string) => boolean;
}) {
  const inherited = claude.inherited();
  const transcripts = sessionTranscripts({ threads, kept });

  function chosen(thread: string) {
    const { model, effort } = threads.of(thread);

    return [
      ...(present(model) ? ["--model", model] : []),
      ...(present(effort) ? ["--effort", effort] : []),
    ];
  }

  function launchArgs(thread: string) {
    return [...chosen(thread), ...args(thread)];
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A session that started with other arguments or another channel starts over: with its next message for a changed model or effort, and at its next rest after an update, so a crash or a plain restart of the hub leaves every session running. A thread with no record started its session with none of its own arguments, before the hub kept one.
  function stale(thread: string) {
    return (
      (threads.get(thread)?.launched ?? stamp([], server)) !==
      stamp(launchArgs(thread), server, startup)
    );
  }

  async function start(
    thread: string,
    prompt?: string,
    fork?: string,
    daemonChecked?: Promise<void>,
  ) {
    await transcripts.land(thread, fork);

    if (!present(fork)) {
      await rewound(thread);
    }

    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // The session's hooks keep what's typed in it as the owner's; this one is hex's.
    if (present(prompt)) {
      await kept(
        (store) =>
          store.messages.deliver(
            {
              key: `hub:${thread}:${Bun.hash(prompt).toString(36)}`,
              to: thread,
              from: "hub",
              author: "prompt",
              body: prompt,
              meta: {},
            },
            "hub",
          ),
        false,
      );
    }

    const known = threads.of(thread);

    const takesOverFrom = present(prompt) || present(fork) ? undefined : expired(thread);
    files.write(thread, {}, takesOverFrom);
    const launching = launchArgs(thread);
    threads.update(thread, { launched: stamp(launching, server, startup) });
    const source = fork ?? (present(known.session) ? undefined : known.fork);

    const resumeArgs = present(source)
      ? ["--resume", source, "--fork-session"]
      : present(known.session) && !fresh(thread) && !present(takesOverFrom)
        ? ["--resume", known.session]
        : [];

    return await claude.start(
      launcher,
      [
        "--channels",
        channel,
        "--name",
        known.name,
        ...resumeArgs,
        ...launching,
        "--settings",
        files.settingsOf(thread),
        ...(present(prompt) ? [prompt] : []),
      ],
      { cwd: threads.cwd(thread), env: inherited },
      daemonChecked,
    );
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A saved session whose last reply the model's safeguards refused would be resumed into the same refusal, so the thread goes on, on its own model, from a copy of the conversation that ends before what that turn was given, or from a new session when nothing came before it or the copy fails.
  async function rewound(thread: string) {
    const session = threads.current(thread);

    if (!present(session) || fresh(thread)) {
      return;
    }

    const refusal = claude.refused(claude.transcript(threads.cwd(thread), session));

    if (!refusal) {
      return;
    }

    threads.dropUnsaved(thread);

    const copy = present(refusal.at)
      ? await claude.rewind(threads.cwd(thread), session, refusal.at, chosen(thread))
      : undefined;

    threads.update(thread, { session: present(copy) ? copy : undefined });
    process.stderr.write(
      `hub: ${thread}'s session ${session} ended on a refused turn, so it goes on ${present(copy) ? `from ${copy}, a copy that ends before it` : "in a new session"}\n`,
    );
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The transcript of a thread's saved session that a new session takes over from instead of resuming: one neither this machine nor hex's store has, like after a restore from hex.db, or one whose prompt cache has expired when it holds more than a new session costs to start and catch up. A start with a prompt, like /compact, needs the old conversation itself, so it resumes.
  function expired(thread: string) {
    const session = threads.of(thread).session;

    if (!present(session) || fresh(thread)) {
      return;
    }

    const file = claude.transcript(threads.cwd(thread), session);

    if (!claude.saved(session)) {
      return file;
    }

    const { sent: context, at, short } = claude.usage(threads.cwd(thread), session);

    return context > handoffAbove && at !== undefined && clock.now() - at > claude.cacheLife(short)
      ? file
      : undefined;
  }

  return { start, launchArgs, stale };
}
