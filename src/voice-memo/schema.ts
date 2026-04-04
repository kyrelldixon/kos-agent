import { z } from "zod";

export const ALLOWED_EXTENSIONS = [".m4a", ".mp3", ".wav", ".webm"] as const;
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

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
