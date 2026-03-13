# Agent System Inngest MVP Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the echo bot + Restate ping service with a working Slack agent powered by Inngest + Claude Agent SDK — Bolt relays messages, Inngest orchestrates, Agent SDK thinks.

**Architecture:** One Bun process runs Bolt (Socket Mode) as a thin event relay and Hono (serving the Inngest function endpoint). All logic lives in 4 Inngest functions: handleMessage (singleton agent session per thread), acknowledgeMessage (reaction indicator), sendReply (post response), handleFailure (error notification). Claude Agent SDK `query()` is called from handleMessage.

**Tech Stack:** Bun, Hono, Inngest v4 (alpha), @slack/bolt, @anthropic-ai/claude-agent-sdk, @slack/web-api (via Bolt), varlock

**Spec:** `docs/superpowers/specs/2026-03-12-unified-architecture-design.md`

**Reference projects:**
- `~/projects/utah` — Inngest event-driven architecture, singleton, Slack mrkdwn conversion
- `~/projects/claude-code-slack-bot` — Agent SDK `query()` consumption, session-per-thread, reaction status

---

## File Structure

```
agent-system/
  src/
    index.ts                        # Entry point — starts Hono + Bolt (MODIFY)
    bolt/
      app.ts                        # Bolt factory — Socket Mode config (MODIFY)
      listeners/
        index.ts                    # Register all listeners (CREATE)
        message.ts                  # DM + mention → inngest.send() (REWRITE)
        message.test.ts             # Tests for message listeners (CREATE)
        onboarding.ts               # member_joined_channel → workspace prompt (CREATE)
        onboarding.test.ts          # Tests for onboarding (CREATE)
        actions.ts                  # channel_workspace_select handler (CREATE)
        actions.test.ts             # Tests for actions (CREATE)
    inngest/
      client.ts                     # Inngest client + event types (CREATE)
      functions/
        index.ts                    # Export all functions (CREATE)
        handle-message.ts           # Singleton agent session per thread (CREATE)
        handle-message.test.ts      # Tests for handle-message (CREATE)
        acknowledge-message.ts      # Reaction indicator (CREATE)
        send-reply.ts               # Post reply to channel (CREATE)
        send-reply.test.ts          # Tests for send-reply (CREATE)
        handle-failure.ts           # Global error handler (CREATE)
    agent/
      session.ts                    # Agent SDK query() wrapper (CREATE)
      session.test.ts               # Tests for agent session (CREATE)
    lib/
      sessions.ts                   # Per-session file persistence (CREATE)
      sessions.test.ts              # Tests for session persistence (CREATE)
      channels.ts                   # Channel config, workspace resolution, allowlist (CREATE)
      channels.test.ts              # Tests for channel config (CREATE)
      slack.ts                      # Shared WebClient instance (CREATE)
      format.ts                     # Markdown → Slack mrkdwn + message splitting (CREATE)
      format.test.ts                # Tests for format utils (CREATE)
  data/
    sessions/                       # Per-session JSON files (gitignored) (CREATE dir)
    channels.json                   # Channel workspace config (CREATE)
  justfile                          # Dev workflow (REWRITE)
  .env.schema                       # Env vars (MODIFY)
```

**Files to delete:**
- `src/restate/server.ts`
- `src/restate/services/ping.ts`
- `src/restate/` directory

---

## Chunk 1: Foundation — Dependencies, Config, Inngest Client

### Task 1: Install new dependencies and remove Restate

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Install inngest and hono, remove Restate**

```bash
cd ~/projects/agent-system
bun add inngest@4.0.0-alpha.6 hono
bun remove @restatedev/restate-sdk
```

Use `inngest@4.0.0-alpha.6` — same version as the utah reference project. This is the v4 alpha that supports `eventType()`, `staticSchema()`, `singleton`, `checkpointing`, and 2-argument `createFunction`.

- [ ] **Step 2: Delete the Restate directory**

```bash
rm -rf src/restate/
```

- [ ] **Step 3: Update .gitignore — add data/ directory**

Add to `.gitignore`:
```
data/sessions/
```

- [ ] **Step 4: Create data directories and channels.json**

```bash
mkdir -p data/sessions
```

Create `data/channels.json`:
```json
{
  "allowedUsers": ["REPLACE_WITH_YOUR_SLACK_USER_ID"],
  "channels": {},
  "workspaces": [
    { "label": "kyrell-os", "path": "~/projects/kyrell-os" },
    { "label": "Agent System", "path": "~/projects/agent-system" },
    { "label": "Vault", "path": "~/kyrell-os-vault" },
    { "label": "kos-kit", "path": "~/projects/kos-kit" }
  ],
  "globalDefault": "~/projects/kyrell-os"
}
```

Look up your Slack user ID: open Slack → click your profile → three dots → "Copy member ID". Replace `REPLACE_WITH_YOUR_SLACK_USER_ID` with it.

