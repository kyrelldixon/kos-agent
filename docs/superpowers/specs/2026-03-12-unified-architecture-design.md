# Agent System Unified Architecture Design

**Date:** 03-12-2026
**Linear:** KYR-117
**Status:** Draft

## Problem

The agent system has three runtime concerns — Slack (Bolt Socket Mode), durable workflows (Restate), and conversational AI (Claude Agent SDK) — running on deprecated APIs (`restate.endpoint()`) with no clear integration pattern between them. The plan's Tasks 4-6 need rearchitecting before continuing.

## Decision

**Approach A: Unified Process.** One Bun process runs Hono (serving Restate fetch handler on port 9080) and Bolt (Socket Mode WebSocket) side by side. Claude Agent SDK is a library call from Bolt listeners. A separate CLI binary provides human/script access to the same workflows.

### Why this approach

- Simplest to develop and operate (two terminals: `restate-server` + `bun dev`)
- No inter-process communication overhead
- Single-user system — concurrent message blocking is manageable (ack immediately, stream response)
- Easy to split later if needed (move `src/restate/` to its own entry point)

## Architecture

```
                     ┌──────────────────────────────────────────┐
                     │  Bun Process (src/index.ts)              │
                     │                                          │
                     │  ┌──────────┐  ┌──────────────────────┐  │
                     │  │  Bolt    │  │  Hono :9080           │  │
  Slack ◄──ws──────► │  │  Socket  │  │  ├─ /restate/* →      │  │
                     │  │  Mode    │  │  │  fetch handler      │  │
                     │  └────┬─────┘  │  └─ GET /health       │  │
                     │       │        └──────────────────────┘  │
                     │       ▼                    ▲              │
                     │  ┌──────────┐              │              │
                     │  │ Agent SDK│   Restate server calls     │
                     │  │ query()  │   into fetch handler       │
                     │  └──────────┘              │              │
                     └────────────────────────────┼─────────────┘
                                                  │
                     ┌──────────────┐    ┌────────┴───────┐
                     │ agent-system │───►│ restate-server  │
                     │ CLI (citty)  │    │ :8080 ingress   │
                     └──────────────┘    └────────────────┘
```

### Process topology (dev)

1. **Terminal 1:** `just restate` — Restate server binary (ingress :8080, admin :9070)
2. **Terminal 2:** `just dev` — Bun process (Hono :9080 + Bolt Socket Mode)
3. **CLI:** `agent-system <command>` — invoked by humans, scripts, or the agent via Bash tool

## Server Entry Point

`src/index.ts` starts both Hono and Bolt:

```typescript
import { Hono } from "hono";
import { createEndpointHandler } from "@restatedev/restate-sdk/fetch";
import { createBoltApp } from "./bolt/app";
import { registerListeners } from "./bolt/listeners";
import { services } from "./restate";

// Must delete before Agent SDK query() — prevents SDK from detecting Claude Code env
delete process.env.CLAUDECODE;

const hono = new Hono();

// Restate fetch handler — replaces deprecated endpoint().listen()
// Note: bidirectional requires HTTP/2. Bun.serve does not support HTTP/2,
// so this falls back to request-response mode. Validate early — if it fails,
// set bidirectional: false (fine for this use case).
const restateHandler = createEndpointHandler({
  services,
  bidirectional: true,
});

// Mount at root — Restate calls /ServiceName/handlerName directly.
// Registration URL must match: `restate deployments register http://localhost:9080`
hono.get("/health", (c) => c.json({ status: "ok" }));
hono.all("/*", (c) => restateHandler(c.req.raw));

Bun.serve({ port: 9080, fetch: hono.fetch.bind(hono) });

const bolt = createBoltApp();
registerListeners(bolt);
await bolt.start();

