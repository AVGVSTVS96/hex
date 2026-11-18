import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { besideOf } from "./beside.ts";
import { open, unclaimed } from "./store.ts";
import { zoneOf } from "./zone.ts";

const QUIETEST_HOUR = 3;
const DAYS_KEPT = 7;
const COMPUTER_GONE_AFTER_MS = 5 * 60_000;

const QuickCheck = z.object({ quick_check: z.string() });

export async function backup(
  storeDir: string,
  day: string,
  computer?: string,
  limit = COMPUTER_GONE_AFTER_MS,
) {
  const dir = join(storeDir, "backups");
  const name = `hex-${day}.db`;
  const part = join(dir, `${name}.part`);

  mkdirSync(dir, { recursive: true });
  rmSync(part, { force: true });

  try {
    await unclaimed(storeDir).copy(part);
    const copy = new Database(part, { readonly: true });
    const { quick_check } = QuickCheck.parse(copy.query("pragma quick_check").get());
    copy.close();

    if (quick_check !== "ok") {
      throw new Error(`its copy fails SQLite's check: ${quick_check}`);
    }
  } catch (error) {
    rmSync(part, { force: true });

    throw error;
  }

  renameSync(part, join(dir, name));

  for (const old of readdirSync(dir)
    .filter((each) => /^hex-.*\.db$/u.test(each))
    .toSorted()
    .slice(0, -DAYS_KEPT)) {
    rmSync(join(dir, old));
  }

  if (computer === undefined || computer === "") {
    return;
  }

  const hash = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(join(dir, name)).arrayBuffer())
    .digest("hex");

  const keepOnlyIfHashMatches = `set -e; mkdir -p ~/hex-backups; cd ~/hex-backups; find . -name 'hex-*.db.part' -mmin +${Math.ceil(limit / 60_000) + 1} -delete; cat > "$1.part"; echo "$2  $1.part" | sha256sum -c --quiet; mv "$1.part" "$1"; ls hex-*.db | head -n -${DAYS_KEPT} | xargs -r rm --; sha256sum "$1"`;
  const late = AbortSignal.timeout(limit);

  const sent = Bun.spawn(
    ["sprite", "exec", "-s", computer, "--", "sh", "-c", keepOnlyIfHashMatches, "sh", name, hash],
    {
      env: process.env,
      stdin: Bun.file(join(dir, name)),
      stdout: "pipe",
      stderr: "pipe",
      signal: late,
      killSignal: "SIGKILL",
    },
  );

  const answer = await Promise.race([
    Promise.all([sent.exited, new Response(sent.stdout).text(), new Response(sent.stderr).text()]),
    new Promise<undefined>((resolve) => {
      late.addEventListener("abort", () => {
        resolve(undefined);
      });
    }),
  ]);

  if (!answer) {
    throw new Error(`${computer} didn't answer in ${limit / 60_000} minutes`);
  }

  const [exit, out, err] = answer;

  if (exit !== 0) {
    throw new Error(`${computer} didn't take it: ${err.trim() || `exit ${exit}`}`);
  }

  if (!out.startsWith(hash)) {
    throw new Error(`the copy on ${computer} doesn't match hex.db's`);
  }
}

export function nightly(storeDir: string, hexDir: string, main: string): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const scheduleNextNightThenBackUp = async () => {
    const now = Temporal.Now.zonedDateTimeISO(zoneOf(hexDir) ?? Temporal.Now.timeZoneId());

    const today = now
      .round({ smallestUnit: "hour", roundingMode: "floor" })
      .with({ hour: QUIETEST_HOUR });

    const passed = Temporal.ZonedDateTime.compare(today, now) <= 0;

    const day = (passed ? today : today.subtract({ days: 1 })).toPlainDate().toString();

    if (!stopped) {
      timer = setTimeout(
        () => void scheduleNextNightThenBackUp(),
        (passed ? today.add({ days: 1 }) : today).epochMilliseconds - Date.now(),
      );
    }

    if (!existsSync(join(storeDir, "backups", `hex-${day}.db`))) {
      try {
        await backup(storeDir, day, process.env.HEX_COMPUTER);
      } catch (error) {
        const body = `[backup] hex couldn't back up its records for ${day}: ${error instanceof Error ? error.message : String(error)}. The next try is at 3:00.`;

        // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
        // The store that couldn't be copied may not take the notice either, so it goes to the hub's log then.
        try {
          await open(storeDir).messages.deliver({
            key: `backup:failed@${day}`,
            to: besideOf(main),
            from: "backup",
            author: "prompt",
            body,
            meta: { user: "backup" },
          });
        } catch (error_) {
          process.stderr.write(`${body} Telling the main thread failed too: ${String(error_)}\n`);
        }
      }
    }
  };

  void scheduleNextNightThenBackUp();

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
