import { join } from "node:path";

import { clients, mirror } from "./apps.ts";
import { sessionsBeside } from "./besides.ts";
import { threadCalls } from "./calls.ts";
import { history } from "./chat.ts";
import * as claude from "./claude.ts";
import { failedStarts } from "./failing.ts";
import type { Failed } from "./failing.ts";
import { sessionFiles } from "./files.ts";
import { holding } from "./holds.ts";
import { threadInbox } from "./inbox.ts";
import { turnInterrupts } from "./interrupt.ts";
import { keeping, landed } from "./kept.ts";
import { PORT, mount } from "./listen.ts";
import { STARTUP } from "./loaded.ts";
import { endpoint } from "./mcp.ts";
import type { ChannelServer, Line, Permission, ToolArguments } from "./mcp.ts";
import { cantStart, tellOwner } from "./notice.ts";
import { queue } from "./observe.ts";
import { sessionPauses } from "./pauses.ts";
import { present } from "./present.ts";
import { threadRenewals } from "./renewals.ts";
import { sessionRests } from "./rest.ts";
import { restarts } from "./restarts.ts";
import { threadRuns } from "./runs.ts";
import { schedule } from "./schedule.ts";
import { wordsSent } from "./sent.ts";
import { threadSessions } from "./sessions.ts";
import { hubSocket } from "./socket.ts";
import type { Questions } from "./socket.ts";
import { stalledTurns } from "./stalls.ts";
import { sessionStarts } from "./start.ts";
import { sessionStops } from "./stops.ts";
import { stateDir as storeOf } from "./store.ts";
import { openThreads } from "./threads.ts";
import { wentThrough, whenThrough } from "./through.ts";
import { sessionTurns } from "./turns.ts";
import { messagesWaiting } from "./waiting.ts";
import type { Waits } from "./waiting.ts";
import { zoneOf } from "./zone.ts";

export type Call = (thread: string, tool: string, args: ToolArguments) => Promise<string>;

export type State = (thread: string, busy: boolean, background: boolean) => void;

export type Settings = { model?: string | undefined; effort?: string | undefined };

export type Hub = Awaited<ReturnType<typeof startHub>>;

// idleStop: how long a quiet session stays warm before it stops. cacheWarm: how long the main thread rests before it compacts, while its cache is still warm. Both sit just inside Claude Code's one-hour prompt cache, so coming back within the hour costs no new cache write. compactAbove: the context above which a session compacts before it rests. reconnect: how long a running session's channel may be gone before the session restarts to get it back. connect: how long a starting session waits for the hub to answer its channel, where Claude Code would give up after 30 seconds for good, so a hub running behind still gets its sessions' channels. Claude Code waits that long for each of a session's MCP servers, but a background session doesn't hold its turn for them. capacity: how much context a fresh thread's session holds before a new one takes over; with 0, every message that finds it done goes to a new one, and HEX_CHAT_CAPACITY changes it. handoffAbove: the context above which a thread whose session's cache has expired starts a new session that takes over from it, instead of resuming it and writing that whole context to the cache again: a new session starts at about 50k and reads back what it needs, so a smaller one costs more to replace than to resume. HEX_HANDOFF_ABOVE changes it. (see https://docs.claude.com/en/docs/build-with-claude/prompt-caching and https://code.claude.com/docs/en/mcp)
export type Limits = {
  idleStop: number;
  cacheWarm: number;
  compactAbove: number;
  reconnect: number;
  connect: number;
  capacity: number;
  handoffAbove: number;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // How long a hub waits for a store that doesn't answer as it starts before the owner hears.
  tellAfter: number;
};

let generalHub: Hub | undefined;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Resolves with the hub serving General once General's session first connects to it: from then on, hex works on the code this process runs.
export const { promise: up, resolve: reached } = Promise.withResolvers<Hub>();

// Claude Code keeps a conversation in the prompt cache for an hour after its last request, and compacts a background session only when told to. It retries a dropped HTTP server at about 0, 1, 3, 7 and 15 seconds, then gives up for good. https://docs.claude.com/en/docs/build-with-claude/prompt-caching
const LIMITS: Limits = {
  idleStop: 54 * 60_000,
  cacheWarm: 54 * 60_000,
  compactAbove: 150_000,
  reconnect: 20_000,
  connect: 300_000,
  capacity: tokensFrom("HEX_CHAT_CAPACITY", 350_000),
  handoffAbove: tokensFrom("HEX_HANDOFF_ABOVE", 80_000),
  tellAfter: 60_000,
};

