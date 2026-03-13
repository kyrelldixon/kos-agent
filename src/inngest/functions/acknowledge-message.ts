import { slack } from "../../lib/slack.ts";
import { agentMessageReceived, inngest } from "../client.ts";

export const acknowledgeMessage = inngest.createFunction(
  {
    id: "acknowledge-message",
    retries: 0,
    triggers: [agentMessageReceived],
  },
  async ({ event, step }) => {
    const { channel, destination } = event.data;

    await step.run("acknowledge", async () => {
      if (channel === "slack") {
        await slack.reactions.add({
          channel: destination.chatId,
          timestamp: destination.messageId,
          name: "brain",
        });
      }
    });
  },
);
