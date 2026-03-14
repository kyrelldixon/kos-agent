# Streaming & Tool Visibility Design

**Goal:** Replace the silent collect-then-post pattern with real-time streaming of agent activity to Slack — tool usage, text responses, and status indicators — so the user always knows what the agent is doing.

**Spec:** This document
**Plan:** TBD (created after spec approval)

---

## Architecture: Durable Bookends with Streaming Core

The handle-message Inngest function changes from wrapping the entire agent query in `step.run()` to a hybrid model. Durable steps protect session management; the agent query streams directly.

```
step.run("resolve-session")        ← durable, memoized on retry
step.run("resolve-workspace")      ← durable, memoized on retry
step.run("resolve-display-mode")   ← durable, memoized on retry
── streaming zone (not in a step) ──
  call session.streamAgentSession() → returns AsyncIterable<SDKMessage>
  for await (const msg of stream):
    system/init  → capture sessionId
    assistant (tool_use) → format via formatToolUse(), post to Slack per displayMode
    assistant (text)     → format via markdownToSlackMrkdwn() + splitMessage(), post to Slack
    result       → capture final result
  if no text was posted during streaming → post "_No response generated._"
── end streaming ──
step.run("save-session")           ← durable, persists sessionId for resume
step.sendEvent("agent.reply.ready") ← durable, sends result text + triggers send-reply
```

All context needed for the streaming zone (`destination`, `channel`, `displayMode`, `sessionId`, `workspace`) comes from `event.data` or from the durable steps above. The `for await` loop processes messages sequentially — no parallelization.

### session.ts refactor

`session.ts` changes from returning a collected `SessionResult` to exposing an `AsyncIterable<SDKMessage>`:

- `runAgentSession()` → renamed to `streamAgentSession()`, returns `AsyncIterable<SDKMessage>` instead of `Promise<SessionResult>`
- Agent configuration (allowed tools, system prompt, resume, cwd, maxTurns) stays encapsulated in `session.ts`
- `extractResponse()` is removed — handle-message processes messages inline during the streaming loop
- Session-level logging (`[agent] Tool use: ...`) moves to handle-message since it now iterates the stream

### Why not wrap streaming in step.run()?

Inngest's `step.run()` blocks until the function returns. The agent SDK query is an async iterable that can run for 30+ seconds across multiple tool calls. Wrapping it in a step means no Slack messages until completion — defeating the purpose.

### Retry behavior

`handle-message` changes from `retries: 0` to `retries: 1` to enable crash recovery.

If the process crashes mid-stream:
1. Inngest retries the function (1 retry)
2. `resolve-session`, `resolve-workspace`, `resolve-display-mode` replay instantly (memoized)
3. Agent SDK resumes via `resume: sessionId` (SDK-level durability)
4. Status messages post again — acceptable duplication, user sees activity

### Singleton cancellation interaction

`handle-message` has `singleton: { key: "event.data.sessionKey", mode: "cancel" }`. If a second message arrives while streaming the first, the first run is cancelled mid-stream. This means orphaned status messages from the first run remain in the thread (no cleanup). The second run starts fresh with its own status messages. This is acceptable — the user sent a new message, so the old status messages are stale context, not confusing.

### send-reply changes

`send-reply` stays as-is — it still posts the final `result` text and handles the reaction swap (brain → checkmark). The streaming zone posts intermediate tool use and text from `assistant` messages. The `result` message from the SDK (captured at the end of streaming) is sent via `agent.reply.ready` for `send-reply` to post as the final response.

This means the final response may partially duplicate text that was already streamed as intermediate `assistant` messages. This is acceptable for now — if it feels redundant in practice, `send-reply` can be changed to reaction-swap-only later.

The `response` field in `AgentReplyData` continues to carry the result text.

### Function timeout

`handle-message` gets a 5-minute function-level timeout. When exceeded, Inngest marks it failed → `handle-failure` fires → posts error to Slack with ❌ reaction. The `maxTurns: 10` in the Agent SDK provides a natural bound within that window.

---

## Display Modes

Two modes control how streaming messages appear in Slack. Stored as `displayMode` in `data/channels.json`.

### verbose (default)

Each SDK message gets its own Slack message in the thread.

```
User: @agent what's in my vault?
  🧠 Thinking...                              ← brain reaction on original
  🔧 Bash: `ls ~/kyrell-os-vault/`            ← new message
  🔧 Read: vault/telos.md                     ← new message
  Here's what I found in your vault...         ← new message (agent text)
  ✅                                           ← checkmark reaction on original
```

