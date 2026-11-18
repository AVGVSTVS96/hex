import { dirname } from "node:path";

import { open, sentPicture } from "@hex/hub";
import { z } from "zod";

import { brief } from "./activity.ts";
import type { Board, Page, Run } from "./board.ts";
import type { Sent } from "./call.ts";
import { Chats } from "./chat.ts";
import type { Where } from "./chat.ts";
import { Feed } from "./feed.ts";
import type { Entry } from "./feed.ts";
import { Goals } from "./goals.ts";
import { Ideas } from "./ideas.ts";
import { Media } from "./media.ts";
import type { Item } from "./media.ts";
import type { Question, Questions } from "./questions.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* The API hex's apps read and act through, beside the calls on the same port: the board of threads
   and their chats, the questions waiting on the owner, the feed, goals, ideas and the photos the
   apps upload. A call comes into it only where the owner asks for one: Talk it through, Discuss and
   Go through them start the live call on a thread, an entry or the questions, and a card the call
   put on screen hears what the owner does with it here. */

export type About = { run: Run } | { entry: Entry } | { asks: Question[] };

export type Calls = {
  talkAbout: (about: About) => Response;
  card: (key: string) => {
    tapped: (label: string, sent: Sent) => void;
    noted: (text: string) => void;
    dismissed: (sent: Sent) => void;
    takenBack: () => void;
    reopened: () => void;
  };
};

let HEX_STATE: string;
let board: Board;
let yours: Questions;
let media: Media;
let feed: Feed;
let goals: Goals;
let ideas: Ideas;
let chats: Chats;
let calls: Calls;

const AnswerBody = z.object({
  label: z.string().default(""),
  labels: z.array(z.string()).default([]),
  media: z.array(z.string()).default([]),
});

const NoteBody = z.object({ text: z.string(), media: z.array(z.string()).default([]) });

const ChatBody = z.object({
  media: z.array(z.string()).default([]),
  text: z.string().default(""),
  key: z.unknown(),
});

const ChatKey = z.string().regex(/^app-[\w-]{8,60}$/u);

