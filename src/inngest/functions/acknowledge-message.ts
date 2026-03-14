import { agentMessageReceived, inngest } from "@/inngest/client";
import { slack } from "@/lib/slack";

export const acknowledgeMessage = inngest.createFunction(
  {
    id: "acknowledge-message",
    retries: 0,
    triggers: [agentMessageReceived],
  },
  async ({ event, step }) => {
    const { channel, destination } = event.data;

    try {
      await step.run("add-reaction", async () => {
        if (channel === "slack") {
          await slack.reactions.add({
            channel: destination.chatId,
            timestamp: destination.messageId,
            name: "brain",
          });
        }
      });
    } catch (err) {
      console.warn("acknowledge reaction failed:", err);
    }
  },
);
