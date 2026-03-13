import type { App } from "@slack/bolt";
import type { Inngest } from "inngest";
import { isUserAllowed } from "@/lib/channels";

export function buildEventData(
  channel: string,
  user: string,
  text: string,
  ts: string,
  threadTs?: string,
) {
  const resolvedThread = threadTs ?? ts;
  return {
    message: text,
    sessionKey: `slack-${channel}-${resolvedThread}`,
    channel: "slack" as const,
    sender: { id: user },
    destination: {
      chatId: channel,
      threadId: resolvedThread,
      messageId: ts,
    },
  };
}

export function registerMessageListeners(app: App, inngest: Inngest) {
  // Channel @mentions
  app.event("app_mention", async ({ event }) => {
    const user = event.user ?? "unknown";
    if (!(await isUserAllowed(user))) return;

    const text = (event.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!text) return;

    await inngest.send({
      name: "agent.message.received",
      data: buildEventData(
        event.channel,
        user,
        text,
        event.ts,
        event.thread_ts,
      ),
    });
  });

  // DMs only (channel IDs starting with D)
  app.message(async ({ message }) => {
    if (!message.channel.startsWith("D")) return;
    if ("bot_id" in message || message.subtype) return;

    const user = "user" in message ? (message.user ?? "unknown") : "unknown";
    if (!(await isUserAllowed(user))) return;

    const text = "text" in message ? (message.text ?? "") : "";
    const threadTs = "thread_ts" in message ? message.thread_ts : undefined;

    await inngest.send({
      name: "agent.message.received",
      data: buildEventData(message.channel, user, text, message.ts, threadTs),
    });
  });
}
