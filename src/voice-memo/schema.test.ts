import { describe, expect, test } from "bun:test";
import {
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE,
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
