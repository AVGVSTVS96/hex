import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";

import { ready } from "./ready.ts";

const transpiler = new Bun.Transpiler({ loader: "ts" });

// WARNING: Bun's import scanner fails on a #! line.
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
    return;
  }

  ready();
  await gone(file);
}

if (import.meta.main) {
  await gone(process.argv[2] ?? "");
}
