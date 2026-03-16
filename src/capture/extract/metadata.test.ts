import { describe, expect, test } from "bun:test";
import { extractMetadata } from "./metadata";

describe("extractMetadata", () => {
  test("extracts metadata from a live article URL", async () => {
    const meta = await extractMetadata("https://example.com", "article");
    expect(meta.title).toBeDefined();
    expect(typeof meta.title).toBe("string");
  });

  test("returns partial metadata on failure", async () => {
    const meta = await extractMetadata(
      "https://this-domain-does-not-exist-abc123.com",
      "article",
    );
    expect(meta.title).toBeUndefined();
  });

  test("extracts youtube video metadata via oEmbed", async () => {
    const meta = await extractMetadata(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "youtube-video",
    );
    expect(meta.title).toContain("Rick");
    expect(meta.author).toBeDefined();
  });

  test("extracts hacker news metadata via Algolia API", async () => {
    const meta = await extractMetadata(
      "https://news.ycombinator.com/item?id=1",
      "hacker-news",
    );
    expect(meta.title).toBeDefined();
    expect(meta.hnPoints).toBeDefined();
    expect(meta.hnComments).toBeDefined();
  });
});
