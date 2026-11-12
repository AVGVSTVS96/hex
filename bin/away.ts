#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

const [machine = "", environmentId = "", name = "", ...args] = process.argv.slice(2);

const home = join(import.meta.dir, "../..");
const [ELSEWHERE, UNREACHABLE] = [76, 77];

function quit(code: number, why: string): never {
  console.error(`away: ${name} can't run on ${machine}: ${why}`);
  process.exit(code);
}

let model: string | undefined;
let effort: string | undefined;
const words: string[] = [];

for (let arg = args.shift(); arg !== undefined; arg = args.shift()) {
  if (arg === "-p" || arg === "--print") {
    continue;
  } else if (arg === "--model") {
    model = args.shift();
  } else if (arg === "--effort") {
    effort = args.shift();
  } else if (arg === "--session-id") {
    args.shift();
  } else if (/^--?[A-Za-z][\w-]*(=.*)?$/u.test(arg)) {
    quit(ELSEWHERE, `${arg} has no place in a T3 Code thread`);
  } else {
    words.push(arg);
  }
}

const piped = process.stdin.isTTY ? "" : (await Bun.stdin.text()).trim();
const asked = [words.join(" "), piped].filter(Boolean).join("\n\n");

if (!asked) {
  quit(ELSEWHERE, "the job has no prompt");
}

const Json = z.json();

type JsonValue = z.infer<typeof Json>;

function parse(text: string): JsonValue {
  try {
    return Json.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const FINAL = new Set(["capability_denied", "thread_not_found", "run_not_found"]);

type Fault = "passing" | "final" | "local";

class AwayError extends Error {
  readonly fault: Fault;
  readonly code: string | undefined;

  constructor(message: string, fault: Fault, code?: string) {
    super(message);
    this.name = "AwayError";
    this.fault = fault;
    this.code = code;
  }
}

const here = (why: string) =>
  new AwayError(`T3 Code on ${hostname()}, this machine: ${why}`, "local");

const Signed = z.object({ Authorization: z.string() }).catchall(z.string());

type SignIn = z.infer<typeof Signed>;

let headers: Promise<SignIn> | undefined;

async function askHelper(refused?: string): Promise<SignIn> {
  const refreshing = refused !== undefined && refused !== "";
  const env = { ...process.env, ...(refreshing && { T3_REFUSED: refused }) };

  const helper = Bun.spawn(
    [join(import.meta.dir, "t3-mcp-headers"), ...(refreshing ? ["--refresh"] : [])],
    { cwd: home, env, stdout: "pipe", stderr: "pipe", timeout: 180_000, killSignal: "SIGKILL" },
  );

  const [out, err, code] = await Promise.all([
    new Response(helper.stdout).text(),
    new Response(helper.stderr).text(),
    helper.exited,
  ]);

  const signed = Signed.safeParse(parse(out));

  if (code !== 0 || !signed.success) {
    throw new Error(
      `T3 Code on ${hostname()}, this machine: couldn't sign in: ${err.trim() || "no sign-in printed"}`,
    );
  }

  return {
    ...signed.data,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
}

async function signIn(refused?: string) {
  try {
    return await askHelper(refused);
  } catch (error) {
    headers = undefined;
    throw error;
  }
}

const signedIn = (refused?: string) => (headers = signIn(refused));

const Runtime = z.object({ port: z.union([z.number(), z.string()]) });

const url = (() => {
  try {
    const { port } = Runtime.parse(
      JSON.parse(readFileSync(join(homedir(), ".t3/userdata/server-runtime.json"), "utf-8")),
    );

    return `http://127.0.0.1:${port}/mcp`;
  } catch {
    return quit(
      UNREACHABLE,
      here("it isn't running (no ~/.t3/userdata/server-runtime.json)").message,
    );
  }
})();

let client: Client | undefined;
let transport: StreamableHTTPClientTransport | undefined;
let opening: Promise<Client> | undefined;

const authenticated: FetchLike = async (input, init) => {
  const using = headers ?? signedIn();
  let used = await using;

  const send = () =>
    fetch(input, {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init?.headers)), ...used },
      signal: AbortSignal.any([
        ...(init?.signal ? [init.signal] : []),
        AbortSignal.timeout(120_000),
      ]),
    });

  let answer = await send();

  if (answer.status === 401) {
    await answer.body?.cancel();
    used = await (headers === using
      ? signedIn(used.Authorization.replace(/^Bearer /u, ""))
      : (headers ?? signedIn()));
    answer = await send();
  }

  if (
    answer.status >= 400 &&
    answer.status < 500 &&
    ![404, 405, 408, 429].includes(answer.status)
  ) {
    throw here(`HTTP ${answer.status} ${await answer.text()}`);
  }

  return answer;
};

