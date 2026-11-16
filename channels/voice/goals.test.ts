import { expect, test } from "bun:test";

import { everyOf } from "./goals.ts";

test("how often a watch runs reads as the owner would say it", () => {
  expect(everyOf({ cron: "0 9 * * *" })).toBe("every day at 9 AM");
  expect(everyOf({ cron: "30 13 * * *" })).toBe("every day at 1:30 PM");
  expect(everyOf({ cron: "0 10 * * 1" })).toBe("every Monday at 10 AM");
  expect(everyOf({ cron: "0 9 1,15 * *" })).toBe("on day 1 and 15 of the month at 9 AM");
  expect(everyOf({ cron: "30 */3 * * *" })).toBe("every 3 hours");
  expect(everyOf({ cron: "20 8-23 * * *" })).toBe("hourly, 8 AM to 11 PM");
  expect(everyOf({ cron: "40 8-22/2 * * *" })).toBe("every 2 hours, 8 AM to 10 PM");
  expect(everyOf({ cron: "*/5 * * * *" })).toBe("on a schedule");
  expect(everyOf({ at: "2026-12-06 09:00" }, "America/Los_Angeles")).toBe("once, Dec 6 at 9 AM");
});
