# Agent System Unified Architecture Design

**Date:** 03-12-2026 (updated 03-13-2026)
**Linear:** KYR-117
**Status:** Draft

## Problem

The agent system needs a clean integration between Slack (Bolt Socket Mode), conversational AI (Claude Agent SDK), and durable workflow execution. The previous spec used Restate for durability, but Inngest is a better fit — better dashboard, better DX, event-driven model that matches how the system naturally works, and it's the engine the cohort/consulting clients will use.

## Decision

**Event-driven unified process.** One Bun process runs Bolt (Socket Mode WebSocket) as a thin event relay and Hono (serving the Inngest function endpoint + health checks). All logic lives in Inngest functions. Claude Agent SDK is a library call from Inngest functions.

### Why this approach

- **Bolt is a thin relay** — receives Slack events, emits Inngest events, returns. No logic in listeners.
- **Inngest handles all orchestration** — session singleton, durable steps, retries, fan-out. The conversational flow IS the first workflow.
- **Dashboard from day 1** — every message → agent run → reply is visible in the Inngest dashboard.
- **Workflows are just more functions** — when `capture`, `research`, etc. arrive, they're Inngest functions in the same system.
- **Multi-channel ready** — any new channel (Telegram, Discord, WhatsApp, iMessage) just emits `agent.message.received`. The Inngest functions don't change.
- **Supports both webhooks and WebSockets** — Bolt uses Socket Mode (WS), future channels can use either. Hono handles webhook receivers. All normalize to Inngest events.

### Why Inngest over Restate

- **Dashboard** — Inngest's dashboard is what cohort clients and consulting teams will interact with to see workflows executing. Restate's UI is more infrastructure-focused.
- **DX** — Community consensus (GTM engineering) is Inngest wins on developer experience.
- **Local dev server** — `inngest-cli dev` runs locally, same as joelclaw's setup.
- **Event-driven model** — natural fit for message-based systems. Bolt emits events, Inngest consumes them.
- **Maturity** — more mature product for the workflow use cases we're building toward.
- **Teaching** — teams coming from n8n/Inngest world will be familiar. Restate is more niche.
- **Future: React Flow visualization** — can build custom workflow visualization layer on top.

## Architecture

```
                     ┌──────────────────────────────────────────┐
                     │  Bun Process (src/index.ts)              │
                     │                                          │
                     │  ┌──────────┐  ┌──────────────────────┐  │
  Slack ◄──ws──────► │  │  Bolt    │  │  Hono :9080           │  │
                     │  │  Socket  │  │  ├─ /api/inngest →    │  │
                     │  │  Mode    │  │  │  serve handler      │  │
                     │  │  (thin   │  │  ├─ /webhooks/* →     │  │
                     │  │  relay)  │  │  │  future channels    │  │
                     │  └────┬─────┘  │  └─ GET /health       │  │
                     │       │        └──────────────────────┘  │
                     │       │                    ▲              │
                     │       ▼                    │              │
                     │  inngest.send()   Inngest dev server     │
                     │  "agent.message   calls functions via    │
                     │   .received"      HTTP                   │
                     └────────────────────────────┼─────────────┘
                                                  │
                     ┌────────────────────────────┴─────────────┐
                     │  Inngest Dev Server :8288                 │
                     │  ├─ Dashboard (workflow visibility)       │
                     │  ├─ Event stream                          │
                     │  ├─ Durable step execution                │
                     │  └─ Singleton, retries, fan-out           │
                     └──────────────────────────────────────────┘
```

### Process topology (dev)

1. **Terminal 1:** `just inngest` — Inngest dev server (dashboard :8288)
2. **Terminal 2:** `just dev` — Bun process (Hono :9080 + Bolt Socket Mode)

## Inngest Version

**Target: `inngest@4.x`** (alpha at time of writing). This matches the utah reference project. Key v4 patterns used throughout this spec:

- 2-argument `createFunction` (config with `triggers` + handler)
- `eventType()` + `staticSchema<T>()` for typed events
- `singleton` for one-at-a-time execution (not `concurrency`)
- `serve()` from `inngest/hono` for HTTP-based function serving
- `checkpointing: true` for near-zero inter-step latency

