import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { transcribe } from "../../hub/hub.ts";

export type Kind = "photo" | "video";

// What Claude Code can read of a photo or clip: its images (a photo, or stills across a clip), and
// for a clip its length and what was said in it. mute: the clip has no sound.
export type Item = {
  id: string;
  kind: Kind;
  images: string[];
  seconds?: number;
  mute?: true;
  words?: string;
};

const TYPES: Record<string, [Kind, string]> = {
  "image/jpeg": ["photo", "jpg"],
  "image/png": ["photo", "png"],
  "image/heic": ["photo", "heic"],
  "video/mp4": ["video", "mp4"],
  "video/quicktime": ["video", "mov"],
};

const STILL_EVERY = 5;
const STILLS = 12;

// Photos and clips the app sends, kept as what Claude Code reads: a photo as JPEG or PNG, a clip as
// stills across it and the words said in it.
export class Media {
  constructor(
    private readonly dir: string,
    private readonly hear: (
      recording: () => Promise<string>,
    ) => Promise<string | undefined> = transcribe,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  static takes(type: string | null) {
    return !!type && type.split(";")[0]!.trim() in TYPES;
  }

  async add(type: string, bytes: Blob): Promise<Item> {
    const [kind, ext] = TYPES[type.split(";")[0]!.trim()]!;
    const id = crypto.randomUUID();
    const file = join(this.dir, `${id}.${ext}`);
    await Bun.write(file, bytes);

    try {
      const item =
        kind === "video"
          ? await this.clip(id, file)
          : ext === "heic"
            ? { id, kind, images: [await jpeg(file, join(this.dir, `${id}.jpg`))] }
            : { id, kind, images: [file] };

      if (ext === "heic") {
        rmSync(file);
      }
      writeFileSync(join(this.dir, `${id}.json`), JSON.stringify(item));

      return item;
    } catch (error) {
      for (const name of readdirSync(this.dir)) {
        if (name.startsWith(id)) rmSync(join(this.dir, name));
      }
      throw error;
    }
  }

  get(id: string): Item | undefined {
    if (!/^[\w-]+$/.test(id)) {
      return;
    }
    try {
      return JSON.parse(readFileSync(join(this.dir, `${id}.json`), "utf-8"));
    } catch {}
  }

  private async clip(id: string, file: string): Promise<Item> {
    const probe = JSON.parse(
      await run(
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type",
        "-of",
        "json",
        file,
      ),
    );

    const seconds = Number(probe.format?.duration) || 0;
    const count = Math.min(STILLS, Math.max(1, Math.round(seconds / STILL_EVERY)));

    const images = await Promise.all(
      Array.from({ length: count }, (_, i) => {
        const still = join(this.dir, `${id}-${i + 1}.jpg`);

        return run(
          "ffmpeg",
          "-v",
          "error",
          "-ss",
          (((i + 0.5) * seconds) / count).toFixed(2),
          "-i",
          file,
          "-frames:v",
          "1",
          "-q:v",
          "3",
          still,
        ).then(() => still);
      }),
    );

    const item: Item = { id, kind: "video", images, seconds: Math.round(seconds) };

    if (!probe.streams?.some((stream: { codec_type?: string }) => stream.codec_type === "audio")) {
      return { ...item, mute: true };
    }
    const audio = join(this.dir, `${id}.wav`);

    try {
      const words = await this.hear(() =>
        run("ffmpeg", "-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", "16000", audio).then(
          () => audio,
        ),
      );

      return words === undefined ? item : { ...item, words };
    } catch (error) {
      process.stderr.write(`voice: ${id}'s sound didn't transcribe: ${error}\n`);

      return item;
    } finally {
      rmSync(audio, { force: true });
    }
  }
}

// One line saying what an item is, for the session that reads its images.
export function line({ kind, images, seconds = 0, mute, words }: Item) {
  if (kind === "photo") {
    return "(photo)";
  }
  const clip = `(video ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}, ${images.length} ${images.length === 1 ? "still" : "stills"}`;

  if (mute) {
    return `${clip}, no sound)`;
  }
  return words
    ? `${clip}; said in it: "${words.replaceAll(/\s+/g, " ")}")`
    : `${clip}; no words came through from its sound)`;
}

// The owner's words with a line for each item after them, as a session gets them.
export function caption(text: string, items: Item[]) {
  return [text, ...items.map(line)].filter(Boolean).join("\n");
}

// The owner's own words of a caption.
export function typed(body: string, items: number) {
  return items ? body.split("\n").slice(0, -items).join("\n") : body;
}

// The meta a message with items carries: every image to read, and each item by kind and id.
export function meta(items: Item[]): Record<string, string> {
  if (!items.length) {
    return {};
  }
  return {
    image_path: items.flatMap((item) => item.images).join("; "),
    media: items.map((item) => `${item.kind} ${item.id}`).join("; "),
  };
}

async function jpeg(from: string, to: string) {
  await run("ffmpeg", "-v", "error", "-i", from, "-frames:v", "1", "-q:v", "2", to);

  return to;
}

async function run(...command: string[]) {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });

  const [out, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (code !== 0) {
    throw new Error(`${command[0]} failed: ${error.trim() || `exit ${code}`}`);
  }
  return out;
}
