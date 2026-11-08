import { above, clip } from "./fit.ts";
import { statusPost } from "./status.ts";
import type { Link } from "./status.ts";
import { open, stateDir } from "./store.ts";
import type { MessageId, Pin, Question, Store } from "./store.ts";

export type { Answer, MessageId, Pin, Question } from "./store.ts";

export { waits } from "./store.ts";

type ClosedThreadEditsLater = false;

type DeletedMessageNeverEdits = null;

export type Post = {
  room: number;
  link: Link;
  send: (thread: string, text: string) => Promise<MessageId>;
  edit: (
    thread: string,
    message: MessageId,
    text: string,
  ) => Promise<true | undefined | ClosedThreadEditsLater | DeletedMessageNeverEdits>;
  /* oxlint-disable anti-slop/no-unknown-returns -- the ledger only awaits these, whatever each app resolves them to */
  ready?: (thread: string) => Promise<unknown>;
  pin: (thread: string, message: MessageId) => Promise<unknown>;
  unpin: (thread: string, message: MessageId) => Promise<unknown>;
  /* oxlint-enable anti-slop/no-unknown-returns -- end of the awaited-only calls */
};

export class Ledger {
  private readonly store: Store;
  private readonly app: string;
  private readonly turns = new Map<string, Promise<unknown>>();

  constructor(appStateDir: string, app: string) {
    this.store = open(stateDir(appStateDir));
    this.app = app;
  }

  get questions(): readonly Question[] {
    return this.store.questions.list({ app: this.app });
  }

  pin(thread: string): Pin | undefined {
    return this.store.pins.get(this.app, thread) ?? undefined;
  }

  post(thread: string, note: string, post: Post): Promise<MessageId> {
    return this.turn(thread, async () => {
      const was = this.pin(thread);
      const words = above(note);
      const text = await this.render(thread, words, post);
      const message = await post.send(thread, text);
      await post.pin(thread, message);
      this.store.pins.pinned({ app: this.app, thread, message, text, note: words });

      if (was) {
        await post.unpin(thread, was.message).catch(() => null);
      }

      return message;
    });
  }

  rewrite(thread: string, post: Post, note?: string, message?: MessageId): Promise<void> {
    return this.turn(thread, async () => {
      const pin = this.pin(thread);

      if (message !== undefined && String(pin?.message) !== String(message)) {
        throw new Error("that message is no longer the status post");
      }

      if (!pin) {
        return;
      }

      const said = note === undefined ? pin.note : above(note);
      const text = await this.render(thread, said, post);

      if (text === pin.text && said === pin.note) {
        return;
      }

      const shown = text === pin.text || (await post.edit(thread, pin.message, text));

      if (shown === null) {
        this.store.pins.unpinned(this.app, thread, pin.message);
      }

      if (shown === null || shown === false) {
        if (note !== undefined) {
          throw new Error(
            shown === null
              ? "the status post is gone; post a new one with pin"
              : "the thread is closed, so its status post can't change now",
          );
        }

        return;
      }

      this.store.write(() => {
        const still = this.pin(thread);

        if (still?.message !== pin.message || still.note !== pin.note) {
          return;
        }

        this.store.pins.pinned({ app: this.app, thread, message: pin.message, text, note: said });
      });
    });
  }

  private turn<T>(thread: string, change: () => T | Promise<T>): Promise<T> {
    const next = (this.turns.get(thread) ?? Promise.resolve()).catch(() => null).then(change);

    this.turns.set(thread, next);

    return next;
  }

  private async render(thread: string, note: string, post: Post) {
    await post.ready?.(thread);

    return statusPost(this.store, thread, note, post.room, post.link);
  }

  keep(
    post: Post,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a failed rewrite's reason is whatever its app threw
    failed: (thread: string, error: unknown) => void,
  ): () => void {
    const rewriteOrReport = async (thread: string) => {
      try {
        await this.rewrite(thread, post);
      } catch (error) {
        failed(thread, error);
      }
    };

    const rewriteAll = () => {
      for (const { thread } of this.store.pins.list({ app: this.app })) {
        void rewriteOrReport(thread);
      }
    };

    const stop = this.store.watch(rewriteAll);

    try {
      rewriteAll();
    } catch (error) {
      stop();
      throw error;
    }

    return stop;
  }

  find(thread: string, message: MessageId) {
    return this.store.questions.get(this.app, thread, message) ?? undefined;
  }

