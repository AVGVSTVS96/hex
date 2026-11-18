import { join } from "node:path";

import { command, filled, usage } from "../command.ts";
import type { Hex } from "../command.ts";
import { holds, keysOf, problems, verdict } from "../notes.ts";

export default command({
  usage: "hex recall <regex, in any case>",
  flags: {
    // oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
    // recall takes -i and ignores it, since memo recall already ignores case.
    "ignore-case": { type: "boolean", short: "i" },
  },
  wordsBeforeFlags: () => 1,
  async run(hex) {
    const [pattern] = hex.args;

    if (!filled(pattern)) {
      usage(hex);
    }

    await recall(hex, pattern);
  },
});

async function recall(hex: Hex, pattern: string) {
  const memo = Bun.spawn([join(import.meta.dir, "../..", "vendor", "memo"), "recall", pattern], {
    stdout: "pipe",
    stderr: "inherit",
  });

  let kept = 0;
  let keyed = 0;
  let notes = 0;

  for (const recalled of (await new Response(memo.stdout).text()).split("\n")) {
    console.log(recalled);

    if (!/^#\d+ /u.test(recalled)) {
      continue;
    }

    notes++;
    const v = await verdict(recalled, hex.store);

    if (keysOf(recalled).length === 0) {
      continue;
    }

    keyed++;

    if (holds(v)) {
      kept++;
    } else {
      console.log(
        problems(v, false)
          .map((why) => `    ✗ ${why}`)
          .join("\n"),
      );
    }

    for (const said of v.keys) {
      console.log(
        said.body
          .split("\n")
          .map((words) => `    ${words}`)
          .join("\n"),
      );
    }
  }

  if (notes > 0) {
    console.log(`${notes} notes: ${keyed} name a message, ${kept} quote it as written.`);
  }

  process.exitCode = await memo.exited;
}
