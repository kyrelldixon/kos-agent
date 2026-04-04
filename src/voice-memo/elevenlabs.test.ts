import { describe, expect, test } from "bun:test";
import { buildTranscriptionResult, formatDuration } from "./elevenlabs";

describe("formatDuration", () => {
  test("formats seconds to M:SS", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(5)).toBe("0:05");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(3661)).toBe("61:01");
  });
});

describe("buildTranscriptionResult", () => {
  test("extracts transcript and duration from API response", () => {
    const apiResponse = {
      text: "Hello world",
      words: [
        { text: "Hello", start: 0.0, end: 0.5, type: "word" },
        { text: " ", start: 0.5, end: 0.6, type: "spacing" },
        { text: "world", start: 0.6, end: 1.2, type: "word" },
      ],
    };
    const result = buildTranscriptionResult(apiResponse);
    expect(result.transcript).toBe("Hello world");
    expect(result.duration).toBe("0:01");
  });

  test("handles empty response", () => {
    const apiResponse = { text: "", words: [] };
    const result = buildTranscriptionResult(apiResponse);
    expect(result.transcript).toBe("");
    expect(result.duration).toBe("0:00");
  });

  test("handles response with audio events", () => {
    const apiResponse = {
      text: "Hello (laughter) world",
      words: [
        { text: "Hello", start: 0.0, end: 0.5, type: "word" },
        { text: "(laughter)", start: 1.0, end: 2.0, type: "audio_event" },
        { text: "world", start: 2.5, end: 3.0, type: "word" },
      ],
    };
    const result = buildTranscriptionResult(apiResponse);
    expect(result.transcript).toBe("Hello (laughter) world");
    expect(result.duration).toBe("0:03");
  });
});