console.log("Agent system running — Hono :9080, Bolt Socket Mode");
```

## Slack to Agent SDK Flow

### Message lifecycle

1. Slack event arrives via Bolt Socket Mode (WebSocket)
2. Bolt listener acks immediately (within 3s)
3. Adds reaction (brain emoji) to show agent is thinking
4. Calls `query()` with message text and `includePartialMessages: true`
5. Streams response to Slack via streaming APIs (`chat.startStream` / `chat.appendStream` / `chat.stopStream`)
6. On error, posts error message to thread

### Session management

Thread-scoped sessions — each Slack thread maps to one Agent SDK session. Session IDs stored in `Map<threadTs, sessionId>` for multi-turn context via `resume`.

```typescript
const sessions = new Map<string, string>(); // threadTs → sessionId

// On message:
const threadTs = event.thread_ts ?? event.ts;
const sessionId = sessions.get(threadTs);

const stream = query({
  prompt: text,
  options: {
    ...(sessionId ? { resume: sessionId } : {}),
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    cwd: process.env.VAULT_PATH,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: systemAppend, // skills, vault path, CLI docs, "responding in Slack"
    },
    maxTurns: 10,
    includePartialMessages: true,
  },
});

for await (const message of stream) {
  if (message.type === "system" && message.subtype === "init") {
    sessions.set(threadTs, message.session_id);
  }
  // Stream text deltas to Slack via streaming APIs...
}
```

### Agent SDK configuration

| Option | Value | Why |
|--------|-------|-----|
| `permissionMode` | `"bypassPermissions"` | Personal system, agent runs autonomously |
| `allowedTools` | Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch | Bash gives access to `agent-system` CLI, `obsidian`, `linear`, etc. |
| `cwd` | `$VAULT_PATH` | Default workspace for knowledge work |
| `maxTurns` | 10 | Prevent runaway sessions |
| `includePartialMessages` | `true` | Stream text deltas for Slack streaming |

## Restate Integration

### Role separation

- **Agent SDK** = conversational brain (Slack message in, reply out)
- **Restate** = durable execution engine (multi-step workflows that must not re-run completed steps)
- **Bridge** = `agent-system` CLI, called by agent via Bash tool or by humans directly. POSTs to Restate HTTP ingress.

### Durable execution guarantee

Each `ctx.run("step-name", fn)` in a Restate workflow is journaled. On failure or retry, completed steps replay from journal — the function is never re-executed. The agent gets a workflow ID and can check status.

### How workflows are triggered

**CLI only.** The `agent-system` binary (citty + Bun) is the single interface for triggering workflows — used by humans, scripts, and the agent via the Bash tool. Each command POSTs to the Restate HTTP ingress under the hood.

This follows the joelclaw pattern: the agent has a well-documented CLI it calls via Bash, not in-process MCP tools. CLIs are self-documenting (`--help`), testable independently, and work the same way whether invoked by a human or an agent.

```bash
agent-system capture https://example.com    # trigger capture workflow
agent-system status <workflow-id>           # check workflow status
agent-system workflows                     # list available workflows
```

The agent discovers available commands via `agent-system --help` or from the system prompt (which documents available CLI tools). This is the same pattern used for `linear`, `obsidian`, and `tmx` in kos-kit.

### Restate handler structure

```
src/restate/
  index.ts              # Exports all services/workflows for binding
  services/
    ping.ts             # Health check (exists)
  workflows/
    capture.ts          # URL capture: fetch → summarize → vault note
  objects/              # Virtual objects (future: job scheduler, rate limiter)
```

```typescript
// src/restate/index.ts
import { pingService } from "./services/ping";
import { captureWorkflow } from "./workflows/capture";

// Array of service/workflow/object definitions for createEndpointHandler
export const services = [pingService, captureWorkflow];
```

### Example workflow

```typescript
// src/restate/workflows/capture.ts
import * as restate from "@restatedev/restate-sdk";