function tokensFrom(name: string, fallback: number) {
  const tokens = process.env[name];

  if (!present(tokens)) {
    return fallback;
  }

  if (!/^\d+$/u.test(tokens)) {
    throw new Error(`${name} must be a number of tokens, got "${tokens}"`);
  }

  return Number(tokens);
}

function startupFiles(hex: string | undefined) {
  return hex === undefined || hex === ""
    ? []
    : Object.values(STARTUP)
        .flat()
        .map((path) => join(hex, path));
}

const ignore = (): void => undefined;

export type HubOptions = {
  stateDir: string;
  storeDir?: string | undefined;
  channel: string;
  server: ChannelServer;
  port?: number | undefined;
  main?: string | undefined;
  mainName?: string | undefined;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The main thread is hex's General: its settings env says HEX_MAIN, and the hub runs schedules.json.
  general?: boolean | undefined;
  call: Call;
  state: State;
  failed: Failed;
  waits?: Waits | undefined;
  permission?: ((thread: string, request: Permission) => void) | undefined;
  questions?: Questions | undefined;
  args?: ((thread: string) => string[]) | undefined;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A fresh thread's session is never compacted: its launcher builds what a new session knows of the chat, and a new one takes over once the old one's context or cache is spent.
  fresh?: ((thread: string) => boolean) | undefined;
  limits?: Partial<Limits> | undefined;
  hexDir?: string | undefined;
  launcher?: string | undefined;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // What the launcher's sessions read only as they start (STARTUP, in the hex folder HEX_STARTUP names): a change to one renews sessions like a change to the channel does.
  startup?: string[] | undefined;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // Where the app opens a thread, which hex.db keeps with it.
  link?: ((thread: string) => string | undefined) | undefined;
  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // The systemd journal General follows for units that keep restarting; a hub without one follows none.
  journal?: (() => string[]) | undefined;
};

