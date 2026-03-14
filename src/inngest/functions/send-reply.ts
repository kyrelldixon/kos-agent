import { NonRetriableError } from "inngest";
import { agentReplyReady, inngest } from "@/inngest/client";
import { markdownToSlackMrkdwn, splitMessage } from "@/lib/format";
import { slack } from "@/lib/slack";

/** Classify Slack API errors and throw the appropriate Inngest error type. */
function handleSlackError(err: unknown, context: string): never {
  const slackError = err as { data?: { error?: string; retry_after?: number } };
  const errorCode = slackError.data?.error ?? "unknown";

  // Permanent errors — retrying won't help
  const permanent = [
    "missing_scope",
    "not_authed",
    "invalid_auth",
    "account_inactive",
    "channel_not_found",
    "not_in_channel",
  ];
  if (permanent.includes(errorCode)) {
    throw new NonRetriableError(`${context}: ${errorCode}`, {
      cause: err as Error,
    });
  }

  // Re-throw for Inngest to retry with default backoff
  throw err;
}

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
        const text = response?.trim();
        if (!text) {
          await slack.chat
            .postMessage({
              channel: destination.chatId,
              text: "_No response generated._",
              thread_ts: destination.threadId,
            })
            .catch((err) => handleSlackError(err, "send empty response"));
          return;
        }
        const formatted = markdownToSlackMrkdwn(text);
        const chunks = splitMessage(formatted);
        for (const chunk of chunks) {
          await slack.chat
            .postMessage({
              channel: destination.chatId,
              text: chunk,
              thread_ts: destination.threadId,
            })
            .catch((err) => handleSlackError(err, "send reply chunk"));
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
