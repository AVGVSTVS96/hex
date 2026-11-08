import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import type { Author } from "../../hub/store.ts";

const HOME = process.env.T3CODE_HOME ?? join(homedir(), ".t3");
const USERDATA = join(HOME, "userdata");
const SCOPES = ["orchestration:read", "orchestration:operate"];

const answer = z.json().optional();

type Answer = z.infer<typeof answer>;

const frameSchema = z.looseObject({
  _tag: z.string(),
  requestId: z.string().optional(),
  exit: z
    .discriminatedUnion("_tag", [
      z.looseObject({ _tag: z.literal("Success"), value: answer }),
      z.looseObject({
        _tag: z.literal("Failure"),
        cause: z.array(
          z.looseObject({
            _tag: z.string(),
            error: z.looseObject({ message: z.string().optional() }).optional(),
            defect: z.coerce.string().nullish(),
          }),
        ),
      }),
    ])
    .optional(),
});

const framesSchema = z.union([z.array(frameSchema), frameSchema.transform((frame) => [frame])]);

type Failure = Extract<NonNullable<z.infer<typeof frameSchema>["exit"]>, { _tag: "Failure" }>;

type Json = z.infer<ReturnType<typeof z.json>>;

async function cli(...args: string[]) {
  const run = Bun.spawn([join(HOME, "bin", "t3"), ...args], { stdout: "pipe", stderr: "pipe" });

  const [out, err, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);

  if (code !== 0) {
    throw new Error(`t3 ${args.slice(0, 3).join(" ")} failed: ${err.trim() || `exit ${code}`}`);
  }

  return out;
}

function failure(exit: Failure) {
  return exit.cause.map((cause) => cause.error?.message ?? cause.defect ?? cause._tag).join("; ");
}

async function revoke(session: string) {
  try {
    await cli("auth", "session", "revoke", session);
  } catch (error) {
    process.stderr.write(`t3: ${String(error)}\n`);
  }
}

// hex calls T3 Code's server as T3's app does: a bearer token its CLI issues (https://github.com/pingdotgg/t3code/blob/8e6a7323050ea8d2891f745f7e624e84f9fd8d9a/apps/server/src/cli/auth.ts#L169-L184), a websocket ticket for it (https://github.com/pingdotgg/t3code/blob/8e6a7323050ea8d2891f745f7e624e84f9fd8d9a/packages/contracts/src/environmentHttp.ts#L580), then Effect RPC over /ws (https://github.com/pingdotgg/t3code/blob/8e6a7323050ea8d2891f745f7e624e84f9fd8d9a/packages/contracts/src/rpc.ts#L525).
export async function withT3<T>(
  work: (call: (tag: string, payload: Json) => Promise<Answer>) => Promise<T>,
): Promise<T> {
  const { origin } = z
    .object({ origin: z.string() })
    .parse(JSON.parse(readFileSync(join(USERDATA, "server-runtime.json"), "utf-8")));

  const issued = z
    .object({ sessionId: z.string(), token: z.string() })
    .parse(
      JSON.parse(
        await cli(
          "auth",
          "session",
          "issue",
          ...SCOPES.flatMap((scope) => ["--scope", scope]),
          "--ttl",
          "5m",
          "--label",
          "hex",
          "--json",
        ),
      ),
    );

  let ws: WebSocket | undefined;

  try {
    const ticketAnswer = await fetch(`${origin}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${issued.token}` },
    });

    if (!ticketAnswer.ok) {
      throw new Error(`T3 Code refused a websocket ticket: HTTP ${ticketAnswer.status}`);
    }

    const { ticket } = z.object({ ticket: z.string() }).parse(await ticketAnswer.json());

    const socket = new WebSocket(
      `${origin.replace(/^http/u, "ws")}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`,
    );

    ws = socket;

    const pending = new Map<
      string,
      { resolve: (value: Answer) => void; reject: (error: Error) => void }
    >();

    let next = 0;

    const lost = new Promise<never>((_resolve, reject) => {
      socket.addEventListener("error", () => {
        reject(new Error("T3 Code's server dropped the connection"));
      });
      socket.addEventListener("close", () => {
        for (const { reject: drop } of pending.values()) {
          drop(new Error("T3 Code's server closed the connection"));
        }

        reject(new Error("T3 Code's server closed the connection"));
      });
    });

    void Promise.allSettled([lost]);
    await Promise.race([
      new Promise((resolve) => {
        socket.addEventListener("open", resolve);
      }),
      lost,
    ]);
    socket.addEventListener("message", (event) => {
      const frames = framesSchema.safeParse(JSON.parse(String(event.data)));

      for (const frame of frames.data ?? []) {
        if (frame._tag === "Ping") {
          socket.send(JSON.stringify({ _tag: "Pong" }));
        }

        if (frame._tag !== "Exit" || frame.requestId === undefined || frame.exit === undefined) {
          continue;
        }

        const waiting = pending.get(frame.requestId);

        if (!waiting) {
          continue;
        }

        pending.delete(frame.requestId);

        if (frame.exit._tag === "Success") {
          waiting.resolve(frame.exit.value);
        } else {
          waiting.reject(new Error(failure(frame.exit)));
        }
      }
    });

    const call = (tag: string, payload: Json) => {
      next += 1;
      const id = String(next);
      socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));

      return new Promise<Answer>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    };

    return await work(call);
  } finally {
    ws?.close();
    void revoke(issued.sessionId);
  }
}

