import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export interface SessionInput {
  message: string;
  sessionId?: string;
  workspace: string;
  destination?: { chatId: string; threadId?: string };
}

function buildSystemAppend(destination?: {
  chatId: string;
  threadId?: string;
}): string {
  const lines = [
    "You are running as a Slack bot agent. You have access to CLI tools (obsidian, linear, etc.) via Bash.",
    "Keep responses concise — they'll be posted to Slack threads.",
    "When asked to switch workspace, update your cwd accordingly.",
  ];

  if (destination) {
    lines.push(
      "",
      "## Slack Context",
      `Your current Slack context — chatId: ${destination.chatId}${destination.threadId ? `, threadId: ${destination.threadId}` : ""}.`,
      "Use these values when creating jobs so results come back to this conversation.",
    );
  }

  lines.push(
    "",
    "## Scheduled Jobs",
    "You can create and manage scheduled jobs via the jobs API at http://localhost:9080/api/jobs.",
    "Jobs run on a schedule via macOS LaunchAgents and execute through Inngest.",
    "",
    "To create a script job:",
    "1. mkdir -p ~/.kos/agent/jobs/<name>",
    "2. Write the script file: ~/.kos/agent/jobs/<name>/script (any language, must have shebang + chmod +x)",
    '3. curl -s -X POST http://localhost:9080/api/jobs -H "Content-Type: application/json" -d \'{"name":"<name>","schedule":{"type":"periodic","seconds":N},"execution":{"type":"script"},"destination":{"chatId":"<chatId>","threadId":"<threadId>"}}\'',
    "",
    "To create an agent job (you respond on a schedule):",
    'curl -s -X POST http://localhost:9080/api/jobs -H "Content-Type: application/json" -d \'{"name":"<name>","schedule":{"type":"scheduled","calendar":{"Hour":9,"Minute":0}},"execution":{"type":"agent","prompt":"<what to do>"},"destination":{"chatId":"<chatId>","threadId":"<threadId>"}}\'',
    "",
    "Schedule types: periodic (every N seconds), scheduled (calendar: Hour/Minute/Day/Weekday/Month).",
    'Other commands: GET /api/jobs (list), DELETE /api/jobs/<name>, PATCH /api/jobs/<name> with {"disabled":true} to pause.',
  );

  return lines.join("\n");
}

/** Stream Agent SDK messages. Caller iterates and handles each message. */
export async function* streamAgentSession(
  input: SessionInput,
): AsyncIterable<SDKMessage> {
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
        "Skill",
        "Agent",
      ],
      settingSources: ["user", "project", "local"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      cwd: input.workspace,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: buildSystemAppend(input.destination),
      },
      maxTurns: 25,
    },
  });

  for await (const msg of stream) {
    yield msg;
  }
}
