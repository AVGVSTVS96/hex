import { clip, fit, HEADINGS } from "./fit.ts";
import type { MessageId, Store, Task } from "./store.ts";

export type Link = (thread: string, message: MessageId) => string | undefined;

function linked(text: string, url: string | undefined) {
  return url !== undefined && url !== "" ? `[${text.replaceAll(/[[\]]/gu, "")}](${url})` : text;
}

export async function statusPost(
  store: Store,
  thread: string,
  note: string,
  room: number,
  link?: Link,
): Promise<string> {
  const tasks = async (status: "open" | "idea") =>
    await Promise.all(
      (await store.tasks.list({ owner: thread, status: [status] })).map(
        async (task) =>
          `- ${linked(clip(task.title, 120), await latest(store, thread, task, link))}`,
      ),
    );

  const [questions, open, ideas, lastDone] = await Promise.all([
    store.questions.list({ thread, waiting: true }),
    tasks("open"),
    tasks("idea"),
    store.tasks.lastDone(thread, 5),
  ]);

  const waiting = questions.map(
    (question) =>
      `- ${question.asker ? linked(`Answered: ${clip(question.text, 110)}`, link?.(thread, question.answer?.message ?? question.message)) : linked(clip(question.text, 120), link?.(thread, question.message))}`,
  );

  const done = lastDone.map(
    (task) => `- ${linked(clip(task.title, 120), firstLinkIn(task.proof))}`,
  );

  const sections = (
    [
      [HEADINGS[0], waiting],
      [HEADINGS[1], open],
      [HEADINGS[2], ideas],
      [HEADINGS[3], done],
    ] as const
  ).flatMap(([header, lines]) =>
    lines.length > 0
      ? [{ header: `**${header}**`, items: lines.map((line) => [line]), gap: "\n" }]
      : [],
  );

  const space = room - fit(sections, 0).length - 2;
  const trimmed = note.trim();
  const head = trimmed.length > space ? `${trimmed.slice(0, Math.max(0, space - 1))}…` : trimmed;

  return [head, fit(sections, room - (head ? head.length + 2 : 0))].filter(Boolean).join("\n\n");
}

async function latest(store: Store, thread: string, task: Task, link: Link | undefined) {
  const ownerLastAskedHere = (
    await Promise.all(task.words.map((words) => store.messages.get(words.message)))
  ).findLast((row) => row?.to === thread);

  return ownerLastAskedHere
    ? link?.(
        thread,
        ownerLastAskedHere.meta?.message_id ??
          ownerLastAskedHere.key.slice(ownerLastAskedHere.key.lastIndexOf(":") + 1),
      )
    : undefined;
}

function firstLinkIn(proof: string | undefined) {
  let found = proof === undefined ? undefined : /https?:\/\/[^\s<>[\]"'`]+/u.exec(proof)?.[0];

  while (
    found !== undefined &&
    found !== "" &&
    (/[*_!?.,;:]$/u.test(found) ||
      (found.endsWith(")") && found.split(")").length > found.split("(").length))
  ) {
    found = found.slice(0, -1);
  }

  return found;
}