async function connect() {
  try {
    await Promise.allSettled([client?.close()]);
    client = new Client({ name: "hex-away", version: "1" });
    transport = new StreamableHTTPClientTransport(new URL(url), { fetch: authenticated });
    await client.connect(transport, { timeout: 120_000 });

    return client;
  } catch (error) {
    opening = undefined;
    throw error;
  }
}

const open = () => (opening ??= connect());

const ToolResult = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
});

type Argument = string | number | boolean | null | undefined | Argument[] | Arguments;

interface Arguments {
  [key: string]: Argument;
}

const Coded = z.object({ code: z.string() });

async function call<Answer extends z.ZodType>(
  tool: string,
  input: Arguments,
  answer: Answer,
  patience = 120_000,
): Promise<z.infer<Answer>> {
  const connected = await open();

  const result = ToolResult.parse(
    await connected.callTool({ name: tool, arguments: { environmentId, ...input } }, undefined, {
      timeout: patience,
    }),
  );

  const text = result.content.find((item) => item.type === "text")?.text ?? "";
  const coded = Coded.safeParse(parse(text));
  const code = coded.success ? coded.data.code : undefined;

  if (result.isError === true) {
    throw new AwayError(
      `${tool}: ${text}`,
      code !== undefined && FINAL.has(code) ? "final" : "passing",
      code,
    );
  }

  return answer.parse(result.structuredContent ?? parse(text));
}

const Launched = z.object({
  threadId: z.string(),
  runId: z.string().nullish(),
  link: z.string(),
});

type Thread = z.infer<typeof Launched>;

const Listed = z.object({
  threads: z.array(
    z.object({
      threadId: z.string(),
      title: z.string(),
      latestRunId: z.string().nullish(),
      link: z.string().optional(),
    }),
  ),
  nextCursor: z.number().nullish(),
});

let threadId: string | undefined;
let tried = false;
let inflight: Promise<Thread> | undefined;
let stopping = false;
let halting: Promise<void> | undefined;
const invocation = process.env.INVOCATION_ID ?? String(process.pid);
const requestId = `hex-job-${name}-${machine}-${invocation}`;
const title = `${name} · ${invocation.slice(0, 8)}`;

async function find(patience?: number): Promise<Thread | null> {
  for (let cursor: number | undefined, pages = 0; pages < 5; pages++) {
    const page = await call(
      "t3_thread_list",
      { allProjects: true, titleContains: title, limit: 100, cursor },
      Listed,
      patience,
    );

    const thread = page.threads.find((listed) => listed.title === title);

    if (thread) {
      return {
        threadId: thread.threadId,
        runId: thread.latestRunId,
        link: thread.link ?? `<t3-thread://v2/${environmentId}/${thread.threadId}>`,
      };
    }

    cursor = page.nextCursor ?? undefined;

    if (cursor === undefined) {
      return null;
    }
  }

  return null;
}

