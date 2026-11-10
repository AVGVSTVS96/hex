import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

const ToolCall = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) });

const McpRequest = z.object({
  id: z.number().optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

const HEX = join(import.meta.dir, "../..");
const home = mkdtempSync(join(tmpdir(), "away-"));
let calls: z.infer<typeof ToolCall>[] = [];
let waits: object[] = [];
let drop = 0;
let refuse: string | undefined;
let running = false;
let refused = 0;
let asked: string[] = [];
let flaky = 0;
let launchDrop = 0;
let launchSlow = 0;
let launched = false;
let unlinked = false;

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    if (request.method === "GET") {
      return new Response(null, { status: 405 });
    }

    if (request.method === "DELETE") {
      return new Response(null, { status: 200 });
    }

    const body = McpRequest.parse(await request.json());

    // https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#session-management: a new session starts without the old one's id.
    if (body.method === "initialize" && request.headers.has("mcp-session-id")) {
      return new Response("already initialized", { status: 400 });
    }

    if (body.method === "initialize") {
      return Response.json(
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-t3", version: "1" },
          },
        },
        { headers: { "mcp-session-id": "s1" } },
      );
    }

    if (body.method !== "tools/call") {
      return new Response(null, { status: 202 });
    }

    const call = ToolCall.parse(body.params);
    calls.push(call);

    if (call.name === "t3_thread_launch" && launchSlow-- > 0) {
      await Bun.sleep(3000);
    }

    if (call.name === "t3_thread_launch" && launchDrop-- > 0 && (launched = true)) {
      return new Response("relay timed out", { status: 504 });
    }

    if (call.name === "t3_thread_wait" && drop-- > 0) {
      return new Response("gone", { status: 502 });
    }

    if (call.name === "t3_thread_wait" && refused-- > 0) {
      return new Response("expired", { status: 401 });
    }

    if (call.name === "t3_thread_wait" && flaky-- > 0) {
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: "mac is not answering" }], isError: true },
      });
    }

    if (call.name === "orchestrator_capabilities" && unlinked) {
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [{ type: "text", text: '{"code":"invalid_request","message":"unknown_link"}' }],
          isError: true,
        },
      });
    }

    if (call.name === refuse) {
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [{ type: "text", text: '{"code":"capability_denied","message":"no link"}' }],
          isError: true,
        },
      });
    }

    const answers = new Map(
      Object.entries({
        orchestrator_capabilities: () => ({
          providers: [
            {
              providerInstanceId: "claudeAgent",
              models: [
                { id: "claude-opus-4-1" },
                { id: "claude-opus-5-5" },
                { id: "claude-sonnet-5-5" },
              ],
            },
          ],
        }),
        t3_thread_launch: () => {
          launched = true;

          return { threadId: "t1", runId: "r1", link: "<t3-thread://v2/env-mac/t1>" };
        },
        t3_thread_list: () => ({
          nextCursor: null,
          threads: launched
            ? [
                {
                  threadId: "t1",
                  title: "hex/atrium · inv1",
                  latestRunId: "r1",
                  link: "<t3-thread://v2/env-mac/t1>",
                },
              ]
            : [],
        }),
        t3_thread_wait: () =>
          waits.shift() ??
          (running
            ? { status: "running", timedOut: true }
            : { status: "completed", timedOut: false }),
        t3_thread_read: () => ({
          thread: { pendingRequestCount: asked.length },
          items: [
            { type: "user_message", text: "go" },
            { type: "assistant_message", text: "Built the Usage tab." },
          ],
          hasMore: false,
        }),
        t3_thread_interrupt: () => {
          running = false;

          return {};
        },
        t3_pending_request: () =>
          call.arguments.action === "list"
            ? { requestIds: asked }
            : { requestId: asked[0], questions: [{ question: "Which branch should I push to?" }] },
      }),
    );

    const answer = answers.get(call.name);

    if (answer === undefined) {
      throw new Error(`no answer for ${call.name}`);
    }

    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        content: [{ type: "text", text: JSON.stringify(answer()) }],
        isError: false,
      },
    });
  },
});

const script = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};

beforeAll(() => {
  mkdirSync(join(home, ".hex/bin"), { recursive: true });
  mkdirSync(join(home, ".t3/userdata"), { recursive: true });
  symlinkSync(join(HEX, "node_modules"), join(home, ".hex/node_modules"));
  cpSync(join(HEX, "bin/away"), join(home, ".hex/bin/away"), { dereference: true });
  script(join(home, ".hex/bin/identity"), 'echo "You are hex."');
  script(
    join(home, ".hex/bin/t3-mcp-headers"),
    `echo "sign-in $*\${T3_REFUSED:+ refused=$T3_REFUSED}" >> "${home}/signed"; echo '{"Authorization":"Bearer t"}'`,
  );
  writeFileSync(
    join(home, ".t3/userdata/server-runtime.json"),
    JSON.stringify({ port: server.port }),
  );
});

