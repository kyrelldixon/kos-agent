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
  let resultText = "";
  const assistantTexts: string[] = [];

  for (const msg of messages) {
    if (msg.type === "system" && msg.subtype === "init") {
      sessionId = msg.session_id;
    }

    // Capture text from assistant messages (intermediate responses)
    if (msg.type === "assistant" && msg.message?.content) {
      for (const part of msg.message.content) {
        if (part.type === "text" && part.text) {
          assistantTexts.push(part.text);
        }
      }
    }

    // Result message has the final response (if any)
    if (msg.type === "result" && msg.subtype === "success") {
      resultText = (msg as any).result ?? "";
    }
  }

  // Prefer result text, fall back to collected assistant texts
  const responseText = resultText || assistantTexts.join("\n\n");
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

  console.log(
    `[agent] Starting session: ${input.sessionId ? "resume" : "new"}, workspace: ${input.workspace}`,
  );

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
    // Log each message for observability
    if (msg.type === "system" && msg.subtype === "init") {
      console.log(`[agent] Session initialized: ${msg.session_id}`);
    } else if (msg.type === "assistant") {
      const parts = msg.message?.content ?? [];
      const textParts = parts.filter((p: any) => p.type === "text").length;
      const toolParts = parts.filter((p: any) => p.type === "tool_use");
      if (toolParts.length > 0) {
        console.log(
          `[agent] Tool use: ${toolParts.map((t: any) => t.name).join(", ")}`,
        );
      }
      if (textParts > 0) {
        console.log(`[agent] Assistant text (${textParts} parts)`);
      }
    } else if (msg.type === "result") {
      console.log(
        `[agent] Result: ${msg.subtype}, text length: ${((msg as any).result ?? "").length}`,
      );
    }

    messages.push(msg);
  }

  const result = extractResponse(messages);
  console.log(
    `[agent] Done. Response length: ${result.responseText.length}, sessionId: ${result.sessionId}`,
  );
  return result;
}
