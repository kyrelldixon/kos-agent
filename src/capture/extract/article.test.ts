import { describe, expect, test } from "bun:test";
import { extractArticleContent } from "./article";

describe("extractArticleContent", () => {
  test("extracts markdown from a public URL", async () => {
    const result = await extractArticleContent("https://example.com");
    expect(result).toBeDefined();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("returns empty string on failure", async () => {
    const result = await extractArticleContent(
      "https://this-domain-does-not-exist-abc123.com",
    );
    expect(result).toBe("");
  });
});
