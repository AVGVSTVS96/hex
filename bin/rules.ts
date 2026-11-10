#!/usr/bin/env bun
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { spawnSync } from "bun";
import { z } from "zod";

import { ROOM } from "../hub/fit.ts";
import { MEMORY, PROFILE, WAKE, history } from "../hub/loaded.ts";
import type { Startup } from "../hub/loaded.ts";
import { own } from "../hub/running.ts";
import { open, stateDir } from "../hub/store.ts";
import { hold, hookSizedPartsSplitAtLineEnds, rendered, rules } from "./instructions";

const hex = resolve(import.meta.dir, "..");
const home = resolve(hex, "..");

const WHAT: Record<Startup, string> = {
  hooks: "hooks",
  skills: "skills",
  launcher: "launch flags",
};

const Hook = z.object({
  session_id: z.string(),
  hook_event_name: z.string(),
  source: z.string().optional(),
});

const Rules = z.record(z.string(), z.string());

const { session_id, hook_event_name, source } = Hook.parse(JSON.parse(await Bun.stdin.text()));
const [part = "1", flag] = process.argv.slice(2);
const thisPart = Number(part);
const anOlderHookRunsItAloneSoItsTheLastPart = process.argv.length <= 2;
const lastPart = flag === "last" || anOlderHookRunsItAloneSoItsTheLastPart;
const isSet = (value?: string): value is string => value !== undefined && value !== "";

const held =
  isSet(process.env.HEX_HELD) && existsSync(join(process.env.HEX_HELD, "CLAUDE.md"))
    ? process.env.HEX_HELD
    : undefined;

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

function unified(changes: { name: string; before: string; after: string }[]) {
  const scratch = mkdtempSync(join(tmpdir(), "hex-rules-"));

  try {
    return changes
      .map(({ name, before, after }, i) => {
        const old = join(scratch, `${i}`);
        const next = join(scratch, `${i}.new`);

        writeFileSync(old, before);
        writeFileSync(next, after);

        return spawnSync([
          "diff",
          "-u",
          "--label",
          name,
          "--label",
          name,
          old,
          next,
        ]).stdout.toString();
      })
      .join("\n");
  } finally {
    rmSync(scratch, { recursive: true });
  }
}

const PARTS = [1, 2, 3, 4];

const NOTE = /^#(?<first>\d+)(?:-(?<last>\d+))? /u;

const notes = (wake: string): Note[] =>
  wake
    .slice(Math.max(0, wake.indexOf(MEMORY)))
    .split("\n")
    .flatMap((line) => {
      const { first, last = first } = NOTE.exec(line)?.groups ?? {};

      return first === undefined ? [] : [{ line, first: Number(first), last: Number(last) }];
    });

type Note = { line: string; first: number; last: number };

const ids = ({ first, last }: Note) =>
  Array.from({ length: last - first + 1 }, (_, i) => first + i);

const profileOf = (wake: string) => {
  const start = wake.indexOf(PROFILE);
  const end = wake.indexOf(MEMORY);

  return start === -1 || end < start ? "" : wake.slice(start + PROFILE.length, end).trim();
};

