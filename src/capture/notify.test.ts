import { describe, expect, test } from "bun:test";
import { buildNotificationMessage } from "./notify";

describe("buildNotificationMessage", () => {
  test("formats success notification with description", () => {
    const msg = buildNotificationMessage({
      title: "Article Title",
      url: "https://example.com/article",
      notePath: "~/kyrell-os-vault/sources/Article Title.md",
      description: "A great article about testing",
    });
    expect(msg).toContain("*Article Title*");
    expect(msg).toContain("A great article about testing");
    expect(msg).toContain("https://example.com/article");
    expect(msg).toContain("~/kyrell-os-vault/sources/Article Title.md");
    // Should NOT contain old format labels
    expect(msg).not.toContain("article ·");
    expect(msg).not.toContain("full capture");
  });

  test("formats failure notification", () => {
    const msg = buildNotificationMessage({
      title: "Bad Page",
      url: "https://example.com/broken",
      notePath: "~/kyrell-os-vault/sources/Bad Page.md",
      description: "",
      failed: true,
    });
    expect(msg).toContain("*Failed: Bad Page*");
    expect(msg).toContain("metadata saved, needs manual processing");
  });

  test("handles missing URL", () => {
    const msg = buildNotificationMessage({
      title: "Local File",
      notePath: "~/kyrell-os-vault/sources/Local File.md",
      description: "A local document",
    });
    expect(msg).toContain("*Local File*");
    expect(msg).not.toContain("undefined");
  });
});
