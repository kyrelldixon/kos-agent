import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { InngestSender } from "@/lib/inngest-sender";
import {
  CONTENT_TYPE_TO_EXTENSION,
  extensionFromContentType,
  VoiceMemoUploadSchema,
} from "@/voice-memo/schema";

const CAPTURES_DIR = join(homedir(), ".kos", "agent", "captures");

function defaultFileName(extension: string): string {
  // Generates "YYYYMMDD HHMMSS.ext", which matches the default-name pattern
  // in voice-memo/templates.ts so deriveTitle() produces "Voice Memo — …".
  const now = new Date();
  const date =
    `${now.getFullYear()}` +
    `${String(now.getMonth() + 1).padStart(2, "0")}` +
    `${String(now.getDate()).padStart(2, "0")}`;
  const time =
    `${String(now.getHours()).padStart(2, "0")}` +
    `${String(now.getMinutes()).padStart(2, "0")}` +
    `${String(now.getSeconds()).padStart(2, "0")}`;
  return `${date} ${time}${extension}`;
}

export function createVoiceMemoRoutes(inngest: InngestSender): Hono {
  const app = new Hono();

  // Accepts the audio file as the raw request body (Content-Type: audio/*).
  // Designed for Apple Shortcuts, which cannot reliably attach a variable as
  // a multipart form field but can send a file as the request body directly.
  app.post("/", async (c) => {
    const contentType = c.req.header("content-type");
    const extension = extensionFromContentType(contentType);
    if (!extension) {
      return c.json(
        {
          error: `Unsupported Content-Type: ${contentType ?? "(none)"}`,
          supported: Object.keys(CONTENT_TYPE_TO_EXTENSION),
        },
        415,
      );
    }

    const arrayBuffer = await c.req.arrayBuffer();
    const fileSize = arrayBuffer.byteLength;
    if (fileSize === 0) {
      return c.json({ error: "Empty request body" }, 400);
    }

    // Optional X-Filename override lets callers preserve a custom name.
    const fileName =
      c.req.header("x-filename")?.trim() || defaultFileName(extension);

    const validation = VoiceMemoUploadSchema.safeParse({ fileName, fileSize });
    if (!validation.success) {
      return c.json(
        { error: "Validation failed", details: validation.error.issues },
        400,
      );
    }

    // Save to captures directory under a unique per-upload subdirectory.
    const timestamp = Date.now();
    const captureDir = join(CAPTURES_DIR, `voice-memo-${timestamp}`);
    await mkdir(captureDir, { recursive: true });

    const filePath = join(captureDir, fileName);
    await Bun.write(filePath, arrayBuffer);

    // Fire Inngest event. The captureDir timestamp makes captureKey unique
    // per upload even when fileName is a generic default.
    const captureKey = `${timestamp}-${fileName}`;
    await inngest.send({
      name: "voice.memo.detected",
      data: { captureKey, filePath, fileName },
    });

    return c.json({ status: "accepted", captureKey }, 202);
  });

  return app;
}
