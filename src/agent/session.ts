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
    `kos jobs create <name> --schedule periodic --seconds <N> --type script --script "#!/bin/bash\\n<commands>" --channel ${destination?.chatId ?? "<chatId>"} --thread ${destination?.threadId ?? "<threadId>"}`,
    "",
    "Create an agent job:",
    `kos jobs create <name> --schedule scheduled --hour 9 --minute 0 --type agent --prompt "<what to do>" --channel ${destination?.chatId ?? "<chatId>"} --thread ${destination?.threadId ?? "<threadId>"}`,
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
    "## Content Capture — CRITICAL: THIS IS ASYNC",
    "",
    "kos capture triggers a background pipeline. It returns IMMEDIATELY.",
    "The vault note WILL NOT EXIST for 5-30 seconds after the command returns.",
    "",
    "ALWAYS use --full or --quick mode. ALWAYS include --channel and --thread flags:",
    `  kos capture <url> --full --channel ${destination?.chatId ?? "<chatId>"} --thread ${destination?.threadId ?? "<threadId>"}`,
    "",
    "After running kos capture, you MUST follow this exact sequence:",
    "1. Run: sleep 15",
    '2. Run: obsidian read file="<Title>"',
    "3. If the note doesn't exist yet, run: sleep 10",
    '4. Run: obsidian read file="<Title>" one more time',
    "5. Only AFTER you have successfully read the note, summarize it for the user",
    "",
    "NEVER tell the user you captured something before verifying the note exists.",
    "NEVER try to manually create or write the note yourself — the pipeline handles it.",
    "",
    "Content types (auto-detected): article, youtube-video, youtube-channel, hacker-news, github-repo",
    "",
    "Other capture commands:",
    "  kos capture <url> --quick          # Quick save: metadata only",
    "  kos capture --batch-file urls.txt  # Batch capture from file",
    "  kos capture --file /path/to/doc    # Capture a local file",
    "",
    "After confirming the note exists, you can:",
    '  obsidian append file="Title" content="Summary text"',
    '  obsidian property:set name=status value=done file="Title"',
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

  const env: Record<string, string | undefined> = { ...process.env };
  if (input.destination?.chatId) {
    env.KOS_SLACK_CHANNEL = input.destination.chatId;
  }
  if (input.destination?.threadId) {
    env.KOS_SLACK_THREAD = input.destination.threadId;
  }

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
      env,
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
