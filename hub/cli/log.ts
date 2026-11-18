import { dirname } from "node:path";

import { command, filled, named, usage, withThread } from "../command.ts";
import type { Hex } from "../command.ts";
import { asked, messagesSince, unclaimed } from "../store.ts";
import type { Row } from "../store.ts";
import { zoneOf } from "../zone.ts";

const flags = {
  since: { type: "string" },
  last: { type: "string" },
  taken: { type: "boolean" },
  room: { type: "string" },
  json: { type: "boolean" },
} as const;

export default command({
  usage:
    "hex log [<thread, by name or id, or a terminal session's id>] [--since <date>] [--last <n>] [--taken] [--room <characters>] [--json]",
  flags,
  wordsBeforeFlags: () => 1,
  async run(hex) {
    const zone = zoneOf(dirname(hex.state)) ?? Temporal.Now.timeZoneId();

    const since = filled(hex.flags.since)
      ? new Date(
          Temporal.PlainDateTime.from(hex.flags.since).toZonedDateTime(zone).epochMilliseconds,
        ).toISOString()
      : "";

    const [given] = hex.args;

    if (hex.args.length > 0 && !filled(given)) {
      console.error("hex log: name the thread, by its name or id");
      process.exit(2);
    }

    const last = filled(hex.flags.last) ? Number(hex.flags.last) : -1;
    const threads = filled(given) ? await threadsOf(hex, given) : [];

    const rows =
      threads.length > 0
        ? (await Promise.all(threads.map((thread) => hex.store.messages.said(thread, last))))
            .flat()
            .toSorted((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
            .slice(last < 0 ? 0 : -last)
        : (await Array.fromAsync(messagesSince(unclaimed(hex.state), since))).flat();

    await log(
      hex,
      rows.filter((row) => row.at > since && (hex.flags.taken !== true || row.taken !== undefined)),
    );
  },
});

async function threadsOf(hex: Hex, given: string) {
  const threads = (await named(hex, given)).map(({ thread }) => thread);

  if (threads.length > 0) {
    return threads;
  }

  if ((await hex.store.messages.said(given, 1)).length > 0) {
    return [given];
  }

  throw new Error(`no thread named "${given}"`);
}

async function log(hex: Hex<typeof flags>, said: Row[]) {
  const room = hex.flags.room === undefined ? Infinity : Number(hex.flags.room);

  if (
    !(room === Infinity || (Number.isInteger(room) && room > 0)) ||
    (hex.flags.room !== undefined && hex.flags.json === true)
  ) {
    usage(hex);
  }

  const rows = said.map((row) =>
    row.from === "t3" && row.author === "owner" ? { ...row, body: asked(row.body) } : row,
  );

  if (hex.flags.json === true) {
    console.log(JSON.stringify(await withThread(hex, rows, (row) => row.to), null, 1));

    return;
  }

  const zone = zoneOf(dirname(hex.state)) ?? Temporal.Now.timeZoneId();
  const names = await hex.store.threads.names();

  const entries = rows.map((row) => {
    const at = Temporal.Instant.from(row.at)
      .toZonedDateTimeISO(zone)
      .toPlainDateTime()
      .toString()
      .slice(0, 16)
      .replace("T", " ");

    const { failed, message_id: messageId, user } = row.meta ?? {};
    const failure = filled(failed) ? ` · failed: ${failed}` : "";
    const name = names[row.to];
    const thread = filled(name) ? `${name} (${row.to})` : row.to;
    const id = filled(messageId) ? ` · message ${messageId}` : "";

    const who =
      filled(user) && (row.author === "prompt" || row.author === "other")
        ? `${row.author} (${user})`
        : row.author;

    return `## ${who} · ${row.from} · ${thread} · ${at} · [${row.key}]${id}${failure}\n\n${row.body}\n`;
  });

  let start = entries.length;

  for (let size = 0; start > 0; start--) {
    size += (entries[start - 1] ?? "").length + 1;

    if (size > room) {
      break;
    }
  }

  const newest = entries.at(-1);

  for (const shown of start < entries.length || newest === undefined
    ? entries.slice(start)
    : [end(newest, room)]) {
    console.log(shown);
  }
}

function end(newest: string, room: number) {
  const head = newest.slice(0, newest.indexOf("\n\n") + 2);
  let from = Math.max(head.length, newest.length - Math.max(0, room - head.length - 2));

  if (/[\uDC00-\uDFFF]/u.test(newest[from] ?? "")) {
    from++;
  }

  return `${head}…${newest.slice(from)}`;
}
