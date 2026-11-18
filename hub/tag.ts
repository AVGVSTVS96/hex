const OPENING = '<channel source="';
const KEY_ON_OPENING_TAG = /^<channel source="[^"]*" key="([^"]+)"/u;
const KEYS = /<channel(?: [\p{L}\p{N}_]+="[^"]*")*? key="([^"]+)"/gu;

const ENTITIES = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" } as const;

const escaped = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

const unescaped = (value: string) =>
  value.replaceAll(/&(lt|gt|quot|apos|amp);/gu, (_, name: keyof typeof ENTITIES) => ENTITIES[name]);

// WARNING: a session that reads a UTC stamp like 06:31Z writes it down as 6:31am, so the tag carries the owner's clock time.
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

export function tag(source: string, meta: Record<string, string>, body: string, zone: string) {
  const attributes = Object.entries(local(meta, zone))
    .map(([name, value]) => ` ${name}="${escaped(value)}"`)
    .join("");

  return `${OPENING}${escaped(source)}"${attributes}>\n${body.replaceAll("</channel>", "<\\/channel>")}\n</channel>`;
}

export const startsWithTag = (text: string) => text.startsWith(OPENING);

export const holdsTag = (text: string) => text.includes(OPENING);

export function keyOf(prompt: string) {
  const key = KEY_ON_OPENING_TAG.exec(prompt)?.[1];

  return key === undefined ? undefined : unescaped(key);
}

export const keys = (text: string) =>
  [...text.matchAll(KEYS)].flatMap(([, key]) => (key === undefined ? [] : [unescaped(key)]));
