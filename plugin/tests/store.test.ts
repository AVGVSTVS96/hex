import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HEX = join(import.meta.dir, "../..");
const BUNX = Bun.which("bunx") ?? "bunx";
const CURL = Bun.which("curl") ?? "curl";
const WORKERS_DEV = "https://hex-store.test.workers.dev";
const KEY = "k".repeat(40);

let root: string;
let home: string;
let hex: string;
let bin: string;
let store: ReturnType<typeof Bun.serve>;
let answering: (deployed: string) => string | null;

function script(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf-8") : "");

const git = (...args: string[]) =>
  Bun.spawnSync(
    ["git", "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { cwd: hex },
  )
    .stdout.toString()
    .trim();

function commit(fit: string, readme = "") {
  writeFileSync(join(hex, "hub/fit.ts"), `export const fit = ${JSON.stringify(fit)};\n`);
  writeFileSync(join(hex, "README.md"), readme);
  git("add", "-A");
  git("commit", "-qm", `${fit} ${readme}`);

  return git("rev-parse", "HEAD");
}

async function run(...args: string[]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.startsWith("HEX_") &&
        !name.startsWith("CLOUDFLARE_") &&
        name !== "CLAUDE_CODE_SESSION_ID",
    ),
  );

  const spawned = Bun.spawn(args, {
    env: {
      ...env,
      PATH: `${bin}:${process.env.PATH}`,
      XDG_STATE_HOME: join(root, "xdg-state"),
      XDG_CACHE_HOME: join(root, "cache"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [out, err, code] = await Promise.all([
    new Response(spawned.stdout).text(),
    new Response(spawned.stderr).text(),
    spawned.exited,
  ]);

  return { out, err, code };
}

const deploys = () =>
  read(join(root, "wrangler.log"))
    .split("\n")
    .filter((line) => line.startsWith("deploy "));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "store-"));
  home = join(root, "hex");
  hex = join(home, ".hex");
  bin = join(root, "stubs");
  mkdirSync(join(hex, "bin"), { recursive: true });
  mkdirSync(join(hex, "hub/store"), { recursive: true });
  mkdirSync(join(home, "state"));
  mkdirSync(bin);

  for (const path of ["bin/hex", "bin/settings", "bin/update", "hub/store/wrangler.jsonc"]) {
    cpSync(join(HEX, path), join(hex, path));
  }

  for (const stub of ["bin/check", "bin/optmem", "bin/migrate", "bin/wake"]) {
    script(join(hex, stub), "");
  }

  writeFileSync(join(hex, ".gitignore"), "node_modules/\nworktrees/\n");
  writeFileSync(join(hex, "package.json"), '{ "name": "hex-under-test", "private": true }\n');
  writeFileSync(
    join(hex, "hub/store/object.ts"),
    `import { DurableObject } from "cloudflare:workers";\nimport { fit } from "../fit.ts";\nexport class Records extends DurableObject {}\nexport default { fetch: () => new Response(fit) };\n`,
  );
  writeFileSync(join(home, ".env"), "TELEGRAM_BOT_TOKEN=test\nCLOUDFLARE_API_TOKEN=from-dotenv\n");

  const wranglerThatBuildsForRealAndDeploysToTheStoreBelow = join(bin, "bunx");
  script(
    wranglerThatBuildsForRealAndDeploysToTheStoreBelow,
    `case " $* " in *" --dry-run "*) exec ${BUNX} "$@" ;; esac
shift
echo "$*" >> ${root}/wrangler.log
echo "token $CLOUDFLARE_API_TOKEN" >> ${root}/wrangler.log
case $1 in
  secret)
    [ ! -e ${root}/secret-list-fails ] || { cat ${root}/secret-list-fails; exit 1; }
    [ -e ${root}/keys ] || { printf '%s\\n\\n%s\\n' '✘ [ERROR] Worker "hex-store" not found.' 'If this is a new Worker, run "wrangler deploy" first to create it.'; exit 1; }
    cat ${root}/keys ;;
  deploy)
    case " $* " in *" --secrets-file "*) cat > ${root}/secrets; echo '[{ "name": "KEY", "type": "secret_text" }]' > ${root}/keys ;; esac
    cp ${root}/deployed ${root}/before 2>/dev/null || :
    for arg; do case $arg in VERSION:*) printf %s "\${arg#VERSION:}" > ${root}/deployed ;; esac; done
    echo "  ${WORKERS_DEV}" ;;
  rollback) mv ${root}/before ${root}/deployed ;;
esac`,
  );
  const curlThatFindsTheWorkersOwnAddressHere = join(bin, "curl");
  script(
    curlThatFindsTheWorkersOwnAddressHere,
    `sed "s#${WORKERS_DEV}#$(cat ${root}/url)#" | exec ${CURL} "$@"`,
  );
  script(join(bin, "sleep"), "");

  answering = (deployed) => deployed;
  store = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);

      const key = existsSync(join(home, "state/store.json"))
        ? KEY
        : /^HEX_STORE_KEY=(.*)$/mu.exec(read(join(home, ".env")))?.[1];

      if (request.headers.get("authorization") !== `Bearer ${key}`) {
        return Response.json({ error: "hex's store takes only its owner's key" }, { status: 401 });
      }

      if (pathname !== "/hex/version") {
        return Response.json({ error: `hex's store has no ${pathname}` }, { status: 404 });
      }

      const version = answering(read(join(root, "deployed")));

      if (version === null) {
        return Response.json({ error: "hex's store can't open its records" }, { status: 503 });
      }

      return Response.json({ version, migrations: 1 });
    },
  });
  writeFileSync(join(root, "url"), store.url.origin);
});

