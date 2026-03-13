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
import { inngest } from "./inngest/client";
import { functions } from "./inngest/functions";
import { createBoltApp } from "./bolt/app";
import { registerListeners } from "./bolt/listeners";

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

Bolt listeners do one thing: normalize the Slack event and emit an Inngest event.

```typescript
// src/bolt/listeners/message.ts
import type { App } from "@slack/bolt";
import type { Inngest } from "inngest";

export function registerMessageListeners(app: App, inngest: Inngest) {
  app.message(async ({ event }) => {
    // Filter bot messages to prevent infinite loops
    if ("bot_id" in event || "subtype" in event) return;

    const threadTs = event.thread_ts ?? event.ts;

    await inngest.send({
      name: "agent.message.received",
      data: {
        message: event.text ?? "",
        sessionKey: `slack-${event.channel}-${threadTs}`,
        channel: "slack",
        sender: { id: event.user ?? "unknown" },
        destination: {
          chatId: event.channel,
          threadId: threadTs,
          messageId: event.ts,
        },
      },
    });
  });
}
```

### Inngest functions handle everything

Three functions trigger on `agent.message.received`:

**1. handleMessage** — runs the Agent SDK session (singleton per thread, cancels stale runs)

```typescript
// src/inngest/functions/handle-message.ts
import { inngest, agentMessageReceived } from "../client";
import { runAgentSession } from "../../agent/session";

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

    // If no workspace set, post workspace selector and wait
    if (!session?.workspace) {
      await step.run("request-workspace", async () => {
        if (channel === "slack") {
          await postWorkspaceSelector(destination.chatId, destination.threadId, sessionKey);
        }
      });
      // Stop here — handleSessionReady will re-trigger after user selects
      return;
    }

    // Run Agent SDK — this is the expensive step
    const result = await step.run("agent-query", async () => {
      return runAgentSession({
        message,
        sessionId: session.sessionId,
        workspace: session.workspace!,
      });
    });

    // Persist session mapping
    if (result.sessionId) {
      await step.run("save-session", async () => {
        saveSession(sessionKey, result.sessionId!);
      });
    }

    // Emit reply event
    await step.sendEvent("send-reply", {
      name: "agent.reply.ready",
      data: {
        response: result.responseText,
        channel: "slack",
        destination,
      },
    });
  },
);
```

**2. acknowledgeMessage** — adds reaction (parallel, best-effort)

```typescript
// src/inngest/functions/acknowledge-message.ts
import { inngest, agentMessageReceived } from "../client";

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
        await addReaction(destination.chatId, destination.messageId, "brain");
      }
    });
  },
);
```

**3. sendReply** — posts response to Slack with retries

```typescript
// src/inngest/functions/send-reply.ts
import { inngest, agentReplyReady } from "../client";

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
        await postMessage(destination.chatId, response, {
          threadTs: destination.threadId,
        });
      }
    });

    // Remove thinking reaction, add checkmark
    await step.run("update-reaction", async () => {
      if (channel === "slack") {
        await removeReaction(destination.chatId, destination.messageId, "brain");
        await addReaction(destination.chatId, destination.messageId, "white_check_mark");
      }
    });
  },
);
```

**4. handleFailure** — notifies user when something goes wrong

```typescript
// src/inngest/functions/handle-failure.ts
import { inngest } from "../client";

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
        await removeReaction(chatId, messageId, "brain");
        await addReaction(chatId, messageId, "x");
        await postMessage(chatId, `Something went wrong (${functionId}): ${error}`, {
          threadTs: threadId,
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
| `cwd` | Per-session (see Workspace Selection) | Resolved at session start via channel default + user selection |
| `maxTurns` | 10 | Prevent runaway sessions |

**No API key required.** The Agent SDK uses the Claude subscription — no `ANTHROPIC_API_KEY` needed.

## Workspace Selection

Each session needs a working directory (`cwd`). The system uses a two-layer approach: **channel defaults + per-thread override**.

### Channel defaults

Each channel has a default workspace configured in `data/workspaces.json`:

```json
{
  "defaults": {
    "slack-C08XXXXXX": "~/kyrell-os-vault",
    "slack-C09YYYYYY": "~/projects/agent-system",
    "telegram-12345": "~/kyrell-os-vault"
  },
  "workspaces": [
    { "label": "Vault", "path": "~/kyrell-os-vault" },
    { "label": "Agent System", "path": "~/projects/agent-system" },
    { "label": "kos-kit", "path": "~/projects/kos-kit" },
    { "label": "Custom path...", "path": null }
  ]
}
```

### First message in a new thread

When a user sends the first message in a thread (no existing session), instead of immediately running the agent, the system posts a workspace selection prompt using Slack's `static_select` Block Kit element:

```typescript
// Slack Block Kit message with workspace selector
{
  blocks: [
    {
      type: "section",
      text: { type: "mrkdwn", text: "Where should I work?" },
      accessory: {
        type: "static_select",
        action_id: "workspace_select",
        placeholder: { type: "plain_text", text: "Select workspace" },
        initial_option: {
          text: { type: "plain_text", text: "Vault" },
          value: "~/kyrell-os-vault",
        },
        options: workspaces.map((ws) => ({
          text: { type: "plain_text", text: ws.label },
          value: ws.path ?? "custom",
        })),
      },
    },
  ],
}
```

**Flow:**
1. First message in thread → post workspace selector (with channel default pre-selected)
2. User picks from dropdown (or selects "Custom path..." for a modal with text input)
3. On selection → save workspace to session, then run the agent with the original message
4. Subsequent messages in the same thread reuse the session's workspace

**Shortcut:** If the user wants to skip the selector, they can prefix their message with a path: `~/projects/foo what files are here?` — the system detects the path prefix and uses it directly.

### Bolt action handler for workspace selection

```typescript
// src/bolt/listeners/actions.ts
app.action("workspace_select", async ({ ack, body, action }) => {
  await ack();
  const selectedPath = action.selected_option.value;
  const threadTs = body.message.thread_ts ?? body.message.ts;
  const sessionKey = `slack-${body.channel.id}-${threadTs}`;

  if (selectedPath === "custom") {
    // Open modal with text input for custom path
    await app.client.views.open({
      trigger_id: body.trigger_id,
      view: buildCustomPathModal(sessionKey, threadTs),
    });
    return;
  }

  // Save workspace and run the queued message
  await saveSessionWorkspace(sessionKey, selectedPath);
  await inngest.send({
    name: "agent.session.ready",
    data: { sessionKey, workspace: selectedPath },
  });
});
```

### Event flow with workspace selection

```
agent.message.received
  → handleMessage checks: does session have a workspace?
    → YES: run agent with that cwd
    → NO (first message): post workspace selector, queue the message
        → User selects workspace
        → agent.session.ready event fires
        → handleSessionReady: save workspace, re-emit agent.message.received with workspace resolved
