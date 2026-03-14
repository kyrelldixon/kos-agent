# Streaming & Tool Visibility Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream agent tool usage and text to Slack in real-time instead of one silent block at the end, with two display modes (verbose/compact).

**Architecture:** Move the agent SDK query out of `step.run()` in the handle-message Inngest function. Durable steps handle session/workspace resolution and post-query persistence. The streaming zone iterates SDK messages and posts to Slack as they arrive. `send-reply` still posts the final result text and handles reaction swaps.

**Tech Stack:** Bun, Inngest v4, @anthropic-ai/claude-agent-sdk, @slack/web-api, Hono

**Spec:** `docs/superpowers/specs/2026-03-14-streaming-and-tool-visibility-design.md`

---

## File Structure

```
agent-system/
  src/
    agent/
      session.ts                    # Refactor: streamAgentSession() returns AsyncIterable (MODIFY)
      session.test.ts               # Rewrite tests for new streaming API (MODIFY)
    lib/
      format.ts                     # Add formatToolUse() (MODIFY)
      format.test.ts                # Add formatToolUse tests (MODIFY)
      channels.ts                   # Add getDisplayMode() (MODIFY)
      channels.test.ts              # Add getDisplayMode test (MODIFY)
    inngest/
      functions/
        handle-message.ts           # Rewrite: streaming loop + display modes (MODIFY)
  data/
    channels.json                   # Add displayMode field (MODIFY)
```

---

## Chunk 1: Tool Formatting and Display Mode Config

### Task 1: Add formatToolUse to format.ts

**Files:**
- Modify: `src/lib/format.ts`
- Modify: `src/lib/format.test.ts`

- [ ] **Step 1: Write tests for formatToolUse**

