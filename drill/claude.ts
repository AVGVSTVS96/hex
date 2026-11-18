import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

// Claude Code as hex drives it, for the drill. `claude --bg` starts a background session as a job that `claude agents --json`, `stop`, `rm` and `respawn` take: https://code.claude.com/docs/en/agent-view#manage-sessions-from-the-shell
// A session runs its plugin's hooks with the inputs Claude Code gives them (https://code.claude.com/docs/en/hooks), connects to its channel's MCP server, and takes each channel message as a turn: https://code.claude.com/docs/en/channels-reference
// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Its model is the drill's: it answers each message with the reply tool, "answer to: <the message>", and holds its answer while the drill's hold file is there.

const VERSION = "2.1.327";
const config = process.env.CLAUDE_CONFIG_DIR ?? "";

if (config === "" || !existsSync(config)) {
  throw new Error(
    "the drill's claude runs only in a sandbox made for it, named by CLAUDE_CONFIG_DIR",
  );
}

const jobs = join(config, "jobs");
const hold = join(config, "hold");
const failed = join(config, "hooks.failed");

const JobRecord = z.object({
  sessionId: z.string(),
  respawnFlags: z.array(z.string()),
  cwd: z.string(),
  startedAt: z.number(),
  pid: z.number().optional(),
});

type Job = z.infer<typeof JobRecord>;

const Settings = z.object({ env: z.record(z.string(), z.string()).default({}) });

const Hook = z.object({
  command: z.string(),
  timeout: z.number().optional(),
  async: z.boolean().optional(),
});

const Hooks = z.object({
  hooks: z.record(
    z.string(),
    z.array(z.object({ matcher: z.string().optional(), hooks: z.array(Hook) })),
  ),
});

const McpJson = z.object({
  mcpServers: z.record(
    z.string(),
    z.object({ url: z.string(), headers: z.record(z.string(), z.string()).default({}) }),
  ),
});

const Added = z.object({ hookSpecificOutput: z.object({ additionalContext: z.string() }) });

const Inbound = z.object({
  content: z.string(),
  meta: z.record(z.string(), z.string()).default({}),
});

const Prompted = z.object({ type: z.literal("user"), message: z.object({ content: z.string() }) });

const TAGS = /<channel source="[^"]*"[^>]*>\n([\s\S]*?)\n<\/channel>/gu;

const VALUED = new Set([
  "--settings",
  "--channels",
  "--name",
  "--resume",
  "--model",
  "--effort",
  "--plugin-dir",
  "--permission-mode",
  "--add-dir",
  "--append-system-prompt",
  "--mcp-config",
  "--system-prompt-file",
  "--disallowedTools",
]);

const jobFile = (id: string) => join(jobs, id, "state.json");
const read = (id: string): Job => JobRecord.parse(JSON.parse(readFileSync(jobFile(id), "utf-8")));

function write(id: string, job: Job) {
  mkdirSync(join(jobs, id), { recursive: true });
  writeFileSync(jobFile(id), JSON.stringify(job));
}

function alive(pid: number | undefined) {
  try {
    return pid !== undefined && process.kill(pid, 0);
  } catch {
    return false;
  }
}

function drillRuns() {
  try {
    return alive(Number(readFileSync(join(config, "runner"), "utf-8")));
  } catch {
    return false;
  }
}

const ids = () =>
  existsSync(jobs) ? readdirSync(jobs).filter((id) => existsSync(jobFile(id))) : [];

const find = (id: string) =>
  ids().find((each) => each === id || read(each).sessionId.startsWith(id));

function parse(argv: string[]) {
  const flags = new Map<string, string>();
  const positional: string[] = [];

  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at] ?? "";

    if (VALUED.has(arg)) {
      flags.set(arg, argv[++at] ?? "");
    } else if (arg.startsWith("--")) {
      flags.set(arg, "");
    } else {
      positional.push(arg);
    }
  }

  return { flags, prompt: positional.at(-1) };
}

