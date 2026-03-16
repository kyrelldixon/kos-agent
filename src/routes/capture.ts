import { Hono } from "hono";
import { detectContentType } from "@/capture/detect-type";
import { CaptureRequestSchema } from "@/capture/schema";

// The inngest parameter is typed loosely to avoid importing the full Inngest type
// which would create a circular dependency risk. The route only needs .send()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createCaptureRoutes(inngest: {
  send: (events: any) => Promise<unknown>;
}): Hono {
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

    const { urls, filePath, mode, type, title } = parsed.data;
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
          source: "cli",
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
            source: "cli",
            mode: resolvedMode,
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
