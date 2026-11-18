import { basename } from "node:path";

import { z } from "zod";

import type { Permission } from "./mcp.ts";
import { fileOnly, pictures, widthOverHeightOf } from "./pictures.ts";
import { present } from "./present.ts";
import { asked, replied, shown, spoken } from "./store.ts";
import type { Store } from "./store.ts";

export type Turn = {
  from: "me" | "hex";
  text: string;
  // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- hex voice reads a picture's width over height by this name
  media?: { id: string; kind: string; file?: string; shape?: number }[];
};

const PreviewFields = z.record(z.string(), z.json());

export function preview({ input_preview, description }: Permission): string {
  try {
    return Object.entries(PreviewFields.parse(JSON.parse(input_preview)))
      .filter(([, value]) => value !== description)
      .map(([key, value]) => `${key}: ${z.string().safeParse(value).data ?? JSON.stringify(value)}`)
      .join("\n");
  } catch {
    return input_preview;
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Chat apps only link web addresses, so a buzz:// link goes through a page on hex's site that opens it.
export function tappable(text: string): string {
  return text.replaceAll(
    /buzz:\/\/[^\s)>\]\\]*[^\s)>\]\\.,;:!?'"]/gu,
    (url) => `https://hex-sand.vercel.app/open.html#${encodeURIComponent(url)}`,
  );
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A thread's chat, oldest first: what the owner said that a session took in, and hex's replies as first sent; with a session, from the first message that session took, the conversation it has.
export async function history(store: Store, thread: string, session?: string): Promise<Turn[]> {
  const rows = await store.messages.said(thread);
  const start = present(session) ? (rows.find((row) => row.taken?.by === session)?.at ?? "9") : "";

  return rows.flatMap((row): Turn[] => {
    if (row.from === "terminal" || !row.taken || row.at < start) {
      return [];
    }

    const sent = pictures(row);
    const words = sent.length > 0 && fileOnly(row) ? "" : row.body;

    if (replied(row)) {
      return shown(row)
        ? [{ from: "hex", text: words, ...(sent.length > 0 && { media: sent }) }]
        : [];
    }

    const media = carried(row.meta) ?? (sent.length > 0 ? sent : undefined);

    if (!spoken(row) || row.author !== "owner") {
      return [];
    }

    const text = row.from === "t3" ? asked(row.body) : media === sent ? words : row.body;

    return text !== "" || media !== undefined
      ? [{ from: "me", text, ...(media && { media }) }]
      : [];
  });
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The hex app's photos and clips a message carried, listed in its meta as "<kind> <id>; ...", with their files, where kept, in the same order in "files".
export function carried(meta?: Record<string, string>): Turn["media"] {
  const files = meta?.files?.split("; ") ?? [];

  return meta?.media?.split("; ").map((entry, i) => {
    const [kind = "", id = ""] = entry.split(" ");
    const file = files[i];
    const widthOverHeight = kind === "photo" ? widthOverHeightOf(file) : undefined;

    return {
      id,
      kind,
      ...(present(file) && { file }),
      ...(widthOverHeight !== undefined &&
        widthOverHeight > 0 && {
          // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- hex voice reads a picture's width over height by this name
          shape: widthOverHeight,
        }),
    };
  });
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A message's words without the line it ends with for each photo or clip it carried.
export function typed(body: string, items: number) {
  return items ? body.split("\n").slice(0, -items).join("\n") : body;
}

const Transcript = z.object({ text: z.string().optional() });

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// TRANSCRIBE_URL is any OpenAI-compatible /audio/transcriptions endpoint.
export async function transcribe(recording: () => Promise<string>): Promise<string | undefined> {
  const { TRANSCRIBE_URL: url, TRANSCRIBE_MODEL: model, TRANSCRIBE_API_KEY: key } = process.env;

  if (!present(url) || !present(model)) {
    return;
  }

  const path = await recording();
  const form = new FormData();
  form.append("file", Bun.file(path), basename(path));
  form.append("model", model);

  const res = await fetch(url, {
    method: "POST",
    body: form,
    headers: present(key) ? { authorization: `Bearer ${key}` } : {},
  });

  if (!res.ok) {
    throw new Error(`transcription failed: HTTP ${res.status}`);
  }

  const { text } = Transcript.parse(await res.json());
  const trimmed = text?.trim();

  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

export function title(text: string): string {
  const word = text.trim();

  if (!/^[^\s_-]+$/u.test(word)) {
    throw new Error(`title must be one word, got "${word}"`);
  }

  return word;
}
