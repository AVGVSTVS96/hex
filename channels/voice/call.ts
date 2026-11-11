export type Speaker = "you" | "voice";

export type Fragment = { who: Speaker; text: string; start: number; end: number };

export type Turn = { who: Speaker; text: string; start: number };

export type Task = {
  id: string;
  state: "running" | "done" | "failed";
  text: string;
  to?: string;
  agent?: string;
};

export type Moment = Task & { at: number };

type AppColonThread = string;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// settled: open copies of the question an answer or settle reached; missed: copies or threads whose hub was down, left as they were.
export type Sent = { thread: AppColonThread; topic: string; settled: number; missed: number };

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// ask: a question put on the caller's screen by its id; answered carries what sending it did; undone: that answer taken back; photo and video: what the caller sent from the app, by media id; muted and unmuted: the caller muting the voice by saying so, as Jev heard it; stopped: hex's turn stopped because the caller called off a handoff, as Jev heard it; checked: what a say's answer rests on, in Claude's words.
export type Mark = {
  at: number;
  kind:
    | "say"
    | "note"
    | "paused"
    | "resumed"
    | "warned"
    | "ask"
    | "answered"
    | "undone"
    | "photo"
    | "video"
    | "muted"
    | "unmuted"
    | "stopped"
    | "reconnected";
  text: string;
  ask?: string;
  sent?: Sent;
  media?: string;
  checked?: string;
};

export type Saved = {
  turns: { who: Speaker; at: number; text: string }[];
  tasks: Moment[];
  moments?: Mark[];
};

const PAUSE = 2000;

export class Call {
  private fragments: (Fragment & { sent?: true })[] = [];
  private readonly tasks = new Map<string, Task>();
  private readonly moments: Moment[] = [];
  private readonly lines = new Map<string, string>();
  private recent: string[] = [];
  private marks: Mark[] = [];

  static resume({ turns, tasks, moments = [] }: Saved) {
    const call = new Call();
    call.fragments = turns.map(({ who, at, text }) => ({
      who,
      text,
      start: at,
      end: at,
      sent: true,
    }));

    for (const task of tasks) {
      call.track(task, task.at);
    }

    call.marks = [...moments];

    return call;
  }

  hear(fragment: Fragment) {
    const after = this.fragments.findLastIndex((earlier) => earlier.start <= fragment.start);

    this.fragments.splice(after + 1, 0, fragment);
  }

  handOff(): Turn[] {
    const due = this.fragments.filter((fragment) => !fragment.sent);

    for (const fragment of due) {
      fragment.sent = true;
    }

    return turnsJoinedAcrossBackchannels(due).map(({ who, text, start }) => ({ who, text, start }));
  }

  unsent(who: Speaker) {
    return this.fragments
      .filter((fragment) => !fragment.sent && fragment.who === who)
      .map(({ text }) => text)
      .join("");
  }

  track(task: Task, at = 0) {
    this.tasks.set(task.id, task);
    this.moments.push({ ...task, at });
    this.touch(task.id);
  }

  task(id: string) {
    return this.tasks.get(id);
  }

  see(id: string, line: string) {
    if (!this.tasks.has(id) || this.lines.get(id) === line) {
      return false;
    }

    this.lines.set(id, line);
    this.touch(id);

    return true;
  }

  activity() {
    return this.recent.flatMap((id) => {
      const task = this.tasks.get(id);

      return task ? [{ ...task, line: this.lines.get(id) }] : [];
    });
  }

  private touch(id: string) {
    this.recent = [id, ...this.recent.filter((other) => other !== id)];
  }

  mark(mark: Mark) {
    this.marks.push(mark);
  }

  board(): string {
    if (!this.tasks.size) {
      return "Task board: nothing running or finished yet.";
    }

    return ["Task board:", ...[...this.tasks.values()].map(entry)].join("\n");
  }

  change(id: string): string {
    const task = this.tasks.get(id);

    if (!task) {
      throw new Error(`no task ${id} on this call`);
    }

    return `Task update:\n${entry(task)}`;
  }

  record() {
    const turns = turnsJoinedAcrossBackchannels(this.fragments);

    return {
      turns: turns.map(({ who, start, text }) => ({ who, at: start, text })),
      tasks: [...this.moments],
      moments: [...this.marks],
    };
  }
}

function entry(task: Task) {
  return `- ${task.id} ${task.state}: ${task.text}${task.to !== undefined && task.to !== "" ? ` (sent to ${task.to})` : ""}`;
}

function turnsJoinedAcrossBackchannels(fragments: Fragment[]) {
  const turns: (Turn & { end: number })[] = [];

  for (const { who, text, start, end } of fragments) {
    const last = turns.findLast((turn) => turn.who === who);

    if (last && start - last.end <= PAUSE) {
      last.text += text;
      last.end = Math.max(last.end, end);
    } else {
      turns.push({ who, text, start, end });
    }
  }

  return tidy(turns.toSorted((a, b) => a.start - b.start));
}

function tidy<T extends Turn>(turns: T[]): T[] {
  return turns.flatMap((turn) => {
    const text = turn.text.trim();

    return text === "" ? [] : [{ ...turn, text }];
  });
}

export function transcript(turns: Turn[]): string {
  return turns
    .map(({ who, text, start }) => `[${(start / 1000).toFixed(1)}s] ${who}: ${text}`)
    .join("\n");
}