afterEach(async () => {
  await store.stop(true);
  rmSync(root, { recursive: true, force: true });
});

function pointed() {
  writeFileSync(
    join(home, "state/store.json"),
    JSON.stringify({ url: store.url.origin, name: "hex", key: KEY }),
  );
}

function published() {
  Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", join(root, "origin.git")]);
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", join(root, "origin.git"));
}

const push = () => git("push", "-q", "origin", "main");

test("hex store deploy makes the store's key once, keeps it in .env, and sends it only on stdin, with the code, to a Worker that has none, then waits for the Worker to answer as what it deployed", async () => {
  published();
  commit("one");

  const first = await run(join(hex, "bin/hex"), "store", "deploy");
  expect(first.code).toBe(0);

  const [line, ...others] = read(join(home, ".env"))
    .split("\n")
    .filter((kept) => kept.startsWith("HEX_STORE_KEY="));

  const key = line?.slice("HEX_STORE_KEY=".length) ?? "";

  expect(others).toEqual([]);
  expect(key.length).toBeGreaterThanOrEqual(32);
  expect(JSON.parse(read(join(root, "secrets")))).toEqual({ KEY: key });
  expect(read(join(root, "wrangler.log"))).not.toContain(key);
  expect(first.out).toContain(
    `the store at ${WORKERS_DEV} answers as ${read(join(root, "deployed"))}`,
  );

  expect((await run(join(hex, "bin/hex"), "status")).out).toContain(
    `store: hex.db here; the Worker at ${WORKERS_DEV} answers, as ${read(join(root, "deployed"))}, ready for a move`,
  );

  rmSync(join(root, "secrets"));

  const again = await run(join(hex, "bin/hex"), "store", "deploy");
  expect(again.code).toBe(0);
  expect(read(join(home, ".env")).match(/HEX_STORE_KEY=/gu)).toHaveLength(1);
  expect(existsSync(join(root, "secrets"))).toBe(false);
  expect(deploys().at(-1)).not.toContain("--secrets-file");
}, 60_000);

