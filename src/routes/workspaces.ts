import { Hono } from "hono";
import { scanWorkspaces } from "@/lib/channels";

export function createWorkspacesRoutes(): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const workspaces = await scanWorkspaces();
    return c.json({ workspaces });
  });

  return app;
}
