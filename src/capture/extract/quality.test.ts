import { describe, expect, test } from "bun:test";
import { checkContentQuality } from "./quality";

describe("checkContentQuality", () => {
  test("rejects short content", () => {
    expect(checkContentQuality("too short")).toBe(false);
  });

  test("accepts 200+ chars of real content", () => {
    const content = "a".repeat(250);
    expect(checkContentQuality(content)).toBe(true);
  });

  test("strips HTML tags before measuring", () => {
    const html = `<nav>nav content</nav><p>${"a".repeat(100)}</p>`;
    expect(checkContentQuality(html)).toBe(false);
  });

  test("strips markdown formatting before measuring", () => {
    const md = `# Heading\n\n**bold** and [link](url) with ${"a".repeat(200)}`;
    expect(checkContentQuality(md)).toBe(true);
  });

  test("rejects markdown that is mostly formatting", () => {
    const md = "# H\n## H\n### H\n- item\n- item\n[link](url)";
    expect(checkContentQuality(md)).toBe(false);
  });
});
