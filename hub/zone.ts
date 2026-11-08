import { readFileSync } from "node:fs";
import { join } from "node:path";

// The owner's time zone: TZ in the hex folder's .claude/settings.json, or else this machine's.
// The owner's zone, if settings name one Temporal knows.
export function zoneOf(hexDir: string): string | undefined {
  try {
    const zone =
      JSON.parse(readFileSync(join(hexDir, ".claude", "settings.json"), "utf-8")).env?.TZ ||
      undefined;

    if (zone) {
      Temporal.Now.zonedDateTimeISO(zone);
    }
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
