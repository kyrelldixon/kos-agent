import { NonRetriableError } from "inngest";
import { inngest } from "@/inngest/client";
import { addReaction, removeReaction, slack } from "@/lib/slack";

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

    if (channel === "slack") {
      await step.run("swap-reaction", async () => {
        await removeReaction(chatId, messageId, "brain");
        await addReaction(chatId, messageId, "x");
      });

      await step.run("notify-user", async () => {
        try {
          await slack.chat.postMessage({
            channel: chatId,
            text: `Something went wrong (\`${functionId}\`): ${error.slice(0, 150)}`,
            thread_ts: threadId,
          });
        } catch (err) {
          const slackError = err as { data?: { error?: string } };
          throw new NonRetriableError(
            `Failed to post error notification: ${slackError.data?.error ?? "unknown"}`,
            { cause: err as Error },
          );
        }
      });
    }
  },
);