```

## Session Management

Thread-scoped sessions — each Slack thread maps to one Agent SDK session ID + workspace path. Session data is persisted to enable multi-turn context via `resume`.

**Storage:** Per-session files in `data/sessions/` for simplicity. Each session key gets its own file, avoiding race conditions when multiple threads are active. Survives process restarts (unlike in-memory Map). Can move to SQLite later if needed.

```typescript
// src/lib/sessions.ts
import { join } from "path";

const SESSIONS_DIR = "data/sessions";

interface SessionData {
  sessionId?: string;
  workspace?: string;
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

export async function saveSessionWorkspace(
  sessionKey: string,
  workspace: string,
): Promise<void> {
  await saveSession(sessionKey, { workspace });
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
      cwd: input.workspace, // Per-session, resolved via workspace selection
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
    if (msg.type === "result") {
      responseText = extractText(msg);
    }
  }

  return { sessionId: newSessionId, responseText };
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
        actions.ts                  # Workspace select + custom path modal
        actions.test.ts
    inngest/
      client.ts                     # Inngest client + event types
      functions/
        index.ts                    # Export all functions
        handle-message.ts           # Singleton agent session per thread
        handle-message.test.ts
        handle-session-ready.ts     # Workspace selected → run queued message
        acknowledge-message.ts      # Reaction indicator (best-effort)
        send-reply.ts               # Post reply to channel with retries
        send-reply.test.ts
        handle-failure.ts           # Global error handler → notify user
    agent/
      session.ts                    # Agent SDK query() wrapper
      session.test.ts
    lib/
      sessions.ts                   # Per-session file persistence (session ID + workspace)
      workspaces.ts                 # Workspace config loader + defaults
      slack.ts                      # Slack API helpers (postMessage, reactions)
      slack.test.ts
  data/
    sessions/                       # Per-session JSON files (gitignored)
    workspaces.json                 # Channel defaults + workspace list
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

- Utah's Inngest event-driven model (Bolt thin relay → Inngest functions)
- Utah's channel handler interface (simplified — just Slack for now)
- claude-code-slack-bot's Agent SDK consumption pattern
- claude-code-slack-bot's reaction-based status indicators

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
| Separate Restate server process | Replace with Inngest dev server (`inngest-cli dev`) |
| Echo bot in `src/bolt/listeners/message.ts` | Replace with thin relay → `inngest.send()` |
| Restate ping service in `src/restate/services/ping.ts` | Remove — use `/health` endpoint instead |
| No Inngest | Add Inngest client, serve handler, event types, functions |
| In-memory session map | Per-session files in `data/sessions/` |

## Known Limitations

- **Per-session files have no TTL.** Old session files accumulate. Acceptable for MVP — add cleanup cron or TTL-based eviction later.
- **No streaming to Slack.** Agent completes full response, then posts as a single message. Acceptable for MVP — can add edit-in-place (`chat.update`) or streaming APIs later.
- **Inngest step timeout.** Agent SDK `query()` with `maxTurns: 10` could run for minutes. Inngest step timeout defaults may need increasing for the `agent-query` step. Validate early.
- **Singleton cancel mode drops messages.** If user sends a message while agent is processing, the in-progress run is cancelled. The new message starts a fresh run, but the old message's context is lost. Acceptable for personal use — the user knows they interrupted.
- **`signingSecret` unnecessary for Socket Mode.** Downgraded to optional in `.env.schema`.
