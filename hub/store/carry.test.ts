import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { difference } from "./carry.ts";
import type { Read } from "./carry.ts";

const holding = (value: string): Read => {
  const db = new Database(":memory:");
  db.run(`create table kept (value); insert into kept values (${value})`);

  return async (text) => await Promise.resolve(db.query(text).all());
};

test("two copies differ when a value reads the same in JSON but SQLite keeps it as another type, like 7 and 7.0", async () => {
  expect(await difference(holding("7"), holding("7.0"), () => {})).toBe(
    "kept holds values of other types",
  );
  expect(await difference(holding("7"), holding("7"), () => {})).toBeUndefined();
});
