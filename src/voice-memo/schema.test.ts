import { describe, expect, test } from "bun:test";
import {
  ALLOWED_EXTENSIONS,
  CONTENT_TYPE_TO_EXTENSION,
  extensionFromContentType,
  VoiceMemoEventSchema,
  VoiceMemoUploadSchema,
} from "./schema";

describe("VoiceMemoUploadSchema", () => {
  test("accepts valid .m4a upload", () => {
    const result = VoiceMemoUploadSchema.safeParse({
      fileName: "recording.m4a",
      fileSize: 1024 * 1024,
    });
    expect(result.success).toBe(true);
  });

  test("rejects non-audio extension", () => {
    const result = VoiceMemoUploadSchema.safeParse({
      fileName: "document.pdf",
      fileSize: 1024,
    });
    expect(result.success).toBe(false);
  });

  test("rejects file over 50MB", () => {
    const result = VoiceMemoUploadSchema.safeParse({
      fileName: "huge.m4a",
      fileSize: 51 * 1024 * 1024,
    });
    expect(result.success).toBe(false);
  });

  test("accepts all allowed extensions", () => {
    for (const ext of ALLOWED_EXTENSIONS) {
      const result = VoiceMemoUploadSchema.safeParse({
        fileName: `test${ext}`,
        fileSize: 1024,
      });
      expect(result.success).toBe(true);
    }
  });
});

describe("extensionFromContentType", () => {
  test("maps iOS m4a content types", () => {
    expect(extensionFromContentType("audio/x-m4a")).toBe(".m4a");
    expect(extensionFromContentType("audio/mp4")).toBe(".m4a");
    expect(extensionFromContentType("audio/m4a")).toBe(".m4a");
  });

  test("maps mp3/wav/webm content types", () => {
    expect(extensionFromContentType("audio/mpeg")).toBe(".mp3");
    expect(extensionFromContentType("audio/wav")).toBe(".wav");
    expect(extensionFromContentType("audio/webm")).toBe(".webm");
  });

  test("strips parameters and normalizes case", () => {
    expect(extensionFromContentType("AUDIO/X-M4A; charset=binary")).toBe(
      ".m4a",
    );
  });

  test("returns null for unsupported or missing types", () => {
    expect(extensionFromContentType(undefined)).toBeNull();
    expect(extensionFromContentType("")).toBeNull();
    expect(extensionFromContentType("application/json")).toBeNull();
    expect(extensionFromContentType("image/png")).toBeNull();
  });

  test("map covers all allowed extensions", () => {
    const mapped = new Set(Object.values(CONTENT_TYPE_TO_EXTENSION));
    for (const ext of ALLOWED_EXTENSIONS) {
      expect(mapped.has(ext)).toBe(true);
    }
  });
});

describe("VoiceMemoEventSchema", () => {
  test("accepts valid event data", () => {
    const result = VoiceMemoEventSchema.safeParse({
      captureKey: "recording-2026-04-04.m4a",
      filePath:
        "/home/user/.kos/agent/captures/voice-memo-1712246400/recording.m4a",
      fileName: "recording.m4a",
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing fields", () => {
    const result = VoiceMemoEventSchema.safeParse({
      captureKey: "test",
    });
    expect(result.success).toBe(false);
  });
});
