import { Hono } from "hono";
import { loadConfig, updateConfig } from "@/lib/channels";

const VALID_DISPLAY_MODES = ["verbose", "compact", "minimal"];

export function createConfigRoutes(): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const config = await loadConfig();
    return c.json(config);
  });

  app.patch("/", async (c) => {
    const body = await c.req.json();
    const errors: string[] = [];

    if (body.displayMode !== undefined) {
      if (!VALID_DISPLAY_MODES.includes(body.displayMode)) {
        errors.push(
          `displayMode must be one of: ${VALID_DISPLAY_MODES.join(", ")}`,
        );
      }
    }

    if (body.allowedUsers !== undefined) {
      if (body.allowedUsers !== "*" && !Array.isArray(body.allowedUsers)) {
        errors.push('allowedUsers must be "*" or string[]');
      }
    }

    if (body.globalDefault !== undefined) {
      if (typeof body.globalDefault !== "string") {
        errors.push("globalDefault must be a string");
      }
    }

    if (body.scanRoots !== undefined) {
      if (!Array.isArray(body.scanRoots)) {
        errors.push("scanRoots must be string[]");
      }
    }

    if (errors.length > 0) {
      return c.json({ error: "Validation failed", details: errors }, 400);
    }

    const updated = await updateConfig(body);
    return c.json(updated);
  });

  return app;
}
