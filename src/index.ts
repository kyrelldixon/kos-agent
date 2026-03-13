import { Hono } from "hono";
import { serve } from "inngest/hono";
import { createBoltApp } from "@/bolt/app";
import { registerMessageListener } from "@/bolt/listeners/message";
import { inngest } from "@/inngest/client";
import { acknowledgeMessage, sendReply } from "@/inngest/functions/index";

// Must delete before Agent SDK query() — SDK detects Claude Code env and changes behavior.
delete process.env.CLAUDECODE;

// Inngest functions — added as implemented (Tasks 5-9)
const functions = [acknowledgeMessage, sendReply];

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
