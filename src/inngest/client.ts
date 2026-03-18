import { eventType, Inngest } from "inngest";
import { z } from "zod";
import {
  CaptureDecisionEventSchema,
  CaptureEventInngestSchema,
  CaptureFileEventSchema,
} from "@/capture/schema";

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

export const agentCaptureRequested = eventType("agent.capture.requested", {
  schema: CaptureEventInngestSchema,
});
export type AgentCaptureData = z.infer<typeof agentCaptureRequested.schema>;

export const agentCaptureFileRequested = eventType(
  "agent.capture.file.requested",
  {
    schema: CaptureFileEventSchema,
  },
);
export type AgentCaptureFileData = z.infer<
  typeof agentCaptureFileRequested.schema
>;

export const agentCaptureDecision = eventType("agent.capture.decision", {
  schema: CaptureDecisionEventSchema,
});
export type AgentCaptureDecisionData = z.infer<
  typeof agentCaptureDecision.schema
>;