**Note on `serve()` vs `connect()`:** Utah uses `connect()` (WebSocket to Inngest). This spec uses `serve()` (HTTP endpoint that Inngest dev server calls) because we already have Hono for health checks and future webhook receivers. Both work with the local dev server. Switch to `connect()` if the HTTP endpoint becomes unnecessary.

## Server Entry Point

`src/index.ts` starts Hono (with Inngest serve handler) and Bolt:

```typescript
import { Hono } from "hono";
import { serve } from "inngest/hono";
import { inngest } from "@/inngest/client";
import { functions } from "@/inngest/functions";
import { createBoltApp } from "@/bolt/app";
import { registerListeners } from "@/bolt/listeners";

// Must delete before Agent SDK query() — SDK detects Claude Code env and changes behavior.
// Without this, query() may hang or behave unexpectedly.
delete process.env.CLAUDECODE;

const hono = new Hono();

// Inngest serve handler — Inngest dev server calls functions via HTTP
hono.on(["GET", "POST", "PUT"], "/api/inngest", serve({ client: inngest, functions }));
hono.get("/health", (c) => c.json({ status: "ok" }));

Bun.serve({ port: 9080, fetch: hono.fetch.bind(hono) });

const bolt = createBoltApp();
registerListeners(bolt, inngest);
await bolt.start();

console.log("Agent system running — Hono :9080, Bolt Socket Mode, Inngest");
```

## Slack → Inngest Event Flow

### Bolt as thin relay

Bolt listeners do one thing: normalize the Slack event and emit an Inngest event. Two listeners handle two contexts:

- **`app.event("app_mention")`** — responds to @mentions in channels
- **`app.message()`** — responds to all messages in DMs (channel ID starts with `D`)

Both check the allowlist before emitting. Unauthorized users are silently ignored.

```typescript
// src/bolt/listeners/message.ts
import type { App } from "@slack/bolt";
import type { Inngest } from "inngest";
import { isUserAllowed } from "@/lib/channels";

function buildEventData(channel: string, user: string, text: string, ts: string, threadTs?: string) {
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
  // Channel @mentions — only responds when explicitly mentioned
  app.event("app_mention", async ({ event }) => {
    if (!(await isUserAllowed(event.user))) return;

    // Strip the @mention from the message text
    const text = (event.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!text) return;

    await inngest.send({
      name: "agent.message.received",
      data: buildEventData(event.channel, event.user, text, event.ts, event.thread_ts),
    });
  });

  // DMs — responds to all messages (no @mention needed)
  app.message(async ({ event }) => {
    // Only handle DMs (channel IDs starting with D)
    if (!event.channel.startsWith("D")) return;
    // Filter bot messages to prevent infinite loops
    if ("bot_id" in event || "subtype" in event) return;
    if (!(await isUserAllowed(event.user ?? "unknown"))) return;

    await inngest.send({
      name: "agent.message.received",
      data: buildEventData(event.channel, event.user ?? "unknown", event.text ?? "", event.ts, event.thread_ts),
    });
  });
}
```

### Inngest functions handle everything

Both listeners (channel @mention and DM) emit the same `agent.message.received` event. From here, the Inngest functions are identical regardless of source:

**1. handleMessage** — runs the Agent SDK session (singleton per thread, cancels stale runs)

