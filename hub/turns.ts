import { clock } from "./clock.ts";
import type { Timer } from "./clock.ts";
import type { Line } from "./mcp.ts";
import type { Message } from "./waiting.ts";

const TURN_REPORTS_WITHIN = 60_000;

type Turn = {
  is: "busy" | "background" | "done";
  untaken?: boolean | undefined;
  starting?: Timer | undefined;
};

export type SessionTurns = ReturnType<typeof sessionTurns>;

export function sessionTurns({ overdue }: { overdue: (thread: string) => void }) {
  const turns = new Map<string, Turn>();

  function turnOf(thread: string): Turn {
    let turn = turns.get(thread);

    if (!turn) {
      turns.set(thread, (turn = { is: "done" }));
    }

    return turn;
  }

  function of(thread: string): Readonly<Turn> {
    return turnOf(thread);
  }

  function active(thread: string) {
    const turn = turnOf(thread);

    return turn.is === "busy" || turn.starting !== undefined;
  }

  function stopWaiting(turn: Turn) {
    clock.clearTimeout(turn.starting);
    turn.starting = undefined;
  }

  function began(thread: string) {
    const turn = turnOf(thread);
    turn.is = "busy";
    stopWaiting(turn);
    turn.untaken = undefined;
  }

  function ended(thread: string, background: boolean) {
    const turn = turnOf(thread);
    turn.is = background ? "background" : "done";
    stopWaiting(turn);
  }

  function expect(thread: string) {
    if (active(thread)) {
      return;
    }

    const turn = turnOf(thread);
    turn.starting = clock.setTimeout(() => {
      turn.starting = undefined;
      overdue(thread);
    }, TURN_REPORTS_WITHIN);
  }

  function handIn(thread: string, line: Line, message: Message) {
    turnOf(thread).untaken = true;
    expect(thread);
    line.send({ type: "inbound", ...message });
  }

  function connected(thread: string, given: boolean) {
    const turn = turnOf(thread);
    turn.untaken = given;
    stopWaiting(turn);

    if (given) {
      expect(thread);
    }
  }

  function forget(thread: string) {
    turns.delete(thread);
  }

  function close(thread: string) {
    clock.clearTimeout(turns.get(thread)?.starting);
  }

  return { of, active, began, ended, handIn, connected, forget, close };
}
