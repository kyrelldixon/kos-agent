import { describe, expect, test } from "bun:test";
import { extractYouTubeTranscript, listChannelVideos } from "./youtube";

describe("extractYouTubeTranscript", () => {
  test("extracts transcript from a public video", async () => {
    // Use a known video with captions
    const transcript = await extractYouTubeTranscript(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(typeof transcript).toBe("string");
    // May be empty if no captions available, but should not throw
  });
});

describe("listChannelVideos", () => {
  test("lists recent videos from a channel", async () => {
    const videos = await listChannelVideos("https://www.youtube.com/@Fireship");
    expect(Array.isArray(videos)).toBe(true);
    expect(videos.length).toBeLessThanOrEqual(10);
  });
});