afterAll(() => {
  void server.stop();
  rmSync(home, { recursive: true });
});

const away = (args: string[], stdin = "") => {
  const run = Bun.spawn(
    ["bun", join(home, ".hex/bin/away"), "mac", "env-mac", "hex/atrium", ...args],
    {
      cwd: home,
      stdin: Buffer.from(stdin),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home, INVOCATION_ID: "inv1" },
    },
  );

  return {
    run,
    out: () => new Response(run.stdout).text(),
    error: () => new Response(run.stderr).text(),
  };
};

const reset = () => {
  calls = [];
  waits = [];
  drop = 0;
  refuse = undefined;
  running = false;
  refused = 0;
  flaky = 0;
  launchDrop = 0;
  launchSlow = 0;
  launched = false;
  unlinked = false;
  asked = [];
  rmSync(join(home, "signed"), { force: true });
};

test("a job runs as a T3 Code thread on that machine, follows its run through early and dropped waits, and prints the thread's last answer", async () => {
  reset();
  waits = [
    { status: "preparing", timedOut: false },
    { status: "running", timedOut: true },
  ];
  drop = 1;

  const { run, out } = away(
    ["-p", "Build the Usage tab.", "--model", "opus", "--effort", "high"],
    "the log",
  );

  expect(await run.exited).toBe(0);
  expect(await out()).toBe(
    "hex/atrium runs on mac as T3 Code thread <t3-thread://v2/env-mac/t1>\nBuilt the Usage tab.\n",
  );
  const launch = calls.find(({ name }) => name === "t3_thread_launch")?.arguments ?? {};
  expect(launch).toMatchObject({
    environmentId: "env-mac",
    scratch: true,
    runtimeMode: "full-access",
    title: "hex/atrium · inv1",
    clientRequestId: "hex-job-hex/atrium-mac-inv1",
  });
  expect(launch.modelSelection).toEqual({
    provider: "claudeAgent",
    model: "claude-opus-5-5",
    options: [{ id: "effort", value: "high" }],
  });
  expect(launch.message).toStartWith("You are hex.");
  expect(launch.message).toEndWith("Build the Usage tab.\n\nthe log");
  const waited = calls.filter(({ name }) => name === "t3_thread_wait");
  expect(waited).toHaveLength(4);
  expect(
    waited.every(
      ({ arguments: input }) => input.runId === "r1" && input.untilDelegatedWorkSettled === true,
    ),
  ).toBe(true);
}, 20_000);

test("a refused token is renewed and a tool error without a final code is retried", async () => {
  reset();
  refused = 1;
  flaky = 1;
  const { run } = away(["-p", "Build it."]);
  expect(await run.exited).toBe(0);
  expect(readFileSync(join(home, "signed"), "utf-8")).toBe(
    "sign-in \nsign-in --refresh refused=t\n",
  );
}, 30_000);

test("a job whose thread stops at a question ends there, with the question as its answer", async () => {
  reset();
  running = true;
  asked = ["q1"];
  const { run, out } = away(["-p", "Build it."]);
  expect(await run.exited).toBe(1);
  expect(await out()).toEndWith(
    "hex/atrium stopped on mac at a question, which a job can't answer: Which branch should I push to?\n",
  );
  expect(calls.find(({ name }) => name === "t3_thread_interrupt")).toMatchObject({
    name: "t3_thread_interrupt",
    arguments: { threadId: "t1", stop: true },
  });
});

test("a job can't run there, having started nothing, with claude flags a thread has no place for, or a link that's gone", async () => {
  reset();
  const flagged = away(["-p", "Build it.", "--permission-mode", "plan"]);
  expect(await flagged.run.exited).toBe(76);
  expect(await flagged.error()).toContain("--permission-mode has no place in a T3 Code thread");
  refuse = "orchestrator_capabilities";
  expect(await away(["-p", "Build it."]).run.exited).toBe(76);
  expect(calls.some(({ name }) => name === "t3_thread_launch")).toBe(false);
  refuse = undefined;
  unlinked = true;
  expect(await away(["-p", "Build it."]).run.exited).toBe(76);
  expect(calls.some(({ name }) => name === "t3_thread_launch")).toBe(false);
});

test("stopping the job stops its thread, and the stop counts once its run has ended", async () => {
  reset();
  running = true;
  const { run } = away(["-p", "Build it."]);

  while (!calls.some(({ name }) => name === "t3_thread_wait")) {
    await Bun.sleep(50);
  }

  run.kill("SIGTERM");
  expect(await run.exited).toBe(143);
  expect(calls.find(({ name }) => name === "t3_thread_interrupt")?.arguments).toMatchObject({
    environmentId: "env-mac",
    threadId: "t1",
    stop: true,
  });
  expect(calls.at(-1)).toMatchObject({ name: "t3_thread_wait", arguments: { threadId: "t1" } });
});