```typescript
// src/inngest/functions/handle-message.ts
import { inngest, agentMessageReceived } from "@/inngest/client";
import { runAgentSession } from "@/agent/session";
import { getSession, saveSession } from "@/lib/sessions";
import { resolveWorkspace } from "@/lib/channels";

export const handleMessage = inngest.createFunction(
  {
    id: "handle-message",
    retries: 0, // Agent SDK calls are expensive — don't auto-retry
    triggers: [agentMessageReceived],
    // Singleton: one conversation at a time per thread.
    // "cancel" mode: if user sends a new message while agent is processing,
    // cancel the stale run and start fresh with the new message.
    singleton: { key: "event.data.sessionKey", mode: "cancel" },
  },
  async ({ event, step }) => {
    const { message, sessionKey, channel, destination } = event.data;

    // Resolve existing session for multi-turn
    const session = await step.run("resolve-session", async () => {
      return getSession(sessionKey);
    });

    // Resolve workspace: session override → channel config → global default
    const workspace = await step.run("resolve-workspace", async () => {
      return session?.workspace ?? resolveWorkspace(destination.chatId);
    });

    // Run Agent SDK — this is the expensive step
    const result = await step.run("agent-query", async () => {
      return runAgentSession({
        message,
        sessionId: session?.sessionId,
        workspace,
      });
    });

    // Persist session mapping
    if (result.sessionId) {
      await step.run("save-session", async () => {
        saveSession(sessionKey, { sessionId: result.sessionId! });
      });
    }

    // Emit reply event
    await step.sendEvent("send-reply", {
      name: "agent.reply.ready",
      data: {
        response: result.responseText,
        channel,
        destination,
      },
    });
  },
);
```

**2. acknowledgeMessage** — adds reaction (parallel, best-effort)

