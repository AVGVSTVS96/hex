import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

const Settings = z.object({ env: z.object({ TZ: z.string().optional() }).optional() });

export function zoneOf(hexDir: string): string | undefined {
  try {
    const zone = Settings.parse(
      JSON.parse(readFileSync(join(hexDir, ".claude", "settings.json"), "utf-8")),
    ).env?.TZ;

    if (zone === undefined || zone === "") {
      return undefined;
    }

    Temporal.Now.zonedDateTimeISO(zone);

    return zone;
  } catch (error) {
    if (error instanceof RangeError) {
      process.stderr.write(
        `hex: TZ in .claude/settings.json isn't a zone hex knows, so it uses this machine's: ${error}\n`,
      );
    }

    return undefined;
  }
}