function launch(id: string) {
  const job = read(id);
  const log = openSync(join(jobs, id, "log"), "a");

  const child = Bun.spawn([process.execPath, import.meta.path, "--session", id], {
    cwd: job.cwd,
    stdio: ["ignore", log, log],
  });

  closeSync(log);
  child.unref();
  write(id, { ...job, pid: child.pid });
}

async function stopped(id: string) {
  const { pid } = read(id);

  if (pid !== undefined && alive(pid)) {
    process.kill(pid, "SIGTERM");
  }

  while (alive(pid)) {
    await Bun.sleep(20);
  }
}

const attribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

const contents = (text: string) =>
  [...text.matchAll(TAGS)].map(([, held = ""]) => held.replaceAll("<\\/channel>", "</channel>"));

type HookFields = {
  source?: string;
  model?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: { text: string };
  tool_response?: object;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
};

type Session = {
  id: string;
  job: Job;
  env: Record<string, string | undefined>;
  plugin: string;
  cwd: string;
  transcript: string;
};

// Every hook an event's matchers select runs at once, with the event's input on stdin; exit 2 blocks a prompt, and any other exit but 0 is a hook that failed, which Claude Code shows its user and the drill is told of: https://code.claude.com/docs/en/hooks#hook-input-and-output
async function hooks(
  { job, env, plugin, cwd, transcript }: Session,
  event: string,
  fields: HookFields,
  subject = "",
) {
  const configured =
    Hooks.parse(JSON.parse(readFileSync(join(plugin, "hooks", "hooks.json"), "utf-8"))).hooks[
      event
    ] ?? [];

  const selected = configured
    .filter(
      ({ matcher = "" }) => matcher === "" || new RegExp(`^(?:${matcher})$`, "u").test(subject),
    )
    .flatMap((group) => group.hooks);

  const input = JSON.stringify({
    session_id: job.sessionId,
    transcript_path: transcript,
    cwd,
    permission_mode: "bypassPermissions",
    hook_event_name: event,
    ...fields,
  });

  const ran = await Promise.all(
    selected.map(async (hook) => {
      const child = Bun.spawn(["sh", "-c", hook.command], {
        cwd,
        env: { ...env, CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_PROJECT_DIR: cwd },
        stdin: new Blob([input]),
        stdout: "pipe",
        stderr: "pipe",
        timeout: (hook.timeout ?? 600) * 1000,
      });

      const ended = Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]).then(([code, out, err]) => {
        process.stderr.write(err);

        if (code !== 0 && code !== 2) {
          appendFileSync(
            failed,
            `${event}: \`${hook.command}\` exited ${code}: ${err.trim().split("\n").at(-1) ?? ""}\n`,
          );
        }

        return { code, out };
      });

      return hook.async === true ? { code: 0, out: "" } : await ended;
    }),
  );

  const added = ran.map(({ out }) => {
    try {
      return Added.parse(JSON.parse(out)).hookSpecificOutput.additionalContext;
    } catch {
      return "";
    }
  });

  return { blocked: ran.some(({ code }) => code === 2), added: added.join("\n") };
}

