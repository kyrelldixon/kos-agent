import type { App } from "@slack/bolt";
import type { Inngest } from "inngest";
import { isUserAllowed } from "@/lib/channels";
import { getSession } from "@/lib/sessions";

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
  // Channel @mentions — always processed
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

  // DMs + thread replies in channels where bot has a session
  app.message(async ({ message }) => {
    if ("bot_id" in message || message.subtype) return;

    const isDM = message.channel.startsWith("D");
    const threadTs = "thread_ts" in message ? message.thread_ts : undefined;

    // In channels, only respond to thread replies where we have an active session
    if (!isDM) {
      if (!threadTs) return; // Top-level channel message without @mention — ignore
      const sessionKey = `slack-${message.channel}-${threadTs}`;
      const session = await getSession(sessionKey);
      if (!session) return; // No session for this thread — ignore
    }

    const user = "user" in message ? (message.user ?? "unknown") : "unknown";
    if (!(await isUserAllowed(user))) return;

    const text = "text" in message ? (message.text ?? "") : "";

    await inngest.send({
      name: "agent.message.received",
      data: buildEventData(message.channel, user, text, message.ts, threadTs),
    });
  });
}
