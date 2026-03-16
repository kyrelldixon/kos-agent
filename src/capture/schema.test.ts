import { describe, expect, test } from "bun:test";
import {
  CaptureDecisionEventSchema,
  CaptureDestinationSchema,
  CaptureEventSchema,
  CaptureFileEventSchema,
  CaptureRequestSchema,
} from "./schema";

describe("CaptureDestinationSchema", () => {
  test("accepts chatId only", () => {
    const result = CaptureDestinationSchema.safeParse({ chatId: "C123" });
    expect(result.success).toBe(true);
  });

  test("accepts chatId + threadId", () => {
    const result = CaptureDestinationSchema.safeParse({
      chatId: "C123",
      threadId: "1234567890.123456",
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing chatId", () => {
    const result = CaptureDestinationSchema.safeParse({ threadId: "123" });
    expect(result.success).toBe(false);
  });
});

describe("CaptureEventSchema", () => {
  test("validates minimal capture event", () => {
    const result = CaptureEventSchema.safeParse({
      captureKey: "https://example.com",
      url: "https://example.com",
      source: "cli",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe("triage"); // default
    }
  });

  test("validates full capture event", () => {
    const result = CaptureEventSchema.safeParse({
      captureKey: "https://youtube.com/watch?v=abc",
      url: "https://youtube.com/watch?v=abc",
      type: "youtube-video",
      source: "slack",
      destination: { chatId: "C123", threadId: "ts123" },
      batchId: "batch-1",
      parentCaptureId: "parent-1",
      mode: "full",
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid source", () => {
    const result = CaptureEventSchema.safeParse({
      captureKey: "https://example.com",
      url: "https://example.com",
      source: "invalid",
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid content type", () => {
    const result = CaptureEventSchema.safeParse({
      captureKey: "https://example.com",
      url: "https://example.com",
      source: "cli",
      type: "podcast",
    });
    expect(result.success).toBe(false);
  });
});

describe("CaptureFileEventSchema", () => {
  test("validates file capture event", () => {
    const result = CaptureFileEventSchema.safeParse({
      captureKey: "file:///Users/me/doc.md",
      filePath: "/Users/me/doc.md",
      source: "cli",
    });
    expect(result.success).toBe(true);
  });

  test("accepts optional title", () => {
    const result = CaptureFileEventSchema.safeParse({
      captureKey: "file:///Users/me/doc.md",
      filePath: "/Users/me/doc.md",
      title: "My Document",
      source: "cli",
    });
    expect(result.success).toBe(true);
  });

  test("rejects extension source", () => {
    const result = CaptureFileEventSchema.safeParse({
      captureKey: "file:///Users/me/doc.md",
      filePath: "/Users/me/doc.md",
      source: "extension",
    });
    expect(result.success).toBe(false);
  });
});

describe("CaptureDecisionEventSchema", () => {
  test("validates decision event", () => {
    const result = CaptureDecisionEventSchema.safeParse({
      captureId: "run-123",
      action: "full",
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid action", () => {
    const result = CaptureDecisionEventSchema.safeParse({
      captureId: "run-123",
      action: "maybe",
    });
    expect(result.success).toBe(false);
  });
});

describe("CaptureRequestSchema", () => {
  test("validates URL request", () => {
    const result = CaptureRequestSchema.safeParse({
      urls: ["https://example.com"],
    });
    expect(result.success).toBe(true);
  });

  test("validates file request", () => {
    const result = CaptureRequestSchema.safeParse({
      filePath: "/Users/me/doc.md",
    });
    expect(result.success).toBe(true);
  });

  test("rejects both urls and filePath", () => {
    const result = CaptureRequestSchema.safeParse({
      urls: ["https://example.com"],
      filePath: "/Users/me/doc.md",
    });
    expect(result.success).toBe(false);
  });

  test("rejects neither urls nor filePath", () => {
    const result = CaptureRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("rejects empty urls array", () => {
    const result = CaptureRequestSchema.safeParse({ urls: [] });
    expect(result.success).toBe(false);
  });

  test("validates with all options", () => {
    const result = CaptureRequestSchema.safeParse({
      urls: ["https://example.com", "https://youtube.com/watch?v=abc"],
      mode: "full",
      type: "article",
    });
    expect(result.success).toBe(true);
  });
});
