import { WebClient } from "@slack/web-api";

// Shared client for outbound Slack API calls (postMessage, reactions, etc.)
// Retries disabled — Inngest handles retries at the function level.
export const slack = new WebClient(process.env.SLACK_BOT_TOKEN, {
  retryConfig: { retries: 0 },
});
