import { z } from "zod";

export const ALLOWED_EXTENSIONS = [".m4a", ".mp3", ".wav", ".webm"] as const;
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

// Maps Content-Type header (lowercased, params stripped) to the extension
// we'll save the upload under. Covers the variants Apple Shortcuts / iOS
// send for Voice Memos (.m4a) plus the other formats we accept.
export const CONTENT_TYPE_TO_EXTENSION: Record<string, string> = {
  "audio/x-m4a": ".m4a",
  "audio/m4a": ".m4a",
  "audio/mp4": ".m4a",
  "audio/mp4a-latm": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/wave": ".wav",
  "audio/webm": ".webm",
};

export function extensionFromContentType(
  contentType: string | undefined,
): string | null {
  if (!contentType) return null;
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return CONTENT_TYPE_TO_EXTENSION[base] ?? null;
}

export const VoiceMemoUploadSchema = z.object({
  fileName: z
    .string()
    .refine(
      (name) =>
        ALLOWED_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext)),
      `File must be one of: ${ALLOWED_EXTENSIONS.join(", ")}`,
    ),
  fileSize: z
    .number()
    .max(MAX_FILE_SIZE, `File must be under ${MAX_FILE_SIZE / 1024 / 1024}MB`),
});

export type VoiceMemoUpload = z.infer<typeof VoiceMemoUploadSchema>;

export const VoiceMemoEventSchema = z.object({
  captureKey: z.string(),
  filePath: z.string(),
  fileName: z.string(),
});

export type VoiceMemoEvent = z.infer<typeof VoiceMemoEventSchema>;
