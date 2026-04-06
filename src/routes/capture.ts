import { Hono } from "hono";
import { detectContentType } from "@/capture/detect-type";
import { CaptureRequestSchema } from "@/capture/schema";
import type { InngestSender } from "@/lib/inngest-sender";

export function createCaptureRoutes(inngest: InngestSender): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const parsed = CaptureRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed", details: parsed.error.issues },
        400,
      );
    }

    const { urls, filePath, mode, type, title, destination } = parsed.data;
    const captured: Array<{
      captureKey: string;
      url?: string;
      filePath?: string;
      type: string;
      mode: string;
    }> = [];

    if (filePath) {
      const captureKey = `file://${filePath}`;
      await inngest.send({
        name: "agent.capture.file.requested",
        data: {
          captureKey,
          filePath,
          title,
          destination,
        },
      });
      captured.push({
        captureKey,
        filePath,
        type: "file",
        mode: "full",
      });
    } else if (urls) {
      const events = urls.map((url) => {
        const detectedType = type ?? detectContentType(url);
        const resolvedMode = mode ?? "triage";
        return {
          name: "agent.capture.requested",
          data: {
            captureKey: url,
            url,
            type: detectedType,
            mode: resolvedMode,
            destination,
          },
        };
      });

      await inngest.send(events);

      for (const event of events) {
        captured.push({
          captureKey: event.data.captureKey,
          url: event.data.url,
          type: event.data.type,
          mode: event.data.mode,
        });
      }
    }

    return c.json({ captured }, 202);
  });

  return app;
}