test("a deploy from a machine with no key, to a Worker that answers to one, is refused, so no hub that uses the key is locked out", async () => {
  published();
  commit("one");
  writeFileSync(join(root, "keys"), '[{ "name": "KEY", "type": "secret_text" }]');

  const refused = await run(join(hex, "bin/hex"), "store", "deploy");
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("the Worker answers to a key already");

  writeFileSync(
    join(root, "secret-list-fails"),
    "✘ [ERROR] A request to the Cloudflare API failed: the route was not found.\n",
  );

  const unsure = await run(join(hex, "bin/hex"), "store", "deploy");
  expect(unsure.code).toBe(1);
  expect(unsure.err).toContain("the route was not found");
  expect(deploys()).toEqual([]);
  expect(read(join(home, ".env"))).not.toContain("HEX_STORE_KEY");
}, 60_000);

test("an update deploys nothing over a store built from a commit made after its own, or one that doesn't answer, and goes over one from a commit a squash merge left out of main", async () => {
  published();
  const before = commit("one");
  pointed();
  writeFileSync(join(root, "deployed"), `a newer store@${"f".repeat(40)}@9999999999`);
  const incoming = commit("two");
  push();
  git("reset", "-q", "--hard", before);

  const newer = await run(join(hex, "bin/update"), "--now");
  expect(newer.code).toBe(1);
  expect(newer.out).toContain(`was built from a commit made after this one (${"f".repeat(40)}@`);

  answering = () => null;
  const silent = await run(join(hex, "bin/update"), "--now");
  expect(silent.code).toBe(1);
  expect(silent.out).toContain("doesn't answer, so nothing deploys over it");
  expect(deploys()).toEqual([]);
  expect(git("rev-parse", "HEAD")).toBe(before);

  answering = (deployed) => deployed;
  writeFileSync(join(root, "deployed"), `a store from a squashed branch@${"e".repeat(40)}@1000`);
  expect((await run(join(hex, "bin/update"), "--now")).code).toBe(0);
  expect(git("rev-parse", "HEAD")).toBe(incoming);
  expect(deploys()).toHaveLength(1);
}, 60_000);

test("an update deploys the store the new hex is built with, with the token in the folder's .env, ships once the object hex points at answers as it, and deploys nothing when it already does", async () => {
  published();
  const before = commit("one");
  writeFileSync(join(root, "deployed"), "the store before");
  pointed();
  const incoming = commit("two");
  push();
  git("reset", "-q", "--hard", before);

  const update = await run(join(hex, "bin/update"), "--now");
  expect(update.code).toBe(0);
  expect(git("rev-parse", "HEAD")).toBe(incoming);
  const version = read(join(root, "deployed"));
  const [deployed, ...more] = deploys();
  expect(more).toEqual([]);
  expect(deployed).toStartWith(`deploy --config ${join(root, "cache")}/hex-check-`);
  expect(deployed).toEndWith(`/.hex/hub/store/wrangler.jsonc --var VERSION:${version}`);
  expect(version).toMatch(new RegExp(`@${incoming}@\\d+$`, "u"));
  expect(read(join(root, "wrangler.log"))).toContain("token from-dotenv");
  expect(existsSync(join(root, "secrets"))).toBe(false);

  const later = commit("two", "words only");
  push();
  git("reset", "-q", "--hard", incoming);
  expect((await run(join(hex, "bin/update"), "--now")).code).toBe(0);
  expect(git("rev-parse", "HEAD")).toBe(later);
  expect(deploys()).toHaveLength(1);
}, 60_000);

test("an update that finds hex up to date still deploys the store it's built with, as after a takeover that pulled hex ahead of its store", async () => {
  published();
  const head = commit("one");
  push();
  pointed();
  writeFileSync(join(root, "deployed"), "the store before");

  const update = await run(join(hex, "bin/update"), "--now");
  expect(update.code).toBe(0);
  expect(update.out).toContain(`up to date at ${head.slice(0, 7)}`);
  expect(deploys()).toHaveLength(1);
  expect(read(join(root, "deployed"))).toMatch(new RegExp(`@${head}@\\d+$`, "u"));

  expect((await run(join(hex, "bin/update"), "--now")).code).toBe(0);
  expect(deploys()).toHaveLength(1);
}, 60_000);

