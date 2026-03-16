import { describe, expect, test } from "bun:test";
import {
  buildNotificationMessage,
  buildTriageBlocks,
  buildTriageUpdateText,
  type SlackBlock,
} from "./notify";

describe("buildNotificationMessage", () => {
  test("formats article notification", () => {
    const msg = buildNotificationMessage({
      title: "My Article",
      url: "https://example.com",
      type: "article",
      mode: "full",
      notePath: "sources/My Article.md",
    });
    expect(msg).toContain("My Article");
    expect(msg).toContain("article");
    expect(msg).toContain("full");
  });
});

describe("buildTriageUpdateText", () => {
  test("formats update text after decision", () => {
    const text = buildTriageUpdateText(
      "My Video",
      "youtube-video",
      "Channel · 10 min",
      "✅ Full capture started",
    );
    expect(text).toContain("My Video");
    expect(text).toContain("✅ Full capture started");
  });
});

describe("buildTriageBlocks", () => {
  test("builds Slack blocks with interactive buttons", () => {
    const blocks = buildTriageBlocks({
      captureId: "run-123",
      type: "youtube-video",
      title: "Great Video",
      description: "Channel Name · 45 min · 120K views",
    });
    expect(blocks).toBeInstanceOf(Array);
    expect(blocks.length).toBeGreaterThan(0);
    // Should contain action buttons
    const actionsBlock = blocks.find((b: SlackBlock) => b.type === "actions");
    expect(actionsBlock).toBeDefined();
  });
});
