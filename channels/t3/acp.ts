#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { createInterface } from "node:readline";

import { z } from "zod";

const given = process.argv[2];

if (given === undefined || given === "") {
  process.stderr.write("usage: acp.ts <path to the t3 hub acp.sock>\n");
  process.exit(2);
}

const path = given;

const LONGER_THAN_A_HUB_RESTART = 120_000;

const OWN_REQUEST_ID_T3_NEVER_ASKED_FOR = "hex-acp:";

const PROMPT_KEY = "hex/key";

const params = z.looseObject({
  sessionId: z.string().optional(),
  cwd: z.string().nullish(),
  mcpServers: z.array(z.unknown()).optional(),
  configId: z.string().optional(),
  value: z.unknown().optional(),
  _meta: z.looseObject({}).nullish(),
});

const messageSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).nullish(),
  method: z.string().optional(),
  params: params.optional(),
  result: z.unknown().optional(),
});

type Message = z.infer<typeof messageSchema>;

type Params = z.infer<typeof params>;

type Request = { id: string | number; method: string; params: Params };

type Waiting = { line: string; request: Request; at: number };

type Counts = Map<number | bigint, number>;

let socket: Socket | undefined;
let ending = false;
let downSince = 0;
let initialize: Params | undefined;
const held: string[] = [];

const sessions = new Map<
  string,
  { cwd: string | null | undefined; mcpServers: unknown[] | undefined }
>();

const picked = new Map<string, Map<string, unknown>>();
const waiting = new Map<string | number, Waiting>();
const STREAMING_UNTIL_ANSWERED = new Set(["session/prompt", "session/load"]);
const shown = new Map<string, Counts>();
const skip = new Map<string, Counts>();

createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on("line", fromT3)
  .on("close", () => {
    ending = true;

    if (socket) {
      socket.end();
    } else {
      process.exit(0);
    }
  });

reach();

function reach(again = false) {
  const next = connect(path);
  next.on("connect", () => {
    socket = next;
    createInterface({ input: next, crlfDelay: Infinity })
      .on("line", fromHex)
      // oxlint-disable-next-line eslint/no-empty-function -- the socket's own close listener reconnects
      .on("error", () => {});

    if (again) {
      reopen(next);
    }

    for (const line of held.splice(0)) {
      fromT3(line);
    }
  });
  next.on("error", (error) => {
    if (again || socket === next) {
      return;
    }

    process.stderr.write(
      `hex acp: can't reach hex at ${path} (${error.message}). Is hex running?\n`,
    );
    process.exit(1);
  });
  next.on("close", () => {
    if (ending) {
      process.exit(0);
    }

    if (socket === next) {
      socket = undefined;
      downSince = Date.now();
    } else if (!again) {
      return;
    }

    if (Date.now() - downSince > LONGER_THAN_A_HUB_RESTART) {
      process.stderr.write(
        `hex acp: hex at ${path} has been gone for ${LONGER_THAN_A_HUB_RESTART / 1000}s\n`,
      );
      process.exit(1);
    }

    setTimeout(() => {
      reach(true);
    }, 250);
  });
}

function fromT3(received: string) {
  if (!socket) {
    held.push(received);

    return;
  }

  const message = parse(received);
  let line = received;

  if (message?.method === "session/prompt" && message.params) {
    message.params._meta = { ...message.params._meta, [PROMPT_KEY]: randomUUID() };
    line = JSON.stringify(message);
  }

  const request = requestOf(message);

  if (request) {
    const { method, params: asked } = request;
    waiting.set(request.id, { line, request, at: Date.now() });

    if (method === "initialize") {
      initialize = asked;
    }

    if (
      (method === "session/resume" || method === "session/load") &&
      asked.sessionId !== undefined
    ) {
      sessions.set(asked.sessionId, { cwd: asked.cwd, mcpServers: asked.mcpServers });
    }

    if (STREAMING_UNTIL_ANSWERED.has(method) && asked.sessionId !== undefined) {
      shown.set(asked.sessionId, new Map());
    }
  }

  socket.write(`${line}\n`);
}

