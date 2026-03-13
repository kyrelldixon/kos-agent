import { eventType, Inngest, staticSchema } from "inngest";

export const inngest = new Inngest({
  id: "agent-system",
  checkpointing: true,
});

// --- Normalized types (channel-agnostic for multi-channel readiness) ---

export type Destination = {
  chatId: string;
  threadId: string;
  messageId: string;
};

export type AgentMessageData = {
  message: string;
  sessionKey: string;
  channel: string;
  sender: { id: string; name?: string };
  destination: Destination;
};

export type AgentReplyData = {
  response: string;
  channel: string;
  destination: Destination;
};

// --- Typed event definitions ---

export const agentMessageReceived = eventType("agent.message.received", {
  schema: staticSchema<AgentMessageData>(),
});

export const agentReplyReady = eventType("agent.reply.ready", {
  schema: staticSchema<AgentReplyData>(),
});
