import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { caption, counted, line, Media, meta, typed } from "./media.ts";

const ffmpeg = Bun.which("ffmpeg") !== null;
let dir: string;
let heard: string[];
let media: Media;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "media-"));
  heard = [];
  media = new Media(join(dir, "media"), async (recording) => {
    heard.push(await recording());

    return "look at the crack here";
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function clip(seconds: number, sound: boolean) {
  const file = join(dir, `clip-${sound}.mp4`);

  const input = [
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=320x240:rate=10:duration=${seconds}`,
    ...(sound ? ["-f", "lavfi", "-i", `sine=duration=${seconds}`] : []),
  ];

  await Bun.spawn(["ffmpeg", "-v", "error", ...input, "-pix_fmt", "yuv420p", "-shortest", file])
    .exited;

  return Bun.file(file);
}

test("a photo is kept as it came, and found again by its id", async () => {
  const item = await media.add("image/png", new Blob(["png bytes"]));
  expect(item.kind).toBe("photo");
  expect(item.images.map((image) => readFileSync(image, "utf-8"))).toEqual(["png bytes"]);
  expect(media.get(item.id)).toEqual(item);
  expect(media.get("../media")).toBeUndefined();
  expect(media.get("nothing")).toBeUndefined();
});

test("only photos and videos the app sends are taken", () => {
  expect(
    [
      "image/jpeg",
      "image/png",
      "image/heic",
      "image/gif",
      "image/webp",
      "image/tiff",
      "image/avif",
      "video/mp4",
      "video/quicktime; codecs=hvc1",
    ].every((type) => Media.takes(type)),
  ).toBe(true);
  expect(["image/bmp", "application/pdf", null].some((type) => Media.takes(type))).toBe(false);
});

test.skipIf(!ffmpeg)("a photo Claude can't read, like WebP, becomes a JPEG", async () => {
  const webp = join(dir, "still.webp");
  Bun.spawnSync([
    "ffmpeg",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=32x32",
    "-frames:v",
    "1",
    webp,
  ]);
  const item = await media.add("image/webp", Bun.file(webp));
  expect(item.images).toEqual([join(dir, "media", `${item.id}.jpg`)]);
  expect(readdirSync(join(dir, "media")).toSorted()).toEqual([`${item.id}.jpg`, `${item.id}.json`]);
});

test("what a call was sent is named in a few words", () => {
  const photo = { id: "p", kind: "photo" as const, images: [] };
  const video = { id: "v", kind: "video" as const, images: [] };
  expect(counted([photo])).toBe("a photo");
  expect(counted([photo, photo, video])).toBe("2 photos and a video");
});

test.skipIf(!ffmpeg)(
  "a clip becomes stills across it and the words said in it",
  async () => {
    const item = await media.add("video/mp4", await clip(12, true));
    expect(item).toMatchObject({ kind: "video", seconds: 12, words: "look at the crack here" });
    expect(item.images.map((image) => existsSync(image))).toEqual([true, true]);
    expect(heard).toHaveLength(1);
    expect(heard.map((recording) => existsSync(recording))).toEqual([false]);
    expect(line(item)).toBe('(video 0:12, 2 stills; said in it: "look at the crack here")');
  },
  30_000,
);

test.skipIf(!ffmpeg)(
  "a clip without sound says so, and nothing is transcribed",
  async () => {
    const item = await media.add("video/mp4", await clip(3, false));
    expect(item).toMatchObject({ seconds: 3, mute: true });
    expect(item.images).toHaveLength(1);
    expect(heard).toEqual([]);
    expect(line(item)).toBe("(video 0:03, 1 still, no sound)");
  },
  30_000,
);

test.skipIf(!ffmpeg)("a file that isn't the video it says leaves nothing behind", async () => {
  const refused = await media.add("video/mp4", new Blob(["not a video"])).then(
    () => false,
    () => true,
  );

  expect(refused).toBe(true);
  expect(readdirSync(join(dir, "media"))).toEqual([]);
});

test("a message's words come first, a line for each item after them, and every image in its meta", () => {
  const photo = { id: "p1", kind: "photo" as const, images: ["/m/p1.jpg"] };

  const video = {
    id: "v1",
    kind: "video" as const,
    images: ["/m/v1-1.jpg", "/m/v1-2.jpg"],
    seconds: 75,
  };

  const body = caption("which one?\nthe left?", [photo, video]);
  expect(body).toBe(
    "which one?\nthe left?\n(photo)\n(video 1:15, 2 stills; no words came through from its sound)",
  );
  expect(typed(body, 2)).toBe("which one?\nthe left?");
  expect(typed(caption("", [photo]), 1)).toBe("");
  expect(meta([photo, video])).toEqual({
    image_path: "/m/p1.jpg; /m/v1-1.jpg; /m/v1-2.jpg",
    media: "photo p1; video v1",
  });
  expect(meta([])).toEqual({});
});
