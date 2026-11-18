import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { join } from "node:path";

import { SESSION, dir, states, start, SeenLine, hookSays, session } from "./hub.testing.ts";
import { until } from "./until.ts";

test("busy and idle from session hooks reach the client, and a dropped session is idle", async () => {
  await start();
  const { close } = await session("chat:9");

  hookSays(true);
  await until(() => states.length === 1);
  hookSays(false);
  await until(() => states.length === 2);
  close();
  await until(() => states.length === 3);
  expect(states).toEqual([
    ["chat:9", true],
    ["chat:9", false],
    ["chat:9", false],
  ]);
});

test("a session's stop hook reports whether background agents are still working, which shells don't count as", async () => {
  const socket = join(dir, "state.sock");
  const received: object[] = [];

  const server = createServer((client) => {
    client.on("data", (chunk) => {
      received.push(SeenLine.parse(JSON.parse(String(chunk))));
    });
  }).listen(socket);

  const stop = async (tasks: object[]) => {
    const hook = Bun.spawn(["bun", join(import.meta.dir, "state.ts"), "idle"], {
      env: { ...process.env, HEX_HUB: socket, HEX_THREAD: "t1" },
      stdin: new Blob([JSON.stringify({ hook_event_name: "Stop", background_tasks: tasks })]),
    });

    await hook.exited;
  };

  await stop([{ type: "subagent", status: "running" }]);
  await stop([{ type: "shell", status: "running" }]);
  await until(() => received.length === 2 || undefined);
  server.close();
  expect(received).toEqual([
    { type: "state", thread: "t1", busy: false, background: true },
    { type: "state", thread: "t1", busy: false },
  ]);
});

test("a session's stop hook names its session, and says when the turn failed", async () => {
  const socket = join(dir, "state.sock");
  const received: object[] = [];

  const server = createServer((client) => {
    client.on("data", (chunk) => {
      received.push(SeenLine.parse(JSON.parse(String(chunk))));
    });
  }).listen(socket);

  for (const hook_event_name of ["Stop", "StopFailure"]) {
    const hook = Bun.spawn(["bun", join(import.meta.dir, "state.ts"), "idle"], {
      env: { ...process.env, HEX_HUB: socket, HEX_THREAD: "t1", HEX_STORE: dir, MEMORY_DIR: "" },
      stdin: new Blob([
        JSON.stringify({
          hook_event_name,
          session_id: SESSION,
          ...(hook_event_name === "StopFailure" && {
            error: "rate_limit",
            last_assistant_message: "API Error: 429",
          }),
        }),
      ]),
    });

    await hook.exited;
    await until(() => received.length === (hook_event_name === "Stop" ? 1 : 2) || undefined);
  }

  server.close();
  expect(received).toEqual([
    { type: "state", thread: "t1", busy: false, session: SESSION },
    {
      type: "state",
      thread: "t1",
      busy: false,
      failed: true,
      error: "rate_limit",
      said: "API Error: 429",
      session: SESSION,
    },
  ]);
});

test("a session beside a thread never reports its turns as the thread's, even with a hub in its settings", async () => {
  const socket = join(dir, "state.sock");
  const received: string[] = [];

  const server = createServer((client) => {
    client.on("data", (chunk) => {
      received.push(String(chunk));
    });
  }).listen(socket);

  for (const hook_event_name of ["UserPromptSubmit", "StopFailure"]) {
    const hook = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "state.ts"),
        hook_event_name === "StopFailure" ? "idle" : "busy",
      ],
      {
        env: {
          ...process.env,
          HEX_HUB: socket,
          HEX_THREAD: "t1",
          HEX_BESIDE: SESSION,
          HEX_STORE: dir,
          MEMORY_DIR: "",
        },
        stdin: new Blob([
          JSON.stringify({ hook_event_name, session_id: SESSION, error: "authentication_failed" }),
        ]),
      },
    );

    expect(await hook.exited).toBe(0);
  }

  await Bun.sleep(100);
  server.close();
  expect(received).toEqual([]);
});

test("a turn's hook tells the hub and goes, without waiting for a stalled hub to hang up", async () => {
  const socket = join(dir, "state.sock");
  const received: object[] = [];

  const server = createServer({ allowHalfOpen: true }, (client) => {
    client.on("data", (chunk) => {
      received.push(SeenLine.parse(JSON.parse(String(chunk))));
    });
  }).listen(socket);

  const hook = Bun.spawn(["bun", join(import.meta.dir, "state.ts"), "idle"], {
    env: { ...process.env, HEX_HUB: socket, HEX_THREAD: "t1" },
    stdin: new Blob([JSON.stringify({ hook_event_name: "Stop" })]),
  });

  await hook.exited;
  await until(() => received.length || undefined);
  server.close();
  expect(received).toEqual([{ type: "state", thread: "t1", busy: false }]);
});

test("a turn tells the hub it began whatever began it, so the owner's words wait for it, and a command that may run no turn tells it nothing", async () => {
  const socket = join(dir, "state.sock");
  const received: object[] = [];

  const server = createServer((client) => {
    client.on("data", (chunk) => {
      received.push(SeenLine.parse(JSON.parse(String(chunk))));
    });
  }).listen(socket);

  const began = async (prompt: string) => {
    const hook = Bun.spawn(["bun", join(import.meta.dir, "state.ts"), "busy"], {
      env: { ...process.env, HEX_HUB: socket, HEX_THREAD: "t1", HEX_STORE: dir, MEMORY_DIR: "" },
      stdin: new Blob([JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt })]),
    });

    await hook.exited;
  };

  await began("<task-notification>\n<task-id>b1</task-id>\n</task-notification>");
  await began('<cross-session-message from="Desk">\nthe build is green\n</cross-session-message>');
  await began("check the deploy");
  await until(() => received.length === 3 || undefined);
  await began("/compact");
  await began("<local-command-stdout>Compacted</local-command-stdout>");
  await began("<command-name>/model</command-name>");
  await began("check it again");
  await until(() => received.length === 4 || undefined);
  server.close();
  expect(received).toEqual(
    Array.from({ length: 4 }, () => ({ type: "state", thread: "t1", busy: true })),
  );
});