// Claude Code retries a remote server's first connection up to three times, and reconnects one that drops up to five times, a second apart and doubling: https://code.claude.com/docs/en/mcp#automatic-reconnection
function channelOf(
  { id, env }: Session,
  url: string,
  headers: Record<string, string>,
  heard: (message: z.infer<typeof Inbound>) => void,
) {
  const expand = (text: string) =>
    text.replaceAll(
      /\$\{(\w+)(?::-([^}]*))?\}/gu,
      (_, name: string, fallback?: string) => env[name] ?? fallback ?? "",
    );

  const open = async () => {
    const client = new Client({ name: "claude-code", version: VERSION });

    client.fallbackNotificationHandler = async ({ method, params }) => {
      if (method === "notifications/tools/list_changed") {
        await client.listTools();
      } else if (method === "notifications/claude/channel") {
        heard(Inbound.parse(params));
      }
    };

    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the MCP client takes one error handler, as a property
    client.onerror = (error) => {
      if (error.message.includes("Maximum reconnection attempts")) {
        dropped(client);
      }
    };

    const transport = new StreamableHTTPClientTransport(new URL(expand(url)), {
      requestInit: {
        headers: Object.fromEntries(
          Object.entries(headers).map(([name, value]) => [name, expand(value)]),
        ),
      },
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
    });

    await client.connect(transport);
    await client.listTools();
    writeFileSync(join(jobs, id, "channel"), transport.sessionId ?? "");

    return client;
  };

  const reach = async (delays: number[]) => {
    for (const delay of delays) {
      await Bun.sleep(delay);
      const client = await open().catch(() => null);

      if (client !== null) {
        return client;
      }
    }

    return null;
  };

  let connection = reach([0, 1000, 2000, 4000]);

  const dropped = (client: Client) => {
    void (async () => {
      if ((await connection) === client) {
        void client.close();
        connection = reach([1000, 2000, 4000, 8000, 16_000]);
      }
    })();
  };

  return {
    reply: async (text: string) => {
      const client = await connection;

      if (client === null) {
        return {
          isError: true,
          content: [{ type: "text", text: "No such tool available: reply" }],
        };
      }

      try {
        return await client.callTool({
          name: "reply",
          arguments: { text },
          _meta: { "claudecode/toolUseId": `toolu_${randomBytes(12).toString("hex")}` },
        });
      } catch (error) {
        dropped(client);

        return { isError: true, content: [{ type: "text", text: String(error) }] };
      }
    },
  };
}

async function session(id: string) {
  const job = read(id);
  const { flags, prompt } = parse(job.respawnFlags);
  const given = flags.get("--settings") ?? "{}";

  const settings = Settings.parse(
    JSON.parse(given.startsWith("{") ? given : readFileSync(given, "utf-8")),
  );

  const cwd = process.cwd();

  const transcript = join(
    config,
    "projects",
    cwd.replaceAll(/[^a-zA-Z0-9]/gu, "-"),
    `${job.sessionId}.jsonl`,
  );

  const self: Session = {
    id,
    job,
    env: { ...process.env, ...settings.env },
    plugin: flags.get("--plugin-dir") ?? "",
    cwd,
    transcript,
  };

  const resumed = flags.has("--resume") && !flags.has("--fork-session");
  mkdirSync(dirname(transcript), { recursive: true });

  const record = (type: "user" | "assistant", content: string) => {
    const message =
      type === "user"
        ? { role: type, content }
        : {
            role: type,
            content: [{ type: "text", text: content }],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 10,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 5,
            },
          };

    appendFileSync(
      transcript,
      `${JSON.stringify({ type, message, uuid: crypto.randomUUID(), sessionId: job.sessionId, cwd, timestamp: new Date().toISOString(), isSidechain: false })}\n`,
    );
  };

  const cut = existsSync(transcript)
    ? Prompted.safeParse(
        JSON.parse(readFileSync(transcript, "utf-8").trim().split("\n").at(-1) ?? "{}"),
      ).data
    : undefined;

  await hooks(
    self,
    "SessionStart",
    { source: resumed ? "resume" : "startup", model: "drill" },
    resumed ? "resume" : "startup",
  );

  const name = /^plugin:([^@]+)@/u.exec(flags.get("--channels") ?? "")?.[1] ?? "";

  const mcp = McpJson.parse(
    JSON.parse(readFileSync(join(self.plugin, "..", "channels", name, ".mcp.json"), "utf-8")),
  ).mcpServers[name];

  const inbox: z.infer<typeof Inbound>[] = [];
  let arrival = Promise.withResolvers<boolean>();

  const channel = channelOf(self, mcp?.url ?? "", mcp?.headers ?? {}, (message) => {
    inbox.push(message);
    arrival.resolve(true);
  });

  const answer = async (messages: string[]) => {
    while (existsSync(hold)) {
      await Bun.sleep(50);
    }

    let said = "ok";

    for (let content = messages.shift(); content !== undefined; content = messages.shift()) {
      said = `answer to: ${content}`;
      const tool_name = `mcp__plugin_${name}_${name}__reply`;
      const tool_input = { text: said };
      await hooks(self, "PreToolUse", { tool_name, tool_input }, tool_name);
      const response = await channel.reply(said);

      if (response.isError === true) {
        console.error(`the reply tool failed: ${JSON.stringify(response.content)}`);
      }

      const event = response.isError === true ? "PostToolUseFailure" : "PostToolUse";
      messages.push(
        ...contents(
          (await hooks(self, event, { tool_name, tool_input, tool_response: response }, tool_name))
            .added,
        ),
      );
    }

    record("assistant", said);
    await hooks(self, "Stop", { stop_hook_active: false, last_assistant_message: said });
  };

  const turn = async (text: string) => {
    if (!(await hooks(self, "UserPromptSubmit", { prompt: text })).blocked) {
      record("user", text);
      await answer(contents(text));
    }
  };

  setInterval(() => {
    arrival.resolve(true);
  }, 60_000);

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A session outlives its hub, as Claude Code's does, and is no child of the drill, so what stops the drill and its leash by their process tree leaves it running: it ends itself once the drill that made its sandbox is gone.
  setInterval(() => {
    if (!drillRuns()) {
      process.exit(0);
    }
  }, 5000);

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A session restarted in place mid-turn runs that turn again, as hex counts on it to (hub/sessions.ts, channelOrRestart).
  if (resumed && cut !== undefined) {
    await answer(contents(cut.message.content));
  }

  if (prompt !== undefined) {
    await turn(prompt);
  }

  for (;;) {
    const next = inbox.shift();

    if (next === undefined) {
      await arrival.promise;
      arrival = Promise.withResolvers<boolean>();
    } else {
      await turn(
        `<channel source="${name}"${Object.entries(next.meta)
          .map(([key, value]) => ` ${key}="${attribute(value)}"`)
          .join("")}>\n${next.content}\n</channel>`,
      );
    }
  }
}

