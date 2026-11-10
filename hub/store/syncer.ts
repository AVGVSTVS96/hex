import { Database } from "bun:sqlite";
import { closeSync, fsyncSync, openSync, readSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

import { z } from "zod";

const { db: path } = z.object({ db: z.string() }).parse(workerData);
const port = parentPort;

if (port === null) {
  throw new Error("the syncer runs as a worker of the store");
}

const CHECKPOINT_AT_FRAMES = 1000;

const db = new Database(path);

db.run("pragma busy_timeout = 30000");

let asked = 0;
let scheduled = false;

function fsyncFile(file: string) {
  let fd: number;

  try {
    fd = openSync(file, "r");
  } catch {
    return;
  }

  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// The wal-index header's mxFrame, the frames now in the WAL: https://www.sqlite.org/walformat.html#the_wal_index_file_format
function framesInWal() {
  const header = new Uint8Array(20);
  let fd: number;

  try {
    fd = openSync(`${path}-shm`, "r");
  } catch {
    return 0;
  }

  try {
    return readSync(fd, header, 0, 20, 0) === 20
      ? new DataView(header.buffer).getUint32(16, true)
      : 0;
  } finally {
    closeSync(fd);
  }
}

function sync() {
  const upTo = asked;

  fsyncFile(`${path}-wal`);
  port?.postMessage(upTo);

  if (framesInWal() >= CHECKPOINT_AT_FRAMES) {
    db.run("pragma wal_checkpoint(passive)");
  }

  scheduled = asked > upTo;

  if (scheduled) {
    setImmediate(sync);
  }
}

port.on("message", (upTo: number) => {
  asked = Math.max(asked, upTo);

  if (!scheduled) {
    scheduled = true;
    setImmediate(sync);
  }
});
