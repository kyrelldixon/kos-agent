import { describe, expect, test } from "bun:test";
import { markdownToSlackMrkdwn, splitMessage } from "@/lib/format";

// send-reply's core logic is: format the response, split it, post to Slack.
// The formatting and splitting are tested in format.test.ts.
// Here we verify the integration expectation: formatted text stays within limits.

describe("send-reply formatting integration", () => {
  test("long response gets split into chunks under 3900 chars", () => {
    const longResponse = "This is a paragraph. ".repeat(300);
    const formatted = markdownToSlackMrkdwn(longResponse);
    const chunks = splitMessage(formatted);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3900);
    }
    expect(chunks.length).toBeGreaterThan(1);
  });
});