export function projectAt(root: string): string | undefined {
  const file = join(USERDATA, "statev2.sqlite");

  if (!existsSync(file)) {
    return;
  }

  const db = new Database(file, { readonly: true });

  try {
    return db
      .query<{ id: string }, [string]>(
        "select project_id id from projection_projects where workspace_root = ? and deleted_at is null order by created_at limit 1",
      )
      .get(root)?.id;
  } finally {
    db.close();
  }
}

// Before T3 cancels a turn to steer it, it records the run as starting again on a steering_restart attempt: https://github.com/pingdotgg/t3code/blob/8e6a7323050ea8d2891f745f7e624e84f9fd8d9a/apps/server/src/orchestration-v2/Orchestrator.ts#L5430-L5452
export function steering(session: string) {
  const file = join(USERDATA, "statev2.sqlite");

  if (!existsSync(file)) {
    return false;
  }

  const db = new Database(file, { readonly: true });

  try {
    return (
      db
        .query(`select 1 from orchestration_v2_projection_runs run
        join orchestration_v2_projection_run_attempts attempt on attempt.attempt_id = json_extract(run.payload_json, '$.activeAttemptId')
        join orchestration_v2_projection_provider_threads thread on thread.provider_thread_id = attempt.provider_thread_id
        where run.status = 'starting' and json_extract(attempt.payload_json, '$.reason') = 'steering_restart' and json_extract(thread.payload_json, '$.nativeThreadRef.nativeId') = ?`)
        .get(session) !== null
    );
  } catch (error) {
    process.stderr.write(
      `t3: can't read whether T3 is steering ${session}, so its cancel is a Stop: ${String(error)}\n`,
    );

    return false;
  } finally {
    db.close();
  }
}

// T3's createdBy and creationSource for a message: https://github.com/pingdotgg/t3code/blob/8e6a7323050ea8d2891f745f7e624e84f9fd8d9a/packages/contracts/src/orchestrationV2.ts#L89-L98
const AUTHORS = new Map<string, Author>([
  ["user/web", "owner"],
  ["user/mobile", "owner"],
  ["agent/mcp", "prompt"],
  ["user/server", "prompt"],
  ["agent/server", "other"],
  ["agent/provider", "other"],
]);

const PROMPT_IS_AMONG_LAST_USER_MESSAGES = 5;

export function promptedBy(session: string, asked: string): Author {
  const file = join(USERDATA, "statev2.sqlite");

  if (!existsSync(file) || asked === "") {
    return "owner";
  }

  let db: Database | undefined;

  try {
    db = new Database(file, { readonly: true });

    const recent = db
      .query<
        { by: string | null; text: string | null },
        [string, number]
      >(`select json_extract(message.payload_json, '$.createdBy') || '/' || json_extract(message.payload_json, '$.creationSource') as by, json_extract(message.payload_json, '$.text') as text
        from orchestration_v2_projection_messages message
        join orchestration_v2_projection_provider_threads thread on thread.thread_id = message.thread_id
        where json_extract(thread.payload_json, '$.nativeThreadRef.nativeId') = ? and message.role = 'user' order by message.created_at desc limit ?`)
      .all(session, PROMPT_IS_AMONG_LAST_USER_MESSAGES);

    const by = recent.find((prompt) => prompt.text?.trim() === asked.trim())?.by;

    const author = by === undefined || by === null ? undefined : AUTHORS.get(by);

    return author ?? (by?.startsWith("system/") === true ? "other" : "owner");
  } catch (error) {
    process.stderr.write(
      `t3: can't read who wrote ${session}'s prompt, so it's the owner's: ${String(error)}\n`,
    );

    return "owner";
  } finally {
    db?.close();
  }
}

export function appThreads():
  | Map<string, { thread: string; title: string; deleted: boolean }>
  | undefined {
  const file = join(USERDATA, "statev2.sqlite");

  if (!existsSync(file)) {
    return;
  }

  const db = new Database(file, { readonly: true });

  try {
    const rows = db
      .query<{ key: string; thread: string; title: string; deleted: number }, []>(
        `select json_extract(p.payload_json, '$.nativeThreadRef.nativeId') as key, t.thread_id as thread, t.title, t.deleted_at is not null as deleted
         from orchestration_v2_projection_provider_threads p
         join orchestration_v2_projection_threads t on t.thread_id = json_extract(p.payload_json, '$.appThreadId')
         where p.driver = 'acpRegistry'
         order by t.deleted_at is null, p.updated_at`,
      )
      .all();

    return new Map(
      rows.map(({ key, thread, title, deleted }) => [key, { thread, title, deleted: !!deleted }]),
    );
  } finally {
    db.close();
  }
}

export function linkTo(thread: string) {
  const environment = readFileSync(join(USERDATA, "environment-id"), "utf-8").trim();

  // T3_APP_SCHEME is the T3 Code app's URL scheme: https://github.com/pingdotgg/t3code/blob/8e6a7323050ea8d2891f745f7e624e84f9fd8d9a/apps/mobile/app.config.ts#L83-L99
  const scheme = process.env.T3_APP_SCHEME ?? "";

  return `${scheme === "" ? "t3code" : scheme}://threads/${environment}/${encodeURIComponent(thread)}`;
}
