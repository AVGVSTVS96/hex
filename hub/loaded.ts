import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const WAKE = "state/wake/CLAUDE.md";

const IMPORT_HOPS = 5;

// https://code.claude.com/docs/en/memory#import-additional-files
export function loaded(
  file: string,
  seen = new Set<string>(),
  depth = 0,
  read = (path: string) => readFileSync(path, "utf-8"),
): [string, string][] {
  const memoryNotInstructions = file.endsWith(`/${WAKE}`);

  if (seen.has(file) || depth > IMPORT_HOPS || memoryNotInstructions) {
    return [];
  }

  seen.add(file);

  let text;

  try {
    text = read(file);
  } catch {
    return [];
  }

  const prose = text.replaceAll(/^(`{3,})[^]*?^\1`*$/gmu, "").replaceAll(/`[^`\n]*`/gu, "");

  const imports = [...prose.matchAll(/(?:^|\s)@(\S+)/gu)].map(([, target = ""]) =>
    target.startsWith("~/") ? join(homedir(), target.slice(2)) : resolve(dirname(file), target),
  );

  return [[file, text], ...imports.flatMap((target) => loaded(target, seen, depth + 1, read))];
}

// Plugin files edited on disk, like hooks, reach a running session only on restart or /reload-plugins: https://code.claude.com/docs/en/plugins/cli-reference#reload-plugins
export const STARTUP = {
  hooks: "plugin/hooks/hooks.json",
  skills: "plugin/skills",
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The flags hex's launcher works out for a session take effect only as its process starts, so a restart or resume picks up a change and compacting doesn't.
  launcher: [
    "bin/session",
    "bin/identity",
    "bin/instructions",
    "bin/chat",
    "hub/loaded.ts",
    "hub/fit.ts",
  ],
};

export type Startup = keyof typeof STARTUP;

const isStartup = (key: string): key is Startup => key in STARTUP;
const STARTUP_KEYS = Object.keys(STARTUP).filter(isStartup);

const endOfWholeSecond = (unixSeconds: string) => (Number(unixSeconds) + 1) * 1000;

export function history(hex: string) {
  const gitOrNothing = (...args: string[]) => {
    try {
      return Bun.spawnSync(["git", "-C", hex, "-c", "core.quotePath=false", ...args], {
        stderr: "ignore",
      })
        .stdout.toString()
        .trim();
    } catch {
      return "";
    }
  };

  const reflog = [
    ...gitOrNothing("log", "-g", "--format=%H %gd", "--date=unix", "HEAD").matchAll(
      /^(\w+) HEAD@\{(\d+)\}$/gmu,
    ),
  ].map(([, commit = "", at = ""]) => ({ commit, at }));

  const head = reflog.length > 0 ? gitOrNothing("rev-parse", "HEAD") : "";
  const diffs = new Map<string, Startup[]>();

  return {
    head,
    on: (started?: number) =>
      started === undefined
        ? undefined
        : reflog.find((move) => endOfWholeSecond(move.at) <= started)?.commit,
    changed(from: string): Startup[] {
      const known = diffs.get(from);

      if (known) {
        return known;
      }

      const names = gitOrNothing(
        "diff",
        "--name-only",
        from,
        head,
        "--",
        ...Object.values(STARTUP).flat(),
      ).split("\n");

      const changed = STARTUP_KEYS.filter((key) =>
        [STARTUP[key]]
          .flat()
          .some((path) => names.some((name) => name === path || name.startsWith(`${path}/`))),
      );

      diffs.set(from, changed);

      return changed;
    },
  };
}