export const captureWorkflow = restate.workflow({
  name: "capture",
  handlers: {
    run: async (ctx: restate.WorkflowContext, input: { url: string }) => {
      const content = await ctx.run("fetch", async () => {
        const res = await fetch(`https://r.jina.ai/${input.url}`);
        return res.text();
      });

      const summary = await ctx.run("summarize", async () => {
        return summarize(content);
      });

      await ctx.run("write-vault", async () => {
        await createVaultNote(input.url, summary);
      });

      return { url: input.url, status: "captured" };
    },
  },
});
```

## File Structure

```
agent-system/
  src/
    index.ts                        # Entry point — starts Hono + Bolt
    bolt/
      app.ts                        # Bolt factory (Socket Mode config)
      listeners/
        message.ts                  # DM + mention handlers → agent session
        message.test.ts
    agent/
      session.ts                    # query() wrapper, streams to Slack
      session.test.ts
      skills.ts                     # Skill loader from filesystem markdown
      skills.test.ts
    restate/
      index.ts                      # Exports all services for binding
      services/
        ping.ts                     # Health check service
        ping.test.ts
      workflows/
        capture.ts                  # URL capture workflow
        capture.test.ts
      objects/                      # Virtual objects (future)
    lib/
      obsidian.ts                   # Obsidian CLI wrapper
      slack.ts                      # Slack streaming helpers
      slack.test.ts
  cli/
    index.ts                        # citty entry point
    commands/
      capture.ts                    # agent-system capture <url>
      status.ts                     # agent-system status <id>
  package.json                      # bin: { "agent-system": "cli/index.ts" }
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
| **claude-code-slack-bot** | `~/projects/claude-code-slack-bot` | Streaming response pattern, Slack formatting, session-per-thread |
| **agent-platform** | `~/projects/agent-platform` | `query()` async iterable consumption, `delete process.env.CLAUDECODE` gotcha |
| **utah** | `~/projects/utah` | Channel abstraction, singleton concurrency, Slack mrkdwn conversion |
| **joelclaw** | `~/projects/joelclaw` | Restate DAG orchestrator, tool-wraps-CLI pattern, video pipeline |

### What NOT to port yet

- Utah's Inngest integration (we use Restate)
- Joelclaw's multi-channel gateway (Slack-only for now)
- Joelclaw's pi-coding-agent extension system (Agent SDK replaces this)
- Utah's two-tier memory system (Agent SDK handles context)

### Future: Channel abstraction

Utah's `ChannelHandler` interface is the right pattern for adding Telegram/web dashboard later. The design keeps Slack-specific I/O in `src/bolt/` — `session.ts` takes a prompt, returns text. This boundary makes adding channels straightforward.

## Dependencies

### Existing (keep)
- `@slack/bolt` — Slack Socket Mode
- `@restatedev/restate-sdk` — Restate service handlers
- `@anthropic-ai/claude-agent-sdk` — Agent sessions
- `zod` — Schema validation (tools, inputs)
- `varlock` + `@varlock/1password-plugin` — Env management

### New (add)
- `hono` — HTTP framework for Restate fetch handler
- `citty` — CLI argument parsing for `agent-system` binary

## Known Limitations

- **Session map is in-memory.** On process restart (including `bun --watch`), all thread→session mappings are lost. Acceptable for MVP — sessions can be persisted to a file or SQLite later if needed.
- **Bidirectional mode requires HTTP/2.** `Bun.serve` does not support HTTP/2. If `bidirectional: true` fails, fall back to `false` (request-response mode). Validate this early.
- **Slack streaming APIs are new.** `chat.startStream` / `chat.appendStream` / `chat.stopStream` — reference `~/projects/claude-code-slack-bot` for a working implementation. Fall back to edit-in-place (`chat.update`) if streaming is unavailable.
- **`signingSecret` unnecessary for Socket Mode.** Can be removed from Bolt config and downgraded to optional in `.env.schema`. Socket Mode authenticates via app token over WebSocket.
- **`ANTHROPIC_API_KEY` must be available.** Either add to `.env.schema` with varlock or ensure it's set in shell profile. The Agent SDK requires it.

## Migration from Current Code

| Current | Change |
|---------|--------|
| `restate.endpoint().listen()` | Replace with `createEndpointHandler` from `@restatedev/restate-sdk/fetch` mounted on Hono |
| Separate Restate server in `src/restate/server.ts` | Merge into `src/index.ts` as Hono route |
| Echo bot in `src/bolt/listeners/message.ts` | Replace with Agent SDK session + Slack streaming |
| No CLI | Add `cli/` with citty, register in `package.json` bin |
| No CLI | Add `cli/` with citty commands that POST to Restate ingress |
