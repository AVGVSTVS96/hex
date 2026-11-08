import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import type { FSWatcher } from "node:fs";
import { join, posix } from "node:path";
import { promisify } from "node:util";

import { decrypt, encrypt, getConversationKey } from "nostr-tools/nip44";
import { verifyEvent } from "nostr-tools/pure";
import type { Event } from "nostr-tools/pure";
import { z } from "zod";

import type { Relay } from "./relay.ts";

const ENGRAM = 30_174;
const FILE = 30_180;
const EDIT = 4180;
const RESULT = 4181;
const LIMIT = 65_535;
const SHARE = ["AGENTS.md", "SOUL.md", "schedules.json"];
const NOTES = "memory/LOG.txt";
const SETTLE = 500;
const RESYNC = 10 * 60_000;
const HEX64 = /^[0-9a-f]{64}$/u;

// oxlint-disable-next-line typescript/strict-void-return -- promisify takes execFile's callback form, which the rule misreads
const exec = promisify(execFile);
const now = () => Math.floor(Date.now() / 1000);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const tag = (event: Event, name: string) => event.tags.find(([key]) => key === name)?.[1];

function log(line: string) {
  process.stderr.write(`buzz hub: ${line}\n`);
}

const keepingLeadingBomForSha256 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const sharedPath = z.string().refine(valid);

const engram = z.looseObject({ slug: z.string() });

const fileRecord = z.union([
  z.looseObject({ path: sharedPath, removed: z.literal(true) }),
  z
    .looseObject({
      path: sharedPath,
      removed: z.never().optional(),
      sha256: z.string().regex(HEX64),
      size: z.int().min(0),
      content: z.string().optional(),
    })
    .refine(
      (body) =>
        body.content === undefined ||
        (Buffer.byteLength(body.content) === body.size &&
          sha256(Buffer.from(body.content)) === body.sha256),
    ),
]);

const editRequest = z.looseObject({
  path: sharedPath,
  base_sha256: z.string().regex(HEX64),
  content: z.string(),
});

