import { eventType, Inngest } from "inngest";
import { z } from "zod";

export const inngest = new Inngest({ id: "agent-system" });

// --- Shared schemas ---

const destinationSchema = z.object({
  chatId: z.string(),
  threadId: z.string(),
  messageId: z.string(),
});

export type Destination = z.infer<typeof destinationSchema>;

// --- Typed event definitions (runtime-validated via Zod) ---

export const agentMessageReceived = eventType("agent.message.received", {
  schema: z.object({
    message: z.string(),
    sessionKey: z.string(),
    channel: z.string(),
    sender: z.object({ id: z.string(), name: z.string().optional() }),
    destination: destinationSchema,
  }),
});

export type AgentMessageData = z.infer<typeof agentMessageReceived.schema>;

export const agentReplyReady = eventType("agent.reply.ready", {
  schema: z.object({
    response: z.string(),
    channel: z.string(),
    destination: destinationSchema,
  }),
});

export type AgentReplyData = z.infer<typeof agentReplyReady.schema>;

export const agentJobTriggered = eventType("agent.job.triggered", {
  schema: z.object({
    job: z.string(),
  }),
});

export type AgentJobData = z.infer<typeof agentJobTriggered.schema>;
