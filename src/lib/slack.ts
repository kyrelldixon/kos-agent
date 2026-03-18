import { WebClient } from "@slack/web-api";

// Shared client for outbound Slack API calls (postMessage, reactions, etc.)
// Retries disabled — Inngest handles retries at the function level.
export const slack = new WebClient(process.env.SLACK_BOT_TOKEN, {
  retryConfig: { retries: 0 },
});

/** Add a reaction, swallowing errors (reaction may already exist). */
export async function addReaction(
  channel: string,
  timestamp: string,
  name: string,
): Promise<void> {
  await slack.reactions
    .add({ channel, timestamp, name })
    .catch((err) => console.warn(`add :${name}: reaction failed:`, err));
}

/** Remove a reaction, swallowing errors (reaction may not exist). */
export async function removeReaction(
  channel: string,
  timestamp: string,
  name: string,
): Promise<void> {
  await slack.reactions
    .remove({ channel, timestamp, name })
    .catch((err) => console.warn(`remove :${name}: reaction failed:`, err));
}
