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

// Must delete before Agent SDK query() — SDK detects Claude Code env and changes behavior.
delete process.env.CLAUDECODE;

// All Inngest functions registered
const functions = [acknowledgeMessage, handleFailure, handleMessage, sendReply];

const hono = new Hono();
hono.on(
  ["GET", "POST", "PUT"],
  "/api/inngest",
  serve({ client: inngest, functions }),
);
hono.get("/health", (c) => c.json({ status: "ok" }));

Bun.serve({ port: 9080, fetch: hono.fetch.bind(hono) });

const bolt = createBoltApp();
registerListeners(bolt, inngest);
await bolt.start();

console.log("Agent system running — Hono :9080, Bolt Socket Mode, Inngest");
