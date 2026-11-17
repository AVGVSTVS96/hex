import type { Database } from "bun:sqlite";

import { z } from "zod";

import { fromJson, now } from "./db.ts";
import type { Core, Mode, Write } from "./db.ts";

export const JobSpecJson = z.object({
  owner: z.string(),
  cwd: z.string(),
  properties: z.array(z.string()),
  command: z.array(z.string()),
  session: z.string().optional(),
  input: z.array(z.string()).optional(),
  startedOver: z.array(z.string()).optional(),
});

export type JobSpec = z.infer<typeof JobSpecJson>;

export const StopReasonColumn = z.enum(["moved", "shutdown"]);

export type StopReason = z.infer<typeof StopReasonColumn>;

const JobRow = z
  .object({
    unit: z.string(),
    machine: z.string(),
    run: z.string(),
    spec: z.string(),
    stopped: StopReasonColumn.nullable(),
    stopped_at: z.string().nullable(),
  })
  .transform(({ spec, stopped, stopped_at: stoppedAt, ...row }) => ({
    ...row,
    spec: fromJson(JobSpecJson, spec),
    stopped: stopped === null || stoppedAt === null ? undefined : { why: stopped, at: stoppedAt },
  }));

export type Job = z.infer<typeof JobRow>;

const SELECT = "select unit, machine, run, spec, stopped, stopped_at from jobs";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The jobs hex answers for, each by the run it last started and the machine that runs it. A row goes once its run ends; one that stopped without ending says why, for the next resume to carry it on.
export class Jobs<M extends Mode = "queued"> {
  private readonly db: Database;
  private readonly write: Write<M>;

  constructor({ db, write }: Core<M>) {
    this.db = db;
    this.write = write;
  }

  started(unit: string, machine: string, run: string, spec: JobSpec) {
    return this.write(() =>
      this.db
        .query(
          "insert into jobs (unit, machine, run, spec) values (?, ?, ?, ?) on conflict (unit) do update set machine = excluded.machine, run = excluded.run, spec = excluded.spec, stopped = null, stopped_at = null",
        )
        .run(unit, machine, run, JSON.stringify(spec)),
    );
  }

  get(unit: string): Job | undefined {
    return JobRow.optional().parse(
      this.db.query(`${SELECT} where unit = ?`).get(unit) ?? undefined,
    );
  }

  list(): Job[] {
    return z.array(JobRow).parse(this.db.query(`${SELECT} order by unit`).all());
  }

  ended(unit: string, machine: string, run: string) {
    return this.write(() =>
      this.db
        .query("delete from jobs where unit = ? and machine = ? and (? = '' or run = ?)")
        .run(unit, machine, run, run),
    );
  }

  stopped(unit: string, machine: string, run: string, why: StopReason, at = now()) {
    return this.write(() =>
      this.db
        .query(
          "update jobs set stopped = ?, stopped_at = ? where unit = ? and machine = ? and (? = '' or run = ?)",
        )
        .run(why, at, unit, machine, run, run),
    );
  }
}
