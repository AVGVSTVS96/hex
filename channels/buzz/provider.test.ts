import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { z } from "zod";

import { respond } from "./provider.ts";

// Recorded from Desktop's real deploy payload builder: https://github.com/block/buzz/blob/d839d3731a11ab363a69e7f5b851c3031b7680dd/crates/buzz-backend-kubernetes/tests/fixtures/provider-wire/deploy-full-launch.request.json
const fixture = {
  op: "deploy",
  request_id: "req-6",
  agent: {
    agent_args: [],
    agent_command: "goose",
    auth_tag: "tag-1",
    env_vars: { USER_KEY: "user-value" },
    idle_timeout_seconds: null,
    launch: {
      args: ["acp"],
      command: "goose",
      env: { GOOSE_MODEL: "gpt-5", GOOSE_PROVIDER: "openai", USER_KEY: "user-value" },
      owner_pubkey: "a".repeat(64),
      policy_env: {
        BUZZ_ACP_AGENTS: "10",
        BUZZ_ACP_DISPLAY_NAME: "worker",
        BUZZ_ACP_LAZY_POOL: "true",
        BUZZ_ACP_MODEL: "gpt-5",
        BUZZ_ACP_RELAY_OBSERVER: "true",
        BUZZ_ACP_SESSION_POLICY: "channel",
        BUZZ_ACP_SESSION_TITLE: "worker",
        GOOSE_MODE: "auto",
      },
    },
    max_turn_duration_seconds: null,
    model: "gpt-5",
    name: "worker",
    parallelism: 10,
    private_key_nsec: "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5",
    provider: "openai",
    relay_url: "wss://relay.example",
    respond_to: "allowlist",
    respond_to_allowlist: ["a".repeat(64), "b".repeat(64)],
    system_prompt: null,
    turn_timeout_seconds: 300,
  },
  provider_config: {
    namespace: "buzz-agents-test",
    image: `ghcr.io/block/buzz-sprig@sha256:${"a".repeat(64)}`,
    inactivity_seconds: 3600,
  },
};

const OWNER = getPublicKey(generateSecretKey());
const AUTH_TAG = JSON.stringify(["auth", OWNER, "", "ab".repeat(64)]);

