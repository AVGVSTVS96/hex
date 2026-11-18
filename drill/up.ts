import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { until } from "../hub/until.ts";
import { cloudflare } from "./cloudflare.ts";
import { folder } from "./hex.ts";
import { telegram } from "./telegram.ts";

const chat = telegram();
const store = cloudflare();
const hex = await folder("a", { telegramUrl: chat.url, storeUrl: store.url });
const env = join(hex.dir, "env");

await hex.moveInto();

hex.start();

await until(hex.connected);

writeFileSync(
  env,
  Object.entries(hex.env)
    .map(([name, value]) => `export ${name}=${JSON.stringify(value)}\n`)
    .join(""),
);

console.log(`a scratch hex runs in ${hex.dir}

  write to it as its owner   curl -d 'hello hex' ${chat.url}/owner
  what it sent to Telegram   curl ${chat.url}/sent
  its commands               (. ${env}; ${join(hex.hex, "bin/hex")} threads)
  its hub's log              ${join(hex.dir, "state/hub.log")}

It's removed when this ends: Ctrl-C, or \`kill\` this process.`);
