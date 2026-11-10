import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import type { Mark, Moment, Speaker } from "./call.ts";
import { Changes } from "./changes.ts";

export type Source = "app" | "web" | "phone-in" | "phone-out" | "discord";

export type Ending = "you" | "hex" | "dropped" | "expired" | "no-connect" | "no-answer" | "busy";

export type CallRecord = {
  id: string;
  started: string;
  ended?: string;
  end?: Ending;
  reason?: string;
  from: Source;
  callee?: string;
  voice?: string;
  title?: string;
  claude?: string;
  why?: string;
  summary?: string;
  waiting?: string[];
  expires?: string;
  usage?: Usage;
  turns: { who: Speaker; at: number; text: string }[];
  tasks: Moment[];
  moments?: Mark[];
};

export type CallSummary = Omit<CallRecord, "turns" | "tasks" | "moments"> & {
  seconds: number;
  tasks: number;
  preview: string;
};

export type Usage = { seconds: number; dollars: number; context?: number };

const speaker = z.enum(["you", "voice"]);

const moment: z.ZodType<Moment> = z.object({
  id: z.string(),
  state: z.enum(["running", "done", "failed"]),
  text: z.string(),
  to: z.string().exactOptional(),
  agent: z.string().exactOptional(),
  at: z.number(),
});

const mark: z.ZodType<Mark> = z.object({
  at: z.number(),
  kind: z.enum([
    "say",
    "note",
    "paused",
    "resumed",
    "warned",
    "ask",
    "answered",
    "undone",
    "photo",
    "video",
  ]),
  text: z.string(),
  ask: z.string().exactOptional(),
  sent: z
    .object({ thread: z.string(), topic: z.string(), settled: z.number(), missed: z.number() })
    .exactOptional(),
  media: z.string().exactOptional(),
  checked: z.string().exactOptional(),
});

export const savedCall: z.ZodType<CallRecord> = z.object({
  id: z.string(),
  started: z.string(),
  ended: z.string().exactOptional(),
  end: z
    .enum(["you", "hex", "dropped", "expired", "no-connect", "no-answer", "busy"])
    .exactOptional(),
  reason: z.string().exactOptional(),
  from: z.enum(["app", "web", "phone-in", "phone-out", "discord"]),
  callee: z.string().exactOptional(),
  voice: z.string().exactOptional(),
  title: z.string().exactOptional(),
  claude: z.string().exactOptional(),
  why: z.string().exactOptional(),
  summary: z.string().exactOptional(),
  waiting: z.array(z.string()).exactOptional(),
  expires: z.string().exactOptional(),
  usage: z
    .object({ seconds: z.number(), dollars: z.number(), context: z.number().exactOptional() })
    .exactOptional(),
  turns: z.array(z.object({ who: speaker, at: z.number(), text: z.string() })),
  tasks: z.array(moment),
  moments: z.array(mark).exactOptional(),
});

export function usage(seconds: number, context?: number): Usage {
  const used: Usage = { seconds, dollars: Math.round((seconds * 5) / 60) / 100 };

  if (context !== undefined) {
    used.context = context;
  }

  return used;
}

const ID = /^[\w-]+$/u;

export function ending(reason: string, by?: string): Ending {
  if (by?.startsWith("close_hex") === true) {
    return "hex";
  }

  if (
    by?.startsWith("close-you") === true ||
    reason === "close_requested" ||
    reason === "remote_hangup"
  ) {
    return "you";
  }

  if (reason === "expired") {
    return "expired";
  }

  if (reason === "content") {
    return "hex";
  }

  return "dropped";
}

export class CallLog extends Changes {
  private readonly summaryUntilItsFileChanges = new Map<
    string,
    { stamp: string; summary: CallSummary }
  >();
  private readonly dir: string;

  constructor(dir: string) {
    super();
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  save(record: CallRecord) {
    const file = this.file(record.id);
    writeFileSync(`${file}.tmp`, JSON.stringify(record));
    renameSync(`${file}.tmp`, file);
    const saved = stamp(file);

    if (saved !== undefined) {
      this.summaryUntilItsFileChanges.set(record.id, { stamp: saved, summary: summary(record) });
    }

    this.changed();
  }

  get(id: string): CallRecord | undefined {
    if (!ID.test(id)) {
      return;
    }

    try {
      return savedCall.parse(JSON.parse(readFileSync(this.file(id), "utf-8")));
    } catch {
      return undefined;
    }
  }

  delete(id: string) {
    if (!this.get(id)) {
      return false;
    }

    rmSync(this.file(id));
    this.summaryUntilItsFileChanges.delete(id);
    this.changed();

    return true;
  }

  list(): CallSummary[] {
    return readdirSync(this.dir)
      .flatMap((name) => {
        const id = name.slice(0, -5);

        if (!name.endsWith(".json") || !ID.test(id)) {
          return [];
        }

        const now = stamp(this.file(id));
        const known = this.summaryUntilItsFileChanges.get(id);

        if (now !== undefined && known?.stamp === now) {
          return [known.summary];
        }

        const record = this.get(id);

        if (!record || now === undefined) {
          return [];
        }

        const listed = summary(record);
        this.summaryUntilItsFileChanges.set(id, { stamp: now, summary: listed });

        return [listed];
      })
      .toSorted((a, b) => b.started.localeCompare(a.started));
  }

  private file(id: string) {
    return join(this.dir, `${id}.json`);
  }
}

function stamp(file: string): string | undefined {
  try {
    const { mtimeMs, size } = statSync(file);

    return `${mtimeMs} ${size}`;
  } catch {
    return undefined;
  }
}

export function summary({ turns, tasks, moments: _moments, ...call }: CallRecord): CallSummary {
  const heard = Math.max(0, ...turns.map((turn) => turn.at), ...tasks.map((task) => task.at));

  const ms =
    call.ended !== undefined && call.ended !== ""
      ? Date.parse(call.ended) - Date.parse(call.started)
      : heard;

  return {
    ...call,
    seconds: Math.round(ms / 1000),
    tasks: new Set(tasks.map((task) => task.id)).size,
    preview: turns.find((turn) => turn.who === "you")?.text.slice(0, 160) ?? "",
  };
}