let dir: string;
let home: string;
let ssh: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "provider-"));
  home = join(dir, "home", "hex");
  fakeHex(home);
  ssh = join(dir, "ssh");
  writeFileSync(
    ssh,
    `#!/bin/sh
jq -cn '$ARGS.positional' --args -- "$@" >> "${dir}/calls"
for last; do :; done
HOME="${join(dir, "home")}" exec sh -c "$last"
`,
  );
  chmodSync(ssh, 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeHex(hexHome: string) {
  mkdirSync(join(hexHome, ".hex", "bin"), { recursive: true });
  writeFileSync(
    join(hexHome, ".hex", "bin", "hex"),
    `#!/bin/sh
echo "$@" >> "${dir}/restarts"
echo "hex started; its log is state/hub.log"
`,
  );
  chmodSync(join(hexHome, ".hex", "bin", "hex"), 0o755);
}

type Fields = Record<string, string | null>;

function request(config?: Fields, agent: Fields = {}) {
  return JSON.stringify({
    ...fixture,
    agent: { ...fixture.agent, auth_tag: AUTH_TAG, ...agent },
    provider_config: config ?? { target: "me@box", home },
  });
}

function run(input: string) {
  const result = Bun.spawnSync(["bun", join(import.meta.dir, "provider.ts")], {
    stdin: new TextEncoder().encode(input),
  });

  return {
    code: result.exitCode,
    out: z.record(z.string(), z.unknown()).parse(JSON.parse(result.stdout.toString())),
    err: result.stderr.toString(),
  };
}

const envFile = () => join(home, "state", "buzz", ".env");
const permissionBits = (path: string) => statSync(path).mode % 0o1000;

const lines = (file: string) =>
  existsSync(file) ? readFileSync(file, "utf-8").trim().split("\n") : [];

test("info has exactly the fields Desktop accepts", () => {
  const { code, out } = run('{"op":"info","request_id":"req-1"}');
  expect(code).toBe(0);
  expect(Object.keys(out).toSorted()).toEqual([
    "config_schema",
    "description",
    "name",
    "ok",
    "protocol_version",
    "version",
  ]);
  expect(out).toMatchObject({
    ok: true,
    protocol_version: 1,
    config_schema: { required: ["target"] },
  });
});

test("deploy writes the credentials over ssh stdin and restarts hex", () => {
  expect(respond(request(), ssh)).toEqual({ ok: true, agent_id: `me@box:${home}` });
  expect(readFileSync(envFile(), "utf-8")).toBe(
    `BUZZ_RELAY_URL=wss://relay.example\nBUZZ_PRIVATE_KEY=${fixture.agent.private_key_nsec}\nBUZZ_AUTH_TAG=${AUTH_TAG}\n`,
  );
  expect(permissionBits(envFile())).toBe(0o600);
  expect(permissionBits(join(home, "state", "buzz"))).toBe(0o700);
  expect(lines(join(dir, "restarts"))).toEqual(["restart"]);
  expect(
    lines(join(dir, "calls")).map((line) => z.array(z.string()).parse(JSON.parse(line))),
  ).toEqual([["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "me@box", "sh -s"]]);
});

test("redeploys are idempotent and tighten a loose .env", () => {
  mkdirSync(join(home, "state", "buzz"), { recursive: true, mode: 0o755 });
  writeFileSync(envFile(), "OLD=1\n", { mode: 0o644 });
  const first = respond(request(), ssh);
  const written = readFileSync(envFile(), "utf-8");
  expect(respond(request(), ssh)).toEqual(first);
  expect(readFileSync(envFile(), "utf-8")).toBe(written);
  expect(readdirSync(join(home, "state", "buzz"))).toEqual([".env"]);
  expect(permissionBits(envFile())).toBe(0o600);
  expect(permissionBits(join(home, "state", "buzz"))).toBe(0o700);
  expect(lines(join(dir, "restarts"))).toEqual(["restart", "restart"]);
});

test("home defaults to ~/hex on the target", () => {
  expect(respond(request({ target: "me@box" }), ssh)).toEqual({
    ok: true,
    agent_id: "me@box:~/hex",
  });
  expect(respond(request({ target: "me@box", home: "" }), ssh)).toEqual({
    ok: true,
    agent_id: "me@box:~/hex",
  });
  expect(lines(join(dir, "restarts"))).toEqual(["restart", "restart"]);
  expect(permissionBits(envFile())).toBe(0o600);
});

test("a home with quotes and spaces is quoted for the remote shell", () => {
  const odd = join(dir, `it's "here" $HOME`, "hex");
  fakeHex(odd);
  expect(respond(request({ target: "me@box", home: odd }), ssh)).toEqual({
    ok: true,
    agent_id: `me@box:${odd}`,
  });
  expect(readFileSync(join(odd, "state", "buzz", ".env"), "utf-8")).toStartWith(
    "BUZZ_RELAY_URL=wss://relay.example\n",
  );
});

test("bad input is refused with ok:false and a non-zero exit", () => {
  const cases: [string, RegExp][] = [
    [JSON.stringify({ ...fixture, provider_config: { target: "me@box", home } }), /auth_tag/u],
    [request({ home }), /target/u],
    [request({ target: "-oProxyCommand=touch /tmp/x", home }), /target/u],
    [request(undefined, { auth_tag: JSON.stringify(["p", OWNER]) }), /auth_tag/u],
    [request(undefined, { auth_tag: null }), /auth_tag/u],
    [request(undefined, { private_key_nsec: nip19.npubEncode(OWNER) }), /private_key_nsec/u],
    [
      request(undefined, {
        private_key_nsec: `${nip19.nsecEncode(generateSecretKey())}\nBUZZ_X=1`,
      }),
      /private_key_nsec/u,
    ],
    [request(undefined, { relay_url: "https://relay.example" }), /relay_url/u],
    [request(undefined, { relay_url: "wss://relay.example\nBUZZ_X=1" }), /relay_url/u],
    ['{"op":"undeploy"}', /unknown op/u],
    ["not json", /./u],
  ];

  for (const [input, error] of cases) {
    const { code, out, err } = run(input);
    expect(code).toBe(1);
    expect(Object.keys(out)).toEqual(["ok", "error"]);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(error);
    expect(err).toContain(String(out.error));
  }

  expect(existsSync(join(home, "state"))).toBe(false);
});

test("a target without hex fails with the reason and writes nothing", () => {
  const nowhere = join(dir, "nowhere");
  expect(() => respond(request({ target: "me@box", home: nowhere }), ssh)).toThrow(
    `no hex at ${nowhere}/.hex/bin/hex`,
  );
  expect(existsSync(nowhere)).toBe(false);
});