  byPoll(poll: string) {
    return this.store.questions.poll(this.app, poll) ?? undefined;
  }

  ask(
    thread: string,
    message: MessageId,
    text: string,
    options: string[],
    how: Pick<Question, "poll" | "multiple" | "shots"> = {},
  ) {
    this.store.questions.ask({ app: this.app, thread, message, text, options, ...how });
    this.store.questions.replied(this.app, thread, {
      label: clip(text, 60),
      at: new Date().toISOString(),
      via: "hex",
      message,
    });
  }

  said(
    thread: string,
    message: MessageId,
    text: string,
    quoted?: { question: Question; message: MessageId },
  ) {
    const answer = { label: clip(text, 60), at: new Date().toISOString(), via: "hex", message };
    const their = quoted?.question;

    if (
      their?.asker === "owner" &&
      their.thread === thread &&
      String(their.message) === String(quoted?.message)
    ) {
      this.store.questions.replied(this.app, thread, answer, their.message);

      return;
    }

    const remindsOfQuoted = quoted !== undefined;
    const question = remindsOfQuoted ? undefined : asking(text);

    if (question === undefined) {
      this.store.questions.replied(this.app, thread, answer);
    } else {
      this.ask(thread, message, question, []);
    }
  }

  heard(thread: string, message: MessageId, text: string, replyTo?: MessageId) {
    this.store.questions.returned(this.app, thread);

    const to =
      replyTo === undefined
        ? undefined
        : (this.store.questions.get(this.app, thread, replyTo) ??
          this.store.questions
            .list({ app: this.app, thread, asker: "owner", waiting: true })
            .find((question) => String(question.answer?.message) === String(replyTo)));

    if (to?.asker === "owner") {
      this.settled(thread, to.message, "you replied");
    } else if (to !== undefined && replyTo !== undefined && !to.options.length) {
      this.answered(thread, replyTo, clip(text, 60), "reply");
    }

    const question = theirs(text);

    if (question !== undefined) {
      this.store.questions.ask({
        asker: "owner",
        app: this.app,
        thread,
        message,
        text: question,
        options: [],
      });
    }
  }

  answered(thread: string, message: MessageId, label: string, via: string, again = false) {
    return this.store.questions.answered(this.app, thread, message, label, via, again);
  }

  settled(thread: string, message: MessageId, note: string) {
    this.store.questions.settled(this.app, thread, message, note);
  }

  reopened(thread: string, message: MessageId) {
    return this.store.questions.reopened(this.app, thread, message);
  }

  edited(thread: string, message: MessageId, text: string) {
    const question = this.store.questions.get(this.app, thread, message);

    if (question !== null) {
      this.store.questions.reworded(
        this.app,
        thread,
        message,
        question.options.length ? text : (asking(text) ?? text),
      );
    }
  }

  unpin(thread: string, post: Post, message?: MessageId): Promise<MessageId | undefined> {
    return this.turn(thread, async () => {
      const target = message ?? this.pin(thread)?.message;

      if (target === undefined) {
        return;
      }

      await post.unpin(thread, target);

      this.store.pins.unpinned(this.app, thread, target);

      return target;
    });
  }

  deleted(thread: string, message: MessageId): Promise<void> {
    this.store.write(() => {
      this.store.questions.unask(this.app, thread, message);
      this.store.pins.unpinned(this.app, thread, message);
    });

    const unpinWhatAPinStillRunningRecorded = () => {
      this.store.pins.unpinned(this.app, thread, message);
    };

    return this.turn(thread, unpinWhatAPinStillRunningRecorded);
  }

  forget(thread: string): Promise<void> {
    this.store.write(() => {
      this.store.questions.unask(this.app, thread);
      this.store.pins.unpinned(this.app, thread);
    });

    return this.turn(thread, () => {
      this.store.pins.unpinned(this.app, thread);
    });
  }
}

const MARKDOWN_LEAD = /^[\s*_>#-]+/u;

export function theirs(text: string): string | undefined {
  return text
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((sentence) => sentence.replace(MARKDOWN_LEAD, "").trim())
    .findLast((sentence) => sentence.endsWith("?"));
}

export function asking(text: string): string | undefined {
  const lastLine = (text.trim().split("\n").at(-1) ?? "").replace(/[\s*_]+$/u, "");

  return lastLine.endsWith("?") ? lastLine.replace(MARKDOWN_LEAD, "") : undefined;
}
