const KEY_ON_OPENING_TAG = /^<channel source="[^"]*" key="([^"]+)"/u;
const KEYS = /<channel [^>]*\bkey="([^"]+)"/gu;

const attribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The apps stamp a message in UTC, and a session that reads 06:31Z writes it down as 6:31am, so the tag carries the owner's clock time with its offset instead.
export function local(meta: Record<string, string>, zone: string): typeof meta {
  const at = meta.ts === undefined || meta.ts === "" ? Number.NaN : Date.parse(meta.ts);

  if (Number.isNaN(at)) {
    return meta;
  }

  try {
    return {
      ...meta,
      ts: Temporal.Instant.fromEpochMilliseconds(at)
        .toZonedDateTimeISO(zone)
        .toString({ timeZoneName: "never", smallestUnit: "second" }),
    };
  } catch {
    return meta;
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A message as Claude Code shows a channel's, key first, so a session's prompt hook reads it back (keyOf).
export function tag(source: string, meta: Record<string, string>, body: string, zone: string) {
  const attributes = Object.entries(local(meta, zone))
    .map(([name, value]) => ` ${name}="${attribute(value)}"`)
    .join("");

  return `<channel source="${attribute(source)}"${attributes}>\n${body.replaceAll("</channel>", "<\\/channel>")}\n</channel>`;
}

export const keyOf = (prompt: string) => KEY_ON_OPENING_TAG.exec(prompt)?.[1];

export const keys = (text: string) => [...text.matchAll(KEYS)].flatMap(([, key]) => key ?? []);
