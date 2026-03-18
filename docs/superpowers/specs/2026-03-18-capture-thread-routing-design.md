# Capture Thread Routing & Agent Wait Behavior

**Date:** 2026-03-18
**Status:** Draft

## Problem

Two bugs in agent-initiated captures:

1. **Agent doesn't wait for capture completion.** `kos capture` returns immediately (202), but the agent inconsistently follows the "wait 10-15 seconds" instruction in its system prompt. It often tries to read the vault note before the pipeline finishes, gets confused, and either tells the user the capture failed or tries to manually create the note.

2. **Notifications go to the wrong channel.** When the agent captures a URL, the completion notification posts to the global notify channel instead of the Slack thread where the conversation is happening. The agent has thread context (`chatId`, `threadId`) in its system prompt, but there's no way to pass it through `kos capture` → HTTP route → Inngest event → notification step.

### Root cause

Both issues stem from the capture pipeline lacking a `destination` passthrough:

- The `kos capture` CLI has no `--channel`/`--thread` flags.
- The HTTP route (`/api/capture`) never includes `destination` in Inngest events.
- The notification step gates on `source === "cli"` instead of checking for a destination.
- The `source` field itself is redundant — notification routing should be destination-driven, not source-driven.

## Design

### Approach: CLI flags + destination-driven notifications

Pass thread context through the entire pipeline via a `destination` object. Remove the `source` field entirely. Notification routing becomes:

- **`destination` present** → post to that thread
- **`destination` absent** → post to notify channel

### Changes by layer

#### 1. CLI: `~/.kos-kit/cli/src/commands/capture.ts`

Add two new flags:

- `--channel <chatId>` — Slack channel ID
- `--thread <threadId>` — Slack thread timestamp

When provided, include in the POST body:

```json
{
  "urls": ["https://example.com"],
  "mode": "full",
  "destination": { "chatId": "C06XXXXX", "threadId": "1234567890.123456" }
}
```

Update `CaptureOptions` interface to add `destination?: { chatId: string; threadId?: string }`. Update `handleCapture` to include `destination` in the request body when present.

#### 2. Schema: `src/capture/schema.ts`

- **Remove** `CaptureSourceEnum` and its `CaptureSource` type export.
- **Remove** `source` field from `CaptureEventSchema` and `CaptureEventInngestSchema` (both use `CaptureSourceEnum`).
- **Remove** `source` field from `CaptureFileEventSchema` (uses an inline `z.enum(["slack", "cli"])`, not the shared enum).
- **Add** `destination: CaptureDestinationSchema.optional()` to `CaptureRequestSchema`.

`CaptureDestinationSchema` already exists with `{ chatId: string, threadId?: string }` — reuse it.

#### 3. Route: `src/routes/capture.ts`

- Destructure `destination` from `parsed.data` alongside the existing fields on line 23.
- Include `destination` in Inngest event data for both URL and file captures.
- Stop setting `source` (field removed from schemas).

#### 4. Inngest: `src/inngest/functions/handle-capture.ts`

**Notification step (lines 354-391):** Replace source-gated logic with destination-driven routing.

Current logic:
```typescript
const source = isCaptureEvent(event) ? event.data.source : "cli";
if (source === "cli") {
  // post to notifyChannel
  // also post to destination thread if present
}
```

New logic:
```typescript
if (destination && destination.chatId) {
  // post to destination.chatId with thread_ts: destination.threadId
} else {
  // post to notifyChannel (if configured)
}
```

This is an intentional behavioral change: the old code posted to both notifyChannel AND destination thread for CLI captures with a destination. The new code posts to one or the other, not both. This is simpler and avoids duplicate notifications.

**YouTube channel fan-out (line 305):** Remove `source: event.data.source` from the fan-out event data. The fan-out already passes `destination` (line 306), so child video captures will inherit the correct notification routing.

**`isCaptureEvent` type guard:** Keep it — it's still used on lines 73, 78, and 85 for narrowing `url`, `mode`, and `type` fields. It doesn't depend on `source` (checks `event.name`). Only remove its use in the notification step.

**Triage mode (lines 95-121):** The `post-triage-prompt` step posts triage buttons to `notifyChannel`. This remains unchanged — triage buttons are interactive prompts that belong in the notify channel, not in an arbitrary thread. If the agent triggers triage mode, the buttons still go to the notify channel. The system prompt should steer the agent toward always using `--full` or `--quick` to avoid this.

#### 5. Agent system prompt: `src/agent/session.ts`

Replace the "Content Capture" section in `buildSystemAppend` with a much stricter version:

```
## Content Capture — CRITICAL: THIS IS ASYNC

kos capture triggers a background pipeline. It returns IMMEDIATELY.
The vault note WILL NOT EXIST for 5-30 seconds after the command returns.

ALWAYS use --full or --quick mode. ALWAYS include --channel and --thread flags:
  kos capture <url> --full --channel <chatId> --thread <threadId>

After running kos capture, you MUST:
1. Sleep 15 seconds (sleep 15)
2. Attempt to read the note (obsidian read file="Title")
3. If the note doesn't exist, sleep 10 more seconds and retry ONCE
4. Only after confirming the note exists, summarize it for the user

NEVER tell the user "I've captured this" before verifying the note exists.
```

The prompt already has `chatId` and `threadId` values in the Slack Context section — the agent uses those to fill in the flag values. The instruction to always use `--full` or `--quick` prevents the agent from accidentally triggering triage mode.

#### 6. Tests: `src/capture/schema.test.ts`

Update tests to remove `source` from test data in `CaptureEventSchema` and `CaptureFileEventSchema` tests. Remove test cases that validate source values (e.g., "rejects invalid source", "rejects extension source"). Add test cases for `CaptureRequestSchema` with `destination`.

### What's NOT changing

- `src/inngest/client.ts` — Capture events get their destination schema from `CaptureDestinationSchema` in `schema.ts`, not from the `destinationSchema` in `client.ts` (that one is for agent message events and has required `threadId` + `messageId`). No changes needed.
- Extraction functions (Jina, local, CF browser) — untouched.
- Vault writer — untouched.
- Slack bolt listeners — they set `destination` on their own events (messages), not capture events.

### Files changed

| File | Change |
|------|--------|
| `~/.kos-kit/cli/src/commands/capture.ts` | Add `--channel`/`--thread` flags, pass `destination` in body |
| `src/capture/schema.ts` | Remove `CaptureSourceEnum`/`source`, add `destination` to request schema |
| `src/capture/schema.test.ts` | Update tests: remove `source` from test data, add `destination` tests |
| `src/routes/capture.ts` | Destructure and pass `destination`, stop setting `source` |
| `src/inngest/functions/handle-capture.ts` | Destination-driven notifications, remove `source` from fan-out |
| `src/agent/session.ts` | Rewrite capture section with hard async rules |

## Testing

- `kos capture <url> --full --channel C123 --thread 123.456` should include destination in the Inngest event.
- `kos capture <url> --full` (no flags) should still work, notifications go to notify channel.
- Agent-initiated capture with `--channel`/`--thread` should post completion to the correct thread.
- Existing CLI captures without flags should continue to notify the configured channel.
- Schema validation should reject malformed destination objects.
- YouTube channel fan-out should propagate destination without source.
- All `src/capture/schema.test.ts` tests pass after source removal.
