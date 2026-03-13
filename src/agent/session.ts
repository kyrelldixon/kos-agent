import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

interface SessionInput {
  message: string;
  sessionId?: string;
  workspace: string;
}

interface SessionResult {
  sessionId?: string;
  responseText: string;
}

/** Extract sessionId and response text from a collected array of SDK messages. */
export function extractResponse(messages: SDKMessage[]): SessionResult {
  let sessionId: string | undefined;
  let responseText = "";

  for (const msg of messages) {
    if (msg.type === "system" && msg.subtype === "init") {
      sessionId = msg.session_id;
    }
    if (msg.type === "result" && msg.subtype === "success") {
      responseText = (msg as any).result ?? "";
    }
  }

  return { sessionId, responseText };
}

function buildSystemAppend(): string {
  return [
    "You are running as a Slack bot agent. You have access to CLI tools (obsidian, linear, etc.) via Bash.",
    "Keep responses concise — they'll be posted to Slack threads.",
    "When asked to switch workspace, update your cwd accordingly.",
  ].join("\n");
}

export async function runAgentSession(
  input: SessionInput,
): Promise<SessionResult> {
  const messages: SDKMessage[] = [];

  const stream = query({
    prompt: input.message,
    options: {
      ...(input.sessionId ? { resume: input.sessionId } : {}),
      allowedTools: [
        "Read",
        "Write",
        "Edit",
        "Bash",
        "Glob",
        "Grep",
        "WebFetch",
        "WebSearch",
      ],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      cwd: input.workspace,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: buildSystemAppend(),
      },
      maxTurns: 10,
    },
  });

  for await (const msg of stream) {
    messages.push(msg);
  }

  return extractResponse(messages);
}
