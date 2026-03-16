import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { serve } from "inngest/hono";
import { createBoltApp } from "@/bolt/app";
import { registerListeners } from "@/bolt/listeners/index";
import { inngest } from "@/inngest/client";
import {
  acknowledgeMessage,
  handleFailure,
  handleMessage,
  sendReply,
} from "@/inngest/functions/index";
import { getOrCreateDeploySecret } from "@/lib/deploy/secret";
import { cfAccessMiddleware } from "@/lib/middleware/access";
import { createConfigRoutes } from "@/routes/config";
import { createHooksRoutes } from "@/routes/hooks";
import { createWorkspacesRoutes } from "@/routes/workspaces";

// Must delete before Agent SDK query() — SDK detects Claude Code env and changes behavior.
delete process.env.CLAUDECODE;

// Ensure data directories exist
const dataDir = join(homedir(), ".kos/agent");
await mkdir(join(dataDir, "sessions"), { recursive: true });

// All Inngest functions registered
const functions = [acknowledgeMessage, handleFailure, handleMessage, sendReply];

const hono = new Hono();

// Inngest serve endpoint (no auth — localhost only, accessed by local Inngest dev server)
hono.on(
  ["GET", "POST", "PUT"],
  "/api/inngest",
  serve({ client: inngest, functions }),
);

// Health check (no auth)
hono.get("/health", (c) => c.json({ status: "ok" }));

// TEMPORARY: Test launchctl from within kos-agent process (remove after Test 0)
hono.get("/test/launchctl", async (c) => {
  const uid = String(process.getuid?.() ?? 501);
  const bootstrap = Bun.spawnSync([
    "launchctl",
    "bootstrap",
    `gui/${uid}`,
    join(homedir(), "Library/LaunchAgents/kos.test.plist"),
  ]);
  const list = Bun.spawnSync(["launchctl", "list"]);
  const listOut = new TextDecoder().decode(list.stdout);
  const kosLines = listOut.split("\n").filter((l) => l.includes("kos"));
  return c.json({
    uid,
    bootstrapOk: bootstrap.exitCode === 0,
    bootstrapStderr: new TextDecoder().decode(bootstrap.stderr),
    kosLines,
  });
});

// Deploy webhook (auth via HMAC signature, Cloudflare Access bypass)
const deploySecret = await getOrCreateDeploySecret(
  join(dataDir, "deploy-secret.txt"),
);
const repoDir = join(import.meta.dir, "..");

hono.route(
  "/api/hooks",
  createHooksRoutes({
    secret: deploySecret,
    spawnDeploy: () => {
      const logPath = join(homedir(), "Library/Logs/kos-agent-deploy.log");
      const fd = openSync(logPath, "a");
      return spawn("bash", ["deploy.sh"], {
        cwd: repoDir,
        detached: true,
        stdio: ["ignore", fd, fd],
      });
    },
  }),
);

// Protected API routes (auth via Cloudflare Access service token)
const cfClientId = process.env.CF_ACCESS_CLIENT_ID ?? "";
if (cfClientId) {
  const accessMw = cfAccessMiddleware(cfClientId);
  hono.use("/api/config", accessMw);
  hono.use("/api/config/*", accessMw);
  hono.use("/api/workspaces", accessMw);
  hono.use("/api/workspaces/*", accessMw);
}
hono.route("/api/config", createConfigRoutes());
hono.route("/api/workspaces", createWorkspacesRoutes());

// Start HTTP server — bind to localhost only (Cloudflare Tunnel connects locally)
Bun.serve({
  port: 9080,
  hostname: "127.0.0.1",
  fetch: hono.fetch.bind(hono),
});

// Start Slack bot
const bolt = createBoltApp();
registerListeners(bolt, inngest);
await bolt.start();

console.log(
  "kos-agent running — Hono :9080 (localhost), Bolt Socket Mode, Inngest",
);
