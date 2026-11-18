import { Database } from "bun:sqlite";
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { difference } from "./carry.ts";
import type { Read } from "./carry.ts";
import { awayFile, remote } from "./remote.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Brings a folder's records back from its Durable Object into a hex.db, and proves every row came before the folder stops pointing hex at the object. hex is stopped first. The claim makes any other machine's hub lost from then on. The hex.db is in place before store.json goes aside, so no process ever finds the folder with neither. Anything that fails leaves hex on the object, and running it again starts over.
export async function back(dir: string, say: (line: string) => void) {
  const store = remote(dir, undefined, false);
  const file = join(dir, "hex.db");

  if (store === undefined) {
    if (existsSync(file)) {
      say(`hex runs on ${file} already`);

      return;
    }

    throw new Error(`${awayFile(dir)} isn't there, and neither is ${file}`);
  }

  say(`claimed hex as tenure ${await store.claim()}`);

  const copy = join(dir, "hex.db.back");
  await store.copy(copy);
  const db = new Database(copy, { readonly: true });

  try {
    const here: Read = async (text) => await Promise.resolve(db.query(text).all());
    const there: Read = async (text) => await store.read(text);
    const differs = await difference(here, there, say);

    if (differs !== undefined) {
      throw new Error(
        `the copy isn't the object's records (${differs}): hex stays on the object, and running this again starts over`,
      );
    }
  } finally {
    db.close();
  }

  if (existsSync(file)) {
    const stamp = new Date().toISOString().replaceAll(/\D/gu, "").slice(0, 14);

    for (const end of ["", "-wal"]) {
      if (existsSync(`${file}${end}`)) {
        renameSync(`${file}${end}`, `${file}.${stamp}${end}`);
      }
    }

    rmSync(`${file}-shm`, { force: true });
    say(`the hex.db that was here is kept as hex.db.${stamp}`);
  }

  renameSync(copy, file);
  renameSync(awayFile(dir), `${awayFile(dir)}.back`);
  say(`hex's records are in ${file}, and ${awayFile(dir)}.back keeps the object's address`);
}

if (import.meta.main) {
  const [dir] = process.argv.slice(2);

  if (dir === undefined) {
    throw new Error("usage: bun hub/store/back.ts <hex's state folder>");
  }

  await back(dir, console.log);
}
