import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";

import { checks, open } from "@hex/hub";

import type { Finished } from "./board.ts";
import { Changes } from "./changes.ts";
import { linkAt } from "./links.ts";
import type { DecidedByHex } from "./questions.ts";

export type Link = { label: string; url: string };

export type Entry = {
  id: string;
  kind: "done" | "found" | "decided";
  title: string;
  body: string;
  topic: string;
  at: string;
  opens: string;
  links: Link[];
  pictures: Shown[];
};

// oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- hex voice reads a picture's width over height by this name
export type Shown = { id: string; shape: number };

export type Stretch = { entries: Entry[]; older: number };

export type Sources = {
  closedSince: (since: string) => Finished[];
  decided: () => DecidedByHex[];
  runs?: () => { id: string; name: string }[];
};

const DAY = 24 * 60 * 60_000;
const STRETCH = 7 * DAY;
const AT_LEAST = 30;
const LABEL = 80;

const URLS = /https?:\/\/[^\s<>"'`()[\]]*[^\s<>"'`()[\].,;:!?]/gu;
const KEYS = /(?<![\w/:.~-])[a-z][\w-]*:-?\w[^\s,;()]*/gu;

export class Feed extends Changes {
  private seen = "";
  private kept: Entry[] = [];
  private readonly watcher: FSWatcher | undefined;
  private readonly state: string;
  private readonly sources: Sources;

  constructor(state: string, sources: Sources) {
    super();
    this.state = state;
    this.sources = sources;
    this.check();

    try {
      this.watcher = watch(state, (_, file) => {
        if (file === "ideas.jsonl") {
          this.check();
        }
      });
    } catch {
      this.watcher = undefined;
    }
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  /* Mapping every closed task to its run takes a few hundred milliseconds, so the entries are made again
     only when what they're made from changes, read cheaply here. */
  check() {
    const now = JSON.stringify([
      open(this.state).tasks.finished(""),
      this.sources.runs?.().map(({ id, name }) => [id, name]),
      this.sources.decided(),
      checks(this.state).filter((check) => check.news === true),
    ]);

    if (now === this.seen) {
      return;
    }

    const first = this.seen === "";
    this.seen = now;
    this.kept = this.make();

    if (!first) {
      this.changed();
    }
  }

  stop() {
    this.watcher?.close();
  }

  entries(): Entry[] {
    return this.kept;
  }

  private make(): Entry[] {
    return [...this.done(), ...this.found(), ...this.decided()].toSorted(
      (a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id),
    );
  }

  find(id: string) {
    return this.entries().find((entry) => entry.id === id);
  }

  stretch(before?: number): Stretch {
    const end = before ?? Number.POSITIVE_INFINITY;
    const left = this.entries().filter((entry) => Date.parse(entry.at) < end);
    const from = (before ?? Date.now()) - STRETCH;

    let n = Math.max(
      left.filter((entry) => Date.parse(entry.at) >= from).length,
      Math.min(AT_LEAST, left.length),
    );

    while (n < left.length && Date.parse(left[n]?.at ?? "") === Date.parse(left[n - 1]?.at ?? "")) {
      n++;
    }

    const entries = left.slice(0, n);
    const last = entries.at(-1);

    return { entries, older: n < left.length && last ? Date.parse(last.at) : 0 };
  }

  private done(): Entry[] {
    return this.sources.closedSince("").map((task) => {
      const { words, links } = this.split(task.proof);

      return {
        id: `done:${task.id}`,
        kind: "done",
        title: task.title,
        body: words,
        topic: task.topic,
        at: task.at,
        opens: task.id,
        links,
        pictures: [],
      };
    });
  }

  private found(): Entry[] {
    const tasks = open(this.state).tasks;

    return checks(this.state).flatMap((check) => {
      if (check.news !== true || check.finding === undefined || check.finding.trim() === "") {
        return [];
      }

      const opens = check.idea ?? "";
      const task = opens === "" ? undefined : tasks.get(opens);
      const { words, links } = this.split(check.finding);
      const [title, body] = firstSentence(words);

      return [
        {
          id: `found:${check.schedule}:${check.at}`,
          kind: "found",
          title,
          body,
          topic: task?.project ?? task?.title ?? "",
          at: check.at,
          opens,
          links,
          pictures: [],
        },
      ];
    });
  }

  private decided(): Entry[] {
    return this.sources.decided().map((question) => {
      const { words, links } = this.split(question.why);

      return {
        id: `decided:${question.id}`,
        kind: "decided",
        title: question.question,
        body: words === "" ? (question.took ?? "") : words,
        topic: question.topic,
        at: question.decided,
        opens: question.id,
        links: [...(question.links ?? []), ...links],
        pictures: [],
      };
    });
  }

  private split(text: string) {
    const links: Link[] = [];
    const store = open(this.state);

    const withoutUrls = text.replaceAll(URLS, (url) => {
      links.push({ label: labelOf(url), url });

      return " ";
    });

    const words = withoutUrls.replaceAll(KEYS, (key) => {
      const said = store.messages.get(key);

      if (said === null) {
        return key;
      }

      const thread = store.threads.list().find((row) => row.thread === said.to);
      const url = linkAt(key.split(":")[0] ?? "", thread?.link, key.split(":").at(-1));

      if (url !== undefined && url !== "") {
        links.push({ label: thread?.name ?? key, url });
      }

      return " ";
    });

    return { words: tidy(words), links };
  }
}

function labelOf(url: string) {
  const { host, pathname } = new URL(url);
  const label = `${host.replace(/^www\./u, "")}${pathname.replace(/\/$/u, "")}`;

  return label.length > LABEL ? `${label.slice(0, LABEL - 1)}…` : label;
}

function tidy(text: string) {
  const tidied = text
    .replaceAll(/\(\s*[·|,;:\s-]*\)/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .replaceAll(/ ([.,;:!?])/gu, "$1")
    .replaceAll(/([·|])(?: ?[·|,])+/gu, "$1")
    .replace(/(?:[\s·|,;:—–-]|\b(?:links?|sources?)\b)+([.!?]?)$/iu, "$1")
    .replace(/([.!?])\.$/u, "$1")
    .replace(/^[\s·|,;:—–-]+/u, "");

  const whole = /^\(([^()]*)\)$/u.exec(tidied);

  return whole?.[1]?.trim() ?? tidied;
}

function firstSentence(text: string): [string, string] {
  const end = /[.!?]["”’)]?\s+(?=["“(]?[A-Z\d])/u.exec(text);

  if (!end) {
    return [text, ""];
  }

  const cut = end.index + end[0].trimEnd().length;

  return [text.slice(0, cut), text.slice(cut).trim()];
}
