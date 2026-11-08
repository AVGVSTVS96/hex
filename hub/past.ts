import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { asked, open } from "./store.ts";
import type { Author, NewRow, Store } from "./store.ts";
import { zoneOf } from "./zone.ts";

const HEAD = /^## (.+?) · (\w+) · (?:(\d{4}-\d{2}-\d{2}) )?(\d{1,2}):(\d{2})\n/gmu;
const OWNER = new Set(["me", "hex app", "hex call"]);
const OLD_LOGS_CUT_SHORT_T3_HEADING = "t";
const SAME_TURN_WITHIN = 2 * 60_000;

const authorInLog = (who: string): Author =>
  OWNER.has(who) ? "owner" : who === "assistant" ? "hex" : "prompt";

type Kept = { to: string; at: string; by: string | undefined };

function nextAfter(previous: string, minuteAt: string) {
  return previous !== "" && previous >= minuteAt
    ? new Date(Date.parse(previous) + 1).toISOString()
    : minuteAt;
}

export function importLogs(store: Store, dir: string, zone: string): number {
  const files = [join(dir, "threads"), dir].flatMap((each) =>
    existsSync(each)
      ? readdirSync(each)
          .filter((name) => name.endsWith(".md"))
          .map((name) => join(each, name))
      : [],
  );

  const takenCountsBySession = new Map<string, Map<string, number>>();

  const threadOfSessionThatTookNothing = new Map(
    store
      .threads()
      .flatMap(({ thread, session }) =>
        session !== undefined && session !== "" ? [[session, thread] as const] : [],
      ),
  );

  const keptByWords = new Map<string, Kept[]>();

  for (const row of store.since()) {
    if (row.taken) {
      const counts = takenCountsBySession.get(row.taken.by) ?? new Map<string, number>();

      takenCountsBySession.set(row.taken.by, counts.set(row.to, (counts.get(row.to) ?? 0) + 1));
    }

    const words = (row.from === "t3" ? asked(row.body) : row.body).trim();

    const times = [row.at, ...(row.taken ? [row.taken.at] : [])].map((at) => ({
      to: row.to,
      at,
      by: row.taken?.by,
    }));

    keptByWords.set(words, [...(keptByWords.get(words) ?? []), ...times]);
  }

  const turnsRepeatedByResumedOrForkedSessions = new Set<string>();
  let added = 0;

  store.write(() => {
    for (const file of files) {
      try {
        added += take(file);
      } catch (error) {
        process.stderr.write(`hex couldn't read ${file} into hex.db: ${String(error)}\n`);
      }
    }
  });

  return added;

  function take(file: string): number {
    const log = readFileSync(file, "utf-8");
    const session = /^# (\d{4}-\d{2}-\d{2}) · session (\S+)/u.exec(log);

    if (!session) {
      return 0;
    }

    const [, day = "", id = ""] = session;

    const threadTakenFromMost = [
      ...(takenCountsBySession.get(id) ?? new Map<string, number>()),
    ].toSorted((a, b) => b[1] - a[1])[0]?.[0];

    let to = threadTakenFromMost ?? threadOfSessionThatTookNothing.get(id) ?? id;

    const heads = [...log.matchAll(HEAD)];
    const isAppSession = heads.some((head) => head[2] !== "terminal");
    const rows: [NewRow, string][] = [];
    let previousAt = "";
    let today = Temporal.PlainDate.from(day);
    let clock = "";

    heads.forEach((head, i) => {
      const [, who = "", headed = "", dated, hour = "", minute = ""] = head;
      const via = headed === OLD_LOGS_CUT_SHORT_T3_HEADING ? "t3" : headed;
      const time = `${hour.padStart(2, "0")}:${minute}`;
      const undatedAndEarlierThanTheLast = dated === undefined && clock !== "" && time < clock;

      if (undatedAndEarlierThanTheLast) {
        today = today.add({ days: 1 });
      }

      clock = time;

      const date = dated ?? today.toString();
      const body = log.slice(head.index + head[0].length, heads[i + 1]?.index).trim();
      const author = authorInLog(who);
      const terminalNoteNeverInApp = isAppSession && via === "terminal" && author === "hex";

      if (terminalNoteNeverInApp) {
        return;
      }

      const minuteAt = Temporal.PlainDateTime.from(`${date}T${time}`)
        .toZonedDateTime(zone)
        .toInstant()
        .toString({ fractionalSecondDigits: 3 });

      const kept =
        author === "hex" ? undefined : keptByWords.get((via === "t3" ? asked(body) : body).trim());

      const sameTurn = (each: Kept) =>
        Math.abs(Date.parse(each.at) - Date.parse(minuteAt)) < SAME_TURN_WITHIN;

      const mine = kept?.findIndex((each) => sameTurn(each) && each.by === id) ?? -1;

      const near =
        mine >= 0 ? mine : (kept?.findIndex((each) => sameTurn(each) && each.to === to) ?? -1);

      const known = near >= 0 ? kept?.splice(near, 1)[0] : undefined;

      if (known !== undefined) {
        to = known.to;
        previousAt = known.at > previousAt ? known.at : previousAt;
      }

      const turn = `${to}\n${who}\n${minuteAt}\n${body}`;

      if (body === "" || turnsRepeatedByResumedOrForkedSessions.has(turn)) {
        return;
      }

      turnsRepeatedByResumedOrForkedSessions.add(turn);

      const buzzLogWroteEverySenderAsMe = via === "buzz" && author === "owner";

      if (known !== undefined || buzzLogWroteEverySenderAsMe) {
        return;
      }

      previousAt = nextAfter(previousAt, minuteAt);
      rows.push([
        {
          key: `${via}:past:${id}:${i}`,
          to,
          from: via,
          author,
          body,
          meta: { log: file.slice(dir.length + 1), ...(author === "prompt" && { user: who }) },
        },
        previousAt,
      ]);
    });

    return store.past(rows, id).length;
  }
}

if (import.meta.main) {
  const home = process.argv[2];

  if (home === undefined) {
    throw new Error("past.ts takes the hex home to read log/ from");
  }

  const added = importLogs(
    open(join(home, "state")),
    join(home, "log"),
    zoneOf(home) ?? Temporal.Now.timeZoneId(),
  );

  if (added > 0) {
    console.log(`hex.db took in ${added} messages from log/`);
  }
}
