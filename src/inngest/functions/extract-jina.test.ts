import { describe, expect, test } from "bun:test";
import { fetchViaJina } from "./extract-jina";

describe("fetchViaJina", () => {
  test("fetches markdown from r.jina.ai", async () => {
    const content = await fetchViaJina("https://example.com");
    expect(typeof content).toBe("string");
  });

  test("returns empty string on timeout/failure", async () => {
    const content = await fetchViaJina(
      "https://this-domain-does-not-exist-abc123.com",
    );
    expect(content).toBe("");
  });
});
