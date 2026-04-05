import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { VoiceMemoUploadSchema } from "@/voice-memo/schema";

const CAPTURES_DIR = join(homedir(), ".kos", "agent", "captures");

// The inngest parameter is typed loosely to avoid importing the full Inngest type
// which would create a circular dependency risk. The route only needs .send()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createVoiceMemoRoutes(inngest: {
  send: (events: any) => Promise<unknown>;
}): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;

    if (!file || !(file instanceof File)) {
      return c.json({ error: "No file provided" }, 400);
    }

    const fileName = file.name;
    const fileSize = file.size;

    // Validate
    const validation = VoiceMemoUploadSchema.safeParse({ fileName, fileSize });
    if (!validation.success) {
      return c.json(
        { error: "Validation failed", details: validation.error.issues },
        400,
      );
    }

    // Save to captures directory
    const timestamp = Date.now();
    const captureDir = join(CAPTURES_DIR, `voice-memo-${timestamp}`);
    await mkdir(captureDir, { recursive: true });

    const filePath = join(captureDir, fileName);
    const arrayBuffer = await file.arrayBuffer();
    await Bun.write(filePath, arrayBuffer);

    // Fire Inngest event
    const captureKey = fileName;
    await inngest.send({
      name: "voice.memo.detected",
      data: { captureKey, filePath, fileName },
    });

    return c.json({ status: "accepted", captureKey }, 202);
  });

  return app;
}