function requestOf(message: Message | undefined): Request | undefined {
  if (
    message?.method === undefined ||
    message.method === "" ||
    message.id === undefined ||
    message.id === null
  ) {
    return undefined;
  }

  return { id: message.id, method: message.method, params: message.params ?? {} };
}

function fromHex(line: string) {
  const message = parse(line);
  const id = message?.id;

  if (z.string().safeParse(id).data?.startsWith(OWN_REQUEST_ID_T3_NEVER_ASKED_FOR) === true) {
    return;
  }

  if (id !== undefined && id !== null && (message?.method ?? "") === "") {
    answered(id, message);
  }

  if (
    message?.method === "session/update" &&
    !fresh(message.params?.sessionId ?? "", Bun.hash(line))
  ) {
    return;
  }

  process.stdout.write(`${line}\n`);
}

const createdSession = z.looseObject({ sessionId: z.string() });

function answered(id: string | number, response: Message | undefined) {
  const result = response?.result;
  const asked = waiting.get(id)?.request;
  waiting.delete(id);
  const created = createdSession.safeParse(result).data?.sessionId ?? "";

  if (asked?.method === "session/new" && created !== "") {
    sessions.set(created, { cwd: asked.params.cwd, mcpServers: asked.params.mcpServers });
  }

  if (asked?.method === "session/set_config_option" && result !== undefined && result !== null) {
    const { sessionId, configId, value } = asked.params;

    if (sessionId !== undefined && configId !== undefined) {
      picked.set(
        sessionId,
        (picked.get(sessionId) ?? new Map<string, unknown>()).set(configId, value),
      );
    }
  }

  if (asked && STREAMING_UNTIL_ANSWERED.has(asked.method) && asked.params.sessionId !== undefined) {
    shown.delete(asked.params.sessionId);
    skip.delete(asked.params.sessionId);
  }
}

function fresh(sessionId: string, hash: number | bigint) {
  const skipping = skip.get(sessionId);
  const left = skipping?.get(hash) ?? 0;

  if (skipping && left !== 0) {
    skipping.set(hash, left - 1);

    return false;
  }

  const counts = shown.get(sessionId);
  counts?.set(hash, (counts.get(hash) ?? 0) + 1);

  return true;
}

type Outgoing = { id: string | number; method: string; params: Params };

function reopen(next: Socket) {
  const send = (message: Outgoing) => {
    next.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };

  if (initialize) {
    send({
      id: `${OWN_REQUEST_ID_T3_NEVER_ASKED_FOR}initialize`,
      method: "initialize",
      params: initialize,
    });
  }

  for (const [sessionId, { cwd, mcpServers }] of sessions) {
    send({
      id: `${OWN_REQUEST_ID_T3_NEVER_ASKED_FOR}${sessionId}`,
      method: "session/resume",
      params: { sessionId, cwd, mcpServers },
    });

    for (const [configId, value] of picked.get(sessionId) ?? []) {
      send({
        id: `${OWN_REQUEST_ID_T3_NEVER_ASKED_FOR}${sessionId}:${configId}`,
        method: "session/set_config_option",
        params: { sessionId, configId, value },
      });
    }
  }

  for (const [id, { line, request, at }] of waiting) {
    const { sessionId } = request.params;

    if (STREAMING_UNTIL_ANSWERED.has(request.method) && sessionId !== undefined) {
      skip.set(sessionId, new Map(shown.get(sessionId)));
    }

    if (request.method === "session/prompt") {
      send({ id, method: "_hex/rejoin", params: { ...request.params, since: at } });
    } else {
      next.write(`${line}\n`);
    }
  }
}

function parse(line: string): Message | undefined {
  try {
    return messageSchema.parse(JSON.parse(line));
  } catch {
    return undefined;
  }
}
