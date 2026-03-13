import { Hono } from "hono";
import { serve } from "inngest/hono";
import { createBoltApp } from "./bolt/app.ts";
import { registerMessageListener } from "./bolt/listeners/message.ts";
import { inngest } from "./inngest/client.ts";

// Must delete before Agent SDK query() — SDK detects Claude Code env and changes behavior.
delete process.env.CLAUDECODE;

// Inngest functions will be added here as they're implemented (Tasks 5-9)
const functions: Parameters<typeof serve>[0]["functions"] = [];

const hono = new Hono();
hono.on(
  ["GET", "POST", "PUT"],
  "/api/inngest",
  serve({ client: inngest, functions }),
);
hono.get("/health", (c) => c.json({ status: "ok" }));

Bun.serve({ port: 9080, fetch: hono.fetch.bind(hono) });

const bolt = createBoltApp();
// Keep existing echo listener for now — will be replaced in Task 10
registerMessageListener(bolt);
await bolt.start();

console.log("Agent system running — Hono :9080, Bolt Socket Mode, Inngest");