function memoryWrittenSinceItLoaded(dir: string, room: number) {
  const live = join(home, WAKE);

  if (!existsSync(live) || room <= 0) {
    return "";
  }

  const now = readFileSync(live, "utf-8");
  const kept = join(dir, "wake.md");
  const before = readFileSync(existsSync(kept) ? kept : join(dir, "CLAUDE.md"), "utf-8");
  const said: string[] = [];
  const [was, is] = [profileOf(before), profileOf(now)];
  let profile = was;

  if (was !== is && is !== "") {
    const diff = unified([{ name: "profile", before: was, after: is }]);

    const change =
      diff.length < is.length
        ? `Your profile changed since this session loaded it:\n\n${diff}`
        : `Your profile changed since this session loaded it; now it reads:\n\n${is}`;

    const fits = change.length <= room;

    said.push(
      fits
        ? change
        : "Your profile changed since this session loaded it; `.hex/bin/hex profile` prints it.",
    );

    profile = fits || change.length > ROOM ? is : was;
  }

  const seen = new Set(notes(before).flatMap(ids));
  const covered = (note: Note) => ids(note).every((id) => seen.has(id));

  const unseen = notes(now).filter((note) => !covered(note));
  const shown: typeof unseen = [];

  if (unseen.length) {
    const count = `Your memory has ${unseen.length} ${unseen.length === 1 ? "note" : "notes"} newer than the copy this session loaded`;
    const recall = "`.hex/vendor/memo recall <regex>` finds";

    const head = (n: number) =>
      n === unseen.length
        ? `${count}, oldest first:`
        : `${count}. The newest ${n}, oldest first (${recall} the rest; they come again at the next prompt):`;

    let left = room - said.join("\n\n").length - head(0).length - "\n\n\n\n".length;

    for (const note of unseen.toReversed()) {
      left -= note.line.length + 1;

      if (left < 0) {
        break;
      }

      shown.unshift(note);
    }

    said.push(
      shown.length === 0
        ? `${count}; ${recall} them, and they come again at the next prompt.`
        : `${head(shown.length)}\n\n${shown.map((note) => note.line).join("\n")}`,
    );
  }

  for (const id of shown.flatMap(ids)) {
    seen.add(id);
  }

  const known = notes(now).filter(covered);
  const record = `${PROFILE}\n\n${profile}\n\n${MEMORY}\n\n${known.map((note) => note.line).join("\n")}\n`;

  if (!existsSync(kept) || readFileSync(kept, "utf-8") !== record) {
    writeFileSync(kept, record);
  }

  return said.join("\n\n");
}

function whatTheStalestPartHasSeen(store: ReturnType<typeof open>) {
  const seenBy = (n: number) => {
    if (held === undefined) {
      const row = store.seen.getWithTime(session_id, `rules ${n}`);

      return row && { record: row.record, at: Date.parse(row.at) };
    }

    const path = join(held, "seen", `rules.${n}.json`);

    return existsSync(path)
      ? { record: readFileSync(path, "utf-8"), at: statSync(path).mtimeMs }
      : undefined;
  };

  const sessionLoaded = () => {
    if (held !== undefined) {
      return { record: readFileSync(join(held, "rules.json"), "utf-8"), at: 0 };
    }

    return { record: store.seen.get(session_id, "rules"), at: 0 };
  };

  const records = PARTS.map((n) => seenBy(n) ?? sessionLoaded());

  return records.toSorted((a, b) => a.at - b.at)[0]?.record ?? sessionLoaded().record;
}