const tellOwner = (said: string) =>
  process.env.HEX_OWNER === undefined
    ? undefined
    : Bun.spawn(
        [
          "bun",
          join(import.meta.dir, "job"),
          "--tell",
          name.split("/").at(-1) ?? name,
          process.env.HEX_OWNER,
          said,
        ],
        { stdout: "ignore", stderr: "inherit" },
      ).exited;

const stopThread = (reason: string) => (halting ??= halt(reason));

const Waited = z.object({
  status: z.string(),
  timedOut: z.boolean().optional(),
  hasPendingQuestion: z.boolean().optional(),
  pendingApproval: z.unknown().optional(),
  resultRun: z.object({ status: z.string() }).nullish(),
});

const STOP_WITHIN_BIN_JOBS_90_S = 70_000;

async function halt(reason: string) {
  let why = "it gave no answer in 70 s";

  const stopped = (async () => {
    for (let wait = 1000; ; wait = Math.min(wait * 2, 10_000)) {
      try {
        if (threadId === undefined && inflight) {
          const launch = inflight.then(
            (thread) => thread.threadId,
            () => null,
          );

          threadId = (await Promise.race([launch, Bun.sleep(20_000)])) ?? undefined;
        }

        if (threadId === undefined && tried) {
          threadId = (await find(30_000))?.threadId;
        }

        if (threadId === undefined) {
          return true;
        }

        await call("t3_thread_interrupt", { threadId, stop: true, reason }, z.unknown(), 30_000);

        const interruptRecordedBeforeTheRunEnds = await call(
          "t3_thread_wait",
          { threadId, timeoutMs: 15_000 },
          Waited.pick({ timedOut: true }),
          30_000,
        );

        if (interruptRecordedBeforeTheRunEnds.timedOut === true) {
          throw new Error("its run was still going after the interrupt");
        }

        return true;
      } catch (error) {
        why = messageOf(error);

        if (error instanceof AwayError && error.code === "thread_not_found") {
          return true;
        }

        if (error instanceof AwayError && error.fault === "final") {
          return false;
        }

        opening = undefined;
        await Bun.sleep(wait);
      }
    }
  })();

  if (await Promise.race([stopped, Bun.sleep(STOP_WITHIN_BIN_JOBS_90_S).then(() => false)])) {
    return;
  }

  const where =
    threadId === undefined
      ? `a T3 Code thread titled "${title}"`
      : `its T3 Code thread <t3-thread://v2/${environmentId}/${threadId}>`;

  const said = `couldn't stop on ${machine} (${why}): ${where} may still be running there. Stop it in T3 Code on ${machine}.`;
  console.log(`${name} ${said}`);
  await Promise.race([tellOwner(said), Bun.sleep(5000)]);
}

async function exit(code: number): Promise<never> {
  if (stopping) {
    await halting;
  }

  await Promise.race([
    (async () => {
      await Promise.allSettled([transport?.terminateSession()]);
      await Promise.allSettled([client?.close()]);
    })(),
    Bun.sleep(2000),
  ]);
  process.exit(stopping ? 143 : code);
}

const onStop = () => {
  if (stopping) {
    return;
  }

  stopping = true;
  void stopThread(`hex stopped the job ${name}`);
  void exit(143);
};

process.on("SIGTERM", onStop);

process.on("SIGINT", onStop);

const TELL_OWNER_UNREACHABLE_AFTER = 600_000;
let toldUnreachable = false;

async function persist<T>(what: () => Promise<T>, patience = Infinity): Promise<T> {
  const since = Date.now();
  const until = since + patience;

  for (let wait = 5000; ; wait = Math.min(wait * 2, 120_000)) {
    try {
      return await what();
    } catch (error) {
      if (stopping) {
        return await exit(143);
      }

      if ((error instanceof AwayError && error.fault !== "passing") || Date.now() + wait > until) {
        throw error;
      }

      console.error(`away: ${messageOf(error)}; trying again in ${wait / 1000} s`);

      if (
        threadId !== undefined &&
        !toldUnreachable &&
        Date.now() - since > TELL_OWNER_UNREACHABLE_AFTER
      ) {
        toldUnreachable = true;
        void tellOwner(
          `can't reach its T3 Code thread <t3-thread://v2/${environmentId}/${threadId}> on ${machine} for 10 minutes (${messageOf(error)}). It keeps trying.`,
        );
      }

      opening = undefined;
      await Bun.sleep(wait);

      if (stopping) {
        return await exit(143);
      }
    }
  }
}

