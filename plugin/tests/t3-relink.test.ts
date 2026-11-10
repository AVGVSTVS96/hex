import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RELINK = join(import.meta.dir, "../../bin/t3-relink");
const ID = "5e1f0000-0000-4000-8000-000000000000";

let root: string;
let bin: string;
let other: string;

const script = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t3-relink-"));
  bin = join(root, "bin");
  other = join(root, "other");
  mkdirSync(bin);
  mkdirSync(join(other, ".t3-hex/userdata"), { recursive: true });
  mkdirSync(join(other, ".t3-hex/runtime/versions/1.0"), { recursive: true });
  writeFileSync(join(other, ".t3-hex/userdata/environment-id"), `${ID}\n`);

  script(
    join(bin, "ssh"),
    `while [ "$1" = -o ]; do shift 2; done; echo "$1" > "${root}/host"; shift; HOME="${other}" exec sh -c "$*"`,
  );
  script(
    join(other, ".t3-hex/runtime/versions/1.0/t3"),
    `echo "$@" > "${root}/paired"; echo "Pair with this code"; echo "Token: c0de"`,
  );
  mkdirSync(join(other, ".t3-hex/runtime/versions/2.0"));
  script(join(other, ".t3-hex/runtime/versions/2.0/t3"), `echo "Token: not-the-service"`);
  writeFileSync(
    join(other, ".t3-hex/runtime/service-state.json"),
    JSON.stringify({ protocol: 3, activeVersion: "1.0" }, null, 2),
  );
  script(
    join(bin, "t3"),
    `case "$1 $2" in
  "environment list") cat "${root}/links.json" ;;
  "environment link") echo "$@" > "${root}/linked"; sed 's/2026-12-01/2026-12-25/' "${root}/links.json" > "${root}/next"; mv "${root}/next" "${root}/links.json" ;;
esac`,
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const links = (environmentId: string) => {
  writeFileSync(
    join(root, "links.json"),
    JSON.stringify([
      {
        environmentId,
        urls: ["https://other.example:3774"],
        expiresAt: "2026-12-01T09:00:00.000Z",
      },
    ]),
  );
};

const relink = () =>
  Bun.spawnSync([RELINK, "other"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });

test("t3-relink links again to the other machine's hex T3 Code with a pairing code from the t3 its service runs, and says when it ends", () => {
  links(ID);
  const run = relink();

  expect(run.stderr.toString()).toBe("");
  expect(run.stdout.toString()).toBe("linked to other until 2026-12-25T09:00:00.000Z\n");
  expect(readFileSync(join(root, "host"), "utf-8")).toBe("other\n");
  expect(readFileSync(join(root, "paired"), "utf-8")).toStartWith(
    `pair --base-dir ${join(other, ".t3-hex")} --label `,
  );
  expect(readFileSync(join(root, "linked"), "utf-8")).toBe(
    "environment link https://other.example:3774 --pairing-code c0de --access full-access\n",
  );
});

test("t3-relink fails without pairing when this machine has no link to that T3 Code", () => {
  links("another-environment");
  const run = relink();

  expect(run.exitCode).toBe(1);
  expect(run.stderr.toString()).toBe("t3-relink: no link to other's hex T3 Code here\n");
  expect(() => readFileSync(join(root, "paired"))).toThrow();
});