**Implementation:** Each tool use and text chunk calls `slack.chat.postMessage()`.

### compact

One editable status message updates in place. Text still gets its own message.

```
User: @agent what's in my vault?
  🧠 Thinking...                              ← status message + brain reaction
  🔧 Bash: `ls ~/kyrell-os-vault/`            ← status message updated
  🔧 Read: vault/telos.md                     ← status message updated
  Here's what I found in your vault...         ← new message (agent text)
  ✅ Done                                      ← status message updated + checkmark reaction
```

**Implementation:** First tool use calls `chat.postMessage()` and stores the `ts`. Subsequent tool uses call `chat.update()` with that `ts`. Text chunks always use `chat.postMessage()` (new message). The `for await` loop guarantees sequential processing — no race condition on the stored `ts`.

### Configuration

```json
{
  "displayMode": "verbose",
  "allowedUsers": ["U12345"],
  ...
}
```

Global setting in `data/channels.json`. Default: `"verbose"`. Changeable by editing the file directly.

---

## Tool Formatting

A `formatToolUse(name: string, input: Record<string, unknown>): string` function in `src/lib/format.ts` produces medium-detail one-liners:

| Tool | Format | Example |
|------|--------|---------|
| Bash | `🔧 Bash: \`{command}\`` | `🔧 Bash: \`git status\`` |
| Read | `📄 Read: {path}` | `📄 Read: src/index.ts` |
| Write | `📝 Write: {path}` | `📝 Write: src/lib/format.ts` |
| Edit | `✏️ Edit: {path}` | `✏️ Edit: src/bolt/app.ts` |
| Glob | `🔍 Glob: {pattern}` | `🔍 Glob: src/**/*.ts` |
| Grep | `🔍 Grep: "{pattern}"` | `🔍 Grep: "handleMessage"` |
| WebFetch | `🌐 Fetch: {url}` | `🌐 Fetch: https://example.com` |
| WebSearch | `🌐 Search: "{query}"` | `🌐 Search: "inngest error handling"` |
| Other | `🔧 {name}` | `🔧 TodoWrite` |

**Truncation:** Bash commands truncated at 80 characters. URLs truncated at 60. All other values truncated at 100.

Each text chunk from `assistant` messages goes through `markdownToSlackMrkdwn()` and `splitMessage()` before posting — the same formatting pipeline as the current flow. Each text part produces one or more Slack messages (split if over 3900 chars). Multi-turn agents that produce text between tool calls (e.g., "Let me check..." → tools → "Here's what I found...") result in multiple text messages in the thread.

---

## Crash and Timeout Handling

### Agent query hangs

Function-level timeout of 5 minutes on handle-message. When exceeded, Inngest marks the function as failed → `handle-failure` fires → posts error to Slack with ❌ reaction. User sees the failure, not silence.

### Process crashes mid-stream

Inngest retries (1 retry). Durable steps replay. Agent SDK resumes via sessionId. A fresh set of status messages appears in the thread. The user sees activity rather than a dead thread.

### Empty response

If the streaming zone produces no text and the result is also empty, `send-reply` handles it (already implemented — posts `_No response generated._`). The streaming zone tracks whether any text was posted; if not and the result text is also empty, the empty-response fallback fires in send-reply.

---

## Files Changed

| File | Change |
|------|--------|
| `src/inngest/functions/handle-message.ts` | Move agent query out of step.run, add streaming loop with Slack posting, add display mode step, set retries: 1 and timeout |
| `src/inngest/functions/send-reply.ts` | No changes — still posts result text and swaps reactions. May be simplified to reaction-only after testing. |
| `src/inngest/client.ts` | No changes — `AgentReplyData` unchanged |
| `src/lib/format.ts` | Add `formatToolUse()` function |
| `src/lib/format.test.ts` | Tests for formatToolUse |
| `src/lib/channels.ts` | Add `getDisplayMode()` function |
| `src/agent/session.ts` | Rename `runAgentSession` → `streamAgentSession`, return `AsyncIterable<SDKMessage>`, remove `extractResponse()` |
| `src/agent/session.test.ts` | Remove extractResponse tests, replace with streamAgentSession tests if feasible |
| `data/channels.json` | Add `displayMode` field |

---

## Out of Scope

- File/image receiving from Slack (follow-up)
- File/image generation by the agent (follow-up)
- Slash commands for switching display mode (YAGNI — edit JSON for now)
- Singleton cancellation cleanup (orphaned status messages are acceptable)
- Article capture workflow (separate spec)
- Video capture workflow (separate spec)
