import { describe, expect, test } from "bun:test";
import { buildVaultNote } from "./templates";

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

  test("uses today's date in MM-DD-YYYY format with backlink", () => {
    const note = buildVaultNote({
      type: "article",
      title: "Test",
      url: "https://example.com",
    });

    const dateMatch = note.match(/created: "\[\[(\d{2}-\d{2}-\d{4})\]\]"/);
    expect(dateMatch).not.toBeNull();
  });

  test("omits conditional fields when not provided", () => {
    const note = buildVaultNote({
      type: "article",
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

  test("builds youtube-channel note", () => {
    const note = buildVaultNote({
      type: "youtube-channel",
      title: "Fireship",
      url: "https://youtube.com/@Fireship",
    });

    expect(note).toContain('categories:\n  - "[[YouTube Channels]]"');
    expect(note).toContain("youtube_url:");
    expect(note).toContain("![[Sources.base#Author]]");
  });
});