- [ ] **Step 5: Verify — typecheck should fail (missing Restate imports in index.ts)**

```bash
cd ~/projects/agent-system && bunx tsc --noEmit 2>&1 | head -5
```

Expected: errors about missing `./restate/server.ts` import in `src/index.ts`. This is correct — we'll fix it in Task 5.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock .gitignore data/channels.json
git commit -m "chore: replace restate with inngest + hono, add data config"
```

---

### Task 2: Inngest client and typed events

**Files:**
- Create: `src/inngest/client.ts`

- [ ] **Step 1: Create the Inngest client with typed events**

Create `src/inngest/client.ts`:
```typescript
import { Inngest, eventType, staticSchema } from "inngest";

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
```

- [ ] **Step 2: Verify the file compiles**

```bash
cd ~/projects/agent-system && bunx tsc --noEmit src/inngest/client.ts 2>&1
```

Expected: may still fail due to index.ts importing Restate, but `client.ts` itself should have no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/inngest/client.ts
git commit -m "feat(inngest): add client with typed events"
```

---

### Task 3: Shared Slack client and format utilities

**Files:**
- Create: `src/lib/slack.ts`
- Create: `src/lib/format.ts`
- Create: `src/lib/format.test.ts`

- [ ] **Step 1: Write format.test.ts — tests for markdown→mrkdwn conversion and message splitting**

Create `src/lib/format.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { markdownToSlackMrkdwn, splitMessage } from "./format";

describe("markdownToSlackMrkdwn", () => {
  test("converts headings to bold", () => {
    expect(markdownToSlackMrkdwn("## Hello")).toBe("*Hello*");
  });

  test("converts bold syntax", () => {
    expect(markdownToSlackMrkdwn("**bold text**")).toBe("*bold text*");
  });

  test("converts markdown links to slack links", () => {
    expect(markdownToSlackMrkdwn("[click](https://example.com)")).toBe(
      "<https://example.com|click>",
    );
  });

  test("preserves code blocks", () => {
    const input = "```\nconst x = 1;\n```";
    expect(markdownToSlackMrkdwn(input)).toBe(input);
  });

  test("preserves inline code", () => {
    const input = "use `const` here";
    expect(markdownToSlackMrkdwn(input)).toBe("use `const` here");
  });

  test("converts bullet lists", () => {
    expect(markdownToSlackMrkdwn("- item one")).toBe("• item one");
  });

  test("preserves bare URLs", () => {
    const input = "visit https://example.com/path_with_underscores today";
    const result = markdownToSlackMrkdwn(input);
    expect(result).toContain("https://example.com/path_with_underscores");
  });
});

describe("splitMessage", () => {
  test("returns single chunk for short messages", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
  });

  test("splits at paragraph boundaries", () => {
    const para1 = "a".repeat(2000);
    const para2 = "b".repeat(2000);
    const input = `${para1}\n\n${para2}`;
    const chunks = splitMessage(input);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(para1);
    expect(chunks[1]).toBe(para2);
  });

  test("respects maxLength parameter", () => {
    const chunks = splitMessage("hello world foo bar", 10);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(10);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/projects/agent-system && bun test src/lib/format.test.ts 2>&1
```

Expected: FAIL — `format.ts` doesn't exist yet.

- [ ] **Step 3: Create format.ts — port from Utah's src/channels/slack/format.ts**

Create `src/lib/format.ts`:
```typescript
/** Convert markdown to Slack mrkdwn. Protects code blocks + URLs from mangling. */
export function markdownToSlackMrkdwn(text: string): string {
  const codeBlocks: string[] = [];
  let result = text.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `\x00CODE${codeBlocks.length - 1}\x00`;
  });
  const inlineCode: string[] = [];
  result = result.replace(/`[^`]+`/g, (match) => {
    inlineCode.push(match);
    return `\x00INLINE${inlineCode.length - 1}\x00`;
  });

  // Links: [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Protect bare URLs
  const urls: string[] = [];
  result = result.replace(/https?:\/\/[^\s>)]+/g, (match) => {
    urls.push(match);
    return `\x00URL${urls.length - 1}\x00`;
  });

  result = result
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\*\*(.*?)\*\*/g, "*$1*")
    .replace(/__(.*?)__/g, "*$1*")
    .replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "_$1_")
    .replace(/~~(.*?)~~/g, "~$1~")
    .replace(/^[\s]*[-*+]\s+/gm, "• ")
    .replace(/^[\s]*\d+\.\s+/gm, "1. ");

  // Restore protected tokens
  result = result.replace(/\x00URL(\d+)\x00/g, (_, i) => urls[parseInt(i)]);
  result = result.replace(
    /\x00INLINE(\d+)\x00/g,
    (_, i) => inlineCode[parseInt(i)],
  );
  result = result.replace(
    /\x00CODE(\d+)\x00/g,
    (_, i) => codeBlocks[parseInt(i)],
  );

  return result;
}

