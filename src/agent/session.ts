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
    "Manage scheduled jobs with the kos CLI. All output is JSON.",
    "",
    "Create a script job (always start --script with #!/bin/bash):",
    'kos jobs create <name> --schedule periodic --seconds <N> --type script --script "#!/bin/bash\\n<commands>" --channel <chatId> --thread <threadId>',
    "",
    "Create an agent job:",
    'kos jobs create <name> --schedule scheduled --hour 9 --minute 0 --type agent --prompt "<what to do>" --channel <chatId> --thread <threadId>',
    "",
    "Other commands:",
    "kos jobs list",
    "kos jobs delete <name>",
    "kos jobs pause <name>",
    "kos jobs resume <name>",
    "",
    "Schedule types:",
    "- periodic: --seconds N",
    "- scheduled: --hour H --minute M (also --day, --weekday, --month)",
    "For multiple triggers per job, use --json mode with a calendar array.",
  );

  lines.push(
    "",
    "## Content Capture",
    "Capture URLs and content into the Obsidian vault using the kos CLI.",
    "",
    "Commands:",
    "kos capture <url> --quick          # Quick save: metadata only",
    "kos capture <url> --full           # Full capture: extract content",
    "kos capture <url>                  # Triage: Slack buttons to decide",
    "kos capture --batch-file urls.txt  # Batch capture from file",
    "kos capture --file /path/to/doc    # Capture a local file",
    "",
    "Content types (auto-detected): article, youtube-video, youtube-channel, hacker-news, github-repo",
    "",
    "After capturing, you can:",
    '- Read the vault note with: obsidian read file="Title"',
    '- Add a summary: obsidian append file="Title" content="Summary text"',
    '- Update properties: obsidian property:set name=status value=done file="Title"',
    '- Create notes from templates: obsidian create name="Title" template="Template Name"',
    "",
    "When someone shares a URL in Slack, consider whether to capture it.",
    "After capturing, read the extracted content and provide a useful summary.",
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
