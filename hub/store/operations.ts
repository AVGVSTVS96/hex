import type { Database } from "bun:sqlite";

import { z } from "zod";

import { TextOrNull } from "./db.ts";
import type { Core, Mode, Written, Write } from "./db.ts";

const OperationRow = z.object({ input: z.string(), result: TextOrNull });

export class Operations<M extends Mode = "queued"> {
  private readonly db: Database;
  private readonly write: Write<M>;

  constructor({ db, write }: Core<M>) {
    this.db = db;
    this.write = write;
  }

  begin(
    scope: string,
    id: string,
    input: string,
  ): Written<M, { fresh: boolean; input: string; result: string | null }> {
    return this.write(() => {
      const fresh =
        this.db
          .query(
            "insert into operations (scope, id, input) values (?, ?, ?) on conflict do nothing",
          )
          .run(scope, id, input).changes > 0;

      const kept = OperationRow.parse(
        this.db
          .query("select input, result from operations where scope = ? and id = ?")
          .get(scope, id),
      );

      return { fresh, ...kept };
    });
  }

  finish(scope: string, id: string, result: string) {
    return this.write(() =>
      this.db
        .query("update operations set result = ? where scope = ? and id = ?")
        .run(result, scope, id),
    );
  }
}