/** Split long messages at smart boundaries (paragraph → sentence → line → word). */
export function splitMessage(text: string, maxLength = 3900): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitPoint = maxLength;
    const half = maxLength * 0.5;

    const para = remaining.lastIndexOf("\n\n", maxLength);
    if (para > half) splitPoint = para + 2;
    else {
      const sentence = remaining.lastIndexOf(". ", maxLength);
      if (sentence > half) splitPoint = sentence + 2;
      else {
        const line = remaining.lastIndexOf("\n", maxLength);
        if (line > half) splitPoint = line + 1;
        else {
          const word = remaining.lastIndexOf(" ", maxLength);
          if (word > half) splitPoint = word + 1;
        }
      }
    }

    chunks.push(remaining.slice(0, splitPoint).trim());
    remaining = remaining.slice(splitPoint).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ~/projects/agent-system && bun test src/lib/format.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Create slack.ts — shared WebClient**

Create `src/lib/slack.ts`:
```typescript
import { WebClient } from "@slack/web-api";

// Shared client for outbound Slack API calls (postMessage, reactions, etc.)
// Retries disabled — Inngest handles retries at the function level.
export const slack = new WebClient(process.env.SLACK_BOT_TOKEN, {
  retryConfig: { retries: 0 },
});
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/format.ts src/lib/format.test.ts src/lib/slack.ts
git commit -m "feat(lib): add slack client and format utilities"
```

---

### Task 4: Channel config and session persistence

**Files:**
- Create: `src/lib/channels.ts`
- Create: `src/lib/channels.test.ts`
- Create: `src/lib/sessions.ts`
- Create: `src/lib/sessions.test.ts`

- [ ] **Step 1: Write channels.test.ts**

Create `src/lib/channels.test.ts`:
```typescript
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { isUserAllowed, resolveWorkspace, saveChannelWorkspace } from "./channels";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";

// Tests use a temp directory to avoid touching real data/channels.json.
// The module reads from CHANNELS_FILE which defaults to data/channels.json.
// For unit tests, we test the pure logic by calling the functions directly
// and verifying behavior against the default config file.

describe("isUserAllowed", () => {
  test("denies unlisted user", async () => {
    // Default channels.json has a specific user ID — random ID should be denied
    const result = await isUserAllowed("U_RANDOM_UNKNOWN");
    expect(result).toBe(false);
  });
});

describe("resolveWorkspace", () => {
  test("returns global default for unknown channel", async () => {
    const result = await resolveWorkspace("C_UNKNOWN_CHANNEL");
    expect(result).toContain("projects/kyrell-os");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/projects/agent-system && bun test src/lib/channels.test.ts
```

Expected: FAIL — `channels.ts` doesn't exist yet.

- [ ] **Step 3: Create channels.ts**

Create `src/lib/channels.ts`:
```typescript
import { join } from "path";
import { homedir } from "os";

const CHANNELS_FILE = "data/channels.json";
const GLOBAL_DEFAULT = join(homedir(), "projects/kyrell-os");

interface ChannelData {
  workspace: string;
  onboardedAt: string;
}

interface ChannelsConfig {
  allowedUsers: string | string[];
  channels: Record<string, ChannelData>;
  workspaces: { label: string; path: string }[];
  globalDefault: string;
}

async function loadConfig(): Promise<ChannelsConfig> {
  const file = Bun.file(CHANNELS_FILE);
  if (!(await file.exists())) {
    return {
      allowedUsers: [],
      channels: {},
      workspaces: [],
      globalDefault: GLOBAL_DEFAULT,
    };
  }
  return file.json();
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export async function isUserAllowed(userId: string): Promise<boolean> {
  const config = await loadConfig();
  if (config.allowedUsers === "*") return true;
  return Array.isArray(config.allowedUsers) && config.allowedUsers.includes(userId);
}

export async function resolveWorkspace(channelId: string): Promise<string> {
  const config = await loadConfig();
  const channel = config.channels[channelId];
  const workspace = channel?.workspace ?? config.globalDefault ?? GLOBAL_DEFAULT;
  return expandHome(workspace);
}

export async function saveChannelWorkspace(
  channelId: string,
  workspace: string,
): Promise<void> {
  const config = await loadConfig();
  config.channels[channelId] = {
    workspace,
    onboardedAt: new Date().toISOString(),
  };
  await Bun.write(CHANNELS_FILE, JSON.stringify(config, null, 2));
}

export async function getWorkspaces(): Promise<{ label: string; path: string }[]> {
  const config = await loadConfig();
  return config.workspaces;
}

export async function getGlobalDefault(): Promise<string> {
  const config = await loadConfig();
  return config.globalDefault ?? GLOBAL_DEFAULT;
}
```

- [ ] **Step 4: Run channels tests**