test("an update whose deployed store isn't the one hex points at, or doesn't answer as it, puts the store before it back and doesn't ship", async () => {
  published();
  const before = commit("one");
  writeFileSync(join(root, "deployed"), "the store before");
  pointed();
  const incoming = commit("two");
  push();
  git("reset", "-q", "--hard", before);
  answering = () => "a store elsewhere";

  const update = await run(join(hex, "bin/update"), "--now");
  expect(update.code).toBe(1);
  expect(update.out).toContain(
    `not updated: the store hex ${incoming.slice(0, 7)} needs didn't deploy`,
  );
  expect(update.out).toContain("within a minute: the store before it is back");
  expect(read(join(root, "wrangler.log"))).toContain("rollback");
  expect(read(join(root, "deployed"))).toBe("the store before");
  expect(git("rev-parse", "HEAD")).toBe(before);
}, 60_000);

test("hex status says whether the store hex points at answers", async () => {
  pointed();
  writeFileSync(join(root, "deployed"), "the store now");
  expect((await run(join(hex, "bin/hex"), "status")).out).toContain(
    `store: ${store.url.origin} answers, as the store now`,
  );

  answering = () => null;
  expect((await run(join(hex, "bin/hex"), "status")).out).toContain(
    `store: ${store.url.origin} doesn't answer, so the hub waits for it`,
  );
});

test("a move that ends after it wrote store.json counts as moved, and one that ends before it doesn't", async () => {
  const moveThatEnds = (afterStoreJson: boolean) => {
    writeFileSync(
      join(hex, "hub/store/move.ts"),
      `import { writeFileSync } from "node:fs";\n${afterStoreJson ? `writeFileSync(process.argv[2] + "/store.json", "{}");\n` : ""}process.exit(1);\n`,
    );
  };

  moveThatEnds(false);
  const before = await run(join(hex, "bin/hex"), "store", "move", WORKERS_DEV, "hex");
  expect(before.code).toBe(1);

  moveThatEnds(true);
  const after = await run(join(hex, "bin/hex"), "store", "move", WORKERS_DEV, "hex");
  expect(after.code).toBe(0);
  expect(after.err).toContain("hex's records are in the object");
});

test("hex store back takes the records back from the object alone, as the move does, and does nothing where they're in hex.db already", async () => {
  writeFileSync(
    join(hex, "hub/store/back.ts"),
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(join(root, "backs"))}, process.argv[2] + "\\n");\n`,
  );

  const already = await run(join(hex, "bin/hex"), "store", "back");
  expect(already.code).toBe(0);
  expect(already.out).toContain("hex's records are in state/hex.db already");
  expect(read(join(root, "backs"))).toBe("");

  pointed();

  const back = await run(join(hex, "bin/hex"), "store", "back");
  expect(back.code).toBe(0);
  expect(read(join(root, "backs"))).toBe(`${join(home, "state")}\n`);

  const lock = Bun.spawn(["flock", "-s", join(home, "state/records.lock"), "sleep", "30"]);

  try {
    await Bun.sleep(200);

    const running = await run(join(hex, "bin/hex"), "store", "back");
    expect(running.code).toBe(1);
    expect(running.err).toContain("hex is running here: stop it first");
  } finally {
    lock.kill();
  }

  expect(read(join(root, "backs"))).toBe(`${join(home, "state")}\n`);
});

test("a move is refused while hex runs on another machine, or is moving there", async () => {
  const marker = join(root, "xdg-state/hex/elsewhere");
  mkdirSync(join(root, "xdg-state/hex"), { recursive: true });
  writeFileSync(marker, "another-machine\n");
  const away = await run(join(hex, "bin/hex"), "store", "move", store.url.origin, "hex");
  expect(away.code).toBe(1);
  expect(away.err).toContain("hex runs on another-machine");
  writeFileSync(marker, "");
  const moving = await run(join(hex, "bin/hex"), "store", "move", store.url.origin, "hex");
  expect(moving.code).toBe(1);
  expect(moving.err).toContain("hex is moving between machines");
}, 120_000);
