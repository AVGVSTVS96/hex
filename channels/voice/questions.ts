import { readFileSync, renameSync, statSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { statusPost, open as store } from "@hex/hub";
import type { Question as Asked, MessageId, Pin, Thread } from "@hex/hub";
import { z } from "zod";

import { generalOf, isDm, projectOf } from "./activity.ts";
import type { Sent } from "./call.ts";
import { Changes } from "./changes.ts";
import { before, Check, final } from "./check.ts";
import { linkAt, Links } from "./links.ts";
import { caption, meta as mediaMeta } from "./media.ts";
import type { Item } from "./media.ts";
import { relay } from "./relay.ts";
import { T3 } from "./t3.ts";
import type { Fresh, Stuck } from "./t3.ts";

const KindSchema = z.enum(["pick", "yesno", "do", "look"]);

export type Kind = z.infer<typeof KindSchema>;

const MessageIdSchema = z.union([z.number(), z.string()]);

const OptionSchema = z.object({
  label: z.string(),
  value: z.string().exactOptional(),
  pick: z.boolean().exactOptional(),
  detail: z.string().exactOptional(),
});

type CuratedOption = z.infer<typeof OptionSchema>;

export type Option = CuratedOption & {
  shot?: number;
  // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- hex voice reads an option's screenshot width over height by this name
  shape?: number;
};

const LinkSchema = z.object({ label: z.string(), url: z.string() });

export type Link = z.infer<typeof LinkSchema>;

const RefSchema = z.object({ app: z.string(), thread: z.string(), message: MessageIdSchema });

export type Ref = z.infer<typeof RefSchema>;

const SourceSchema = z.object({
  app: z.string(),
  thread: z.string().exactOptional(),
  message: MessageIdSchema.exactOptional(),
  call: z.string().exactOptional(),
});

export type Source = z.infer<typeof SourceSchema>;

export type Answer = {
  label: string;
  at: string;
  via: string;
  question?: string;
  told?: string[];
  refs?: Ref[];
  missed?: Ref[];
  finishing?: boolean;
  undoing?: boolean;
  dismissed?: boolean;
  before?: Answer;
};

const AnswerSchema: z.ZodType<Answer> = z.object({
  label: z.string(),
  at: z.string(),
  via: z.string(),
  question: z.string().exactOptional(),
  told: z.array(z.string()).exactOptional(),
  refs: z.array(RefSchema).exactOptional(),
  missed: z.array(RefSchema).exactOptional(),
  finishing: z.boolean().exactOptional(),
  undoing: z.boolean().exactOptional(),
  dismissed: z.boolean().exactOptional(),
  get before() {
    return AnswerSchema.exactOptional();
  },
});

type Taken = Answer & Required<Pick<Answer, "question" | "told" | "refs" | "missed">>;

export type Place = { app: string; place: string; task?: string; call?: string; link?: string };

const CuratedSchema = z.object({
  id: z.string(),
  kind: KindSchema,
  task: z.string(),
  at: z.string(),
  question: z.string(),
  context: z.string().exactOptional(),
  why: z.string().exactOptional(),
  options: z.array(OptionSchema),
  links: z.array(LinkSchema).exactOptional(),
  tag: z.string().exactOptional(),
  was: z.array(z.string()).exactOptional(),
  partly: z.string().exactOptional(),
  undoing: z.literal(true).exactOptional(),
  from: z.array(SourceSchema).exactOptional(),
  refs: z.array(RefSchema).exactOptional(),
});

export type Curated = z.infer<typeof CuratedSchema>;

export type Question = Omit<Curated, "from" | "refs" | "options"> & {
  options: Option[];
  app: string;
  topic: string;
  places: Place[];
};

export type Words = { place: string; at?: string; text: string };

const NoteSchema = z.object({
  title: z.string(),
  text: z.string(),
  did: z.string().exactOptional(),
});

export type Note = z.infer<typeof NoteSchema>;

const Waiting = z.object({
  id: z.string(),
  title: z.string(),
  why: z.string(),
  action: z.string(),
  mark: z.enum(["paused", "failed"]),
  at: z.string(),
  request: z.string().exactOptional(),
}) satisfies z.ZodType<Omit<Stuck, "app">>;

const CheckFile = z.object({
  at: z.string(),
  why: z.string(),
  read: z.record(z.string(), z.number()),
  asks: z.array(CuratedSchema),
  fixed: z.array(NoteSchema),
  flagged: z.array(NoteSchema),
  stuck: z.array(Waiting),
  inputs: z.string().exactOptional(),
});

export type CheckResult = z.infer<typeof CheckFile>;

export type View = {
  version: number;
  asks: Question[];
  stuck: (Stuck & { sent?: string })[];
  fresh: (Fresh & { read: boolean })[];
  check: { at: string; why: string; fixed: number; flagged: number } | null;
};

const ReopenedSchema = z.object({
  refs: z.array(RefSchema),
  question: z.string().exactOptional(),
  at: z.string(),
});

const MarksFile = z.object({
  answers: z.record(z.string(), AnswerSchema).exactOptional(),
  sent: z.record(z.string(), z.string()).exactOptional(),
  dismissed: z.record(z.string(), z.string()).exactOptional(),
  read: z.record(z.string(), z.string()).exactOptional(),
  reopened: z.record(z.string(), ReopenedSchema).exactOptional(),
});

type Marks = Required<z.infer<typeof MarksFile>>;

const CallRecord = z.object({
  title: z.string().exactOptional(),
  summary: z.string().exactOptional(),
  started: z.string().exactOptional(),
  ended: z.string().exactOptional(),
});

type HubStep =
  | { type: "settle"; thread: string; message: MessageId; note: string }
  | { type: "answer"; thread: string; message: MessageId; label: string; via: string };

const KEEP_MARKS_MS = 14 * 24 * 60 * 60_000;
const CALLS = join(homedir(), ".claude", "channels", "voice", "calls");

const WHERE = new Map([
  ["app", "in the app"],
  ["call", "on a call"],
]);

const NOT_NEEDED = "Not needed";

const PICK = /\s*[([]?\s*(?:←\s*)?(?:(?:my|hex[’']s) pick)\s*[)\]]?/iu;

type CallPlace = { stamp: string; title: string | undefined; started: string | undefined };

export class Questions extends Changes {
  view: Omit<View, "version"> = { asks: [], stuck: [], fresh: [], check: null };
  counts = new Changes();
  private ledgers = new Map<string, Asked[]>();
  private readonly threads = new Map<string, Thread>();
  private readonly pins = new Map<string, Pin>();
  private readonly links: Links;
  private readonly calls: string;
  private result: CheckResult | undefined;
  private checkStamp: string | undefined;
  private readonly marks: Marks;
  private readonly taking = new Set<string>();
  private pending?: ReturnType<typeof setTimeout>;
  private readonly stops: (() => void)[] = [];
  private readonly t3: T3;
  private readonly check: (why: string) => void;
  private seen?: { pins: string; t3: string };
  private callPlaces = new Map<string, CallPlace>();
  private readonly shots = new Map<string, string[]>();
  private lastCallPlaces = new Map<string, CallPlace>();
  private readonly state: string;

  constructor(
    state: string,
    {
      t3Database,
      t3Home,
      calls = CALLS,
      check = (why) => {
        new Check(state).start(why);
      },
    }: { t3Database?: string; t3Home?: string; calls?: string; check?: (why: string) => void } = {},
  ) {
    super();
    this.state = state;
    this.check = check;
    this.calls = calls;
    this.links = new Links(
      state,
      () => {
        this.schedule();
      },
      t3Home,
    );
    this.marks = readMarks(join(state, "voice", "marks.json"));
    this.t3 = new T3(() => {
      this.schedule();
    }, t3Database);
    this.stops.push(
      store(state).watch(() => {
        this.schedule();
      }),
      watchDir(join(state, "voice"), (file) => {
        if (file === "check.json") {
          this.schedule();
        }
      }),
    );
    this.build();
  }

  get lastCheck() {
    return this.result;
  }

  opened() {
    const checked = this.result?.at ?? "";

    if (
      [...this.ledgers.values()].some((questions) =>
        questions.some(
          (question) => !question.answer && !question.settled && question.at > checked,
        ),
      )
    ) {
      this.check("you opened Tasks");
    }
  }

  called() {
    this.check("a call ended");
  }

  close() {
    clearTimeout(this.pending);
    this.t3.close();
    this.links.close();

    for (const stop of this.stops) {
      stop();
    }
  }

  shot(id: string, n: number): string | undefined {
    const asked = this.find(id);

    return asked && this.shots.get(asked.id)?.[n];
  }

  find(id: string) {
    const listed = (key: string) => this.view.asks.find((question) => question.id === key);

    return listed(id) ?? listed(this.renamed(id) ?? id);
  }

  private renamed(id: string): string | undefined {
    if (this.view.asks.some((question) => question.id === id)) {
      return;
    }

    const copies = new Set([id, ...(this.marks.reopened[id]?.refs ?? []).map(refId)]);

    return this.result?.asks.find(
      (question) => question.refs?.some((ref) => copies.has(refId(ref))) === true,
    )?.id;
  }

  private listed(id: string) {
    return this.marks.answers[id] === undefined ? (this.renamed(id) ?? id) : id;
  }

  of(id: string) {
    const pin = this.pins.get(id);
    const thread = id.slice(id.indexOf(":") + 1);
    const text = pin && statusPost(store(this.state), thread, pin.note, Infinity);

    return {
      asks: this.view.asks.filter((question) => question.task === id),
      ...(filled(text) && { pin: text }),
    };
  }

  words(id: string): Words | undefined {
    const curated = this.result?.asks.find((question) => question.id === id);
    const raw = curated ? undefined : this.refs(id)[0];

    const sources: Source[] | undefined = curated
      ? (curated.from ?? curated.refs ?? [])
      : raw && [raw];

    const listed = this.find(id);

    if (listed === undefined || sources === undefined) {
      return;
    }

    for (const source of sources) {
      const words = filled(source.call)
        ? this.callWords(source.call)
        : filled(source.thread) && source.message !== undefined
          ? this.threadWords(source.app, source.thread, source.message, curated !== undefined)
          : undefined;

      if (words) {
        return words;
      }
    }
  }

  private threadWords(
    app: string,
    thread: string,
    message: MessageId,
    own: boolean,
  ): Words | undefined {
    const db = store(this.state);
    const asked = this.asked({ app, thread, message });
    const pin = this.pins.get(`${app}:${thread}`);
    const pinned = !asked && pin && String(pin.message) === String(message) ? pin : undefined;
    // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Store#find(thread, message) is not Array#find
    const row = asked || pinned ? undefined : db.messages.find(thread, message);

    const said =
      asked ?? (row && { app, thread, message, text: row.body, at: row.at, options: [] });

    const text = said
      ? [...before(db, app, said, Infinity), ...(own ? [said.text] : [])].join("\n\n")
      : pinned
        ? waiting(pinned.note)
        : "";

    const at = (said ?? pinned)?.at;

    if (at === undefined || text.trim() === "") {
      return;
    }

    return { place: this.thread(app, thread, message).place, at, text };
  }

  private callWords(id: string): Words | undefined {
    const call = readJson(join(this.calls, `${id}.json`), CallRecord);
    const at = call?.ended ?? call?.started;

    if (call !== undefined && filled(call.summary)) {
      return { place: call.title ?? "a call", ...(filled(at) && { at }), text: call.summary };
    }
  }

  answer(id: string, label: string, via: string, media: Item[] = []): Promise<Sent> {
    return this.take(this.listed(id), label, via, false, media);
  }

  private async answering(
    id: string,
    label: string,
    via: string,
    question: Question,
    taken: Taken,
    where: string,
    finishing: boolean,
    media: Item[],
  ) {
    const value = question.options.find((option) => option.label === label)?.value ?? label;
    const refs = this.left(id, taken);
    const missed = new Set(chain(taken.before).flatMap((mark) => (mark.missed ?? []).map(refId)));
    const first = refs.find((ref) => !missed.has(refId(ref)));

    const settle = (ref: Ref) =>
      this.reach(taken, ref, {
        type: "settle",
        thread: ref.thread,
        message: ref.message,
        note: `✓ Answered ${where}: ${label}`,
      });

    if (finishing) {
      return await tryEach(refs, settle);
    }

    await (first && media.length === 0 && this.asked(first)?.options.includes(value) === true
      ? this.reach(taken, first, {
          type: "answer",
          thread: first.thread,
          message: first.message,
          label: value,
          via,
        })
      : this.inform(
          taken,
          first ? place(first) : question.task,
          `(answered ${where}) ${question.question}: ${label}`,
          via,
          media,
        ));

    return await tryEach(
      refs.filter((ref) => !taken.refs.includes(ref)),
      settle,
    );
  }

  async note(id: string, text: string, via: string, media: Item[] = []): Promise<Sent> {
    const key = this.listed(id);
    const question = this.find(key);

    if (!question) {
      throw new Error("that question is already answered or settled");
    }

    if (this.taking.has(key)) {
      throw new Error("an answer to that is on its way; try again in a moment");
    }

    const [asked] = this.left(key, undefined);
    const thread = asked ? place(asked) : question.task;

    await this.tell(
      thread,
      `(note written ${WHERE.get(via) ?? via}) ${question.question}: ${text}`,
      via,
      "owner",
      media,
    );

    return { ...this.sent(thread, 0), missed: 0 };
  }

  dismiss(id: string, via: string): Promise<Sent> {
    return this.take(this.listed(id), NOT_NEEDED, via, true);
  }

  private async dismissing(
    id: string,
    via: string,
    question: Question,
    taken: Taken,
    where: string,
    finishing: boolean,
  ) {
    const told = new Set(finishing ? round(taken.before).flatMap((mark) => mark.told ?? []) : []);

    const say = async (thread: string) => {
      if (told.has(thread)) {
        return;
      }

      await this.inform(
        taken,
        thread,
        `(not needed from me, said ${where}: decide or do it yourself) ${question.question}`,
        via,
      );
      told.add(thread);
    };

    await say(question.task);
    const failed: unknown[] = [];

    for (const [thread, copies] of Map.groupBy(this.left(id, taken), place)) {
      try {
        await say(thread);
      } catch (error) {
        failed.push(error, ...copies.map(() => error));
        taken.missed.push(...copies);
        continue;
      }

      failed.push(
        ...(await tryEach(copies, (ref) =>
          this.reach(taken, ref, {
            type: "settle",
            thread: ref.thread,
            message: ref.message,
            note: `✓ ${NOT_NEEDED}, said ${where}`,
          }),
        )),
      );
    }

    return failed;
  }

  async undo(asked: string, via: string) {
    const renamed = this.renamed(asked);

    const id =
      this.marks.answers[asked] === undefined &&
      filled(renamed) &&
      this.marks.answers[renamed] !== undefined
        ? renamed
        : asked;

    if (this.taking.has(id)) {
      throw new Error("that answer is still on its way; try again in a moment");
    }

    this.taking.add(id);

    try {
      const taken = this.marks.answers[id];
      const marks = chain(taken);
      const closed = this.refs(id).filter((ref) => !this.open(ref));

      const refs = [
        ...new Map(
          [...marks.flatMap((mark) => mark.refs ?? []), ...closed].map((ref) => [refId(ref), ref]),
        ).values(),
      ].filter((ref) => this.ours(ref));

      if (!taken && !refs.length) {
        throw new Error("there is no answer here to take back");
      }

      const curated = this.result?.asks.find((question) => question.id === id);
      const failed: unknown[] = [];
      const stuck: Ref[] = [];
      const reopened: Ref[] = [];
      let did = false;

      for (const ref of refs) {
        try {
          await relay(this.state, ref.app, {
            type: "reopen",
            thread: ref.thread,
            message: ref.message,
            via,
          });
        } catch (error) {
          failed.push(error);
          stuck.push(ref);
          continue;
        }

        did = true;
        reopened.push(ref);

        for (const mark of marks) {
          if (mark.refs) {
            mark.refs = mark.refs.filter((done) => refId(done) !== refId(ref));
          }
        }
      }

      if (!curated && reopened.some((ref) => refId(ref) !== id)) {
        const kept = this.marks.reopened[id];
        const question = taken?.question ?? kept?.question;

        const eachCopyOnce = [
          ...new Map([...(kept?.refs ?? []), ...reopened].map((ref) => [refId(ref), ref])).values(),
        ];

        this.marks.reopened[id] = {
          refs: eachCopyOnce,
          ...(question !== undefined && { question }),
          at: now(),
        };
      }

      const said = new Set<string>();

      for (const mark of marks) {
        if (curated) {
          mark.question ??= curated.question;
        }

        const notTold: string[] = [];

        for (const thread of mark.told ?? (curated ? [curated.task] : [])) {
          const line = isDismissal(mark)
            ? `(took back: this needs me after all) ${mark.question}`
            : `(took back) ${mark.question}: ${mark.label}`;

          if (!said.has(`${thread} ${line}`)) {
            try {
              await this.tell(thread, line, via);
            } catch (error) {
              failed.push(error);
              notTold.push(thread);
              continue;
            }
          }

          did = true;
          said.add(`${thread} ${line}`);
        }

        mark.told = notTold;
      }

      if (failed.length) {
        Object.assign(
          (this.marks.answers[id] = taken ?? { label: "", at: now(), via, refs: stuck, told: [] }),
          { undoing: true, at: now() },
        );
      } else {
        this.marks.answers = Object.fromEntries(
          Object.entries(this.marks.answers).filter(([key]) => key !== id),
        );
      }

      this.saveMarks();

      if (failed.length) {
        throw new Error(
          `part of it couldn't be taken back; undo again to finish (${failed[0] instanceof Error ? failed[0].message : String(failed[0])})`,
        );
      }

      if (!did) {
        throw new Error(
          "nothing was left to take back: its copies were answered or closed in their own apps since",
        );
      }

      if (!refs.length) {
        this.check("you took back an answer");
      }
    } finally {
      this.taking.delete(id);
    }
  }

  answered(id: string) {
    const key = this.listed(id);

    return this.taking.has(key) || this.marks.answers[key] !== undefined;
  }

  async act(id: string) {
    const item = this.view.stuck.find((each) => each.id === id);

    if (!item) {
      throw new Error("that is no longer stuck");
    }

    if (filled(item.request)) {
      if (this.taking.has(id)) {
        throw new Error("that request is on its way");
      }

      this.taking.add(id);

      try {
        await this.tell(this.general(), item.request, "app", "prompt");
      } finally {
        this.taking.delete(id);
      }

      this.marks.sent[id] = now();
    } else {
      this.marks.dismissed[id] = now();
    }

    this.saveMarks();
  }

  read(id: string) {
    this.marks.read[id] = now();
    this.saveMarks();
  }

  private refs(id: string): Ref[] {
    const curated = this.result?.asks.find((question) => question.id === id);

    if (curated) {
      return curated.refs ?? [];
    }

    const reopened = this.marks.reopened[id];

    if (reopened) {
      return reopened.refs;
    }

    for (const [app, questions] of this.ledgers) {
      const asked = questions.find((question) => refId(question) === id);

      if (asked) {
        return [{ app, thread: asked.thread, message: asked.message }];
      }
    }

    return [];
  }

  private async take(
    id: string,
    label: string,
    via: string,
    dismissed: boolean,
    media: Item[] = [],
  ): Promise<Sent> {
    if (this.taking.has(id)) {
      throw new Error("an answer to that is on its way; try again in a moment");
    }

    this.taking.add(id);

    try {
      const question = this.find(id);
      const kept = this.marks.answers[id];
      const standing = this.standing(id);

      if (!question || standing === "stale") {
        throw new Error("that question is already answered or settled");
      }

      if (standing === "undoing") {
        throw new Error("taking back the last answer to this stopped partway; undo it again first");
      }

      const finishing = standing === "finishing" && kept !== undefined;

      if (finishing && kept.label !== label) {
        throw new Error(`part of "${kept.label}" went out; send it again to finish, or undo it`);
      }

      const notNeeded = finishing ? isDismissal(kept) : dismissed;

      const taken: Taken = {
        label,
        at: now(),
        via,
        question: question.question,
        told: [],
        refs: [],
        missed: [],
        dismissed: notNeeded,
        ...(finishing && { finishing }),
        ...(kept && { before: kept }),
      };

      const where = WHERE.get(via) ?? via;

      const failed = await (notNeeded
        ? this.dismissing(id, via, question, taken, where, finishing)
        : this.answering(id, label, via, question, taken, where, finishing, media));

      if (taken.told.length === 0 && taken.refs.length === 0) {
        const [error] = failed;

        throw error instanceof Error
          ? error
          : new Error("that question is already answered or settled");
      }

      this.marks.answers[id] = taken;
      this.saveMarks();
      const first = (finishing ? round(kept).at(-1) : undefined) ?? taken;
      const firstRef = (first.refs ?? taken.refs)[0];
      const thread = first.told?.[0] ?? (firstRef ? place(firstRef) : question.task);

      return { ...this.sent(thread, taken.refs.length), missed: failed.length };
    } finally {
      this.taking.delete(id);
    }
  }

  private left(id: string, answer: Answer | undefined) {
    const reached = new Set(chain(answer).flatMap((mark) => (mark.refs ?? []).map(refId)));

    return this.refs(id).filter((ref) => this.open(ref) && !reached.has(refId(ref)));
  }

  private async reach(taken: Taken, ref: Ref, message: HubStep) {
    try {
      await relay(this.state, ref.app, message);
    } catch (error) {
      taken.missed.push(ref);
      throw error;
    }

    taken.refs.push(ref);
  }

  private async inform(
    taken: Taken,
    thread: string,
    content: string,
    via: string,
    media: Item[] = [],
  ) {
    await this.tell(thread, content, via, "owner", media);
    taken.told.push(thread);
  }

  private standing(id: string): "stale" | "undoing" | "finishing" | "free" {
    const kept = this.marks.answers[id];

    if (!kept) {
      return "free";
    }

    if (kept.undoing === true) {
      return "undoing";
    }

    const marks = chain(kept);

    const listHasNotCaughtUp = marks.some(
      (mark) => mark.refs?.some((ref) => this.open(ref)) === true,
    );

    if (this.refs(id).length === 0 || listHasNotCaughtUp) {
      return "stale";
    }

    const missed = new Set(marks.flatMap((mark) => (mark.missed ?? []).map(refId)));
    const left = this.left(id, kept);
    const onlyMissedLeft = left.length > 0 && left.every((ref) => missed.has(refId(ref)));

    return onlyMissedLeft ? "finishing" : "free";
  }

  private ours(ref: Ref) {
    const asked = this.asked(ref);

    if (!asked) {
      return false;
    }

    if (asked.answer) {
      return WHERE.has(asked.answer.via);
    }

    return !asked.settled || /^✓ (Answered|Not needed)/u.test(asked.settled.note);
  }

  private sent(thread: string, settled: number) {
    return { thread, topic: this.topic(thread), settled };
  }

  private asked(ref: Ref) {
    return this.ledgers
      .get(ref.app)
      ?.find(
        (question) =>
          question.thread === ref.thread && String(question.message) === String(ref.message),
      );
  }

  private open(ref: Ref) {
    const asked = this.asked(ref);

    return !!asked && !asked.answer && !asked.settled;
  }

  private tell(
    id: string,
    content: string,
    via: string,
    author: "owner" | "prompt" = "owner",
    media: Item[] = [],
  ) {
    const [app = "", ...thread] = id.split(":");

    return relay(this.state, app, {
      type: "inbound",
      thread: thread.join(":"),
      content: caption(content, media),
      author,
      meta: { user: `hex ${via}`, ...mediaMeta(media) },
    });
  }

  private general() {
    const general = generalOf(this.threads.values());

    if (!general) {
      throw new Error("hex has no Telegram General to send this to");
    }

    return `${general.app}:${general.thread}`;
  }

  private topic(task: string) {
    const thread = this.threads.get(task);

    return thread
      ? projectOf(thread, generalOf(this.threads.values()))
      : task.slice(task.lastIndexOf(":") + 1);
  }

  private schedule() {
    clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      this.build();
    }, 30);
  }

  private build() {
    this.shots.clear();
    this.threads.clear();
    this.pins.clear();
    const questions = store(this.state).questions.list({ asker: "hex" });

    for (const thread of store(this.state).threads.list()) {
      this.threads.set(`${thread.app}:${thread.thread}`, thread);
    }

    this.ledgers = Map.groupBy(
      questions.filter((question) => question.app !== "voice"),
      (question) => question.app,
    );

    for (const pin of store(this.state).pins.list()) {
      if (pin.text !== "") {
        this.pins.set(`${pin.app}:${pin.thread}`, pin);
      }
    }

    const check = join(this.state, "voice", "check.json");
    const stamp = stampOf(check);

    if (stamp !== this.checkStamp) {
      this.result = readJson(check, CheckFile);
      this.checkStamp = this.result !== undefined || stamp === "" ? stamp : undefined;
    }

    [this.lastCallPlaces, this.callPlaces] = [this.callPlaces, new Map<string, CallPlace>()];
    this.notice();
    const used = new Set<string>();

    const curated = (this.result?.asks ?? []).flatMap((question) => {
      for (const ref of question.refs ?? []) {
        used.add(refId(ref));
      }

      const live =
        question.refs !== undefined && question.refs.length > 0
          ? question.refs.some((ref) => this.open(ref))
          : this.marks.answers[question.id] === undefined;

      return live ? [this.dress(question)] : [];
    });

    const reopened = Object.entries(this.marks.reopened).flatMap(([id, { refs, question }]) => {
      const first = refs.find((ref) => this.open(ref));
      const asked = first && this.asked(first);

      if (first === undefined || asked === undefined || refs.some((ref) => used.has(refId(ref)))) {
        return [];
      }

      for (const ref of refs) {
        used.add(refId(ref));
      }

      return [
        this.dress({
          ...fromLedger(first.app, asked),
          id,
          refs,
          from: refs,
          ...(filled(question) && { question }),
        }),
      ];
    });

    const raw = [...this.ledgers].flatMap(([app, ledger]) =>
      ledger
        .filter((question) => !question.answer && !question.settled && !used.has(refId(question)))
        .map((question) => this.dress(fromLedger(app, question))),
    );

    raw.sort((a, b) => b.at.localeCompare(a.at));
    const checked = this.result?.at ?? "";

    const stuck = [
      ...this.t3.stuck,
      ...(this.result?.stuck ?? []).map((item) => ({ ...item, app: "hex" })),
    ].flatMap((item) => {
      const sent = this.marks.sent[item.id];

      return filled(this.marks.dismissed[item.id])
        ? []
        : [{ ...item, ...(filled(sent) && { sent }) }];
    });

    const view: Omit<View, "version"> = {
      asks: [
        ...raw.filter((question) => question.at > checked),
        ...curated,
        ...reopened,
        ...raw.filter((question) => question.at <= checked),
      ],
      stuck,
      fresh: this.t3.fresh.map((item) => ({ ...item, read: filled(this.marks.read[item.id]) })),
      check: this.result
        ? {
            at: this.result.at,
            why: this.result.why,
            fixed: this.result.fixed.length,
            flagged: this.result.flagged.length,
          }
        : null,
    };

    if (JSON.stringify(view) === JSON.stringify(this.view)) {
      return;
    }

    const moved =
      view.asks.length !== this.view.asks.length || view.stuck.length !== this.view.stuck.length;

    this.view = view;
    this.changed();

    if (moved) {
      this.counts.changed();
    }
  }

  private notice() {
    const current = {
      pins: JSON.stringify([...this.pins].map(([id, pin]) => [id, pin.note])),
      t3: JSON.stringify(
        [this.t3.stuck, this.t3.fresh].map((items) => items.map((item) => item.id)),
      ),
    };

    const why =
      this.seen === undefined
        ? undefined
        : current.pins === this.seen.pins
          ? current.t3 === this.seen.t3
            ? undefined
            : "a T3 run ended"
          : "a pinned post changed";

    this.seen = current;

    if (why) {
      this.check(why);
    }
  }

  private half(id: string): Pick<Question, "partly" | "undoing"> {
    const standing = this.standing(id);
    const kept = this.marks.answers[id];

    return standing === "undoing"
      ? { undoing: true }
      : standing === "finishing" && kept
        ? { partly: kept.label }
        : {};
  }

  private dress({ refs, from, options, ...question }: Curated): Question {
    const [app = "", ...thread] = question.task.split(":");
    const was = (refs ?? []).map(refId).filter((id) => id !== question.id);

    const shown = refs?.map((ref) => this.asked(ref)).find((asked) => asked?.shots !== undefined);

    if (shown?.shots !== undefined) {
      this.shots.set(question.id, shown.shots);
    }

    return {
      ...question,
      app,
      topic: this.topic(question.task),
      options: options.map((option) => withItsShot(option, shown)),
      places: this.places(from ?? [...(refs ?? []), { app, thread: thread.join(":") }]),
      ...(was.length > 0 && { was }),
      ...this.half(question.id),
    };
  }

  private places(from: Source[]): Place[] {
    const best = new Map<string, Source>();

    for (const source of from) {
      if (!filled(source.call) && !filled(source.thread)) {
        continue;
      }

      const key = filled(source.call) ? `call:${source.call}` : `${source.app}:${source.thread}`;
      const held = best.get(key);

      if (!held || this.rank(source) < this.rank(held)) {
        best.set(key, source);
      }
    }

    return [...best.values()]
      .map((source) =>
        filled(source.call)
          ? this.call(source.call)
          : this.thread(source.app, source.thread ?? "", source.message),
      )
      .toSorted(
        (a, b) =>
          Number(filled(b.link)) - Number(filled(a.link)) || (b.at ?? "").localeCompare(a.at ?? ""),
      )
      .map(({ at: _at, ...where }) => where);
  }

  private rank({ app, thread = "", message, call }: Source) {
    if (filled(call) || message === undefined) {
      return 3;
    }

    if (this.open({ app, thread, message })) {
      return 0;
    }

    return String(this.pins.get(`${app}:${thread}`)?.message) === String(message) ? 1 : 2;
  }

  private thread(
    app: string,
    thread: string,
    message?: MessageId,
  ): Place & { at?: string | undefined } {
    const key = `${app}:${thread}`;
    const general = generalOf(this.threads.values());

    const name =
      general && `${general.app}:${general.thread}` === key
        ? "General"
        : isDm({ app, thread })
          ? "DM"
          : (this.links.title(app, thread) ?? this.threads.get(key)?.name ?? thread);

    const link = linkAt(app, this.threads.get(key)?.link, message);
    const pin = this.pins.get(key);

    const at =
      message === undefined
        ? undefined
        : pin && String(pin.message) === String(message)
          ? pin.at
          : this.asked({ app, thread, message })?.at;

    return { app, place: name, task: key, ...(filled(link) && { link }), at };
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  /* A call's record holds its whole transcript, megabytes for a long one, so its title and start
     are read again only once the file changes. */
  private call(id: string): Place & { at?: string | undefined } {
    const file = join(this.calls, `${id}.json`);
    const stamp = stampOf(file);
    const kept = this.callPlaces.get(id) ?? this.lastCallPlaces.get(id);
    let known = kept?.stamp === stamp ? kept : undefined;

    if (!known) {
      const call = readJson(file, CallRecord);
      known = { stamp: call ? stamp : "", title: call?.title, started: call?.started };
    }

    this.callPlaces.set(id, known);

    return { app: "voice", place: known.title ?? "a call", call: id, at: known.started };
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  /* Marks are kept 14 days, but a final answer for good: an ask a pinned post still mentions would
     come back without one. */
  private saveMarks() {
    const since = new Date(Date.now() - KEEP_MARKS_MS).toISOString();

    const recent = (book: Record<string, string>) =>
      Object.fromEntries(Object.entries(book).filter(([, at]) => at >= since));

    const marks = this.marks;
    marks.sent = recent(marks.sent);
    marks.dismissed = recent(marks.dismissed);
    marks.read = recent(marks.read);

    marks.answers = Object.fromEntries(
      Object.entries(marks.answers).filter(([, answer]) => answer.at >= since || final(answer)),
    );

    marks.reopened = Object.fromEntries(
      Object.entries(marks.reopened).filter(([, kept]) => kept.at >= since),
    );

    const file = join(this.state, "voice", "marks.json");
    writeFileSync(`${file}.tmp`, `${JSON.stringify(this.marks, null, 1)}\n`);
    renameSync(`${file}.tmp`, file);
    this.schedule();
  }
}

export function fromLedger(app: string, asked: Asked): Curated {
  const lines = plain(asked.text)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const options = asked.options.map((value) => {
    const unmarked = value.replace(PICK, "").trim();
    const label = unmarked === "" ? value : unmarked;

    return { label, value, ...(label !== value && { pick: true }) };
  });

  const [question, rest] = cut(lines[0] ?? "", 160);
  const context = [...(rest ? [rest] : []), ...lines.slice(1)].join("\n");

  return {
    id: refId({ app, thread: asked.thread, message: asked.message }),
    kind: asked.options.length <= 2 ? "yesno" : "pick",
    task: `${app}:${asked.thread}`,
    at: asked.at,
    question: question.replace(/:$/u, ""),
    ...(context !== "" && { context }),
    options,
    refs: [{ app, thread: asked.thread, message: asked.message }],
    from: [{ app, thread: asked.thread, message: asked.message }],
  };
}

function waiting(note: string) {
  const parts = note.trim().split(/\n\s*\n/u);
  const onTheOwner = parts.filter((part) => /\bon you\b/iu.test(part));
  const whatTheProjectIs = parts.slice(0, 1);

  return (onTheOwner.length > 0 ? onTheOwner : whatTheProjectIs).join("\n\n");
}

function withItsShot(option: CuratedOption, shown: Asked | undefined): Option {
  const shot =
    shown?.shots === undefined || option.value === undefined
      ? -1
      : shown.options.indexOf(option.value);

  const widthOverHeight = widthOverHeightOf(shown?.shots?.[shot]);

  return widthOverHeight !== undefined && widthOverHeight > 0
    ? // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- hex voice reads an option's screenshot width over height by this name
      { ...option, shot, shape: widthOverHeight }
    : option;
}

const widthOverHeightOfEachFileVersion = new Map<string, number | undefined>();

function widthOverHeightOf(file: string | undefined) {
  if (file === undefined) {
    return;
  }

  const version = `${file}@${statSync(file, { throwIfNoEntry: false })?.mtimeMs}`;

  if (!widthOverHeightOfEachFileVersion.has(version)) {
    widthOverHeightOfEachFileVersion.set(version, readWidthOverHeight(file));
  }

  return widthOverHeightOfEachFileVersion.get(version);
}

const PNG_SIGNATURE = 0x89_50_4e_47;

function readWidthOverHeight(file: string) {
  let bytes: Buffer;

  try {
    bytes = readFileSync(file);
  } catch {
    return;
  }

  if (bytes.readUInt32BE(0) === PNG_SIGNATURE) {
    return bytes.readUInt32BE(16) / bytes.readUInt32BE(20);
  }

  for (
    let at = 2;
    bytes[at] === 0xff && at + 9 < bytes.length;
    at += 2 + bytes.readUInt16BE(at + 2)
  ) {
    const marker = bytes[at + 1] ?? 0;

    if (marker >= 0xc0 && marker <= 0xc3) {
      return bytes.readUInt16BE(at + 7) / bytes.readUInt16BE(at + 5);
    }
  }
}

function refId({ app, thread, message }: Ref) {
  return `${app}:${thread}:${message}`;
}

function chain(answer: Answer | undefined) {
  const marks: Answer[] = [];

  for (let mark = answer; mark; mark = mark.before) {
    marks.push(mark);
  }

  return marks;
}

function isDismissal(mark: Answer) {
  return mark.dismissed ?? mark.label === NOT_NEEDED;
}

function round(answer: Answer | undefined) {
  const marks = chain(answer);
  const start = marks.findIndex((mark) => mark.finishing !== true);

  return marks.slice(0, start + 1);
}

function place({ app, thread }: Ref) {
  return `${app}:${thread}`;
}

function plain(text: string) {
  return text
    .replaceAll(/```[\s\S]*?(```|$)/gu, "")
    .replaceAll(/\*\*|__|`/gu, "")
    .replaceAll(/^#+\s+/gmu, "");
}

function cut(line: string, max: number): [string, string] {
  if (line.length <= max) {
    return [line, ""];
  }

  let depth = 0;
  let end = line.length;

  for (let i = 0; i < line.length; i++) {
    const char = line.charAt(i);

    if ("([{（".includes(char)) {
      depth++;
    } else if (")]}）".includes(char)) {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && "?？".includes(char)) {
      end = i + 1;
    }
  }

  return [line.slice(0, end), line.slice(end).trim()];
}

export function clip(text: string, max: number) {
  return text.length > max
    ? `${text
        .slice(0, max - 1)
        .replace(/[\uD800-\uDBFF]$/u, "")
        .trimEnd()}…`
    : text;
}

function readMarks(file: string): Marks {
  const marks = readJson(file, MarksFile) ?? {};

  return {
    answers: marks.answers ?? {},
    sent: marks.sent ?? {},
    dismissed: marks.dismissed ?? {},
    read: marks.read ?? {},
    reopened: marks.reopened ?? {},
  };
}

function stampOf(path: string) {
  try {
    const { mtimeMs, size } = statSync(path);

    return `${mtimeMs}:${size}`;
  } catch {
    return "";
  }
}

function readJson<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
): z.infer<Schema> | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(path, "utf-8")));

    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function watchDir(dir: string, changed: (file: string | null) => void) {
  try {
    const watcher = watch(dir, (_, file) => {
      changed(file);
    });

    return () => {
      watcher.close();
    };
  } catch {
    return () => null;
  }
}

async function tryEach<T>(steps: T[], step: (each: T) => Promise<void>) {
  const failed: unknown[] = [];

  for (const each of steps) {
    try {
      await step(each);
    } catch (error) {
      failed.push(error);
    }
  }

  return failed;
}

function filled(text: string | undefined): text is string {
  return text !== undefined && text !== "";
}

function now() {
  return new Date().toISOString();
}
