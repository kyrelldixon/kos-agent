import { describe, expect, test } from "bun:test";
import { fetchAndConvertLocal } from "./extract-local";

describe("fetchAndConvertLocal", () => {
  test("converts HTML to markdown via Readability + node-html-markdown", async () => {
    const content = await fetchAndConvertLocal("https://example.com");
    expect(typeof content).toBe("string");
    expect(content.length).toBeGreaterThan(0);
    expect(content).not.toContain("<html");
    expect(content).not.toContain("<body");
  });

  test("returns empty string on failure", async () => {
    const content = await fetchAndConvertLocal(
      "https://this-domain-does-not-exist-abc123.com",
    );
    expect(content).toBe("");
  });
});
