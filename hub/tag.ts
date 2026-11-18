const OPENING = '<channel source="';
const KEY_ON_OPENING_TAG = /^<channel source="[^"]*" key="([^"]+)"/u;
const KEYS = /<channel(?: [\p{L}\p{N}_]+="[^"]*")*? key="([^"]+)"/gu;
const WHOLE = /^<channel((?: [\p{L}\p{N}_]+="[^"]*")*)>([\s\S]*)<\/channel>\s*$/u;
const TAGS = /<channel(?: [\p{L}\p{N}_]+="[^"]*")+>[\s\S]*?<\/channel>/gu;
const ATTRIBUTE = / ([\p{L}\p{N}_]+)="([^"]*)"/gu;
const ESCAPED_END = "<\\/channel>";

const ENTITIES = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" } as const;

const escaped = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

const unescaped = (value: string) =>
  value.replaceAll(/&(lt|gt|quot|apos|amp);/gu, (_, name: keyof typeof ENTITIES) => ENTITIES[name]);

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
    .map(([name, value]) => ` ${name}="${escaped(value)}"`)
    .join("");

  return `${OPENING}${escaped(source)}"${attributes}>\n${body.replaceAll("</channel>", ESCAPED_END)}\n</channel>`;
}

export const startsWithTag = (text: string) => text.startsWith(OPENING);

export const holdsTag = (text: string) => text.includes(OPENING);

export function keyOf(prompt: string) {
  const key = KEY_ON_OPENING_TAG.exec(prompt)?.[1];

  return key === undefined ? undefined : unescaped(key);
}

export const keys = (text: string) =>
  [...text.matchAll(KEYS)].flatMap(([, key]) => (key === undefined ? [] : [unescaped(key)]));

export const tagsIn = (text: string) => [...text.matchAll(TAGS)].map(([found]) => found);

export function untag(text: string) {
  const [, attributes = "", body] = WHOLE.exec(text) ?? [];

  if (body === undefined) {
    return;
  }

  const meta = Object.fromEntries(
    [...attributes.matchAll(ATTRIBUTE)].map(([, name = "", value = ""]) => [
      name,
      unescaped(value),
    ]),
  );

  return { meta, body: body.replaceAll(ESCAPED_END, "</channel>") };
}
