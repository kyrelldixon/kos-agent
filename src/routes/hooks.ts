import { Hono } from "hono";
import { verifyGitHubSignature } from "@/lib/deploy/verify-signature";

interface HooksRoutesOptions {
  secret: string;
  spawnDeploy: () => { unref: () => void };
}

export function createHooksRoutes(options: HooksRoutesOptions): Hono {
  const app = new Hono();

  app.post("/deploy", async (c) => {
    const body = await c.req.text();
    const signature = c.req.header("x-hub-signature-256");
    const event = c.req.header("x-github-event");

    if (!verifyGitHubSignature(options.secret, body, signature)) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    if (event !== "push") {
      return c.json({ triggered: false, reason: "not a push event" });
    }

    const payload = JSON.parse(body);
    if (payload.ref !== "refs/heads/main") {
      return c.json({ triggered: false, reason: "not main branch" });
    }

    const child = options.spawnDeploy();
    child.unref();

    return c.json({ triggered: true });
  });

  return app;
}