test("a sign-in that fails here is this machine's fault, named at once, and starts nothing", async () => {
  reset();
  const helper = join(home, ".hex/bin/t3-mcp-headers");
  const kept = readFileSync(helper, "utf-8");
  script(helper, 'echo "no pairing code" >&2; exit 1');
  const { run, error } = away(["-p", "Build it."]);
  expect(await run.exited).toBe(77);
  expect(await error()).toContain("this machine: couldn't sign in: no pairing code");
  expect(calls).toHaveLength(0);
  writeFileSync(helper, kept);
});

test("a job stopped while its launch may have reached the other machine finds that thread by its title and stops it", async () => {
  reset();
  launchDrop = 1;
  const { run, error } = away(["-p", "Build it."]);

  while (!calls.some(({ name }) => name === "t3_thread_launch")) {
    await Bun.sleep(50);
  }

  await Bun.sleep(200);
  run.kill("SIGTERM");
  expect(await run.exited).toBe(143);
  expect(calls.filter(({ name }) => name === "t3_thread_launch")).toHaveLength(1);
  expect(
    calls.some(
      ({ name, arguments: input }) =>
        name === "t3_thread_list" && input.titleContains === "hex/atrium · inv1",
    ),
  ).toBe(true);
  expect(calls.find(({ name }) => name === "t3_thread_interrupt")).toMatchObject({
    name: "t3_thread_interrupt",
    arguments: { threadId: "t1", stop: true },
  });
  expect(await error()).toContain("trying again");
}, 20_000);

test("a job stopped while its launch is on its way stops the thread the launch answers with", async () => {
  reset();
  launchSlow = 1;
  const { run } = away(["-p", "Build it."]);

  while (!calls.some(({ name }) => name === "t3_thread_launch")) {
    await Bun.sleep(50);
  }

  const stopped = Date.now();
  run.kill("SIGTERM");
  expect(await run.exited).toBe(143);
  expect(Date.now() - stopped).toBeLessThan(5000);
  expect(calls.filter(({ name }) => name === "t3_thread_launch")).toHaveLength(1);
  expect(calls.find(({ name }) => name === "t3_thread_interrupt")).toMatchObject({
    name: "t3_thread_interrupt",
    arguments: { threadId: "t1", stop: true },
  });
}, 20_000);

test("a launch that was tried and refused fails the job there, rather than moving it to a machine where it could run twice", async () => {
  reset();
  refuse = "t3_thread_launch";
  const launch = away(["-p", "Build it."]);
  expect(await launch.run.exited).toBe(1);
  expect(await launch.error()).toContain("hex/atrium couldn't start on mac");
});

test("a stop that can't reach the thread tells the job's owner where it may still be running", async () => {
  reset();
  running = true;
  writeFileSync(
    join(home, ".hex/bin/job"),
    `require('fs').writeFileSync(${JSON.stringify(join(home, "told"))}, process.argv.slice(2).map(arg => arg + '|').join(''))`,
  );

  const run = Bun.spawn(
    ["bun", join(home, ".hex/bin/away"), "mac", "env-mac", "hex/atrium", "-p", "Build it."],
    {
      cwd: home,
      stdin: Buffer.from(""),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home, INVOCATION_ID: "inv1", HEX_OWNER: "telegram:-100123:101" },
    },
  );

  while (!calls.some(({ name }) => name === "t3_thread_wait")) {
    await Bun.sleep(50);
  }

  refuse = "t3_thread_interrupt";
  run.kill("SIGTERM");
  expect(await run.exited).toBe(143);
  expect(readFileSync(join(home, "told"), "utf-8")).toBe(
    '--tell|atrium|telegram:-100123:101|couldn\'t stop on mac (t3_thread_interrupt: {"code":"capability_denied","message":"no link"}): its T3 Code thread <t3-thread://v2/env-mac/t1> may still be running there. Stop it in T3 Code on mac.|',
  );
}, 20_000);

test("a run a restart cut, which T3 shows final but timed out while its continuation is pending, is followed to the end", async () => {
  reset();
  waits = [{ status: "cancelled", timedOut: true }];
  const { run, out } = away(["-p", "Build it."]);
  expect(await run.exited).toBe(0);
  expect(await out()).toEndWith("Built the Usage tab.\n");
  expect(calls.filter(({ name }) => name === "t3_thread_wait")).toHaveLength(2);
});

test("a run that ends while its own background task runs is followed until that task wakes the thread and it answers", async () => {
  reset();
  waits = [
    { status: "completed", timedOut: true },
    { status: "completed", timedOut: false, resultRun: { runId: "r2", status: "failed" } },
  ];
  const { run, out } = away(["-p", "Build it."]);
  expect(await run.exited).toBe(1);
  expect(await out()).toEndWith("Built the Usage tab.\n");
  expect(calls.filter(({ name }) => name === "t3_thread_wait")).toHaveLength(2);
});
