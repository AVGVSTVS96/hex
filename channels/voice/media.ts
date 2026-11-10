import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { transcribe } from "@hex/hub";
import { z } from "zod";

export type Kind = "photo" | "video";

export type Item = {
  id: string;
  kind: Kind;
  images: string[];
  file?: string;
  seconds?: number;
  mute?: true;
  words?: string;
};

const savedItem: z.ZodType<Item> = z.object({
  id: z.string(),
  kind: z.enum(["photo", "video"]),
  images: z.array(z.string()),
  file: z.string().exactOptional(),
  seconds: z.number().exactOptional(),
  mute: z.literal(true).exactOptional(),
  words: z.string().exactOptional(),
});

const probed = z.object({
  format: z.object({ duration: z.unknown() }).optional().catch(undefined),
  streams: z
    .array(z.object({ codec_type: z.unknown() }))
    .optional()
    .catch(undefined),
});

const TYPES = new Map<string, [Kind, string]>([
  ["image/jpeg", ["photo", "jpg"]],
  ["image/png", ["photo", "png"]],
  ["image/heic", ["photo", "heic"]],
  ["image/gif", ["photo", "gif"]],
  ["image/webp", ["photo", "webp"]],
  ["image/tiff", ["photo", "tiff"]],
  ["image/avif", ["photo", "avif"]],
  ["video/mp4", ["video", "mp4"]],
  ["video/quicktime", ["video", "mov"]],
]);

const mime = (type: string) => (type.split(";")[0] ?? "").trim();

const STILL_EVERY = 5;
const STILLS = 12;

export class Media {
  private readonly dir: string;
  private readonly hear: (recording: () => Promise<string>) => Promise<string | undefined>;

  constructor(
    dir: string,
    hear: (recording: () => Promise<string>) => Promise<string | undefined> = transcribe,
  ) {
    this.dir = dir;
    this.hear = hear;
    mkdirSync(dir, { recursive: true });
  }

  static takes(type: string | null) {
    return type !== null && type !== "" && TYPES.has(mime(type));
  }

  async add(type: string, bytes: Blob): Promise<Item> {
    const taken = TYPES.get(mime(type));

    if (!taken) {
      throw new Error(`the app doesn't send ${type}`);
    }

    const [kind, ext] = taken;
    const id = crypto.randomUUID();
    const file = join(this.dir, `${id}.${ext}`);
    await Bun.write(file, bytes);

    const converts = kind === "photo" && ext !== "jpg" && ext !== "png";

    try {
      const item =
        kind === "video"
          ? await this.clip(id, file)
          : converts
            ? await jpeg(file, join(this.dir, `${id}.jpg`)).then((still) => ({
                id,
                kind,
                images: [still],
                file: still,
              }))
            : { id, kind, images: [file], file };

      if (converts) {
        rmSync(file);
      }

      writeFileSync(join(this.dir, `${id}.json`), JSON.stringify(item));

      return item;
    } catch (error) {
      for (const name of readdirSync(this.dir)) {
        if (name.startsWith(id)) {
          rmSync(join(this.dir, name));
        }
      }

      throw error;
    }
  }

  get(id: string): Item | undefined {
    if (!/^[\w-]+$/u.test(id)) {
      return undefined;
    }

    try {
      return savedItem.parse(JSON.parse(readFileSync(join(this.dir, `${id}.json`), "utf-8")));
    } catch {
      return undefined;
    }
  }

  private async clip(id: string, file: string): Promise<Item> {
    const probe = probed.parse(
      JSON.parse(
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

    const item: Item = { id, kind: "video", images, file, seconds: Math.round(seconds) };

    if (probe.streams?.some((stream) => stream.codec_type === "audio") !== true) {
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
      process.stderr.write(`voice: ${id}'s sound didn't transcribe: ${String(error)}\n`);

      return item;
    } finally {
      rmSync(audio, { force: true });
    }
  }
}

export function line({ kind, images, seconds = 0, mute, words }: Item) {
  if (kind === "photo") {
    return "(photo)";
  }

  const clip = `(video ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}, ${images.length} ${images.length === 1 ? "still" : "stills"}`;

  if (mute === true) {
    return `${clip}, no sound)`;
  }

  return words !== undefined && words !== ""
    ? `${clip}; said in it: "${words.replaceAll(/\s+/gu, " ")}")`
    : `${clip}; no words came through from its sound)`;
}

export function counted(items: Item[]) {
  return (["photo", "video"] as const)
    .flatMap((kind) => {
      const count = items.filter((item) => item.kind === kind).length;

      return count === 0 ? [] : [count === 1 ? `a ${kind}` : `${count} ${kind}s`];
    })
    .join(" and ");
}

export function caption(text: string, items: Item[]) {
  return [text, ...items.map(line)].filter(Boolean).join("\n");
}

export function meta(items: Item[]) {
  if (!items.length) {
    return {};
  }

  return {
    image_path: items.flatMap((item) => item.images).join("; "),
    media: items.map((item) => `${item.kind} ${item.id}`).join("; "),
    files: items.map((item) => item.file ?? item.images[0] ?? "").join("; "),
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
