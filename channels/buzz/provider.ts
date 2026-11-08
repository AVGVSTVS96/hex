#!/usr/bin/env bun
import { nip19 } from "nostr-tools";
import { z } from "zod";

import { version } from "./package.json";

const info = {
  ok: true,
  name: "hex",
  version,
  protocol_version: 1,
  description: "Runs the agent as Hex on a machine you reach over SSH",
  config_schema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        title: "SSH destination",
        description: "The machine Hex runs on, as you would pass it to ssh, e.g. user@host",
      },
      home: {
        type: "string",
        title: "Hex folder",
        description: "Your hex folder on that machine",
        default: "~/hex",
      },
    },
    required: ["target"],
  },
};

const RELAY_URL = "agent.relay_url must be a ws:// or wss:// URL";
const NSEC = "agent.private_key_nsec must be an nsec";
const AUTH_TAG = 'agent.auth_tag must be a JSON ["auth", owner, conditions, sig] tag';
const TARGET = "provider_config.target must be an ssh destination, e.g. user@host";

const signedAuthTag = z.tuple([
  z.literal("auth"),
  z.string().regex(/^[0-9a-f]{64}$/u),
  z.string(),
  z.string(),
]);

const authTag = z.unknown().transform((value, context) => {
  let raw: unknown;

  try {
    raw = JSON.parse(String(value));
  } catch {
    raw = undefined;
  }

  const parsed = signedAuthTag.safeParse(raw);

  if (!parsed.success) {
    context.addIssue({ code: "custom", message: AUTH_TAG });

    return z.NEVER;
  }

  return parsed.data;
});

const anyObject = z.record(z.string(), z.unknown()).catch({});

const deployment = z.object({
  agent: anyObject.pipe(
    z.object({
      relay_url: z.string(RELAY_URL).regex(/^wss?:\/\/\S+$/u, RELAY_URL),
      private_key_nsec: z.string(NSEC).refine(isNsec, NSEC),
      auth_tag: authTag,
    }),
  ),
  provider_config: anyObject.pipe(
    z.object({
      target: z.string(TARGET).regex(/^[^-\s]\S*$/u, TARGET),
      home: z.string().trim().min(1).catch("~/hex"),
    }),
  ),
});

type Deployment = z.output<typeof deployment>;

export function respond(input: string, ssh = "/usr/bin/ssh") {
  const request = z.looseObject({ op: z.unknown().exactOptional() }).parse(JSON.parse(input));

  if (request.op === "info") {
    return info;
  }

  if (request.op === "deploy") {
    const parsed = deployment.safeParse(request);

    if (!parsed.success) {
      throw new Error(parsed.error.issues[0]?.message);
    }

    return { ok: true, agent_id: deploy(parsed.data, ssh) };
  }

  throw new Error(`unknown op ${JSON.stringify(request.op)}`);
}

function deploy({ agent, provider_config: config }: Deployment, ssh: string): string {
  const { relay_url, private_key_nsec, auth_tag: tag } = agent;
  const { target, home } = config;

  if (/[\n\r]/u.test(home)) {
    throw new Error("provider_config.home must be one line");
  }

  const script = `set -eu
home=${remotePath(home)}
hex="$home/.hex/bin/hex"
[ -x "$hex" ] || { echo "no hex at $hex" >&2; exit 1; }
umask 077
mkdir -p "$home/state/buzz"
chmod 700 "$home/state/buzz"
tmp=$(mktemp "$home/state/buzz/.env.XXXXXX")
cat > "$tmp" <<'EOF'
BUZZ_RELAY_URL=${relay_url}
BUZZ_PRIVATE_KEY=${private_key_nsec}
BUZZ_AUTH_TAG=${JSON.stringify(tag)}
EOF
chmod 600 "$tmp"
mv -f "$tmp" "$home/state/buzz/.env"
"$hex" restart </dev/null
`;

  const result = Bun.spawnSync(
    [ssh, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", target, "sh -s"],
    {
      stdin: new TextEncoder().encode(script),
    },
  );

  if (result.exitCode !== 0) {
    const reason = result.stderr.toString().trim() || `ssh exited with ${result.exitCode}`;
    throw new Error(`deploying to ${target}:${home} failed: ${reason}`);
  }

  return `${target}:${home}`;
}

function isNsec(value: string): boolean {
  try {
    return nip19.decode(value).type === "nsec";
  } catch {
    return false;
  }
}

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

function remotePath(path: string): string {
  if (path === "~") {
    return '"$HOME"';
  }

  if (path.startsWith("~/")) {
    return `"$HOME"/${quote(path.slice(2))}`;
  }

  return quote(path);
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(respond(await Bun.stdin.text())));
  } catch (error_) {
    const error = error_ instanceof Error ? error_.message : String(error_);
    console.log(JSON.stringify({ ok: false, error }));
    console.error(`buzz-backend-hex: ${error}`);
    process.exit(1);
  }
}
