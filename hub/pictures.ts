import { basename } from "node:path";

import type { Row } from "./store.ts";

export type Held = {
  name: string;
  type?: string;
  path?: string;
  telegram?: string;
  dimensions?: string;
};

const filled = (value?: string): value is string => value !== undefined && value !== "";

const each = (value?: string) => (value ?? "").split("; ");

const imageType = (path: string) => (path.endsWith(".png") ? "image/png" : "image/jpeg");

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The files a Telegram message holds, in the order Telegram shows them: photos the owner sent, kept on disk, then what hex sent, kept by Telegram under a file id.
export function held(row: Row): Held[] {
  const meta = row.meta ?? {};
  const images = each(meta.image_path).filter(Boolean);
  const kinds = each(meta.attachment_kind);
  const names = each(meta.attachment_name);
  const mimes = each(meta.attachment_mime);
  const attachmentSizes = each(meta.attachment_dimensions);
  const imageSizes = each(meta.image_dimensions);

  const attachments = each(meta.attachment_file_id).flatMap((telegram, at): Held[] => {
    const kind = kinds[at] ?? "";
    const mime = kind === "photo" ? "image/jpeg" : (mimes[at] ?? "");

    return telegram === ""
      ? []
      : [
          {
            name: [names[at], meta.file, kind].find(filled) ?? "file",
            telegram,
            ...(mime !== "" && { type: mime }),
            ...(filled(attachmentSizes[at]) && { dimensions: attachmentSizes[at] }),
          },
        ];
  });

  return [
    ...images.map((path, at) => ({
      name: basename(path),
      path,
      type: imageType(path),
      ...(filled(imageSizes[at]) && { dimensions: imageSizes[at] }),
    })),
    ...attachments,
  ];
}

export const fileOnly = (row: Row) =>
  (row.author === "hex" && row.body === `(file: ${row.meta?.file ?? ""})`) ||
  (row.author === "owner" && (row.body === "(photo)" || /^\(album of \d+\)$/u.test(row.body)));

const SENT = "sent-";

export const pictureId = (key: string, at: number) =>
  `${SENT}${Buffer.from(key).toString("base64url")}-${String(at)}`;

export function pictureOf(id: string): { key: string; at: number } | undefined {
  const [, key = "", at = ""] = /^sent-([\w-]+)-(\d+)$/u.exec(id) ?? [];

  return key === "" ? undefined : { key: Buffer.from(key, "base64url").toString(), at: Number(at) };
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The pictures a chat app's message holds, named so an app can ask for each by id.
export const pictures = (row: Row) =>
  held(row).flatMap(({ type, path }, at) =>
    type?.startsWith("image/") === true
      ? [{ id: pictureId(row.key, at), kind: "photo", ...(path !== undefined && { file: path }) }]
      : [],
  );
