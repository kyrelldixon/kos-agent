import { describe, expect, test } from "bun:test";
import { buildVaultNote, renderVaultNote } from "./templates";

describe("renderVaultNote", () => {
  test("renders article note with full content", () => {
    const note = renderVaultNote({
      type: "article",
      mode: "full",
      title: "My Article",
      url: "https://example.com/post",
      author: "Jane Doe",
      published: "2026-03-15",
      content: "# Full article content\n\nHello world.",
    });

    expect(note).toContain('categories:\n  - "[[Sources]]"');
    expect(note).toContain('author: "[[Jane Doe]]"');
    expect(note).toContain('url: "https://example.com/post"');
    expect(note).toContain("source_type: article");
    expect(note).toContain("capture_mode: full");
    expect(note).toContain("status: raw");
    expect(note).toContain("# My Article");
    expect(note).toContain("# Full article content");
  });

  test("renders article note in quick mode", () => {
    const note = renderVaultNote({
      type: "article",
      mode: "quick",
      title: "My Article",
      url: "https://example.com",
      description: "A short description of the article.",
    });

    expect(note).toContain("capture_mode: quick");
    expect(note).toContain("A short description of the article.");
    expect(note).not.toContain("# Full article");
  });

  test("renders youtube video note with transcript", () => {
    const note = renderVaultNote({
      type: "youtube-video",
      mode: "full",
      title: "Great Video",
      url: "https://youtube.com/watch?v=abc",
      author: "Channel Name",
      channel: "Channel Name",
      duration: "45:32",
      views: 120000,
      content: "Full transcript here...",
    });

    expect(note).toContain('channel: "[[Channel Name]]"');
    expect(note).toContain('duration: "45:32"');
    expect(note).toContain("views: 120000");
    expect(note).toContain("source_type: youtube-video");
    expect(note).toContain("Full transcript here...");
  });

  test("renders youtube channel note", () => {
    const note = renderVaultNote({
      type: "youtube-channel",
      mode: "full",
      title: "Fireship",
      url: "https://youtube.com/@Fireship",
      description: "High-intensity code tutorials.",
    });

    expect(note).toContain('categories:\n  - "[[YouTubers]]"');
    expect(note).toContain("youtube_url:");
    expect(note).toContain("![[Sources.base#Author]]");
  });

  test("renders hacker news note", () => {
    const note = renderVaultNote({
      type: "hacker-news",
      mode: "full",
      title: "Some HN Post",
      url: "https://original-article.com",
      hnUrl: "https://news.ycombinator.com/item?id=123",
      hnPoints: 150,
      hnComments: 42,
      content: "Article content...",
    });

    expect(note).toContain("source_type: hacker-news");
    expect(note).toContain("hn_url:");
    expect(note).toContain("hn_points: 150");
    expect(note).toContain("hn_comments: 42");
  });

  test("renders twitter note", () => {
    const note = renderVaultNote({
      type: "twitter",
      mode: "full",
      title: "Tweet by someone",
      url: "https://x.com/user/status/123",
      author: "User Name",
      handle: "@user",
      content: "The full tweet thread text...",
    });

    expect(note).toContain("source_type: twitter");
    expect(note).toContain('handle: "@user"');
    expect(note).toContain("The full tweet thread text...");
  });

  test("renders file capture note", () => {
    const note = renderVaultNote({
      type: "file",
      mode: "full",
      title: "My Conversation",
      filePath: "/Users/me/conversation.md",
      content: "# Conversation\n\nStuff here...",
    });

    expect(note).toContain("source_type: file");
    expect(note).toContain('file_path: "/Users/me/conversation.md"');
  });

  test("uses today's date in MM-DD-YYYY format with backlink", () => {
    const note = renderVaultNote({
      type: "article",
      mode: "quick",
      title: "Test",
      url: "https://example.com",
    });

    // Date should match [[MM-DD-YYYY]] pattern
    const dateMatch = note.match(/created: "\[\[(\d{2}-\d{2}-\d{4})\]\]"/);
    expect(dateMatch).not.toBeNull();
  });

  test("omits conditional fields when not provided", () => {
    const note = renderVaultNote({
      type: "article",
      mode: "quick",
      title: "Test",
      url: "https://example.com",
    });

    expect(note).not.toContain("channel:");
    expect(note).not.toContain("duration:");
    expect(note).not.toContain("views:");
    expect(note).not.toContain("hn_url:");
    expect(note).not.toContain("handle:");
    expect(note).not.toContain("file_path:");
  });
});

describe("buildVaultNote", () => {
  test("builds article note with frontmatter and body content", () => {
    const note = buildVaultNote({
      type: "article",
      title: "Test Article",
      url: "https://example.com",
      author: "John Doe",
      description: "A test article",
      content: "Full article content here",
      extractionMethod: "jina",
    });

    // Frontmatter
    expect(note).toContain("source_type: article");
    expect(note).toContain('url: "https://example.com"');
    expect(note).toContain("extraction_method: jina");
    expect(note).toContain("status: raw");
    // Body — summary in content, not frontmatter
    expect(note).toContain("# Test Article");
    expect(note).toContain("A test article");
    expect(note).toContain("Full article content here");
  });

  test("sets extraction-failed status when content is empty on full mode", () => {
    const note = buildVaultNote({
      type: "article",
      title: "Failed Article",
      url: "https://example.com",
      extractionFailed: true,
    });
    expect(note).toContain("status: extraction-failed");
  });

  test("builds github-repo note with repo-specific fields", () => {
    const note = buildVaultNote({
      type: "github-repo",
      title: "cool-repo",
      url: "https://github.com/owner/cool-repo",
      stars: 1234,
      language: "TypeScript",
      license: "MIT",
      localPath: "~/projects/cool-repo",
    });
    expect(note).toContain("source_type: github-repo");
    expect(note).toContain("stars: 1234");
    expect(note).toContain('language: "TypeScript"');
    expect(note).toContain('local_path: "~/projects/cool-repo"');
  });
});
