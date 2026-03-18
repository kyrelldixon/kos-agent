import { agentMessageReceived, inngest } from "@/inngest/client";
import { addReaction } from "@/lib/slack";

export const acknowledgeMessage = inngest.createFunction(
  {
    id: "acknowledge-message",
    retries: 0,
    triggers: [agentMessageReceived],
  },
  async ({ event, step }) => {
    const { channel, destination } = event.data;

    if (channel === "slack") {
      await step.run("add-reaction", () =>
        addReaction(destination.chatId, destination.messageId, "brain"),
      );
    }
  },
);
