import { agentReplyReady, inngest } from "@/inngest/client";
import { slack } from "@/lib/slack";

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

    try {
      await step.run("remove-brain-reaction", async () => {
        if (channel === "slack") {
          await slack.reactions.remove({
            channel: destination.chatId,
            timestamp: destination.messageId,
            name: "brain",
          });
        }
      });
    } catch (err) {
      console.warn("remove brain reaction failed:", err);
    }

    try {
      await step.run("add-checkmark-reaction", async () => {
        if (channel === "slack") {
          await slack.reactions.add({
            channel: destination.chatId,
            timestamp: destination.messageId,
            name: "white_check_mark",
          });
        }
      });
    } catch (err) {
      console.warn("add checkmark reaction failed:", err);
    }
  },
);