function filled(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

function messageOf(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

async function bodyOf<Schema extends z.ZodType>(request: Request, schema: Schema) {
  const parsed = schema.safeParse(await request.json().catch(() => null));

  return parsed.success ? parsed.data : undefined;
}

export function startApp(
  state: string,
  shared: { board: Board; questions: Questions; media: Media },
  given: Calls,
) {
  HEX_STATE = state;
  calls = given;
  ({ board, questions: yours, media } = shared);
  chats = new Chats(state);
  ideas = new Ideas(state);
  feed = new Feed(state, {
    closedSince: (from) => board.closedSince(from),
    decided: () => yours.view.decided,
    runs: () => board.runs,
  });
  goals = new Goals(state, dirname(state), board, yours);
  board.listen(() => {
    chats.changed();
    void feed.check();
  });
  yours.listen(() => {
    void feed.check();
  });
}

export function routes(request: Request) {
  const url = new URL(request.url);
  const { pathname } = url;

  if (pathname === "/tasks" || pathname.startsWith("/tasks/")) {
    return runRoutes(request, url);
  }

  if (pathname === "/feed" || pathname.startsWith("/feed/")) {
    return feedRoutes(request, url);
  }

  if (pathname === "/goals" || pathname.startsWith("/goals/")) {
    return goalRoutes(request, url);
  }

  if (/^\/(asks|stuck|fresh)(\/|$)/u.test(pathname)) {
    return questionRoutes(request, url);
  }

  if (pathname === "/ideas" || pathname.startsWith("/ideas/")) {
    return ideaRoutes(request, url);
  }

  if (pathname === "/media" && request.method === "POST") {
    return upload(request);
  }

  const [, image] = /^\/media\/([\w-]+)$/u.exec(pathname) ?? [];

  if (filled(image) && request.method === "GET") {
    return showImage(image);
  }
}

export function aboutOf(id?: string): About | undefined {
  if (id === "asks") {
    return { asks: yours.view.asks };
  }

  const entry = id?.startsWith("feed:") === true ? feed.find(id.slice(5)) : undefined;

  if (entry) {
    return { entry };
  }

  const run = filled(id) ? board.get(id) : undefined;

  return run && { run };
}

async function upload(request: Request) {
  const type = request.headers.get("content-type");

  if (type === null || type === "" || !Media.takes(type)) {
    return new Response(
      "Send a JPEG, PNG, HEIC, GIF, WebP, TIFF or AVIF photo, or an MP4 or QuickTime video",
      {
        status: 415,
      },
    );
  }

  try {
    const { id, kind } = await media.add(type, await request.blob());

    return Response.json({ id, kind }, { status: 201 });
  } catch (error) {
    return new Response(messageOf(error), { status: 422 });
  }
}

async function showImage(id: string) {
  const image = media.get(id)?.images[0];
  const sent = image === undefined ? await sentPicture(open(HEX_STATE), id) : undefined;
  const path = image ?? sent?.path;

  return path === undefined
    ? new Response("404", { status: 404 })
    : new Response(Bun.file(path), sent && { headers: { "content-type": sent.type } });
}

async function showRuns(url: URL, runs: Board) {
  const after = url.searchParams.get("after");

  if (after !== null && after !== "") {
    await runs.changes(Number(after), 25_000);
  }

  return Response.json({ version: runs.version, tasks: runs.rows(), finished: runs.finished });
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* The Tasks button's counts: threads that need you and are working, and how many things are yours,
   as many as Tasks lists under Needs you: every question, everything stuck, and every thread that
   needs you without a question. */
async function showSummary(url: URL, runs: Board, questions: Questions) {
  const version = () => runs.counts.version + questions.counts.version;
  const after = Number(url.searchParams.get("after"));

  if (after === version()) {
    await Promise.race([
      runs.counts.changes(runs.counts.version, 25_000),
      questions.counts.changes(questions.counts.version, 25_000),
    ]);
  }

  const asked = new Set(questions.view.asks.map((question) => question.task));
  const unasked = runs.rows().filter((row) => row.state === "needs" && !asked.has(row.id)).length;

  return Response.json({
    version: version(),
    ...runs.summary,
    yours: questions.view.asks.length + questions.view.stuck.length + unasked,
  });
}

async function showFeed(url: URL) {
  const after = url.searchParams.get("after");
  const before = Number(url.searchParams.get("before"));

  if (after !== null && after !== "") {
    await feed.changes(Number(after), 25_000);
  }

  return Response.json({
    version: feed.version,
    ...feed.stretch(Number.isFinite(before) && before > 0 ? before : undefined),
  });
}

function feedRoutes(request: Request, url: URL) {
  if (url.pathname === "/feed" && request.method === "GET") {
    return showFeed(url);
  }

  const [, id] = /^\/feed\/([^/]+)\/talk$/u.exec(url.pathname) ?? [];
  const entry = filled(id) ? feed.find(decodeURIComponent(id)) : undefined;

  if (entry && request.method === "POST") {
    return calls.talkAbout({ entry });
  }

  return new Response("404", { status: 404 });
}

async function showQuestions(url: URL, questions: Questions) {
  const after = url.searchParams.get("after");

  if (after !== null && after !== "") {
    await questions.changes(Number(after), 25_000);
  }

  return Response.json({ version: questions.version, ...questions.view });
}

async function questionRoutes(request: Request, url: URL) {
  const questions = yours;

  if (url.pathname === "/asks" && request.method === "GET") {
    const after = url.searchParams.get("after");

    if (after === null || after === "") {
      questions.opened();
    }

    return await showQuestions(url, questions);
  }

  if (url.pathname === "/asks/check" && request.method === "GET") {
    return questions.lastCheck
      ? Response.json(questions.lastCheck)
      : new Response("No check yet", { status: 404 });
  }

  const [, shown, n] = /^\/asks\/([^/]+)\/shots\/(\d+)$/u.exec(url.pathname) ?? [];

  if (filled(shown) && request.method === "GET") {
    const file = questions.shot(decodeURIComponent(shown), Number(n));

    return file !== undefined && (await Bun.file(file).exists())
      ? new Response(Bun.file(file), { headers: { "Cache-Control": "no-cache" } })
      : new Response("No such screenshot", { status: 404 });
  }

  const [, asked] = /^\/asks\/([^/]+)\/words$/u.exec(url.pathname) ?? [];

  if (filled(asked) && request.method === "GET") {
    const words = await questions.words(decodeURIComponent(asked));

    return words ? Response.json(words) : new Response("Nothing to show", { status: 404 });
  }

  if (url.pathname === "/asks/talk" && request.method === "POST") {
    return calls.talkAbout({ asks: questions.view.asks });
  }

  const [, kind, id, verb] =
    /^\/(asks|stuck|fresh)\/([^/]+)\/(answer|note|dismiss|undo|act|read)$/u.exec(url.pathname) ??
    [];

  if (!filled(kind) || id === undefined || request.method !== "POST") {
    return new Response("404", { status: 404 });
  }

  try {
    const key = decodeURIComponent(id);
    const onTheCall = calls.card(key);

    if (kind === "asks" && verb === "answer") {
      const body = await bodyOf(request, AnswerBody);
      const items = mediaOf(body?.media ?? []);

      if (!items) {
        return new Response(CHAT_FIELD_PROBLEMS.media, { status: 400 });
      }

      const picked = body?.labels.filter(filled) ?? [];
      const typed = body?.label.trim() ?? "";
      const label = picked.length > 0 ? picked.join("; ") : typed === "" ? photos(items) : typed;

      if (!filled(label)) {
        return new Response("An answer needs its label", { status: 400 });
      }

      const sent = await yours.answer(key, picked.length > 0 ? picked : label, "app", items);
      onTheCall.tapped(label, sent);

      return Response.json(sent);
    }

    if (kind === "asks" && verb === "note") {
      const body = await bodyOf(request, NoteBody);
      const items = mediaOf(body?.media ?? []);

      if (!items) {
        return new Response(CHAT_FIELD_PROBLEMS.media, { status: 400 });
      }

      const typed = body?.text.trim() ?? "";
      const text = typed === "" ? photos(items) : typed;

      if (text === "") {
        return new Response("A note needs its text", { status: 400 });
      }

      const sent = await questions.note(key, text, "app", items);
      onTheCall.noted(text);

      return Response.json(sent);
    }

    if (kind === "asks" && verb === "dismiss") {
      const sent = await questions.dismiss(key, "app");
      onTheCall.dismissed(sent);

      return Response.json(sent);
    }

    if (kind === "asks" && verb === "undo") {
      try {
        await questions.undo(key, "app");
      } finally {
        onTheCall.takenBack();
      }

      onTheCall.reopened();
    } else if (kind === "stuck" && verb === "act") {
      await questions.act(key);
    } else if (kind === "fresh" && verb === "read") {
      questions.read(key);
    } else {
      return new Response("404", { status: 404 });
    }
  } catch (error) {
    return new Response(messageOf(error), { status: 409 });
  }

  return new Response(null, { status: 204 });
}

async function runRoutes(request: Request, url: URL) {
  const runs = board;

  if (url.pathname === "/tasks" && request.method === "GET") {
    return await showRuns(url, runs);
  }

  if (url.pathname === "/tasks/summary" && request.method === "GET") {
    return await showSummary(url, runs, yours);
  }

  const [, id, verb] = /^\/tasks\/([^/]+)(?:\/(talk|chat|stop))?$/u.exec(url.pathname) ?? [];
  const key = filled(id) ? decodeURIComponent(id) : "";
  const thread = filled(key) ? await runs.find(key) : undefined;

  if (thread && verb === "chat") {
    return request.method === "POST"
      ? await sendChat(request, thread)
      : await showChat(url, thread);
  }

  if (thread && !filled(verb) && request.method === "GET") {
    return await showPage(url, runs, key);
  }

  const run = filled(key) ? runs.get(key) : undefined;

  if (!run) {
    return new Response("404", { status: 404 });
  }

  if (verb === "talk" && request.method === "POST") {
    return calls.talkAbout({ run });
  }

  if (verb === "stop" && request.method === "POST") {
    return await done(() => {
      chats.stop(run);
    });
  }

  return new Response("404", { status: 404 });
}

const IdeaBody = z.object({
  text: z.string().default(""),
  key: z.string().optional(),
  day: z.number().default(0),
});

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* The owner's ideas: the list and one idea, each held until it changes, and what the app does with
   one. Starting one tells its thread to work on it, keeping it again says never mind, and the
   owner's words on it go to its thread as theirs. */
async function ideaRoutes(request: Request, url: URL) {
  const [, id, verb] = /^\/ideas(?:\/(t-\d+)(?:\/(\w+))?)?$/u.exec(url.pathname) ?? [];
  const after = url.searchParams.get("after");

  if (request.method === "GET" && !filled(verb)) {
    if (after !== null && after !== "") {
      await ideas.changes(Number(after), 25_000);
    }

    if (!filled(id)) {
      return Response.json({ version: ideas.version, ideas: await ideas.list() });
    }

    const { version } = ideas;
    const one = await ideas.one(id);

    return one ? Response.json({ version, ...one }) : new Response("404", { status: 404 });
  }

  if (request.method !== "POST" || !filled(id)) {
    return new Response("404", { status: 404 });
  }

  const body = IdeaBody.safeParse((await request.json().catch(() => null)) ?? {});
  const { text, key, day } = body.success ? body.data : { text: "", key: "", day: 0 };

  return await done(async () => {
    const idea = await ideas.get(id);

    const toThread = async (words: string, named = `app-${id}-${Date.now()}`) => {
      const run = await board.find((await ideas.one(id))?.thread ?? "");

      if (!run) {
        throw new Error(`${id}'s thread can't be reached from here; write to it in its own app.`);
      }

      await chats.send(run, words, ChatKey.parse(named));
    };

    if (verb === "seen") {
      ideas.seen(id);
    } else if (verb === "start") {
      await ideas.status(id, "open");
      await toThread(`Start on my idea ${id}, “${idea.title}”: it's a task now, so work on it.`);
    } else if (verb === "keep") {
      if ((await ideas.status(id, "idea")) === "open") {
        await toThread(`Never mind starting ${id}, “${idea.title}”: keep it as an idea for now.`);
      }
    } else if (verb === "drop") {
      await ideas.status(id, "dropped");
    } else if (verb === "stop") {
      await ideas.stop(id);
    } else if (verb === "look") {
      await ideas.look(id, day);
    } else if (verb === "add" && text.trim() !== "") {
      await toThread(`On my idea ${id}, “${idea.title}”: ${text.trim()}`, key);
    } else {
      throw new Error(verb === "add" ? CHAT_FIELD_PROBLEMS.text : `Ideas can't ${verb ?? ""}`);
    }
  });
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* Goals: what the owner asked for and what hex watches (goals.ts). A goal's "Not needed" and "Not
   what I asked" tell its topic, as words typed in the app would; Undo puts back what was. */
async function goalRoutes(request: Request, url: URL) {
  if (url.pathname === "/goals" && request.method === "GET") {
    const after = url.searchParams.get("after");

    if (after !== null && after !== "") {
      await goals.changes(Number(after), 25_000);
    }

    return Response.json(goals.view);
  }

  const [, one] = /^\/goals\/(t-\d+)$/u.exec(url.pathname) ?? [];

  if (filled(one) && request.method === "GET") {
    const goal = await goals.goal(one);

    return goal ? Response.json(goal) : new Response("404", { status: 404 });
  }

  const [, watched, act] = /^\/goals\/w\/([^/]+)\/(stop|undo)$/u.exec(url.pathname) ?? [];

  if (filled(watched) && filled(act) && request.method === "POST") {
    const name = decodeURIComponent(watched);

    return await done(async () => {
      await (act === "stop" ? goals.stopWatching(name) : goals.undo(name));
    });
  }

  const [, id, verb] = /^\/goals\/(t-\d+)\/(drop|reopen|undo)$/u.exec(url.pathname) ?? [];

  if (!filled(id) || !filled(verb) || request.method !== "POST") {
    return new Response("404", { status: 404 });
  }

  return await done(async () => {
    const run = goals.runOf(id);

    const changed =
      verb === "drop"
        ? await goals.drop(id)
        : verb === "reopen"
          ? await goals.reopen(id)
          : await goals.undo(id);

    const where = run === undefined ? undefined : await board.find(run);

    if (changed && where) {
      await chats.send(where, changed.told, `app-goal-${id}-${verb}-${Date.now()}`);
    }
  });
}

async function showPage(url: URL, runs: Board, key: string) {
  const read = async () => {
    const found = await runs.find(key);

    return (
      found && {
        ...found,
        ...("steps" in found && {
          steps: found.steps.map((step) => ({ ...step, brief: brief(step) })),
        }),
        ...(await yours.of(found.id)),
      }
    );
  };

  const after = url.searchParams.get("after");

  if (after !== null && after !== "" && Number(after) === runs.version) {
    const end = Date.now() + 25_000;
    const before = JSON.stringify(await read());

    while (Date.now() < end && JSON.stringify(await read()) === before) {
      await runs.changes(runs.version, end - Date.now());
    }
  }

  const { version } = runs;
  const shown = await read();

  return shown ? Response.json({ version, ...shown }) : new Response("404", { status: 404 });
}

async function showChat(url: URL, run: Run | Page) {
  const where = (): Where => {
    const serving = board.session(run.id);

    return serving === undefined ? { ...run } : { ...run, session: serving };
  };

  const after = url.searchParams.get("after");

  const chat =
    after !== null && after !== ""
      ? await chats.next(where, Number(after), 25_000)
      : await chats.of(where());

  return Response.json(chat);
}

const CHAT_FIELD_PROBLEMS = {
  media: "Name each photo or video by the id /media gave it",
  text: "Send some words, or a photo or video",
  key: "Name the message with a key starting app-",
};

async function sendChat(request: Request, run: Run | Page) {
  const raw: unknown = await request.json().catch(() => null);
  const parsed = ChatBody.safeParse(raw ?? {});

  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];

    return new Response(field === "media" ? CHAT_FIELD_PROBLEMS.media : CHAT_FIELD_PROBLEMS.text, {
      status: 400,
    });
  }

  const { media: names, text, key } = parsed.data;
  const items = mediaOf(names);

  if (!items) {
    return new Response(CHAT_FIELD_PROBLEMS.media, { status: 400 });
  }

  if (text.trim() === "" && items.length === 0) {
    return new Response(CHAT_FIELD_PROBLEMS.text, { status: 400 });
  }

  const named = ChatKey.safeParse(key);

  if (!named.success) {
    return new Response(CHAT_FIELD_PROBLEMS.key, { status: 400 });
  }

  return await done(() => chats.send(run, text.trim(), named.data, items));
}

function mediaOf(names: string[]) {
  const items = names.map((name) => media.get(name));

  return items.every((item) => item !== undefined) ? items : undefined;
}

function photos(items: Item[]) {
  if (items.length === 0) {
    return "";
  }

  const kinds = new Set(items.map((item) => item.kind));
  const kind = kinds.size === 1 ? [...kinds][0] : "photo or video";

  return items.length === 1 ? `a ${kind}` : `${items.length} ${kind}s`;
}

async function done(act: () => Promise<void> | void) {
  try {
    await act();

    return new Response(null, { status: 204 });
  } catch (error) {
    return new Response(messageOf(error), { status: 409 });
  }
}