const argv = process.argv.slice(2);
const [command = "", target = ""] = argv;

if (command === "--version") {
  console.log(`${VERSION} (Claude Code)`);
} else if (command === "daemon") {
  console.log(target === "status" ? `version: ${VERSION}` : "");
} else if (command === "agents") {
  console.log(
    JSON.stringify(
      ids().flatMap((id) => {
        const { sessionId, pid, startedAt } = read(id);

        return alive(pid) ? [{ id, sessionId, pid, status: "idle", startedAt }] : [];
      }),
    ),
  );
} else if (command === "stop" || command === "kill") {
  const id = find(target);

  if (id !== undefined) {
    await stopped(id);
  }
} else if (command === "rm") {
  const id = find(target);

  if (id !== undefined && !alive(read(id).pid)) {
    rmSync(join(jobs, id), { recursive: true, force: true });
  }
} else if (command === "respawn") {
  const id = find(target);

  if (id !== undefined) {
    await stopped(id);
    launch(id);
  }
} else if (command === "--session") {
  await session(target);
} else if (argv.includes("--bg")) {
  const respawnFlags = argv.filter((arg) => arg !== "--bg");
  const { flags } = parse(respawnFlags);
  const resumed = flags.get("--resume");
  const id = randomBytes(4).toString("hex");

  const sessionId =
    resumed !== undefined && !flags.has("--fork-session") ? resumed : crypto.randomUUID();

  write(id, { sessionId, respawnFlags, cwd: process.cwd(), startedAt: Date.now() });
  launch(id);
  console.log(`backgrounded · ${id} · ${flags.get("--name") ?? "session"}`);
} else {
  console.error(`the drill's claude doesn't do \`claude ${argv.join(" ")}\``);
  process.exit(1);
}