try {
  await signedIn();
} catch (error) {
  quit(UNREACHABLE, messageOf(error));
}

const Offered = z.object({
  providers: z.array(
    z.object({ providerInstanceId: z.string(), models: z.array(z.object({ id: z.string() })) }),
  ),
});

async function unknownLinkPassedOver() {
  try {
    return await call("orchestrator_capabilities", {}, Offered);
  } catch (error) {
    throw error instanceof AwayError && error.code === "invalid_request"
      ? new AwayError(error.message, "final")
      : error;
  }
}

async function offeredOrQuit() {
  try {
    return await persist(unknownLinkPassedOver, 300_000);
  } catch (error) {
    return quit(
      error instanceof AwayError && error.fault === "final" ? ELSEWHERE : UNREACHABLE,
      messageOf(error),
    );
  }
}

const offered = await offeredOrQuit();

if (stopping) {
  await exit(143);
}

const Settings = z.object({ model: z.string().optional() });

const modelIn = (settings: string) => {
  try {
    return Settings.safeParse(parse(readFileSync(settings, "utf-8"))).data?.model;
  } catch {
    return null;
  }
};

const wanted =
  model ??
  modelIn(join(home, ".claude/settings.json")) ??
  modelIn(join(homedir(), ".claude/settings.json")) ??
  "opus";

const claude = offered.providers.find((provider) => provider.providerInstanceId === "claudeAgent");

const newestFirst = claude?.models
  .filter(({ id }) => id.includes(wanted))
  .toSorted((a, b) => b.id.localeCompare(a.id));

const chosen = claude?.models.find(({ id }) => id === wanted) ?? newestFirst?.[0];

if (!chosen) {
  quit(ELSEWHERE, claude ? `its Claude has no ${wanted}` : "its T3 Code has no Claude");
}

const identity = Bun.spawnSync([join(import.meta.dir, "identity"), home]).stdout.toString();

const message = `${identity}

You are running on ${machine}, in a T3 Code thread hex started there because ${hostname()}, where hex runs, was short on room. The job was started in ${process.cwd()} on ${hostname()}. Your folder ${home}, the files under it and every other path on ${hostname()} are reached with \`ssh ${userInfo().username}@${hostname()} '<command>'\`, hex's commands included. Work in this machine's own checkouts: clone or pull a repo here, and push what you commit.

${asked}`;

if (message.length > 120_000) {
  quit(
    ELSEWHERE,
    `its prompt is ${message.length} characters, over the 120,000 a T3 Code thread takes`,
  );
}

const launch = () =>
  call(
    "t3_thread_launch",
    {
      title,
      scratch: true,
      message,
      runtimeMode: "full-access",
      modelSelection: {
        provider: "claudeAgent",
        model: chosen.id,
        options: effort === undefined || effort === "" ? [] : [{ id: "effort", value: effort }],
      },
      clientRequestId: requestId,
    },
    Launched,
  );

async function foundOrLaunched() {
  if (tried) {
    const found = await find();

    if (found && (found.runId === undefined || found.runId === null || found.runId === "")) {
      throw new Error(`its thread ${found.link} has no run yet`);
    }

    if (found) {
      return found;
    }
  }

  if (stopping) {
    return await exit(143);
  }

  tried = true;
  inflight = launch();

  try {
    return await inflight;
  } finally {
    inflight = undefined;
  }
}

