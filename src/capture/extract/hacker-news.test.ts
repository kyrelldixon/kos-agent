import { describe, expect, test } from "bun:test";
import { extractHNContent } from "./hacker-news";

describe("extractHNContent", () => {
  test("extracts article and comments from HN item", async () => {
    const result = await extractHNContent(
      "https://news.ycombinator.com/item?id=1",
    );
    expect(result.article).toBeDefined();
    expect(result.comments).toBeDefined();
    expect(Array.isArray(result.comments)).toBe(true);
  });
});