try {
  const store = open(stateDir());

  if (hook_event_name === "SessionEnd") {
    store.seen.unshowAll(session_id, "rules");
    store.seen.unshow(session_id, "hex");
    process.exit(0);
  }

  if (
    held !== undefined &&
    hook_event_name === "SessionStart" &&
    (source === "compact" || source === "clear")
  ) {
    hold(held);
  }

  const now = rules();

  const keptAs = (n: number) =>
    held === undefined ? `rules ${n}` : join(held, "seen", `rules.${n}.json`);

  const kept = whatTheStalestPartHasSeen(store);

  let out = "";

  if (hook_event_name === "UserPromptSubmit" && kept !== "") {
    const before = Rules.parse(JSON.parse(kept));

    const changed = [...new Set([...Object.keys(before), ...Object.keys(now)])].filter(
      (file) => before[file] !== now[file],
    );

    if (changed.length) {
      const body = unified(
        changed.map((file) => ({
          name: file.startsWith(home) ? relative(home, file) : file.replace(homedir(), "~"),
          before: before[file] ?? "",
          after: now[file] ?? "",
        })),
      );

      const lead =
        "Your instruction files changed since this session loaded them. From now on, follow their new wording";

      const aChatsNextSessionStartsFromTheNewFiles =
        isSet(process.env.HEX_FRESH) && isSet(process.env.HEX_THREAD);

      if (body.length <= ROOM) {
        if (thisPart === 1) {
          out = `${lead}; this is what changed:\n\n${body}`;
        }
      } else if (!aChatsNextSessionStartsFromTheNewFiles) {
        const all = hookSizedPartsSplitAtLineEnds(rendered());
        const mine = all[thisPart - 1] ?? "";

        const which =
          all.length > 1 ? `, part ${thisPart} of ${all.length}; read the parts in order` : "";

        const more =
          lastPart && all.length > thisPart
            ? `\nThat's all the hooks can show. Read the rest in the files themselves: ${Object.keys(now).join(", ")}.\n`
            : "";

        if (mine.trim() !== "") {
          out = `${lead}. The change is too long for a diff, so here they are whole${which}.\n\n${mine}${more}`;
        }
      }
    }
  }

  const keepBeforeSayingSoAKeepThatFailsSaysNothing = () => {
    if (hook_event_name === "SessionStart") {
      if (held === undefined) {
        store.seen.unshowAll(session_id, "rules");
        store.seen.show(session_id, "rules", JSON.stringify(now));
      }

      return;
    }

    if (JSON.stringify(now) === kept) {
      return;
    }

    for (const n of anOlderHookRunsItAloneSoItsTheLastPart ? PARTS : [thisPart]) {
      if (held === undefined) {
        store.seen.show(session_id, keptAs(n), JSON.stringify(now));
      } else {
        mkdirSync(dirname(keptAs(n)), { recursive: true });
        writeFileSync(keptAs(n), JSON.stringify(now));
      }
    }
  };

  keepBeforeSayingSoAKeepThatFailsSaysNothing();

  let shown = "";

  if (hook_event_name === "UserPromptSubmit" && thisPart === 1) {
    try {
      const updates = history(hex);
      const told = store.seen.get(session_id, "hex");
      const self = own(session_id);
      const processStartSinceReloadPluginsFiresNoHook = self?.started;

      const from =
        updates.head !== "" && told !== updates.head
          ? updates.on(processStartSinceReloadPluginsFiresNoHook)
          : undefined;

      const changed = from === undefined ? [] : updates.changed(from);
      const changedAgainSinceItWasTold = told === "" || updates.changed(told).length > 0;

      if (from !== undefined && changed.length > 0 && changedAgainSinceItWasTold) {
        store.seen.show(session_id, "hex", updates.head);

        const names = (keys: Startup[]) =>
          new Intl.ListFormat("en").format(keys.map((key) => WHAT[key]));

        const hub = store.threads
          .list({ open: true })
          .some((thread) => thread.session === session_id);

        const after = hub
          ? "hex resumes it on the new hex at its next rest, once its work here is done"
          : "It takes the new ones when it restarts";

        out = [
          out,
          `hex was updated (${from.slice(0, 7)} to ${updates.head.slice(0, 7)}) after this session started, and Claude Code reads hex's ${names(changed)} only at start, so this session may still run the old ones. ${after}. Tell me so in a line when you next write to me.`,
        ]
          .filter(Boolean)
          .join("\n\n");
        const reload = changed.filter((key) => key !== "launcher");

        const steps = [
          ...(reload.length ? [`run /reload-plugins for its new ${names(reload)}`] : []),
          ...(changed.includes("launcher")
            ? [
                `quit it and run cd ${quote(self?.cwd ?? home)} && ${quote(`${hex}/bin/session`)} --resume ${session_id} for its new launch flags`,
              ]
            : []),
        ];

        const someoneReadsItsScreen = !hub;

        if (someoneReadsItsScreen) {
          shown = `hex was updated after this session started: ${steps.join(", and ")}.`;
        }
      }
    } catch (error) {
      console.error(`hex couldn't tell whether this session runs an older hex: ${String(error)}`);
    }
  }

  if (hook_event_name === "UserPromptSubmit" && thisPart === 1 && held !== undefined) {
    try {
      out = [out, memoryWrittenSinceItLoaded(held, ROOM - out.length)].filter(Boolean).join("\n\n");
    } catch (error) {
      console.error(`hex couldn't tell this session what its memory gained: ${String(error)}`);
    }
  }

  if (shown !== "") {
    console.log(
      JSON.stringify({
        systemMessage: shown,
        hookSpecificOutput: { hookEventName: hook_event_name, additionalContext: out },
      }),
    );
  } else if (out !== "") {
    console.log(out);
  }
} catch (error) {
  console.error(
    `hex couldn't compare this session's rules with the ones it loaded: ${String(error)}`,
  );
}
