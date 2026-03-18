import { agentReplyReady, inngest } from "@/inngest/client";
import { addReaction, removeReaction } from "@/lib/slack";

export const sendReply = inngest.createFunction(
  {
    id: "send-reply",
    retries: 3,
    triggers: [agentReplyReady],
  },
  async ({ event, step }) => {
    const { channel, destination } = event.data;

    // Text is already posted during the streaming zone in handle-message.
    // This function only handles the reaction swap: brain → checkmark.

    if (channel === "slack") {
      await step.run("remove-brain-reaction", () =>
        removeReaction(destination.chatId, destination.messageId, "brain"),
      );
      await step.run("add-checkmark-reaction", () =>
        addReaction(
          destination.chatId,
          destination.messageId,
          "white_check_mark",
        ),
      );
    }
  },
);
