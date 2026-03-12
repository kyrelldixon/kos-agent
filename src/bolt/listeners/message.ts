import type { App } from "@slack/bolt";

export function registerMessageListener(app: App) {
  app.event("app_mention", async ({ event, say }) => {
    await say({
      text: `Got it: "${event.text}"`,
      thread_ts: event.ts,
    });
  });

  app.message(async ({ message, say }) => {
    if (message.channel_type !== "im") return;
    if (message.subtype) return;

    await say(`Echo: ${message.text}`);
  });
}