export async function startHub({
  stateDir,
  storeDir = storeOf(stateDir),
  channel,
  server,
  port = PORT,
  main,
  mainName = "main",
  general = false,
  call,
  state,
  failed,
  waits,
  permission,
  questions,
  args = () => [],
  fresh = () => false,
  limits,
  hexDir = process.cwd(),
  launcher = "claude",
  startup = startupFiles(process.env.HEX_STARTUP),
  link,
  journal,
}: HubOptions) {
  const {
    idleStop,
    cacheWarm,
    compactAbove,
    reconnect,
    connect,
    capacity,
    handoffAbove,
    tellAfter,
  } = { ...LIMITS, ...limits };

  const socketPath = join(stateDir, "hub.sock");
  const runs = threadRuns();
  const calls = threadCalls(runs);
  const generalThread = general && present(main) ? main : undefined;
  const plugin = channel.replace(/^plugin:/u, "");
  const path = `/${plugin.split("@")[0]}`;
  const app = path.slice(1);
  let started = false;

  const owing = keeping(storeDir, {
    spool: join(storeDir, `owed.${app}.json`),
    earlier: stateDir === storeDir ? [] : [join(stateDir, `owed.${app}.json`)],
    refused: join(storeDir, `refused.${app}.json`),
    letGo: (thread, rows) => {
      if (started) {
        inbox.heldLetGo(thread, rows);
      }
    },
    queue: (turn, store) => queue(storeDir, turn, store),
    tell: (why) => void tellOwner(why),
  });

  const { kept, must } = owing;

  const threads = await openThreads({
    app,
    storeDir,
    owing,
    hexDir,
    link,
    tell: cantStart(storeDir),
    tellAfter,
  });

  started = true;
  const words = wordsSent({ threads, owing, app });
  const turns = sessionTurns({ overdue: (thread) => void inbox.letHeldGo(thread) });
  const waiting = messagesWaiting({ runs, kept, waits });

  const files = sessionFiles({
    stateDir,
    channel,
    plugin,
    socketPath,
    port,
    storeDir,
    connect,
    generalThread,
    fresh,
  });

  const starts = sessionStarts({
    threads,
    files,
    kept,
    launcher,
    channel,
    server,
    startup,
    args,
    handoffAbove,
    fresh,
  });

  let closed = false;
  const closing = new AbortController();
  const serving = () => !closed;
  const zone = () => zoneOf(hexDir) ?? Temporal.Now.timeZoneId();

  const stops = sessionStops({
    runs,
    threads,
    kept,
    serving,
    stopping: (thread) => {
      rests.cancel(thread);
    },
    paused: (thread, running) => pauses.stopped(thread, running),
  });

  const failing = failedStarts({
    runs,
    threads,
    waiting,
    kept,
    app,
    main,
    generalThread,
    generalHubMain: () => generalHub?.main,
    failed,
  });

  const pauses = sessionPauses({ runs, threads, waiting, turns, kept, serving, turnEnded, failed });

  const sessions = threadSessions({
    runs,
    threads,
    waiting,
    files,
    starts,
    stops,
    failing,
    pauses,
    kept,
    serving,
    channel,
    main,
    mainName,
    fresh,
    connect,
    reconnect,
    turnBegan,
    turnEnded,
    startFailed: (thread) => {
      renewals.startFailed(thread);
    },
  });

  const rests = sessionRests({
    runs,
    threads,
    turns,
    sessions,
    stops,
    pauses,
    calls,
    serving,
    main,
    fresh,
    idleStop,
    cacheWarm,
    compactAbove,
    capacity,
    forget,
  });

  const renewals = threadRenewals({
    runs,
    threads,
    turns,
    waiting,
    sessions,
    starts,
    stops,
    rests,
    calls,
    kept,
    serving,
    main,
    fresh,
  });

  const besides = sessionsBeside({
    threads,
    files,
    starts,
    kept,
    serving,
    app,
    main,
    channel,
    launcher,
    zone,
    ownTurnsOnly: () => clients.get(app)?.waits === true,
    failed,
    wake: () => {
      inbox.wake();
    },
  });

  const inbox = threadInbox({
    threads,
    turns,
    waiting,
    sessions,
    starts,
    stops,
    pauses,
    rests,
    calls,
    besides,
    owing,
    serving,
    app,
    fresh,
  });

  const stalls = stalledTurns({ runs, threads, turns, inbox, failed });

  const interrupts = turnInterrupts({
    runs,
    threads,
    turns,
    kept,
    closing: closing.signal,
    turnEnded,
  });

  function turnBegan(thread: string) {
    state(thread, true, false);
    threads.claim(thread);
    turns.began(thread);
    rests.rest(thread);
    renewals.letGo(thread);
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A held message let go can start a session, and with it a turn, so what follows reads the turn as it is then.
  async function turnEnded(thread: string, background = false) {
    state(thread, false, background);
    threads.claim(thread);
    turns.ended(thread, background);
    await inbox.letHeldGo(thread);
    renewals.atRest(thread);
    rests.rest(thread, turns.of(thread).is === "done");
    renewals.letGo(thread);
  }

  function forget(thread: string, leaving: (session: string) => void) {
    const session = threads.close(thread);
    sessions.end(thread);
    rests.cancel(thread);
    runs.forget(thread);
    turns.forget(thread);
    files.forget(thread);
    void (async () => {
      await threads.save();
      leaving(session);
    })();
  }

  function adopt(thread: string, name: string, session: string, prompt?: string, cwd?: string) {
    threads.open(thread, { name, session, ...(present(cwd) && { cwd }) });

    if (present(prompt)) {
      sessions.launch(thread, name, { prompt });
    }
  }

  function configure(thread: string, settings: Settings) {
    const { model, effort } = { ...threads.of(thread), ...settings };

    threads.update(thread, {
      model: present(model) ? model : undefined,
      effort: present(effort) ? effort : undefined,
    });
  }

  // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
  // A session's channel connected over HTTP: its session is the one the hub started, or the one Claude reports running for the thread. One that only reconnects still owes a renew it asked for. One that reconnects while it's being stopped gets nothing, since what it took would end with it. It's live at once, and is given what waits for it once that's read (waiting.catchUp), unless its line is gone by then.
  async function welcome(thread: string, line: Line) {
    const was = sessions.connected(thread, line);

    if (!was) {
      return;
    }

    if (thread === generalThread) {
      reached(api);
    }

    renewals.connecting(thread);
    sessions.track(thread, was, line);
    const read = await waiting.catchUp(thread, line);
    const { phase } = sessions.of(thread);

    if (phase.is !== "live" || phase.line !== line) {
      return;
    }

    const given = waiting.connected(thread, line, read);
    turns.connected(thread, given.length > 0);
    renewals.noteAwaited(thread);
    rests.rest(thread);
    renewals.connected(thread);
    sessions.noteRunning(thread, line);

    if (was.is === "launching") {
      wentThrough("start");
    }
  }

  async function drop(thread: string, line: Line) {
    if (!sessions.dropped(thread, line)) {
      return;
    }

    const resting = rests.of(thread);
    await turnEnded(thread);

    if (resting.leaving) {
      forget(thread, resting.leaving);

      return;
    }

    await waiting.markAll(thread);
  }

  const serve = endpoint(
    path.slice(1),
    channel,
    files.token,
    server,
    {
      // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
      // A tool can send into another thread: what it sends there is still its caller's session's words.
      call: (thread, tool, toolArgs, by) =>
        words.callingAs(by ?? threads.current(thread), () => call(thread, tool, toolArgs)),
      permission: (thread, request) => permission?.(thread, request),
      open: (thread, line) => void welcome(thread, line),
      close: (thread, line) => void drop(thread, line),
    },
    owing.operations,
    zone,
  );

  const unmount = mount(path, serve);

  const sock = hubSocket({
    socketPath,
    threads,
    sessions,
    inbox,
    stalls,
    owing,
    questions,
    turnBegan,
    turnEnded,
    mirror: (thread, to, where) => mirror(api, thread, to, where),
  });

  function halt(thread: string) {
    failing.halted(thread);

    return stops.stop(thread);
  }

  if (present(main) || threads.ids().length > 0) {
    void (async () => {
      await sessions.hubStarted(await claude.agents(serving));
      inbox.wake();
    })();
  }

  const unwatch = await kept((store) => store.watch(inbox.wake), ignore);
  besides.hubStarted();
  const unschedule = present(generalThread) ? schedule(storeDir, hexDir, generalThread) : ignore;
  const unhold = present(generalThread) ? holding(storeDir) : ignore;

  const unrestart =
    present(generalThread) && journal !== undefined
      ? restarts(storeDir, generalThread, journal)
      : ignore;

  const api = {
    deliver: inbox.deliver,
    sent: words.sent,
    noted: words.noted,
    said: words.said,
    command: sessions.restart,
    configure,
    settings: (thread: string): Settings => ({
      model: threads.get(thread)?.model,
      effort: threads.get(thread)?.effort,
    }),
    register: threads.register,
    open: (thread: string, name: string, prompt?: string, cwd?: string) => {
      sessions.launch(thread, name, { prompt, cwd });
    },
    fork: (thread: string, name: string, session: string, prompt: string, cwd?: string) => {
      sessions.launch(thread, name, { prompt, fork: session, cwd });
    },
    main,
    fresh,
    renewal: renewals.renewal,
    keep: renewals.keep,
    adrift: calls.drift,
    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // Once what this hub and every other in the process wrote can't be lost.
    synced: async () => {
      await landed();
      await owing.synced();
    },
    renew: renewals.renewAsked,
    session: threads.current,
    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // A turn cut short, which runs no Stop hook, queues its memory pass here.
    turned: async (thread: string) => {
      const session = threads.current(thread);

      if (present(session)) {
        await must(
          { kind: "pass", pass: { session, by: new Date().toISOString(), thread } },
          false,
        );
      }
    },
    running: sessions.sessionOf,
    threads: threads.ids,
    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // Saves the threads again, for an app that learned links it couldn't give before.
    save: threads.save,
    name: (thread: string) => threads.get(thread)?.name,
    cwd: (thread: string) => threads.get(thread)?.cwd,
    stop: halt,
    interrupt: interrupts.interrupt,
    answer: (thread: string, request_id: string, behavior: "allow" | "deny") => {
      const { phase } = sessions.of(thread);

      if (phase.is === "live") {
        phase.line.send({ type: "permission", request_id, behavior });
      }
    },
    release: rests.release,
    adopt,
    follow: (thread: string, name: string, session: string, cwd?: string) => {
      threads.open(thread, { name, fork: session, ...(present(cwd) && { cwd }) });
    },
    history: (thread: string) =>
      kept((store) => history(store, thread, threads.current(thread)), []),
    retire: rests.retire,
    find: threads.find,
    rename: (thread: string, name: string) => {
      threads.update(thread, { name });
    },
    close: () => {
      closed = true;
      unwatch();
      unschedule();
      unhold();
      unrestart();

      if (generalHub === api) {
        generalHub = undefined;
      }

      sock.close();
      unmount();

      closing.abort();

      for (const thread of runs.threads()) {
        sessions.end(thread);
        rests.cancel(thread);
        turns.close(thread);
        calls.hangUp(thread);
      }
    },
  };

  whenThrough("start", () => void sessions.retry(), closing.signal);
  whenThrough("turn", () => void rests.recompact(), closing.signal);
  whenThrough("turn", stalls.resume, closing.signal);
  whenThrough("turn", () => void besides.release(), closing.signal);

  if (present(generalThread)) {
    generalHub = api;
  }

  return api;
}