```typescript
// src/inngest/functions/acknowledge-message.ts
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

**3. sendReply** — posts response to Slack with retries

```typescript
// src/inngest/functions/send-reply.ts
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

    // Remove thinking reaction, add checkmark
    await step.run("update-reaction", async () => {
      if (channel === "slack") {
        await slack.reactions.remove({
          channel: destination.chatId,
          timestamp: destination.messageId,
          name: "brain",
        }).catch(() => {}); // Best-effort — may not exist
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

**4. handleFailure** — notifies user when something goes wrong

```typescript
// src/inngest/functions/handle-failure.ts
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
        await slack.reactions.remove({
          channel: chatId, timestamp: messageId, name: "brain",
        }).catch(() => {});
        await slack.reactions.add({
          channel: chatId, timestamp: messageId, name: "x",
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

### Agent SDK configuration

| Option | Value | Why |
|--------|-------|-----|
| `permissionMode` | `"bypassPermissions"` | Personal system, agent runs autonomously |
| `allowedTools` | Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch | Bash gives access to `obsidian`, `linear`, etc. CLIs |
| `cwd` | Per-session (see Workspace & Channel Onboarding) | Resolved at message time: session override → channel config → global default (`~/projects/kyrell-os`) |
| `maxTurns` | 10 | Prevent runaway sessions |

**No API key required.** The Agent SDK uses the Claude subscription — no `ANTHROPIC_API_KEY` needed.

## Workspace & Channel Onboarding

Each session needs a working directory (`cwd`). The system resolves it with a simple fallback chain — no per-message prompts, no queued messages.

### Resolution order

1. **Session override** — if the user said "switch to ~/projects/foo" in conversation, stored in session data
2. **Channel config** — set during channel onboarding, stored in `data/channels.json`
3. **Global default** — `~/projects/kyrell-os`

Messages always process immediately. There is never a "waiting for workspace" state.

### Channel config

```json
// data/channels.json
{
  "allowedUsers": ["U08XXXXXXX"],
  "channels": {
    "C08XXXXXX": {
      "workspace": "~/projects/kyrell-os",
      "onboardedAt": "2026-03-13T00:00:00.000Z"
    },
    "C09YYYYYY": {
      "workspace": "~/projects/agent-system",
      "onboardedAt": "2026-03-13T00:00:00.000Z"
    }
  },
  "workspaces": [
    { "label": "kyrell-os", "path": "~/projects/kyrell-os" },
    { "label": "Agent System", "path": "~/projects/agent-system" },
    { "label": "Vault", "path": "~/kyrell-os-vault" },
    { "label": "kos-kit", "path": "~/projects/kos-kit" }
  ],
  "globalDefault": "~/projects/kyrell-os"
}
```

- **`allowedUsers`**: `"*"` allows everyone. An array like `["U08XXXXXXX"]` restricts to those user IDs only. Defaults to your user ID.

### Channel onboarding (bot join)

When the bot is invited to a channel, Slack fires `member_joined_channel`. Bolt listens for this and posts an onboarding message with a workspace dropdown:

```typescript
// src/bolt/listeners/onboarding.ts
import type { App } from "@slack/bolt";
import type { Inngest } from "inngest";
import { getChannelConfig, getWorkspaces, getGlobalDefault } from "@/lib/channels";

export function registerOnboardingListeners(app: App, inngest: Inngest) {
  app.event("member_joined_channel", async ({ event, client }) => {
    // Only respond when the bot itself joins (not other users)
    const botInfo = await client.auth.test();
    if (event.user !== botInfo.user_id) return;

    const workspaces = getWorkspaces();
    const globalDefault = getGlobalDefault();

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

### Workspace selection action handler

```typescript
// src/bolt/listeners/actions.ts
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

### Channel config module

```typescript
// src/lib/channels.ts
import { join } from "path";
import { homedir } from "os";

const CHANNELS_FILE = "data/channels.json";
const GLOBAL_DEFAULT = join(homedir(), "projects/kyrell-os");

interface ChannelData {
  workspace: string;
  onboardedAt: string;
}

interface ChannelsConfig {
  allowedUsers: string | string[]; // "*" for all, or array of Slack user IDs
  channels: Record<string, ChannelData>;
  workspaces: { label: string; path: string }[];
  globalDefault: string;
}

async function loadConfig(): Promise<ChannelsConfig> {
  const file = Bun.file(CHANNELS_FILE);
  if (!(await file.exists())) {
    return { allowedUsers: [], channels: {}, workspaces: [], globalDefault: GLOBAL_DEFAULT };
  }
  return file.json();
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
  // Expand ~ to homedir
  return workspace.startsWith("~/") ? join(homedir(), workspace.slice(2)) : workspace;
}

export async function saveChannelWorkspace(channelId: string, workspace: string): Promise<void> {
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

### Workspace resolution flow

```
agent.message.received
  → handleMessage
    → resolve workspace: session override → channel config → global default
    → run agent with resolved cwd (always immediate, never blocked)
```

**Override mid-conversation:** The user can tell the agent "switch to ~/projects/foo" — the agent updates the session's workspace via its Bash tool. Subsequent messages in that thread use the override. Other threads are unaffected.

**Re-configure a channel:** The workspace dropdown from onboarding can be re-triggered with a Slack slash command or by re-inviting the bot.

## Session Management

Thread-scoped sessions — each Slack thread maps to one Agent SDK session ID. Session data is persisted to enable multi-turn context via `resume`. Optionally stores a workspace override if the user switches mid-conversation.

**Storage:** Per-session files in `data/sessions/` for simplicity. Each session key gets its own file, avoiding race conditions when multiple threads are active. Survives process restarts (unlike in-memory Map). Can move to SQLite later if needed.

```typescript
// src/lib/sessions.ts
import { join } from "path";

const SESSIONS_DIR = "data/sessions";

interface SessionData {
  sessionId?: string;
  workspace?: string;  // Per-thread override — only set if user switches mid-conversation
  updatedAt: string;
}

export async function getSession(sessionKey: string): Promise<SessionData | undefined> {
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

## Inngest Client & Event Types

```typescript
// src/inngest/client.ts
import { Inngest, eventType, staticSchema } from "inngest";

export const inngest = new Inngest({
  id: "agent-system",
  checkpointing: true, // Near-zero inter-step latency
});

// Normalized types — channel-agnostic field names for multi-channel readiness
export type Destination = {
  chatId: string;     // Slack: channel ID. Telegram: chat ID. Discord: channel ID.
  threadId: string;   // Slack: thread_ts. Telegram: message_thread_id.
  messageId: string;  // Slack: ts. Telegram: message_id.
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

// Typed event definitions — gives type safety at Inngest boundary
export const agentMessageReceived = eventType("agent.message.received", {
  schema: staticSchema<AgentMessageData>(),
});

export const agentReplyReady = eventType("agent.reply.ready", {
  schema: staticSchema<AgentReplyData>(),
});
```

## Agent Session Wrapper

`agent/session.ts` wraps the Agent SDK `query()` call, isolating SDK consumption from Inngest function logic:

```typescript
// src/agent/session.ts
import { query } from "@anthropic-ai/claude-agent-sdk";

interface SessionInput {
  message: string;
  sessionId?: string;
  workspace: string; // Resolved working directory for this session
}

interface SessionResult {
  sessionId?: string;
  responseText: string;
}

export async function runAgentSession(input: SessionInput): Promise<SessionResult> {
  let newSessionId: string | undefined;
  let responseText = "";

  const stream = query({
    prompt: input.message,
    options: {
      ...(input.sessionId ? { resume: input.sessionId } : {}),
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch"],
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
    if (msg.type === "system" && msg.subtype === "init") {
      newSessionId = msg.session_id;
    }
    // Result message contains final response text
    // Pattern from claude-code-slack-bot: msg.result holds the text on success
    if (msg.type === "result" && msg.subtype === "success") {
      responseText = (msg as any).result ?? "";
    }
  }

  return { sessionId: newSessionId, responseText };
}

/**
 * System prompt append — gives the agent context about its environment.
 * Injected via the `append` option on the claude_code preset.
 */
function buildSystemAppend(): string {
  return [
    "You are running as a Slack bot agent. You have access to CLI tools (obsidian, linear, etc.) via Bash.",
    "Keep responses concise — they'll be posted to Slack threads.",
    "When asked to switch workspace, update your cwd accordingly.",
  ].join("\n");
}
```

## Environment Variables

Required in `.env.schema`:

| Variable | Required | Source | Notes |
|----------|----------|-------|-------|
| `SLACK_BOT_TOKEN` | Yes | 1Password | `xoxb-` token for posting messages |
| `SLACK_APP_TOKEN` | Yes | 1Password | `xapp-` token for Socket Mode |
| `SLACK_SIGNING_SECRET` | No | 1Password | Not needed for Socket Mode, optional |

**No `ANTHROPIC_API_KEY` needed.** The Agent SDK uses the Claude subscription directly.

## Slack Client & Helpers

`lib/slack.ts` exports a shared `WebClient` from `@slack/web-api` (already installed — Bolt depends on it). Inngest functions import this client directly for outbound API calls. Retries are disabled on the client — Inngest owns all retry logic.

```typescript
// src/lib/slack.ts
import { WebClient } from "@slack/web-api";

// Shared client for outbound Slack API calls (postMessage, reactions, etc.)
// Retries disabled — Inngest handles retries at the function level to avoid
// double-retry (WebClient retries + Inngest retries) and keep retry counts
// visible in the Inngest dashboard.
export const slack = new WebClient(process.env.SLACK_BOT_TOKEN, {
  retryConfig: { retries: 0 },
});
```

Inngest functions use it directly with full type safety:

```typescript
// In any Inngest function
import { slack } from "@/lib/slack";

await slack.chat.postMessage({ channel, text, thread_ts: threadId });
await slack.reactions.add({ channel, timestamp, name: "brain" });
await slack.reactions.remove({ channel, timestamp, name: "brain" });
```

### Markdown → Slack mrkdwn conversion

**Ported from Utah's `src/channels/slack/format.ts`.** Protects code blocks and URLs from mangling, then converts markdown syntax to Slack's mrkdwn format. Includes message splitting for the 4000-char limit.

```typescript
// src/lib/format.ts

/** Convert markdown to Slack mrkdwn. Protects code blocks + URLs from mangling. */
export function markdownToSlackMrkdwn(text: string): string {
  // Protect code blocks and inline code
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
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")           // Headings → bold
    .replace(/\*\*(.*?)\*\*/g, "*$1*")                // **bold** → *bold*
    .replace(/__(.*?)__/g, "*$1*")                    // __bold__ → *bold*
    .replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "_$1_")  // *italic* → _italic_
    .replace(/~~(.*?)~~/g, "~$1~")                    // ~~strike~~ → ~strike~
    .replace(/^[\s]*[-*+]\s+/gm, "• ")               // Lists → bullets
    .replace(/^[\s]*\d+\.\s+/gm, "1. ");             // Numbered lists

  // Restore protected tokens
  result = result.replace(/\x00URL(\d+)\x00/g, (_, i) => urls[parseInt(i)]);
  result = result.replace(/\x00INLINE(\d+)\x00/g, (_, i) => inlineCode[parseInt(i)]);
  result = result.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeBlocks[parseInt(i)]);

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

## Path Aliases

All imports use `@/` path aliases mapped to `src/`. Configured in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  }
}
```

Bun resolves `paths` from `tsconfig.json` natively — no additional configuration needed.

## File Structure

```
agent-system/
  src/
    index.ts                        # Entry point — starts Hono + Bolt
    bolt/
      app.ts                        # Bolt factory (Socket Mode config)
      listeners/
        index.ts                    # Register all listeners
        message.ts                  # DM + mention → inngest.send()
        message.test.ts
        onboarding.ts               # member_joined_channel → workspace prompt
        onboarding.test.ts
        actions.ts                  # channel_workspace_select handler
        actions.test.ts
    inngest/
      client.ts                     # Inngest client + event types
      functions/
        index.ts                    # Export all functions
        handle-message.ts           # Singleton agent session per thread
        handle-message.test.ts
        acknowledge-message.ts      # Reaction indicator (best-effort)
        send-reply.ts               # Post reply to channel with retries
        send-reply.test.ts
        handle-failure.ts           # Global error handler → notify user
    agent/
      session.ts                    # Agent SDK query() wrapper
      session.test.ts
    lib/
      sessions.ts                   # Per-session file persistence (session ID + workspace override)
      channels.ts                   # Channel config, workspace resolution, onboarding state
      channels.test.ts
      slack.ts                      # Shared WebClient instance (retries disabled — Inngest owns retries)
      format.ts                     # Markdown → Slack mrkdwn conversion + message splitting
      format.test.ts
  data/
    sessions/                       # Per-session JSON files (gitignored)
    channels.json                   # Channel workspace config + available workspaces
  package.json
  justfile
  .env.schema
  tsconfig.json
  biome.json
  bunfig.toml
```

Tests are co-located with source files.

## Reference Projects

| Project | Path | What to port |
|---------|------|-------------|
| **utah** | `~/projects/utah` | Channel abstraction pattern, Inngest event-driven architecture, singleton per session, Slack mrkdwn conversion |
| **claude-code-slack-bot** | `~/projects/claude-code-slack-bot` | Agent SDK `query()` async iterable consumption, session-per-thread, reaction status indicators, `delete process.env.CLAUDECODE` gotcha |
| **joelclaw** | `~/projects/joelclaw` | Inngest function patterns, CLI tool pattern, event naming conventions |

### What to port now

- **Utah's Inngest event-driven model** — Bolt thin relay → Inngest functions. 2-arg `createFunction`, singleton/cancel, `step.sendEvent()` chaining
- **Utah's Slack formatting** — `markdownToSlackMrkdwn()`, `splitMessage()` with smart boundaries (from `src/channels/slack/format.ts`). API calls use `WebClient` from `@slack/web-api` instead of Utah's raw `fetch` wrapper.
- **Utah's markdown→mrkdwn conversion** — `markdownToSlackMrkdwn()`, `splitMessage()` with smart boundaries (from `src/channels/slack/format.ts`)
- **Utah's failure handler pattern** — truncated error message, function ID, reaction swap (from `src/functions/failure-handler.ts`)
- **claude-code-slack-bot's Agent SDK consumption** — `for await` over `query()`, `system/init` → sessionId, `result` → response text (from `src/claude-handler.ts`)
- **claude-code-slack-bot's reaction status flow** — thinking → completed/error pattern (from `src/slack-handler.ts`)

### What NOT to port yet

- Utah's full channel abstraction (Telegram, Discord — Slack only for MVP)
- Utah's Inngest webhook transforms (we use Bolt Socket Mode, not webhooks)
- Joelclaw's DAG orchestrator (no complex workflows yet)
- Joelclaw's multi-channel gateway (Slack-only for now)
- claude-code-slack-bot's Slack streaming APIs (append-only messages are simpler)
- claude-code-slack-bot's permission MCP server (using bypassPermissions)

### Future: Multi-channel

When adding Telegram, Discord, WhatsApp, iMessage:
1. Webhook-based channels: add Hono route → normalize → `inngest.send("agent.message.received")`
2. WebSocket-based channels: add WS connection in entry point → normalize → `inngest.send("agent.message.received")`
3. Implement channel handler (sendReply, acknowledge)
4. Register in channel map

The Inngest functions (handleMessage, sendReply, acknowledgeMessage) don't change — they dispatch via the `channel` field.

### Future: Workflows

When adding durable workflows (capture, research, enrichment):
1. Add Inngest function in `src/inngest/functions/`
2. Trigger via event (`inngest.send("capture/requested", { url })`)
3. Agent can trigger workflows via CLI → `inngest.send()` under the hood
4. Dashboard shows workflow execution alongside conversational flows
5. Optional: React Flow visualization layer on top

### Future: CLI

When the system has workflows worth triggering outside Slack:
1. Add `cli/` with citty
2. CLI commands send Inngest events (same as Bolt relay)
3. `agent-system capture <url>` → `inngest.send("capture/requested", { url })`
4. `agent-system status` → query Inngest API for function run status

## Dependencies

### Existing (keep)
- `@slack/bolt` — Slack Socket Mode
- `@anthropic-ai/claude-agent-sdk` — Agent sessions
- `zod` — Schema validation
- `varlock` + `@varlock/1password-plugin` — Env management

### New (add)
- `inngest` — Event-driven durable execution
- `hono` — HTTP framework for Inngest serve handler + health checks

### Remove
- `@restatedev/restate-sdk` — Replaced by Inngest

## Migration from Current Code

| Current | Change |
|---------|--------|
| `restate.endpoint().listen()` in `src/restate/server.ts` | Remove entirely — Inngest replaces Restate |
| `src/restate/` directory | Remove — all Restate code replaced by Inngest functions |
| `@restatedev/restate-sdk` dependency | Remove from package.json |
| Separate Restate server process | Replace with Inngest dev server (`inngest-cli dev`) |
| Echo bot in `src/bolt/listeners/message.ts` | Replace with thin relay → `inngest.send()` |
| Restate ping service in `src/restate/services/ping.ts` | Remove — use `/health` endpoint instead |
| No Inngest | Add Inngest client, serve handler, event types, functions |
| No Hono | Add Hono for Inngest serve handler + health checks |
| No session persistence | Per-session files in `data/sessions/` |
| No workspace management | Channel config in `data/channels.json` with onboarding flow |
| Relative imports | `@/` path aliases via tsconfig |

## Known Limitations

- **Per-session files have no TTL.** Old session files accumulate. Acceptable for MVP — add cleanup cron or TTL-based eviction later.
- **No streaming to Slack.** Agent completes full response, then posts as a single message. Acceptable for MVP — can add edit-in-place (`chat.update`) or streaming APIs later.
- **Inngest step timeout.** Agent SDK `query()` with `maxTurns: 10` could run for minutes. Inngest step timeout defaults may need increasing for the `agent-query` step. Validate early.
- **Singleton cancel mode drops messages.** If user sends a message while agent is processing, the in-progress run is cancelled. The new message starts a fresh run, but the old message's context is lost. Acceptable for personal use — the user knows they interrupted.
- **`signingSecret` unnecessary for Socket Mode.** Downgraded to optional in `.env.schema`.
- **Channel config is file-based.** `data/channels.json` works for single-process, single-machine. Move to SQLite or KV if needed later.
- **DM workspace is always global default.** DMs don't trigger `member_joined_channel`, so they always use `~/projects/kyrell-os`. Override per-thread by telling the agent.
