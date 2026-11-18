import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { command, filled, heldBySession } from "../command.ts";
import { history } from "../loaded.ts";
import { running, serving } from "../running.ts";
import type { Session } from "../running.ts";

export default command({
  usage: "hex running [--json]",
  flags: {
    json: { type: "boolean" },
  },
  async run({ flags, state, store }) {
    const threads = await store.threads.list({ open: true });
    const held = heldBySession(threads);
    const names = new Map(threads.map(({ app, thread, name }) => [`${app}:${thread}`, name]));
    const home = realpathSync(dirname(state));
    const sessions = await running(store);
    const updates = history(resolve(import.meta.dir, "../.."));

    const behind = (session: Session, thread?: string) => {
      const runsHex = filled(thread) || filled(session.helper);
      const from = runsHex ? updates.on(session.started) : undefined;

      if (!filled(from)) {
        return;
      }

      const changed = updates.changed(from);

      return changed.length > 0 ? { from, changed } : undefined;
    };

    const rows = [...sessions.values()].map((session) => {
      const thread = serving(session, held, sessions);

      return { ...session, thread, behind: behind(session, thread) };
    });

    if (flags.json === true) {
      console.log(JSON.stringify(rows, null, 1));
    } else {
      console.log(
        rows
          .map(({ id, status, name, cwd, thread, state: doing, detail, needs, behind: old }) => {
            const now =
              (doing === "blocked" || status === "waiting") && filled(needs) ? needs : detail;

            return `${status} ${id.slice(0, 8)} ${name ?? ""}${filled(cwd) && cwd !== home ? ` in ${cwd}` : ""}${filled(thread) ? ` · ${names.get(thread) ?? thread} (${thread})` : ""}${old ? ` · started on an older hex (${old.from.slice(0, 7)}), ${old.changed.join(", ")} changed since` : ""}${filled(doing) ? ` · ${doing}${filled(now) ? `: ${now.replaceAll(/\s+/gu, " ")}` : ""}` : ""}`;
          })
          .join("\n") || "nothing running",
      );
    }
  },
});
