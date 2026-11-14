import { Bot } from "grammy";

const token = process.env.TELEGRAM_BOT_TOKEN;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// grammY's calls share their connections to Telegram, so asking who the bot is, which takes in no messages, opens the one the hub's first calls take once hex stops waiting, without a new TLS handshake.
if (token !== undefined && token !== "") {
  // oxlint-disable-next-line eslint/no-empty-function -- one that fails leaves the hub's first calls to open their own
  void new Bot(token).api.getMe().catch(() => {});
}