// The memory panel is NIP-AE (https://github.com/block/buzz/blob/d839d3731a11ab363a69e7f5b851c3031b7680dd/docs/nips/NIP-AE.md) and Agent Files is NIP-AF (https://github.com/AVGVSTVS96/buzz/blob/8f9e4593dbaf029beed0490b3ca2e6464e536732/docs/nips/NIP-AF.md)
export function startMemory({
  relay,
  secretKey,
  owner,
  hexDir,
  share = SHARE,
}: {
  relay: Relay;
  secretKey: Uint8Array;
  owner: string;
  hexDir: string;
  share?: string[] | undefined;
}) {
  const key = getConversationKey(secretKey, owner);
  const engrams = book(ENGRAM, "agent-memory/v1/d-tag", engram, (body) => body.slug);
  const records = book(FILE, "agent-files/v1/d-tag", fileRecord, (body) => body.path);

  const shared = share
    .map((entry) => posix.normalize(entry).replace(/\/$/u, ""))
    .filter((entry) => {
      if (!valid(entry)) {
        log(`can't share ${entry}, paths stay inside the hex folder`);
      }

      return valid(entry);
    });

  const answered = new Set<string>();
  const watchers: FSWatcher[] = [];
  let queue = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sharing = true;
  let edits: (() => void) | undefined;
  let closed = false;

  function address(domain: string, name: string) {
    return createHmac("sha256", key).update(`${domain}\0${name}`).digest("hex");
  }

  function open<Body>(event: Event, schema: z.ZodType<Body>) {
    let text: string;
    let raw: unknown;

    try {
      if (!verifyEvent(event)) {
        return;
      }

      text = decrypt(event.content, key);
      raw = JSON.parse(text);
    } catch {
      return;
    }

    const parsed = schema.safeParse(raw);

    return parsed.success ? { text, body: parsed.data } : undefined;
  }

  function book<Body>(
    kind: number,
    domain: string,
    schema: z.ZodType<Body>,
    nameOf: (body: Body) => string,
  ) {
    const heads = new Map<string, { text: string; at: number; id: string }>();
    let loaded: Promise<void> | undefined;

    async function load() {
      for (const event of await relay.query([
        { kinds: [kind], authors: [relay.pubkey], "#p": [owner] },
      ])) {
        const opened = open(event, schema);

        if (!opened) {
          continue;
        }

        const name = nameOf(opened.body);

        if (address(domain, name) !== tag(event, "d")) {
          continue;
        }

        const head = heads.get(name);

        if (
          head &&
          (head.at > event.created_at || (head.at === event.created_at && head.id < event.id))
        ) {
          continue;
        }

        heads.set(name, { text: opened.text, at: event.created_at, id: event.id });
      }
    }

    async function put(name: string, body: Body) {
      const text = JSON.stringify(body);
      const head = heads.get(name);

      if (head?.text === text) {
        return;
      }

      if (Buffer.byteLength(text) > LIMIT) {
        log(`${name} is over 64 KB, so the Buzz panel doesn't get it`);

        return;
      }

      const event = await relay.publish({
        kind,
        content: encrypt(text, key),
        tags: [
          ["d", address(domain, name)],
          ["p", owner],
        ],
        created_at: Math.max(now(), (head?.at ?? 0) + 1),
      });

      heads.set(name, { text, at: event.created_at, id: event.id });
    }

    return {
      async sync(wanted: Map<string, Body>, gone: (name: string) => Body | undefined) {
        loaded ??= load();

        try {
          await loaded;
        } catch (error) {
          loaded = undefined;
          throw error;
        }

        for (const [name, body] of wanted) {
          await put(name, body);
        }

        for (const name of heads.keys()) {
          const body = wanted.has(name) ? undefined : gone(name);

          if (body !== undefined) {
            await put(name, body);
          }
        }
      },
    };
  }

  function read(path: string): string | undefined {
    try {
      return readFileSync(join(hexDir, path), "utf-8");
    } catch {
      return undefined;
    }
  }

  function memories() {
    const wanted = new Map<string, z.output<typeof engram>>();
    const soul = read("SOUL.md");

    if (soul !== undefined) {
      wanted.set("core", { slug: "core", profile: soul });
    }

    const notes = (read(NOTES) ?? "").matchAll(/^#\d+ (\d{4}-\d\d-\d\d) (.+?)\s*$/gmu);

    for (const [day, lines] of Map.groupBy(notes, ([, noteDay]) => noteDay ?? "")) {
      const slug = `mem/notes/${day}`;
      wanted.set(slug, { slug, value: lines.map((note) => `- ${note[2]}`).join("\n") });
    }

    return wanted;
  }

  function sharedFilesOnDisk() {
    const found = new Map<string, Buffer>();

    function visit(path: string) {
      if (!valid(path)) {
        return;
      }

      const full = join(hexDir, path);

      try {
        const stat = lstatSync(full);

        if (stat.isFile()) {
          found.set(path, readFileSync(full));
        }

        if (stat.isDirectory()) {
          for (const name of readdirSync(full)) {
            if (!name.startsWith(".")) {
              visit(`${path}/${name}`);
            }
          }
        }
        // oxlint-disable-next-line eslint/no-empty -- a path that is gone or unreadable is left out of the share
      } catch {}
    }

    for (const entry of shared) {
      visit(entry);
    }

    return new Map([...found].map(([path, bytes]) => [path, record(path, bytes)]));
  }

  function run(task: () => Promise<void>) {
    const previous = queue;

    queue = (async () => {
      await previous;

      if (closed) {
        return;
      }

      try {
        await task();
      } catch (error) {
        log(`memory: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }

  function later() {
    clearTimeout(timer);
    timer = setTimeout(sync, SETTLE);
  }

  function sync() {
    arm();
    run(() =>
      engrams.sync(memories(), (slug) => (slug === "core" ? undefined : { slug, value: null })),
    );
    run(publish);
  }

  async function publish() {
    if (!sharing) {
      return;
    }

    try {
      await records.sync(sharedFilesOnDisk(), (path) => ({ path, removed: true }));
    } catch (error) {
      if (!String(error).includes("unknown event kind")) {
        throw error;
      }

      sharing = false;

      log(
        `this relay doesn't take Agent Files yet (${error instanceof Error ? error.message : String(error)}), so shared files stay off`,
      );

      return;
    }

    edits ??= await listen();
  }

  async function listen() {
    for (const event of await relay.query([
      { kinds: [RESULT], authors: [relay.pubkey], "#p": [owner] },
    ])) {
      answered.add(tag(event, "e") ?? "");
    }

    if (closed) {
      return;
    }

    return relay.subscribe([{ kinds: [EDIT], authors: [owner], "#p": [relay.pubkey] }], (event) => {
      run(() => answer(event));
    });
  }

  // NIP-AF answers only a readable edit request addressed to this agent alone, so any other gets no result: https://github.com/AVGVSTVS96/buzz/blob/8f9e4593dbaf029beed0490b3ca2e6464e536732/docs/nips/NIP-AF.md#edit-requests
  async function answer(event: Event) {
    if (answered.has(event.id) || event.pubkey !== owner) {
      return;
    }

    const addressed = event.tags.filter(([name]) => name === "p");

    const request =
      addressed.length === 1 && addressed[0]?.[1] === relay.pubkey
        ? open(event, editRequest)?.body
        : undefined;

    if (!request) {
      answered.add(event.id);

      log(`ignored an unreadable edit request ${event.id}`);

      return;
    }

    const result = await edit(request);
    await relay.publish({
      kind: RESULT,
      content: encrypt(JSON.stringify(result), key),
      tags: [
        ["p", owner],
        ["e", event.id],
      ],
    });
    answered.add(event.id);
  }

  async function edit({ path, base_sha256: base, content }: z.output<typeof editRequest>) {
    const current = sharedFilesOnDisk().get(path);

    if (!current) {
      return { status: "declined", path, reason: "file is not shared" };
    }

    if (!("content" in current)) {
      return { status: "declined", path, reason: "file is too large or not text" };
    }

    if (current.sha256 !== base) {
      return { status: "conflict", path, sha256: current.sha256 };
    }

    const full = join(hexDir, path);
    const bytes = Buffer.from(content);
    const sha = sha256(bytes);
    writeFileSync(`${full}.tmp`, bytes, { mode: statSync(full).mode });
    renameSync(`${full}.tmp`, full);
    await commit(path);
    await publish();

    return { status: "applied", path, sha256: sha };
  }

  async function commit(path: string) {
    try {
      await exec("git", ["-C", hexDir, "rev-parse", "--git-dir"]);
    } catch {
      return;
    }

    try {
      await exec("git", ["-C", hexDir, "add", "--", path]);
      await exec("git", [
        "-C",
        hexDir,
        "commit",
        "-q",
        "-m",
        `chore(buzz): edit ${path}`,
        "--",
        path,
      ]);
    } catch (error) {
      log(
        `couldn't commit ${path}: ${error instanceof Error ? error.message.trim() : String(error)}`,
      );
    }
  }

  function arm() {
    for (const watcher of watchers.splice(0)) {
      watcher.close();
    }

    if (closed) {
      return;
    }

    const top = new Set(["SOUL.md", ...shared.map((entry) => entry.split("/")[0])]);
    follow("", false, (name) => top.has(name));
    follow(posix.dirname(NOTES), false, (name) => name === posix.basename(NOTES));

    for (const dir of shared) {
      follow(dir, true, () => true);
    }
  }

  function follow(dir: string, recursive: boolean, wanted: (name: string) => boolean) {
    const full = join(hexDir, dir);

    try {
      if (dir && !statSync(full).isDirectory()) {
        return;
      }

      const watcher = watch(full, { recursive }, (_, name) => {
        if (wanted(String(name))) {
          later();
        }
      });

      // oxlint-disable-next-line eslint/no-empty-function -- an FSWatcher error with no listener throws; the next resync watches again
      watcher.on("error", () => {});
      watchers.push(watcher);
      // oxlint-disable-next-line eslint/no-empty -- a folder that doesn't exist yet is watched on the next resync
    } catch {}
  }

  sync();
  const resync = setInterval(sync, RESYNC);

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      clearInterval(resync);

      for (const watcher of watchers.splice(0)) {
        watcher.close();
      }

      edits?.();
    },
  };
}

function record(path: string, bytes: Buffer) {
  const listed = { path, sha256: sha256(bytes), size: bytes.length };
  let content: string;

  try {
    content = keepingLeadingBomForSha256.decode(bytes);
  } catch {
    return listed;
  }

  const inlined = { ...listed, content };

  return Buffer.byteLength(JSON.stringify(inlined)) <= LIMIT ? inlined : listed;
}

function valid(path: string) {
  return (
    Buffer.byteLength(path) <= 255 &&
    !/[\\\p{Cc}]/u.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}
