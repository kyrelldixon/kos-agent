import { agentReplyReady, inngest } from "@/inngest/client";
import { markdownToSlackMrkdwn, splitMessage } from "@/lib/format";
import { slack } from "@/lib/slack";

export const sendReply = inngest.createFunction(
  {
    id: "send-reply",
    retries: 3,
    triggers: [agentReplyReady],
  },
  async ({ event, step }) => {
    const { response, channel, destination } = event.data;

    await step.run("send", async () => {
      if (channel === "slack") {
        const formatted = markdownToSlackMrkdwn(response);
        const chunks = splitMessage(formatted);
        for (const chunk of chunks) {
          await slack.chat.postMessage({
            channel: destination.chatId,
            text: chunk,
            thread_ts: destination.threadId,
          });
        }
      }
    });

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
