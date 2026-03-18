import { describe, expect, test } from "bun:test";
import {
  formatToolUse,
  markdownToSlackMrkdwn,
  splitMessage,
} from "@/lib/format";

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

  test("strips language tags from code blocks", () => {
    const input = "```typescript\nconst x = 1;\n```";
    expect(markdownToSlackMrkdwn(input)).toBe("```\nconst x = 1;\n```");
  });

  test("preserves inline code", () => {
    const input = "use `const` here";
    expect(markdownToSlackMrkdwn(input)).toBe("use `const` here");
  });

  test("converts bullet lists", () => {
    expect(markdownToSlackMrkdwn("- item one")).toBe("• item one");
  });

  test("preserves numbered list order", () => {
    const input = "1. first\n2. second\n3. third";
    expect(markdownToSlackMrkdwn(input)).toBe("1. first\n2. second\n3. third");
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

describe("formatToolUse", () => {
  test("formats Bash with command preview", () => {
    expect(formatToolUse("Bash", { command: "git status" })).toBe(
      "🔧 Bash: `git status`",
    );
  });

  test("truncates long Bash commands at 80 chars", () => {
    const longCmd = "a".repeat(100);
    const result = formatToolUse("Bash", { command: longCmd });
    expect(result).toBe(`🔧 Bash: \`${"a".repeat(77)}...\``);
  });

  test("formats Read with file path", () => {
    expect(formatToolUse("Read", { file_path: "src/index.ts" })).toBe(
      "📄 Read: src/index.ts",
    );
  });

  test("formats Write with file path", () => {
    expect(formatToolUse("Write", { file_path: "src/lib/format.ts" })).toBe(
      "📝 Write: src/lib/format.ts",
    );
  });

  test("formats Edit with file path", () => {
    expect(formatToolUse("Edit", { file_path: "src/bolt/app.ts" })).toBe(
      "✏️ Edit: src/bolt/app.ts",
    );
  });

  test("formats Glob with pattern", () => {
    expect(formatToolUse("Glob", { pattern: "src/**/*.ts" })).toBe(
      "🔍 Glob: src/**/*.ts",
    );
  });

  test("formats Grep with pattern", () => {
    expect(formatToolUse("Grep", { pattern: "handleMessage" })).toBe(
      '🔍 Grep: "handleMessage"',
    );
  });

  test("formats WebFetch with url", () => {
    expect(formatToolUse("WebFetch", { url: "https://example.com" })).toBe(
      "🌐 Fetch: https://example.com",
    );
  });

  test("truncates long URLs at 60 chars", () => {
    const longUrl = `https://example.com/${"a".repeat(60)}`;
    const result = formatToolUse("WebFetch", { url: longUrl });
    expect(result.length).toBeLessThanOrEqual(70);
  });

  test("formats WebSearch with query", () => {
    expect(
      formatToolUse("WebSearch", { query: "inngest error handling" }),
    ).toBe('🌐 Search: "inngest error handling"');
  });

  test("formats unknown tools with just the name", () => {
    expect(formatToolUse("TodoWrite", { tasks: [] })).toBe("🔧 TodoWrite");
  });
});
