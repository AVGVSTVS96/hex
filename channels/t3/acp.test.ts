import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

import { until } from "@hex/hub/testing";
import type { Subprocess } from "bun";
import { z } from "zod";

let dir: string;
let path: string;
const servers: Server[] = [];
const proxies: Subprocess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "t3-acp-"));
  path = join(dir, "acp.sock");
});

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }

  for (const proxy of proxies.splice(0)) {
    proxy.kill();
  }

  rmSync(dir, { recursive: true, force: true });
});

const rpc = z.looseObject({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z
    .looseObject({
      update: z.looseObject({ content: z.looseObject({ text: z.string() }) }).optional(),
    })
    .optional(),
});

type Rpc = z.infer<typeof rpc>;

function hubAnsweringEachRequestWith(answer: (request: Rpc, socket: Socket) => void) {
  const server = createServer((socket) => {
    createInterface({ input: socket }).on("line", (line) => {
      answer(rpc.parse(JSON.parse(line)), socket);
    });
  });

  servers.push(server);

  return new Promise<Server>((resolve) => {
    server.listen(path, () => {
      resolve(server);
    });
  });
}

const write = (socket: Socket, message: Rpc) => {
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
};

const said = (text: string) => ({
  method: "session/update",
  params: {
    sessionId: "s1",
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId: text,
      content: { type: "text", text },
    },
  },
});

test("a thread's history a hub restart cut short loads again without repeating what T3 has", async () => {
  const first = await hubAnsweringEachRequestWith((request, socket) => {
    if (request.method !== "session/load") {
      return;
    }

    write(socket, said("one"));
    write(socket, said("two"));
    setTimeout(() => {
      first.close();
      socket.destroy();
    }, 100);
  });

  const proxy = Bun.spawn(["bun", join(import.meta.dir, "acp.ts"), path], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });

  proxies.push(proxy);
  const out: Rpc[] = [];
  createInterface({ input: Readable.from(proxy.stdout) }).on("line", (line) => {
    out.push(rpc.parse(JSON.parse(line)));
  });
  await Bun.sleep(100);
  void proxy.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/load", params: { sessionId: "s1", cwd: dir, mcpServers: [] } })}\n`,
  );
  void proxy.stdin.flush();
  await until(() => out.length === 2);
  await new Promise((resolve) => {
    first.on("close", resolve);
  });
  await hubAnsweringEachRequestWith((request, socket) => {
    if (request.method !== "session/load") {
      write(socket, { id: request.id, result: {} });

      return;
    }

    for (const text of ["one", "two", "three"]) {
      write(socket, said(text));
    }

    write(socket, { id: request.id, result: {} });
  });
  await until(() => out.some((message) => message.id === 1));
  expect(out.map((message) => message.params?.update?.content.text ?? message.id)).toEqual([
    "one",
    "two",
    "three",
    1,
  ]);
});
