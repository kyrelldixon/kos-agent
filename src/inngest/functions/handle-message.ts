import { runAgentSession } from "@/agent/session";
import { agentMessageReceived, inngest } from "@/inngest/client";
import { resolveWorkspace } from "@/lib/channels";
import { getSession, saveSession } from "@/lib/sessions";

export const handleMessage = inngest.createFunction(
  {
    id: "handle-message",
    retries: 0,
    triggers: [agentMessageReceived],
    singleton: { key: "event.data.sessionKey", mode: "cancel" },
  },
  async ({ event, step }) => {
    const { message, sessionKey, destination } = event.data;

    const session = await step.run("resolve-session", async () => {
      return getSession(sessionKey);
    });

    const workspace = await step.run("resolve-workspace", async () => {
      return session?.workspace ?? (await resolveWorkspace(destination.chatId));
    });

    const result = await step.run("agent-query", async () => {
      return runAgentSession({
        message,
        sessionId: session?.sessionId,
        workspace,
      });
    });

    if (result.sessionId) {
      await step.run("save-session", async () => {
        saveSession(sessionKey, { sessionId: result.sessionId as string });
      });
    }

    await step.sendEvent("send-reply", {
      name: "agent.reply.ready",
      data: {
        response: result.responseText,
        channel: event.data.channel,
        destination,
      },
    });
  },
);
