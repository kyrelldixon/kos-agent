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
  handleScheduledJob,
  sendReply,
} from "@/inngest/functions/index";
import { syncAllJobs } from "@/jobs/sync";
import { getOrCreateDeploySecret } from "@/lib/deploy/secret";
import { cfAccessMiddleware } from "@/lib/middleware/access";
import { createConfigRoutes } from "@/routes/config";
import { createHooksRoutes } from "@/routes/hooks";
import { createJobsRoutes } from "@/routes/jobs";
import { createWorkspacesRoutes } from "@/routes/workspaces";

// Must delete before Agent SDK query() — SDK detects Claude Code env and changes behavior.
delete process.env.CLAUDECODE;

// Ensure data directories exist
const dataDir = join(homedir(), ".kos/agent");
await mkdir(join(dataDir, "sessions"), { recursive: true });
await mkdir(join(dataDir, "jobs"), { recursive: true });
await mkdir(join(dataDir, "logs"), { recursive: true });

// Sync LaunchAgents on startup
const syncReport = await syncAllJobs();
if (syncReport.synced.length || syncReport.removed.length) {
  console.log(
    `[jobs] Synced: ${syncReport.synced.length}, removed: ${syncReport.removed.length}, unchanged: ${syncReport.unchanged.length}`,
  );
}

// All Inngest functions registered
const functions = [
  acknowledgeMessage,
  handleFailure,
  handleMessage,
  handleScheduledJob,
  sendReply,
];

const hono = new Hono();

// Inngest serve endpoint (no auth — localhost only, accessed by local Inngest dev server)
hono.on(
  ["GET", "POST", "PUT"],
  "/api/inngest",
  serve({ client: inngest, functions }),
);

// Health check (no auth)
hono.get("/health", (c) => c.json({ status: "ok" }));

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
  hono.use("/api/jobs", accessMw);
  hono.use("/api/jobs/*", accessMw);
}
hono.route("/api/config", createConfigRoutes());
hono.route("/api/workspaces", createWorkspacesRoutes());
hono.route("/api/jobs", createJobsRoutes());

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
