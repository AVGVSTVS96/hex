import type { Database, SQLQueryBindings } from "bun:sqlite";

import { z } from "zod";

import { clause, fromJson, MessageIdColumn, now, TextOrAbsent } from "./db.ts";
import type { Core, MessageId, Write } from "./db.ts";

export type Answer = { label: string; at: string; via: string; message?: MessageId; kept?: true };

export type Question = {
  asker?: "owner";
  app: string;
  thread: string;
  message: MessageId;
  text: string;
  options: string[];
  at: string;
  poll?: string;
  multiple?: boolean;
  shots?: string[];
  answer?: Answer;
  settled?: { note: string; at: string };
};

export type NewQuestion = Omit<Question, "at"> & { at?: string };

export const waits = (question: Question) =>
  !question.settled && (question.asker === "owner") === !!question.answer;

const Labels = z.array(z.string());

export const AnswerJson: z.ZodType<Answer> = z.object({
  label: z.string(),
  at: z.string(),
  via: z.string(),
  message: MessageIdColumn.exactOptional(),
  kept: z.literal(true).exactOptional(),
});

export const SettledJson = z.object({ note: z.string(), at: z.string() });

const QuestionRow = z
  .object({
    asker: z.enum(["hex", "owner"]).default("hex"),
    app: z.string(),
    thread: z.string(),
    message: MessageIdColumn,
    text: z.string(),
    options: z.string(),
    at: z.string(),
    poll: TextOrAbsent,
    multiple: z.number(),
    shots: TextOrAbsent.optional(),
    answer: TextOrAbsent,
    settled: TextOrAbsent,
  })
  .transform((row): Question => ({
    ...(row.asker === "owner" && { asker: "owner" as const }),
    app: row.app,
    thread: row.thread,
    message: row.message,
    text: row.text,
    options: fromJson(Labels, row.options),
    at: row.at,
    ...(row.poll !== undefined && { poll: row.poll }),
    ...(row.multiple !== 0 && { multiple: true }),
    ...(row.shots !== undefined && { shots: fromJson(Labels, row.shots) }),
    ...(row.answer !== undefined && { answer: fromJson(AnswerJson, row.answer) }),
    ...(row.settled !== undefined && { settled: fromJson(SettledJson, row.settled) }),
  }));

const QuestionRows = z.array(QuestionRow);

export class Questions {
  private readonly db: Database;
  private readonly write: Write;

  constructor({ db, write }: Core) {
    this.db = db;
    this.write = write;
  }

  ask({
    asker,
    app,
    thread,
    message,
    text,
    options,
    poll,
    multiple,
    shots,
    at = now(),
    answer,
    settled,
  }: NewQuestion) {
    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // An older hex's questions, brought in by steps before the asker and shots columns exist, are hex's and fill only the columns they had.
    const row = {
      ...(asker !== undefined && { asker }),
      app,
      thread,
      message,
      text,
      options: JSON.stringify(options),
      poll: poll ?? null,
      multiple: multiple === true ? 1 : 0,
      ...(shots !== undefined && shots.length > 0 && { shots: JSON.stringify(shots) }),
      answer: answer === undefined ? null : JSON.stringify(answer),
      settled: settled === undefined ? null : JSON.stringify(settled),
      at,
    } satisfies Record<string, SQLQueryBindings>;

    const columns = Object.keys(row);

    this.write(() =>
      this.db
        .query(
          `insert into questions (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")}) on conflict do nothing`,
        )
        .run(...Object.values(row)),
    );
  }

  get(app: string, thread: string, message: MessageId): Question | null {
    return QuestionRow.nullable().parse(
      this.db
        .query("select * from questions where app = ? and thread = ? and message = ?")
        .get(app, thread, message),
    );
  }

  poll(app: string, poll: string): Question | null {
    return QuestionRow.nullable().parse(
      this.db.query("select * from questions where app = ? and poll = ?").get(app, poll),
    );
  }

  list({
    app,
    thread,
    asker,
    waiting,
  }: {
    app?: string | undefined;
    thread?: string | undefined;
    asker?: "hex" | "owner" | undefined;
    waiting?: boolean | undefined;
  } = {}): Question[] {
    const [where, params] = clause([
      app !== undefined && ["app = ?", app],
      thread !== undefined && ["thread = ?", thread],
      asker !== undefined && ["asker = ?", asker],
      waiting === true && [
        `settled is null and (asker = 'hex' and answer is null or asker = 'owner' and answer is not null)`,
      ],
    ]);

    return QuestionRows.parse(
      this.db.query(`select * from questions ${where} order by n`).all(...params),
    );
  }

  replied(app: string, thread: string, answer: Answer, to?: MessageId) {
    const which = to === undefined ? `json_extract(answer, '$.kept') is null` : "message = ?";
    this.write(() =>
      this.db
        .query(
          `update questions set answer = ? where asker = 'owner' and app = ? and thread = ? and settled is null and ${which}`,
        )
        .run(
          JSON.stringify(to === undefined ? answer : { ...answer, kept: true }),
          app,
          thread,
          ...(to === undefined ? [] : [to]),
        ),
    );
  }

  returned(app: string, thread: string) {
    this.write(() =>
      this.db
        .query(
          `update questions set answer = json_set(answer, '$.kept', json('true')) where asker = 'owner' and app = ? and thread = ? and answer is not null and settled is null`,
        )
        .run(app, thread),
    );
  }

  answered(
    app: string,
    thread: string,
    message: MessageId,
    label: string,
    via: string,
    again = false,
  ): boolean {
    return this.write(
      () =>
        this.db
          .query(
            "update questions set answer = ?, settled = null where app = ? and thread = ? and message = ? and (? or answer is null)",
          )
          .run(JSON.stringify({ label, at: now(), via }), app, thread, message, again).changes ===
        1,
    );
  }

  reworded(app: string, thread: string, message: MessageId, text: string) {
    this.write(() =>
      this.db
        .query("update questions set text = ? where app = ? and thread = ? and message = ?")
        .run(text, app, thread, message),
    );
  }

  settled(app: string, thread: string, message: MessageId, note: string) {
    this.write(() =>
      this.db
        .query("update questions set settled = ? where app = ? and thread = ? and message = ?")
        .run(JSON.stringify({ note, at: now() }), app, thread, message),
    );
  }

  reopened(app: string, thread: string, message: MessageId): boolean {
    return this.write(
      () =>
        this.db
          .query(
            "update questions set answer = null, settled = null where app = ? and thread = ? and message = ? and (answer is not null or settled is not null)",
          )
          .run(app, thread, message).changes === 1,
    );
  }

  unask(app: string, thread: string, message?: MessageId) {
    this.write(() =>
      this.db
        .query(
          "delete from questions where app = ? and thread = ? and (?3 is null or message = ?3)",
        )
        .run(app, thread, message ?? null),
    );
  }
}
