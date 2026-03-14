import { inngest } from "@/inngest/client";
import { slack } from "@/lib/slack";

export const handleFailure = inngest.createFunction(
  {
    id: "handle-failure",
    retries: 0,
    triggers: [{ event: "inngest/function.failed" }],
  },
  async ({ event, step }) => {
    const originalEvent = event.data.event;
    if (!originalEvent?.data?.destination) return;

    const { chatId, threadId, messageId } = originalEvent.data.destination;
    const channel = originalEvent.data.channel;
    const functionId = event.data.function_id;
    const error = event.data.error?.message ?? "Unknown error";

    await step.run("notify-user", async () => {
      if (channel === "slack") {
        await slack.reactions
          .remove({ channel: chatId, timestamp: messageId, name: "brain" })
          .catch(() => {});
        await slack.reactions
          .add({
            channel: chatId,
            timestamp: messageId,
            name: "x",
          })
          .catch(() => {});
        await slack.chat.postMessage({
          channel: chatId,
          text: `Something went wrong (\`${functionId}\`): ${error.slice(0, 150)}`,
          thread_ts: threadId,
        });
      }
    });
  },
);
