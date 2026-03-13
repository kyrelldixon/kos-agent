import { describe, expect, test } from "bun:test";
import { markdownToSlackMrkdwn, splitMessage } from "./format";

describe("markdownToSlackMrkdwn", () => {
  test("converts headings to bold", () => {
    expect(markdownToSlackMrkdwn("## Hello")).toBe("*Hello*");
  });

  test("converts bold syntax", () => {
    expect(markdownToSlackMrkdwn("**bold text**")).toBe("*bold text*");
  });

  test("converts markdown links to slack links", () => {
    expect(markdownToSlackMrkdwn("[click](https://example.com)")).toBe(
      "<https://example.com|click>",
    );
  });

  test("preserves code blocks", () => {
    const input = "```\nconst x = 1;\n```";
    expect(markdownToSlackMrkdwn(input)).toBe(input);
  });

  test("preserves inline code", () => {
    const input = "use `const` here";
    expect(markdownToSlackMrkdwn(input)).toBe("use `const` here");
  });

  test("converts bullet lists", () => {
    expect(markdownToSlackMrkdwn("- item one")).toBe("• item one");
  });

  test("preserves bare URLs", () => {
    const input = "visit https://example.com/path_with_underscores today";
    const result = markdownToSlackMrkdwn(input);
    expect(result).toContain("https://example.com/path_with_underscores");
  });
});

describe("splitMessage", () => {
  test("returns single chunk for short messages", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
  });

  test("splits at paragraph boundaries", () => {
    const para1 = "a".repeat(2000);
    const para2 = "b".repeat(2000);
    const input = `${para1}\n\n${para2}`;
    const chunks = splitMessage(input);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(para1);
    expect(chunks[1]).toBe(para2);
  });

  test("respects maxLength parameter", () => {
    const chunks = splitMessage("hello world foo bar", 10);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(10);
    }
  });
});
