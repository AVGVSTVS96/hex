import { expect, test } from "bun:test";

import { prompt } from "./beside.ts";
import type { Row } from "./store.ts";
import { holdsTag, keyOf, keys, local, startsWithTag, tag, tagsIn, untag } from "./tag.ts";

const ZONE = "America/Los_Angeles";

const row: Row = {
  key: "telegram:-100:7",
  to: "general",
  from: "telegram",
  author: "owner",
  body: "the build passed?",
  at: "2026-10-20T06:31:05.123Z",
  meta: {
    chat_id: "-100",
    message_id: "7",
    user: "sam",
    ts: "2026-10-20T06:31:05.123Z",
    stalled: "true",
  },
};

const held = ({ from, key, meta, body }: Row) => tag(from, { key, ...meta }, body, ZONE);

test("a beside session's prompt is the tag it was before one file wrote it", () => {
  expect(prompt("telegram", row, ZONE)).toBe(
    '<channel source="telegram" key="telegram:-100:7" chat_id="-100" message_id="7" user="sam" ts="2026-10-19T23:31:05-07:00">\nthe build passed?\n</channel>',
  );
});

test("words held for a turn are the tag they were before one file wrote it", () => {
  expect(held(row)).toBe(
    '<channel source="telegram" key="telegram:-100:7" chat_id="-100" message_id="7" user="sam" ts="2026-10-19T23:31:05-07:00" stalled="true">\nthe build passed?\n</channel>',
  );
});

test("a body can't close the tag, and an attribute can't open one, for either writer", () => {
  const odd = { ...row, body: "a </channel> b", meta: { reply_to_text: 'x < y & "z"' } };

  for (const written of [prompt("telegram", odd, ZONE), held(odd)]) {
    expect(written).toContain('reply_to_text="x &lt; y &amp; &quot;z&quot;"');
    expect(written).toContain("\na <\\/channel> b\n</channel>");
    expect(written.match(/<\/channel>/gu)).toHaveLength(1);
  }
});

test("the key a tag is written with is the key read back from it, whatever it holds", () => {
  for (const key of [row.key, `schedule:a<b&c"d'e>f@1`]) {
    expect(keyOf(prompt("telegram", { ...row, key }, ZONE))).toBe(key);
    expect(keyOf(held({ ...row, key }))).toBe(key);
  }

  expect(keyOf(`a word first ${held(row)}`)).toBeUndefined();
  expect(keys(`${held(row)}\n${held({ ...row, key: "schedule:a<b@1" })}`)).toEqual([
    row.key,
    "schedule:a<b@1",
  ]);
});

test("Claude Code's own tag is read back the same way, entities and all", () => {
  const written =
    '<channel source="plugin:telegram:telegram" key="telegram:-100:8" reply_to_text="it&apos;s 2 &gt; 1 &amp;amp; &quot;so&quot;">\nok\n</channel>';

  expect(keyOf(written)).toBe("telegram:-100:8");
  expect(untag(written)?.meta.reply_to_text).toBe(`it's 2 > 1 &amp; "so"`);
});

test("a tag read whole gives back the meta and body it was written with", () => {
  const meta = { key: row.key, reply_to_text: 'x < y > z & "w"' };
  const body = "a </channel> b";
  const written = tag("telegram", meta, body, ZONE);

  expect(startsWithTag(written)).toBe(true);
  expect(holdsTag(`The user sent a new message while you were working:\n${written}`)).toBe(true);
  expect(untag(written)).toEqual({ meta: { source: "telegram", ...meta }, body: `\n${body}\n` });
  expect(tagsIn(`${written}\n${held(row)}`)).toEqual([written, held(row)]);
  expect(untag("not a tag")).toBeUndefined();
});

test("a message's time reaches the session on the owner's clock, with its offset", () => {
  expect(local({ chat_id: "1", ts: "2026-10-20T06:31:05.123Z" }, ZONE)).toEqual({
    chat_id: "1",
    ts: "2026-10-19T23:31:05-07:00",
  });
  expect(local({ ts: "2026-01-15T20:00:00Z" }, ZONE).ts).toBe("2026-01-15T12:00:00-08:00");
});

test("meta without a time or a zone it can read passes through as it is", () => {
  expect(local({ chat_id: "1" }, "UTC")).toEqual({ chat_id: "1" });
  expect(local({ ts: "soon" }, "UTC")).toEqual({ ts: "soon" });
  expect(local({ ts: "2026-10-20T06:31:05Z" }, "Bogus/Zone")).toEqual({
    ts: "2026-10-20T06:31:05Z",
  });
});
