#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { spawnSync } from "bun";
import { z } from "zod";

import { ROOM } from "../hub/fit.ts";
import { history } from "../hub/loaded.ts";
import type { Startup } from "../hub/loaded.ts";
import { own } from "../hub/running.ts";
import { open, stateDir } from "../hub/store.ts";
import { hold, rules } from "./instructions";

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
const isSet = (value?: string): value is string => value !== undefined && value !== "";

const held =
  isSet(process.env.HEX_HELD) && existsSync(join(process.env.HEX_HELD, "CLAUDE.md"))
    ? process.env.HEX_HELD
    : undefined;

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

try {
  const store = open(stateDir());

  if (hook_event_name === "SessionEnd") {
    store.unshow(session_id, "rules");
    store.unshow(session_id, "hex");
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

  const kept =
    held === undefined
      ? store.seen(session_id, "rules")
      : readFileSync(join(held, "rules.json"), "utf-8");

  let out = "";

  if (hook_event_name !== "SessionStart" && kept !== "") {
    const before = Rules.parse(JSON.parse(kept));

    const changed = [...new Set([...Object.keys(before), ...Object.keys(now)])].filter(
      (file) => before[file] !== now[file],
    );

    if (changed.length) {
      const scratch = mkdtempSync(join(tmpdir(), "hex-rules-"));

      const diffs = changed.map((file, i) => {
        const name = file.startsWith(home) ? relative(home, file) : file.replace(homedir(), "~");

        const old = join(scratch, `${i}`);
        const next = join(scratch, `${i}.new`);

        writeFileSync(old, before[file] ?? "");
        writeFileSync(next, now[file] ?? "");

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
      });

      rmSync(scratch, { recursive: true });
      const names = changed.map((file) => file.replace(homedir(), "~"));
      const body = diffs.join("\n");

      const lead =
        "Your instruction files changed since this session loaded them. From now on, follow their new wording";

      const aChatsNextSessionStartsFromTheNewFiles =
        isSet(process.env.HEX_FRESH) && isSet(process.env.HEX_THREAD);

      if (body.length <= ROOM) {
        out = `${lead}; this is what changed:\n\n${body}`;
      } else if (!aChatsNextSessionStartsFromTheNewFiles) {
        out = `${lead}. The change is too long to show here, so read them again: ${names.join(", ")}`;
      }
    }
  }

  const keepBeforeSayingSoAKeepThatFailsSaysNothing = () => {
    if (JSON.stringify(now) === kept) {
      return;
    }

    if (held === undefined) {
      store.show(session_id, "rules", JSON.stringify(now));
    } else if (hook_event_name !== "SessionStart") {
      writeFileSync(join(held, "rules.json"), JSON.stringify(now));
    }
  };

  keepBeforeSayingSoAKeepThatFailsSaysNothing();

  let shown = "";

  if (hook_event_name === "UserPromptSubmit") {
    try {
      const updates = history(hex);
      const told = store.seen(session_id, "hex");
      const self = own(session_id);
      const processStartSinceReloadPluginsFiresNoHook = self?.started;

      const from =
        updates.head !== "" && told !== updates.head
          ? updates.on(processStartSinceReloadPluginsFiresNoHook)
          : undefined;

      const changed = from === undefined ? [] : updates.changed(from);
      const changedAgainSinceItWasTold = told === "" || updates.changed(told).length > 0;

      if (from !== undefined && changed.length > 0 && changedAgainSinceItWasTold) {
        store.show(session_id, "hex", updates.head);

        const names = (keys: Startup[]) =>
          new Intl.ListFormat("en").format(keys.map((key) => WHAT[key]));

        const hub = store.threads({ open: true }).some((thread) => thread.session === session_id);

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