async function launchedOrExit() {
  try {
    return await persist(foundOrLaunched, 1_800_000);
  } catch (error) {
    console.error(
      `away: ${name} couldn't start on ${machine}: ${messageOf(error)}; stopping any thread it started there`,
    );
    await stopThread(`hex couldn't start the job ${name}`);

    return await exit(1);
  }
}

const launched = await launchedOrExit();

threadId ??= launched.threadId;

if (stopping) {
  await exit(143);
}

console.log(`${name} runs on ${machine} as T3 Code thread ${launched.link}`);

const { runId } = launched;

const FINISHED = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);

const ended = ({ status, timedOut }: z.infer<typeof Waited>) =>
  FINISHED.has(status) && timedOut !== true;

const ThreadState = z.object({ thread: z.object({ pendingRequestCount: z.number() }) });
const Pending = z.object({ requestIds: z.array(z.string()).optional() });
const Question = z.object({ questions: z.array(z.object({ question: z.string() })).optional() });

const Messages = z.object({
  items: z.array(z.object({ type: z.string(), text: z.string().nullish() })),
  nextPosition: z.number().nullish(),
  hasMore: z.boolean().optional(),
});

const PAUSE_SO_THE_MACHINES_ARENT_ASKED_IN_A_TIGHT_LOOP = 5000;

const slice = (timeoutMs: number) =>
  persist(() =>
    call("t3_thread_wait", { threadId, runId, timeoutMs, untilDelegatedWorkSettled: true }, Waited),
  );

const threadState = () =>
  persist(() => call("t3_thread_read", { threadId, limit: 1, runLimit: 1 }, ThreadState));

const messagesAfter = (after: number | null | undefined) =>
  persist(() =>
    call(
      "t3_thread_read",
      { threadId, view: "messages", limit: 100, maxCharsPerItem: 50_000, afterPosition: after },
      Messages,
    ),
  );

async function follow(): Promise<number> {
  let waited = await slice(50_000);

  while (!ended(waited)) {
    const { thread } = await threadState();

    const pending =
      thread.pendingRequestCount > 0 ||
      waited.hasPendingQuestion === true ||
      Boolean(waited.pendingApproval);

    if (pending) {
      waited = await slice(1);
    }

    if (pending && !ended(waited)) {
      const { requestIds } = await call(
        "t3_pending_request",
        { action: "list", threadId },
        Pending,
      ).catch(() => ({ requestIds: undefined }));

      const read =
        requestIds !== undefined && requestIds.length > 0
          ? await call(
              "t3_pending_request",
              { action: "read", threadId, requestId: requestIds[0] },
              Question,
            ).catch(() => null)
          : null;

      await stopThread(`the job ${name} has nobody to answer`);

      const question = read?.questions?.map((asking) => asking.question).join(" ");

      console.log(
        `${name} stopped on ${machine} at a question, which a job can't answer: ${question ?? `see ${launched.link}`}`,
      );

      return 1;
    }

    if (waited.timedOut !== true) {
      await Bun.sleep(PAUSE_SO_THE_MACHINES_ARENT_ASKED_IN_A_TIGHT_LOOP);
    }

    if (!ended(waited)) {
      waited = await slice(50_000);
    }
  }

  if (stopping) {
    return await exit(143);
  }

  let last: string | null | undefined;

  for (let after: number | null | undefined, more = true; more;) {
    const page = await messagesAfter(after);

    const answers = page.items.filter((item) => item.type === "assistant_message");

    if (answers.length > 0) {
      last = answers.at(-1)?.text;
    }

    after = page.nextPosition;
    more = page.hasMore === true;
  }

  console.log(last ?? `${name} ended on ${machine} with no answer`);

  return (waited.resultRun ?? waited).status === "completed" ? 0 : 1;
}

try {
  await exit(await follow());
} catch (error) {
  console.error(`away: ${messageOf(error)}; stopping the thread`);
  await stopThread(`hex lost track of the job ${name}`);
  await exit(1);
}