```bash
cd ~/projects/agent-system && bun test src/lib/channels.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write sessions.test.ts**

Create `src/lib/sessions.test.ts`:
```typescript
import { describe, expect, test, afterEach } from "bun:test";
import { getSession, saveSession } from "./sessions";
import { unlink } from "fs/promises";
import { join } from "path";

// Tests write to data/sessions/ (gitignored). Use unique keys and clean up.
const TEST_KEY = "test-session-unit";
const SESSIONS_DIR = "data/sessions";

describe("sessions", () => {
  afterEach(async () => {
    await unlink(join(SESSIONS_DIR, `${TEST_KEY}.json`)).catch(() => {});
  });

  test("getSession returns undefined for missing session", async () => {
    const result = await getSession("nonexistent-key-xyz");
    expect(result).toBeUndefined();
  });

  test("saveSession and getSession roundtrip", async () => {
    await saveSession(TEST_KEY, { sessionId: "abc-123" });
    const result = await getSession(TEST_KEY);
    expect(result?.sessionId).toBe("abc-123");
    expect(result?.updatedAt).toBeDefined();
  });

  test("saveSession merges with existing data", async () => {
    await saveSession(TEST_KEY, { sessionId: "abc-123" });
    await saveSession(TEST_KEY, { workspace: "~/projects/foo" });
    const result = await getSession(TEST_KEY);
    expect(result?.sessionId).toBe("abc-123");
    expect(result?.workspace).toBe("~/projects/foo");
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

```bash
cd ~/projects/agent-system && bun test src/lib/sessions.test.ts
```

Expected: FAIL — `sessions.ts` doesn't exist yet.

- [ ] **Step 7: Create sessions.ts**

Create `src/lib/sessions.ts`:
```typescript
import { join } from "path";

const SESSIONS_DIR = "data/sessions";

interface SessionData {
  sessionId?: string;
  workspace?: string;
  updatedAt: string;
}

export async function getSession(
  sessionKey: string,
): Promise<SessionData | undefined> {
  const file = Bun.file(join(SESSIONS_DIR, `${sessionKey}.json`));
  if (!(await file.exists())) return undefined;
  return file.json();
}

export async function saveSession(
  sessionKey: string,
  data: Partial<SessionData>,
): Promise<void> {
  const existing = (await getSession(sessionKey)) ?? {};
  await Bun.write(
    join(SESSIONS_DIR, `${sessionKey}.json`),
    JSON.stringify({ ...existing, ...data, updatedAt: new Date().toISOString() }),
  );
}
```

- [ ] **Step 8: Run sessions tests**

```bash
cd ~/projects/agent-system && bun test src/lib/sessions.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/channels.ts src/lib/channels.test.ts src/lib/sessions.ts src/lib/sessions.test.ts
git commit -m "feat(lib): add channel config and session persistence"
```

---

## Chunk 2: Inngest Functions

### Task 5: Acknowledge message function

**Files:**
- Create: `src/inngest/functions/acknowledge-message.ts`
- Create: `src/inngest/functions/index.ts`

- [ ] **Step 1: Create acknowledge-message.ts**

Create `src/inngest/functions/acknowledge-message.ts`:
```typescript
import { inngest, agentMessageReceived } from "@/inngest/client";
import { slack } from "@/lib/slack";

export const acknowledgeMessage = inngest.createFunction(
  {
    id: "acknowledge-message",
    retries: 0,
    triggers: [agentMessageReceived],
  },
  async ({ event, step }) => {
    const { channel, destination } = event.data;

    await step.run("acknowledge", async () => {
      if (channel === "slack") {
        await slack.reactions.add({
          channel: destination.chatId,
          timestamp: destination.messageId,
          name: "brain",
        });
      }
    });
  },
);
```

- [ ] **Step 2: Create functions/index.ts — export barrel**

Create `src/inngest/functions/index.ts`:
```typescript
export { acknowledgeMessage } from "./acknowledge-message";
```

We'll add more exports as we create each function.

- [ ] **Step 3: Verify it compiles**

```bash
cd ~/projects/agent-system && bunx tsc --noEmit src/inngest/functions/acknowledge-message.ts 2>&1
```

Expected: no type errors (index.ts may still fail due to Restate imports).

- [ ] **Step 4: Commit**

```bash
git add src/inngest/functions/
git commit -m "feat(inngest): add acknowledge-message function"
```

---

### Task 6: Send reply function

**Files:**
- Create: `src/inngest/functions/send-reply.ts`
- Create: `src/inngest/functions/send-reply.test.ts`
- Modify: `src/inngest/functions/index.ts`

- [ ] **Step 1: Write send-reply.test.ts**

Create `src/inngest/functions/send-reply.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { markdownToSlackMrkdwn, splitMessage } from "@/lib/format";

// send-reply's core logic is: format the response, split it, post to Slack.
// The formatting and splitting are tested in format.test.ts.
// Here we verify the integration expectation: formatted text stays within limits.

describe("send-reply formatting integration", () => {
  test("long response gets split into chunks under 3900 chars", () => {
    const longResponse = "This is a paragraph. ".repeat(300);
    const formatted = markdownToSlackMrkdwn(longResponse);
    const chunks = splitMessage(formatted);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3900);
    }
    expect(chunks.length).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

```bash
cd ~/projects/agent-system && bun test src/inngest/functions/send-reply.test.ts
```

Expected: PASS (it's testing the format utilities which already exist).

- [ ] **Step 3: Create send-reply.ts**

Create `src/inngest/functions/send-reply.ts`:
```typescript
import { inngest, agentReplyReady } from "@/inngest/client";
import { slack } from "@/lib/slack";
import { markdownToSlackMrkdwn, splitMessage } from "@/lib/format";

export const sendReply = inngest.createFunction(
  {
    id: "send-reply",
    retries: 3,
    triggers: [agentReplyReady],
  },
  async ({ event, step }) => {
    const { response, channel, destination } = event.data;

    await step.run("send", async () => {
      if (channel === "slack") {
        const formatted = markdownToSlackMrkdwn(response);
        const chunks = splitMessage(formatted);
        for (const chunk of chunks) {
          await slack.chat.postMessage({
            channel: destination.chatId,
            text: chunk,
            thread_ts: destination.threadId,
          });
        }
      }
    });

    await step.run("update-reaction", async () => {
      if (channel === "slack") {
        await slack.reactions
          .remove({
            channel: destination.chatId,
            timestamp: destination.messageId,
            name: "brain",
          })
          .catch(() => {});
        await slack.reactions.add({
          channel: destination.chatId,
          timestamp: destination.messageId,
          name: "white_check_mark",
        });
      }
    });
  },
);
```

- [ ] **Step 4: Update functions/index.ts**

Add to `src/inngest/functions/index.ts`:
```typescript
export { sendReply } from "./send-reply";
```

- [ ] **Step 5: Commit**

```bash
git add src/inngest/functions/send-reply.ts src/inngest/functions/send-reply.test.ts src/inngest/functions/index.ts
git commit -m "feat(inngest): add send-reply function"
```

---

### Task 7: Handle failure function

**Files:**
- Create: `src/inngest/functions/handle-failure.ts`
- Modify: `src/inngest/functions/index.ts`

- [ ] **Step 1: Create handle-failure.ts**

Create `src/inngest/functions/handle-failure.ts`:
```typescript
import { inngest } from "@/inngest/client";
import { slack } from "@/lib/slack";

export const handleFailure = inngest.createFunction(
  {
    id: "handle-failure",
    retries: 0,
    triggers: [{ event: "inngest/function.failed" }],
  },
  async ({ event, step }) => {
    const originalEvent = event.data.event;
    if (!originalEvent?.data?.destination) return;

    const { chatId, threadId, messageId } = originalEvent.data.destination;
    const channel = originalEvent.data.channel;
    const functionId = event.data.function_id;
    const error = event.data.error?.message ?? "Unknown error";

    await step.run("notify-user", async () => {
      if (channel === "slack") {
        await slack.reactions
          .remove({ channel: chatId, timestamp: messageId, name: "brain" })
          .catch(() => {});
        await slack.reactions.add({
          channel: chatId,
          timestamp: messageId,
          name: "x",
        });
        await slack.chat.postMessage({
          channel: chatId,
          text: `Something went wrong (\`${functionId}\`): ${error.slice(0, 150)}`,
          thread_ts: threadId,
        });
      }
    });
  },
);
```

- [ ] **Step 2: Update functions/index.ts**

Add to `src/inngest/functions/index.ts`:
```typescript
export { handleFailure } from "./handle-failure";
```

- [ ] **Step 3: Commit**

```bash
git add src/inngest/functions/handle-failure.ts src/inngest/functions/index.ts
git commit -m "feat(inngest): add handle-failure function"
```

---

### Task 8: Agent session wrapper

**Files:**
- Create: `src/agent/session.ts`
- Create: `src/agent/session.test.ts`

- [ ] **Step 1: Write session.test.ts — test the response extraction logic**

Create `src/agent/session.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { extractResponse } from "./session";

describe("extractResponse", () => {
  test("extracts text from success result", () => {
    const messages = [
      { type: "system", subtype: "init", session_id: "sess-1" },
      { type: "result", subtype: "success", result: "Hello from Claude" },
    ];
    const result = extractResponse(messages as any);
    expect(result.sessionId).toBe("sess-1");
    expect(result.responseText).toBe("Hello from Claude");
  });

  test("returns empty string when no result", () => {
    const messages = [
      { type: "system", subtype: "init", session_id: "sess-2" },
    ];
    const result = extractResponse(messages as any);
    expect(result.sessionId).toBe("sess-2");
    expect(result.responseText).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/projects/agent-system && bun test src/agent/session.test.ts
```

Expected: FAIL — `session.ts` doesn't exist yet.

- [ ] **Step 3: Create session.ts**

Create `src/agent/session.ts`:
```typescript
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
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/agent-system && bun test src/agent/session.test.ts
```

Expected: PASS (extractResponse tests don't call the real SDK).

- [ ] **Step 5: Commit**

```bash
git add src/agent/session.ts src/agent/session.test.ts
git commit -m "feat(agent): add session wrapper for Agent SDK"
```

---

### Task 9: Handle message function (the main one)

**Files:**
- Create: `src/inngest/functions/handle-message.ts`
- Modify: `src/inngest/functions/index.ts`

- [ ] **Step 1: Create handle-message.ts**

Create `src/inngest/functions/handle-message.ts`:
```typescript
import { inngest, agentMessageReceived } from "@/inngest/client";
import { runAgentSession } from "@/agent/session";
import { getSession, saveSession } from "@/lib/sessions";
import { resolveWorkspace } from "@/lib/channels";

export const handleMessage = inngest.createFunction(
  {
    id: "handle-message",
    retries: 0,
    triggers: [agentMessageReceived],
    singleton: { key: "event.data.sessionKey", mode: "cancel" },
  },
  async ({ event, step }) => {
    const { message, sessionKey, destination } = event.data;

    const session = await step.run("resolve-session", async () => {
      return getSession(sessionKey);
    });

    const workspace = await step.run("resolve-workspace", async () => {
      return session?.workspace ?? (await resolveWorkspace(destination.chatId));
    });

    const result = await step.run("agent-query", async () => {
      return runAgentSession({
        message,
        sessionId: session?.sessionId,
        workspace,
      });
    });

    if (result.sessionId) {
      await step.run("save-session", async () => {
        saveSession(sessionKey, { sessionId: result.sessionId! });
      });
    }

    await step.sendEvent("send-reply", {
      name: "agent.reply.ready",
      data: {
        response: result.responseText,
        channel: event.data.channel,
        destination,
      },
    });
  },
);
```

- [ ] **Step 2: Update functions/index.ts — final version with all exports**

Rewrite `src/inngest/functions/index.ts`:
```typescript
export { acknowledgeMessage } from "./acknowledge-message";
export { handleMessage } from "./handle-message";
export { sendReply } from "./send-reply";
export { handleFailure } from "./handle-failure";
```

- [ ] **Step 3: Verify it compiles**

```bash
cd ~/projects/agent-system && bunx tsc --noEmit src/inngest/functions/handle-message.ts 2>&1
```

- [ ] **Step 4: Commit**

```bash
git add src/inngest/functions/handle-message.ts src/inngest/functions/index.ts
git commit -m "feat(inngest): add handle-message function with singleton"
```

---

## Chunk 3: Bolt Listeners & Entry Point

### Task 10: Message listeners (thin relay)

**Files:**
- Rewrite: `src/bolt/listeners/message.ts`
- Create: `src/bolt/listeners/message.test.ts`

- [ ] **Step 1: Write message.test.ts**

Create `src/bolt/listeners/message.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { buildEventData } from "./message";

describe("buildEventData", () => {
  test("uses threadTs when provided", () => {
    const data = buildEventData("C123", "U456", "hello", "1234.5678", "1111.2222");
    expect(data.sessionKey).toBe("slack-C123-1111.2222");
    expect(data.destination.threadId).toBe("1111.2222");
    expect(data.destination.messageId).toBe("1234.5678");
  });

  test("uses ts as threadId when no threadTs", () => {
    const data = buildEventData("C123", "U456", "hello", "1234.5678");
    expect(data.sessionKey).toBe("slack-C123-1234.5678");
    expect(data.destination.threadId).toBe("1234.5678");
  });

  test("sets channel to slack", () => {
    const data = buildEventData("C123", "U456", "hello", "1234.5678");
    expect(data.channel).toBe("slack");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/projects/agent-system && bun test src/bolt/listeners/message.test.ts
```

Expected: FAIL — `buildEventData` is not exported (or file is still the echo bot).

- [ ] **Step 3: Rewrite message.ts — thin relay**

Rewrite `src/bolt/listeners/message.ts`:
```typescript
import type { App } from "@slack/bolt";
import type { Inngest } from "inngest";
import { isUserAllowed } from "@/lib/channels";

export function buildEventData(
  channel: string,
  user: string,
  text: string,
  ts: string,
  threadTs?: string,
) {
  const resolvedThread = threadTs ?? ts;
  return {
    message: text,
    sessionKey: `slack-${channel}-${resolvedThread}`,
    channel: "slack" as const,
    sender: { id: user },
    destination: {
      chatId: channel,
      threadId: resolvedThread,
      messageId: ts,
    },
  };
}

export function registerMessageListeners(app: App, inngest: Inngest) {
  // Channel @mentions
  app.event("app_mention", async ({ event }) => {
    if (!(await isUserAllowed(event.user))) return;

    const text = (event.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!text) return;

    await inngest.send({
      name: "agent.message.received",
      data: buildEventData(event.channel, event.user, text, event.ts, event.thread_ts),
    });
  });

  // DMs only (channel IDs starting with D)
  app.message(async ({ event }) => {
    if (!event.channel.startsWith("D")) return;
    if ("bot_id" in event || "subtype" in event) return;
    if (!(await isUserAllowed(event.user ?? "unknown"))) return;

    await inngest.send({
      name: "agent.message.received",
      data: buildEventData(
        event.channel,
        event.user ?? "unknown",
        event.text ?? "",
        event.ts,
        event.thread_ts,
      ),
    });
  });
}
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/agent-system && bun test src/bolt/listeners/message.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bolt/listeners/message.ts src/bolt/listeners/message.test.ts
git commit -m "feat(bolt): rewrite message listeners as thin relay"
```

---

### Task 11: Onboarding and action listeners

**Files:**
- Create: `src/bolt/listeners/onboarding.ts`
- Create: `src/bolt/listeners/actions.ts`
- Create: `src/bolt/listeners/index.ts`

- [ ] **Step 1: Create onboarding.ts**

Create `src/bolt/listeners/onboarding.ts`:
```typescript
import type { App } from "@slack/bolt";
import { getWorkspaces, getGlobalDefault } from "@/lib/channels";

export function registerOnboardingListeners(app: App) {
  app.event("member_joined_channel", async ({ event, client }) => {
    const botInfo = await client.auth.test();
    if (event.user !== botInfo.user_id) return;

    const workspaces = await getWorkspaces();
    const globalDefault = await getGlobalDefault();

    await client.chat.postMessage({
      channel: event.channel,
      text: `I'm set up to work in \`${globalDefault}\`. Change it below if needed.`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `I'm set up to work in \`${globalDefault}\`. Change it below if needed.`,
          },
          accessory: {
            type: "static_select",
            action_id: "channel_workspace_select",
            initial_option: {
              text: { type: "plain_text", text: "kyrell-os" },
              value: globalDefault,
            },
            options: workspaces.map((ws) => ({
              text: { type: "plain_text", text: ws.label },
              value: ws.path,
            })),
          },
        },
      ],
    });
  });
}
```

- [ ] **Step 2: Create actions.ts**

Create `src/bolt/listeners/actions.ts`:
```typescript
import type { App } from "@slack/bolt";
import { saveChannelWorkspace } from "@/lib/channels";
import { slack } from "@/lib/slack";

export function registerActionListeners(app: App) {
  app.action("channel_workspace_select", async ({ ack, body, action }) => {
    await ack();
    const selectedPath = (action as any).selected_option.value;
    const channelId = body.channel?.id;
    if (!channelId) return;

    await saveChannelWorkspace(channelId, selectedPath);
    await slack.chat.postMessage({
      channel: channelId,
      text: `Workspace set to \`${selectedPath}\`.`,
    });
  });
}
```

- [ ] **Step 3: Create listeners/index.ts — register all listeners**

Create `src/bolt/listeners/index.ts`:
```typescript
import type { App } from "@slack/bolt";
import type { Inngest } from "inngest";
import { registerMessageListeners } from "./message";
import { registerOnboardingListeners } from "./onboarding";
import { registerActionListeners } from "./actions";

export function registerListeners(app: App, inngest: Inngest) {
  registerMessageListeners(app, inngest);
  registerOnboardingListeners(app);
  registerActionListeners(app);
}
```

- [ ] **Step 4: Commit**

```bash
git add src/bolt/listeners/onboarding.ts src/bolt/listeners/actions.ts src/bolt/listeners/index.ts
git commit -m "feat(bolt): add onboarding and action listeners"
```

---

### Task 12: Rewrite entry point and justfile

**Files:**
- Rewrite: `src/index.ts`
- Modify: `src/bolt/app.ts`
- Rewrite: `justfile`
- Modify: `.env.schema`

- [ ] **Step 1: Update bolt/app.ts — make signingSecret optional**

Rewrite `src/bolt/app.ts`:
```typescript
import { App } from "@slack/bolt";

export function createBoltApp() {
  return new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET ?? "not-needed-for-socket-mode",
    socketMode: true,
  });
}
```

- [ ] **Step 2: Rewrite src/index.ts**

Rewrite `src/index.ts`:
```typescript
import { Hono } from "hono";
import { serve } from "inngest/hono";
import { inngest } from "@/inngest/client";
import {
  acknowledgeMessage,
  handleMessage,
  sendReply,
  handleFailure,
} from "@/inngest/functions";
import { createBoltApp } from "@/bolt/app";
import { registerListeners } from "@/bolt/listeners";

// Must delete before Agent SDK query() — SDK detects Claude Code env and changes behavior.
delete process.env.CLAUDECODE;

const functions = [acknowledgeMessage, handleMessage, sendReply, handleFailure];

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
```

- [ ] **Step 3: Update .env.schema — remove Restate vars, mark signing secret optional**

Rewrite `.env.schema`:
```
# This env file uses @env-spec - see https://varlock.dev/env-spec for more info
#
# @plugin(@varlock/1password-plugin)
# @initOp(allowAppAuth=true, account=my)
# @defaultRequired=infer @defaultSensitive=false
# @generateTypes(lang=ts, path=env.d.ts)
# ---

# Slack bot OAuth token
# @required @sensitive
SLACK_BOT_TOKEN=op("op://Developer/GTM Agent Slack bot/SLACK_BOT_TOKEN")

# Slack app-level token for Socket Mode
# @required @sensitive
SLACK_APP_TOKEN=op("op://Developer/GTM Agent Slack bot/SLACK_APP_LEVEL_TOKEN")

# Slack signing secret (not needed for Socket Mode, but Bolt requires it)
# @sensitive
SLACK_SIGNING_SECRET=op("op://Developer/GTM Agent Slack bot/SIGNING SECRET")

# Path to Obsidian vault
VAULT_PATH=~/kyrell-os-vault
```

- [ ] **Step 4: Rewrite justfile**

Rewrite `justfile`:
```just
# Agent System task runner
#
# Dev workflow:
#   Terminal 1: just inngest
#   Terminal 2: just dev
#   Test:        just test

# List available recipes
default:
    @just --list

# Start Inngest dev server (dashboard at :8288)
inngest:
    bunx inngest-cli@latest dev -u http://localhost:9080/api/inngest --no-discovery

# Start the Bun app (Bolt Socket Mode + Hono :9080)
dev:
    INNGEST_DEV=1 bunx varlock run -- bun --watch src/index.ts

# Run tests
test *args:
    bun test {{args}}

# Typecheck
check:
    bunx tsc --noEmit

# Lint + format
lint:
    bunx biome check .

# Open Inngest dashboard
dashboard:
    open http://localhost:8288

# Health check
health:
    curl -s http://localhost:9080/health | jq
```

- [ ] **Step 5: Update dev script in package.json**

Update the `dev` script in `package.json` to include `INNGEST_DEV=1`:
```json
"dev": "INNGEST_DEV=1 bunx varlock run -- bun --watch src/index.ts"
```

Also remove the `dev:restate` and `register` scripts. Keep `test`, `lint`, `format`.

- [ ] **Step 6: Run typecheck**

```bash
cd ~/projects/agent-system && bunx tsc --noEmit
```

Expected: PASS — all imports should resolve now.

- [ ] **Step 7: Run all tests**

```bash
cd ~/projects/agent-system && bun test
```

Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts src/bolt/app.ts justfile .env.schema package.json
git commit -m "feat: wire up entry point with Hono + Inngest + Bolt"
```

---

## Chunk 4: End-to-End Verification

### Task 13: Smoke test the full system

This is a manual verification task — no code to write, just run and validate.

- [ ] **Step 1: Install Inngest CLI if not already installed**

```bash
bunx inngest-cli@latest --version
```

If this fails, it will auto-install on first use via `bunx`.

- [ ] **Step 2: Start Inngest dev server in Terminal 1**

```bash
cd ~/projects/agent-system && just inngest
```

Expected: Inngest dev server starts on :8288. Dashboard opens at http://localhost:8288.

- [ ] **Step 3: Start the app in Terminal 2**

```bash
cd ~/projects/agent-system && just dev
```

Expected: output includes "Agent system running — Hono :9080, Bolt Socket Mode, Inngest". No errors.

- [ ] **Step 4: Verify health endpoint**

```bash
curl -s http://localhost:9080/health | jq
```

Expected: `{ "status": "ok" }`

- [ ] **Step 5: Verify Inngest sees the app**

Open http://localhost:8288. Check that 4 functions are registered:
- `acknowledge-message`
- `handle-message`
- `send-reply`
- `handle-failure`

- [ ] **Step 6: Send a DM to the bot in Slack**

Send a simple message like "hello, what can you do?" via DM to the Slack bot.

Expected:
1. Brain emoji reaction appears on your message
2. After a few seconds, the agent responds in the thread
3. Brain emoji is replaced with checkmark
4. In the Inngest dashboard, you can see the function runs

- [ ] **Step 7: Test @mention in a channel**

In a channel where the bot is present, @mention the bot with a message.

Expected: same flow as DM — reaction, response, checkmark.

- [ ] **Step 8: Test channel onboarding**

Invite the bot to a new channel. Expected: bot posts workspace dropdown message.

Select a workspace from the dropdown. Expected: bot confirms "Workspace set to `~/projects/...`".

- [ ] **Step 9: Commit any fixes**

If any fixes were needed during smoke testing, commit them:
```bash
git add -A
git commit -m "fix: smoke test fixes"
```

- [ ] **Step 10: Update Linear**

Comment on KYR-117 with session results. If MVP is working end-to-end, update status as appropriate.
