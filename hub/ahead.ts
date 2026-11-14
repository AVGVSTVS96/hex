import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";

const transpiler = new Bun.Transpiler({ loader: "ts" });

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The packages a module imports, itself or through the modules of its own it imports, as the files they resolve to. Bun's scanner takes no #! line.
function packages(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) {
    return [];
  }

  seen.add(file);

  return transpiler
    .scanImports(readFileSync(file, "utf-8").replace(/^#!.*/u, ""))
    .flatMap(({ path }) => {
      if (/^(?:node|bun):/u.test(path)) {
        return [];
      }

      const resolved = Bun.resolveSync(path, dirname(file));

      if (!path.startsWith(".")) {
        return [resolved];
      }

      return extname(resolved) === ".ts" ? packages(resolved, seen) : [];
    });
}

export function gone(file: string): Promise<void> {
  return new Promise((resolve) => {
    const watcher = watch(dirname(file), () => {
      if (!existsSync(file)) {
        watcher.close();
        resolve();
      }
    });

    if (!existsSync(file)) {
      watcher.close();
      resolve();
    }
  });
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// hex started ahead of its turn, while it still runs on another machine that's handing it over, gets ready to take over without touching hex.db or any channel: it loads the packages its channels import (their own modules start them, so they wait), runs each channel's ahead.ts, which may open its connections, says "ready" in the file HEX_AHEAD names, and waits until that file is gone. A hub whose code won't load here never says it's ready.
export async function ahead(file: string, channels: string[]) {
  await Promise.all(
    channels.flatMap((channel) => {
      const own = join(channel, "ahead.ts");

      return [...new Set(packages(join(channel, "bot.ts"))), ...(existsSync(own) ? [own] : [])].map(
        async (path) => {
          await import(path);
        },
      );
    }),
  );

  try {
    writeFileSync(file, "ready\n", { flag: "r+" });
  } catch {
    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // Already gone: the handover came first.
  }

  await gone(file);
}

if (import.meta.main) {
  await gone(process.argv[2] ?? "");
}
