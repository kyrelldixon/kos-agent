import { describe, expect, test } from "bun:test";
import { buildVoiceMemoNote, deriveTitle } from "./templates";

describe("deriveTitle", () => {
  test("uses custom filename when not a timestamp pattern", () => {
    expect(deriveTitle("Workshop ideas.m4a")).toBe("Workshop ideas");
  });

  test("generates date-based title for default Voice Memos names", () => {
    const title = deriveTitle("20260404 142345.m4a");
    expect(title).toMatch(/^Voice Memo — \d{2}-\d{2}-\d{4}/);
  });

  test("strips extension from custom names", () => {
    expect(deriveTitle("My thoughts on pricing.m4a")).toBe(
      "My thoughts on pricing",
    );
  });

  test("handles New Recording default name", () => {
    const title = deriveTitle("New Recording.m4a");
    expect(title).toMatch(/^Voice Memo — /);
  });

  test("handles New Recording with number", () => {
    const title = deriveTitle("New Recording 3.m4a");
    expect(title).toMatch(/^Voice Memo — /);
  });
});

describe("buildVoiceMemoNote", () => {
  test("builds complete vault note with transcript", () => {
    const note = buildVoiceMemoNote({
      title: "Workshop ideas",
      filePath: "/path/to/recording.m4a",
      duration: "4:32",
      transcript: "Here are my thoughts on the workshop.",
      extractionMethod: "elevenlabs",
    });

    expect(note).toContain('categories:\n  - "[[Sources]]"');
    expect(note).toContain("source_type: voice-memo");
    expect(note).toContain('file_path: "/path/to/recording.m4a"');
    expect(note).toContain('duration: "4:32"');
    expect(note).toContain("extraction_method: elevenlabs");
    expect(note).toContain("topics: []");
    expect(note).toContain("status: raw");
    expect(note).toContain("# Workshop ideas");
    expect(note).toContain("Here are my thoughts on the workshop.");
  });

  test("builds note with transcription-failed status when transcript is empty", () => {
    const note = buildVoiceMemoNote({
      title: "Failed memo",
      filePath: "/path/to/recording.m4a",
      duration: "",
      transcript: "",
      extractionMethod: "elevenlabs",
    });

    expect(note).toContain("status: transcription-failed");
    expect(note).toContain("# Failed memo");
  });

  test("includes created date in MM-DD-YYYY format with wikilink", () => {
    const note = buildVoiceMemoNote({
      title: "Test",
      filePath: "/test.m4a",
      duration: "1:00",
      transcript: "test",
      extractionMethod: "elevenlabs",
    });

    const dateMatch = note.match(/created: "\[\[(\d{2}-\d{2}-\d{4})\]\]"/);
    expect(dateMatch).not.toBeNull();
  });
});