Add to `src/lib/format.test.ts`:
```typescript
import { markdownToSlackMrkdwn, splitMessage, formatToolUse } from "@/lib/format";

// ... existing tests ...

describe("formatToolUse", () => {
  test("formats Bash with command preview", () => {
    expect(formatToolUse("Bash", { command: "git status" })).toBe(
      "🔧 Bash: `git status`",
    );
  });

  test("truncates long Bash commands at 80 chars", () => {
    const longCmd = "a".repeat(100);
    const result = formatToolUse("Bash", { command: longCmd });
    expect(result).toBe(`🔧 Bash: \`${"a".repeat(77)}...\``);
  });

  test("formats Read with file path", () => {
    expect(formatToolUse("Read", { file_path: "src/index.ts" })).toBe(
      "📄 Read: src/index.ts",
    );
  });

  test("formats Write with file path", () => {
    expect(formatToolUse("Write", { file_path: "src/lib/format.ts" })).toBe(
      "📝 Write: src/lib/format.ts",
    );
  });

  test("formats Edit with file path", () => {
    expect(formatToolUse("Edit", { file_path: "src/bolt/app.ts" })).toBe(
      "✏️ Edit: src/bolt/app.ts",
    );
  });

  test("formats Glob with pattern", () => {
    expect(formatToolUse("Glob", { pattern: "src/**/*.ts" })).toBe(
      "🔍 Glob: src/**/*.ts",
    );
  });

  test("formats Grep with pattern", () => {
    expect(formatToolUse("Grep", { pattern: "handleMessage" })).toBe(
      '🔍 Grep: "handleMessage"',
    );
  });

  test("formats WebFetch with url", () => {
    expect(formatToolUse("WebFetch", { url: "https://example.com" })).toBe(
      "🌐 Fetch: https://example.com",
    );
  });

  test("truncates long URLs at 60 chars", () => {
    const longUrl = "https://example.com/" + "a".repeat(60);
    const result = formatToolUse("WebFetch", { url: longUrl });
    expect(result.length).toBeLessThanOrEqual(70); // emoji + label + truncated url
  });

  test("formats WebSearch with query", () => {
    expect(formatToolUse("WebSearch", { query: "inngest error handling" })).toBe(
      '🌐 Search: "inngest error handling"',
    );
  });

  test("formats unknown tools with just the name", () => {
    expect(formatToolUse("TodoWrite", { tasks: [] })).toBe("🔧 TodoWrite");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/projects/agent-system && bun test src/lib/format.test.ts
```

Expected: FAIL — `formatToolUse` is not exported from `format.ts`.

- [ ] **Step 3: Implement formatToolUse**

Add to the end of `src/lib/format.ts`:
```typescript
function truncate(str: string, max: number): string {
  return str.length > max ? `${str.slice(0, max - 3)}...` : str;
}

/** Format a tool use into a one-line Slack message. */
export function formatToolUse(
  name: string,
  input: Record<string, unknown>,
): string {
  switch (name) {
    case "Bash":
      return `🔧 Bash: \`${truncate(String(input.command ?? ""), 80)}\``;
    case "Read":
      return `📄 Read: ${truncate(String(input.file_path ?? ""), 100)}`;
    case "Write":
      return `📝 Write: ${truncate(String(input.file_path ?? ""), 100)}`;
    case "Edit":
      return `✏️ Edit: ${truncate(String(input.file_path ?? ""), 100)}`;
    case "Glob":
      return `🔍 Glob: ${truncate(String(input.pattern ?? ""), 100)}`;
    case "Grep":
      return `🔍 Grep: "${truncate(String(input.pattern ?? ""), 100)}"`;
    case "WebFetch":
      return `🌐 Fetch: ${truncate(String(input.url ?? ""), 60)}`;
    case "WebSearch":
      return `🌐 Search: "${truncate(String(input.query ?? ""), 100)}"`;
    default:
      return `🔧 ${name}`;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ~/projects/agent-system && bun test src/lib/format.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/format.ts src/lib/format.test.ts
git commit -m "feat(lib): add formatToolUse for Slack tool display"
```

---

### Task 2: Add getDisplayMode to channels.ts and update channels.json

**Files:**
- Modify: `src/lib/channels.ts`
- Modify: `src/lib/channels.test.ts`
- Modify: `data/channels.json`

- [ ] **Step 1: Add displayMode to channels.json**

Add `"displayMode": "verbose"` to the top level of `data/channels.json`. The file currently looks like:
```json
{
  "allowedUsers": ["UGZLW3Q69"],
  "channels": { ... },
  "workspaces": [ ... ],
  "globalDefault": "~/projects/kyrell-os"
}
```

Add the field:
```json
{
  "displayMode": "verbose",
  "allowedUsers": ["UGZLW3Q69"],
  ...
}
```

- [ ] **Step 2: Write test for getDisplayMode**

Add to `src/lib/channels.test.ts`:
```typescript
import { isUserAllowed, resolveWorkspace, getDisplayMode } from "./channels";

// ... existing tests ...

describe("getDisplayMode", () => {
  test("returns display mode from config", async () => {
    const result = await getDisplayMode();
    expect(result).toBe("verbose");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd ~/projects/agent-system && bun test src/lib/channels.test.ts
```

Expected: FAIL — `getDisplayMode` is not exported.

- [ ] **Step 4: Implement getDisplayMode**

Add the `displayMode` field to `ChannelsConfig` interface and add the function at the end of `src/lib/channels.ts`:

Update the interface:
```typescript
interface ChannelsConfig {
  displayMode?: "verbose" | "compact";
  allowedUsers: string | string[];
  channels: Record<string, ChannelData>;
  workspaces: { label: string; path: string }[];
  globalDefault: string;
}
```

Add the function:
```typescript
export async function getDisplayMode(): Promise<"verbose" | "compact"> {
  const config = await loadConfig();
  return config.displayMode ?? "verbose";
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd ~/projects/agent-system && bun test src/lib/channels.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/channels.ts src/lib/channels.test.ts data/channels.json
git commit -m "feat(lib): add displayMode config and getDisplayMode"
```

---

## Chunk 2: Session Streaming Refactor

### Task 3: Refactor session.ts to return AsyncIterable

**Files:**
- Modify: `src/agent/session.ts`
- Modify: `src/agent/session.test.ts`

- [ ] **Step 1: Rewrite session.ts — streamAgentSession returns AsyncIterable**

Rewrite `src/agent/session.ts`:
```typescript
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export interface SessionInput {
  message: string;
  sessionId?: string;
  workspace: string;
}

function buildSystemAppend(): string {
  return [
    "You are running as a Slack bot agent. You have access to CLI tools (obsidian, linear, etc.) via Bash.",
    "Keep responses concise — they'll be posted to Slack threads.",
    "When asked to switch workspace, update your cwd accordingly.",
  ].join("\n");
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
        append: buildSystemAppend(),
      },
      maxTurns: 10,
    },
  });

  for await (const msg of stream) {
    yield msg;
  }
}
```

Key changes:
- `runAgentSession()` → `streamAgentSession()` (async generator)
- Returns `AsyncIterable<SDKMessage>` — caller iterates and handles each message
- `extractResponse()` removed — handle-message processes messages inline
- `SessionResult` type removed — no longer needed
- `SessionInput` is now exported (handle-message needs it)
- Logging moves to handle-message (the consumer)
- Added `Skill` and `Agent` to `allowedTools` — enables project skill invocation
- Added `settingSources: ["user", "project", "local"]` — tells SDK to discover skills in the cwd project's `.claude/skills/`

- [ ] **Step 2: Rewrite session.test.ts**

Rewrite `src/agent/session.test.ts` — since `streamAgentSession` calls the real SDK, we only test that the module exports correctly and the input types work:

```typescript
import { describe, expect, test } from "bun:test";
import { streamAgentSession, type SessionInput } from "@/agent/session";

describe("streamAgentSession", () => {
  test("is an async generator function", () => {
    // Verify the function exists and has the right shape
    expect(typeof streamAgentSession).toBe("function");
  });

  test("SessionInput type is exported", () => {
    // Type-level test — if this compiles, the type is correctly exported
    const input: SessionInput = {
      message: "test",
      workspace: "/tmp",
    };
    expect(input.message).toBe("test");
  });
});
```

- [ ] **Step 3: Run tests**

```bash
cd ~/projects/agent-system && bun test src/agent/session.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run all tests + typecheck**

```bash
cd ~/projects/agent-system && bunx tsc --noEmit && bun test
```

Expected: Type errors in `handle-message.ts` because it still imports `runAgentSession`. This is expected — we fix it in Task 4.

If typecheck fails only on handle-message.ts imports, that's fine. If other files fail, fix them.

- [ ] **Step 5: Continue to handle-message rewrite (same commit)**

Do NOT commit yet — session.ts and handle-message.ts must be committed together to avoid a broken build.

---

## Chunk 3: Handle Message Streaming Rewrite

### Task 4: Rewrite handle-message with streaming loop (continues Task 3)

**Files:**
- Modify: `src/inngest/functions/handle-message.ts`

This is the core change. The agent query moves out of `step.run()` and into a streaming loop that posts to Slack as messages arrive.

- [ ] **Step 1: Rewrite handle-message.ts**

Rewrite `src/inngest/functions/handle-message.ts`:
```typescript
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { streamAgentSession } from "@/agent/session";
import { agentMessageReceived, inngest } from "@/inngest/client";
import { getDisplayMode, resolveWorkspace } from "@/lib/channels";
import { formatToolUse, markdownToSlackMrkdwn, splitMessage } from "@/lib/format";
import { getSession, saveSession } from "@/lib/sessions";
import { slack } from "@/lib/slack";

export const handleMessage = inngest.createFunction(
  {
    id: "handle-message",
    retries: 1,
    timeouts: { finish: "5m" },
    triggers: [agentMessageReceived],
    singleton: { key: "event.data.sessionKey", mode: "cancel" },
  },
  async ({ event, step }) => {
    const { message, sessionKey, channel, destination } = event.data;

    // --- Durable bookend: resolve context ---

    const session = await step.run("resolve-session", async () => {
      return getSession(sessionKey);
    });

    const workspace = await step.run("resolve-workspace", async () => {
      return session?.workspace ?? (await resolveWorkspace(destination.chatId));
    });

    const displayMode = await step.run("resolve-display-mode", async () => {
      return getDisplayMode();
    });

    // --- Streaming zone (not in a step) ---

    let sessionId: string | undefined = session?.sessionId;
    let resultText = "";
    let statusMessageTs: string | undefined; // For compact mode
    let textPosted = false;

    const stream = streamAgentSession({
      message,
      sessionId,
      workspace,
    });

    for await (const msg of stream) {
      if (msg.type === "system" && msg.subtype === "init") {
        sessionId = msg.session_id;
        console.log(`[agent] Session initialized: ${sessionId}`);
      }

      if (msg.type === "assistant" && msg.message?.content) {
        for (const part of msg.message.content) {
          // Tool use → post formatted tool message
          if (part.type === "tool_use") {
            const toolText = formatToolUse(part.name, part.input as Record<string, unknown>);
            console.log(`[agent] ${toolText}`);

            if (channel === "slack") {
              if (displayMode === "verbose") {
                await slack.chat.postMessage({
                  channel: destination.chatId,
                  text: toolText,
                  thread_ts: destination.threadId,
                }).catch((err) => console.warn("tool message failed:", err.data?.error ?? err.message));
              } else {
                // Compact: post or update status message
                if (!statusMessageTs) {
                  const res = await slack.chat.postMessage({
                    channel: destination.chatId,
                    text: toolText,
                    thread_ts: destination.threadId,
                  }).catch((err) => {
                    console.warn("status message failed:", err.data?.error ?? err.message);
                    return undefined;
                  });
                  statusMessageTs = res?.ts;
                } else {
                  await slack.chat.update({
                    channel: destination.chatId,
                    ts: statusMessageTs,
                    text: toolText,
                  }).catch((err) => console.warn("status update failed:", err.data?.error ?? err.message));
                }
              }
            }
          }

          // Text → post formatted text message
          if (part.type === "text" && part.text?.trim()) {
            console.log(`[agent] Assistant text (${part.text.length} chars)`);

            if (channel === "slack") {
              const formatted = markdownToSlackMrkdwn(part.text);
              const chunks = splitMessage(formatted);
              for (const chunk of chunks) {
                await slack.chat.postMessage({
                  channel: destination.chatId,
                  text: chunk,
                  thread_ts: destination.threadId,
                }).catch((err) => console.warn("text message failed:", err.data?.error ?? err.message));
              }
              textPosted = true;
            }
          }
        }
      }

      if (msg.type === "result") {
        console.log(`[agent] Result: ${msg.subtype}, text length: ${((msg as any).result ?? "").length}`);
        if (msg.subtype === "success") {
          resultText = (msg as any).result ?? "";
        }
      }
    }

    // Compact mode: update status to done
    if (displayMode === "compact" && statusMessageTs && channel === "slack") {
      await slack.chat.update({
        channel: destination.chatId,
        ts: statusMessageTs,
        text: "✅ Done",
      }).catch((err) => console.warn("status done update failed:", err.data?.error ?? err.message));
    }

    console.log(`[agent] Done. Result length: ${resultText.length}, sessionId: ${sessionId}`);

    // --- Durable bookend: persist and notify ---

    if (sessionId) {
      await step.run("save-session", async () => {
        await saveSession(sessionKey, { sessionId: sessionId as string });
      });
    }

    await step.sendEvent("send-reply", {
      name: "agent.reply.ready",
      data: {
        response: resultText,
        channel,
        destination,
      },
    });
  },
);
```

Key changes from current handle-message.ts:
- `retries: 0` → `retries: 1` (crash recovery)
- Removed `step.run("agent-query")` — streaming zone replaces it
- Added `step.run("resolve-display-mode")`
- Imports `streamAgentSession` instead of `runAgentSession`
- Imports `formatToolUse`, `markdownToSlackMrkdwn`, `splitMessage`, `slack`, `getDisplayMode`
- Streaming loop handles tool use and text display per `displayMode`
- Compact mode tracks `statusMessageTs` for `chat.update()`
- Slack API calls in streaming zone use `.catch()` — best-effort, non-fatal
- `resultText` captured from `result` message, passed to `agent.reply.ready`

- [ ] **Step 2: Run typecheck**

```bash
cd ~/projects/agent-system && bunx tsc --noEmit
```

Expected: PASS — all imports should resolve now.

- [ ] **Step 3: Run all tests**

```bash
cd ~/projects/agent-system && bun test
```

Expected: all tests PASS. The handle-message function itself isn't unit-tested (it's an Inngest function with Slack side effects), but all imported modules have their own tests.

- [ ] **Step 4: Commit (includes session.ts refactor from Task 3)**

```bash
git add src/agent/session.ts src/agent/session.test.ts src/inngest/functions/handle-message.ts
git commit -m "feat: stream agent activity to Slack in real-time"
```

---

## Chunk 4: Verification

### Task 5: Smoke test the streaming flow

This is a manual verification task — no code to write.

- [ ] **Step 1: Restart both servers**

Terminal 1:
```bash
cd ~/projects/agent-system && just inngest
```

Terminal 2:
```bash
cd ~/projects/agent-system && just dev
```

- [ ] **Step 2: Verify health + functions**

```bash
just health
```

Expected: `{ "status": "ok" }`

Check http://localhost:8288 — should show 4 functions.

- [ ] **Step 3: Test verbose mode (default) — DM the bot**

Send a DM like: "read the file at src/index.ts and tell me what it does"

Expected:
- Brain emoji appears on your message
- Tool messages appear in thread as they fire (e.g., "📄 Read: src/index.ts")
- Text response appears as the agent produces it
- Final result text posted by send-reply
- Brain swaps to checkmark

Check the console — you should see `[agent]` logs for each step.

- [ ] **Step 4: Test compact mode — edit channels.json**

Change `"displayMode": "verbose"` to `"displayMode": "compact"` in `data/channels.json`.

Send another DM.

Expected:
- One status message appears and updates in place as tools fire
- Text response appears as a new message
- Status message updates to "✅ Done"
- Checkmark reaction

- [ ] **Step 5: Switch back to verbose mode**

Change `"displayMode": "compact"` back to `"displayMode": "verbose"` in `data/channels.json`.

- [ ] **Step 6: Test @mention in a channel**

Same flow as DM but via @mention. Verify tool messages and text appear in the thread.

- [ ] **Step 7: Test thread reply**

Reply in the thread without @mention. Verify the bot responds (session exists from the @mention).

- [ ] **Step 8: Check for duplication**

Verify whether the final result text from send-reply duplicates text already streamed. If it does and it feels redundant, note it for a follow-up change (remove text posting from send-reply).

- [ ] **Step 9: Commit any fixes**

If any fixes were needed during smoke testing:
```bash
git add -A
git commit -m "fix: smoke test fixes for streaming"
```

- [ ] **Step 10: Update Linear**

```bash
linear issue comment KYR-117 "Streaming & tool visibility implemented. Agent now shows tool usage and text in real-time in Slack threads. Two display modes: verbose (message per tool) and compact (single updating status). Tested DM, @mention, thread replies."
```
