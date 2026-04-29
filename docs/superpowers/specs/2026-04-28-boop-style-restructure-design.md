# Boop-Style Restructure: kos-agent on Convex with Dispatcher/Executor Split

**Date:** 2026-04-28
**Status:** Draft
**Reference repo:** `/Users/kyrelldixon/projects/boop-agent` (cloned for study; we port patterns *into* kos-agent, not the other way around)

## Goal

Replace the self-hosted-Inngest + JSON-file-sessions architecture with a Convex-backed, dispatcher/executor-split agent that runs as a single Bun process on the Mac Mini today and on any always-on Linux box tomorrow. Get a real-time debug UI for agent observability — the loudest existing pain — without adding new SaaS dependencies beyond Convex itself.

## Why now

Two pain points converged:

1. **Self-hosted Inngest has been unreliable.** Migrating to Inngest Cloud is a possible quick fix, but it preserves the underlying observability gap — Inngest's dashboard tells you about workflow runs, not about what the agent is *doing across turns and tool calls*.
2. **No agent observability.** The current system has no place to see "what conversations exist, what sub-agents got spawned, what tools they called, how much each cost." Slack history is not a substitute. This has been actively painful.

Boop solves both with one move: Convex as the shared state + reactive UI substrate, plus a dispatcher/executor split that makes "what the agent did" structurally legible (per-agent rows, per-step logs, per-call usage).

## Non-goals

- **Composio integration.** Skip for now. The dispatcher/executor pattern works without it; we add it later if we want broad SaaS tool access.
- **Memory consolidation pipeline.** Boop's daily proposer/adversary/judge pipeline is too sophisticated for current needs. Defer until simple memory becomes a real problem.
- **exe.dev / client-deployment story.** Architecture is designed to be portable, but actually deploying for clients is downstream of getting personal use working.
- **Cloudflare Workers / serverless.** Vault is a local Obsidian repo on disk; the agent must write files to it. Always-on process is required. Serverless ruled out.
- **Mini-PaaS for vibecoded apps.** Deferred per earlier scoping conversation.

## Architecture

### Target shape

```
                      Mac Mini (always-on Bun process)
                ┌────────────────────────────────────────┐
                │  Bun + Hono server (port 9080)         │
                │                                        │
  Slack ───────►│  Bolt listeners (socket mode)          │
                │   ├─► Dispatcher (interaction agent)   │
                │   │     ├─ memory tools                │
                │   │     └─ spawn_agent(name, task)     │◄────┐
                │   │                                    │     │
                │   └─► Executor (per-spawn sub-agent)   │     │
                │         └─ scoped tools per task       │     │
                │                                        │     │ reactive
                │  HTTP routes                           │     │ subscriptions
                │   ├─► /api/voice-memo (Apple Shortcut) │     │
                │   ├─► /api/capture                     │     │
                │   └─► /api/inngest (DELETED)           │     │
                │                                        │     │
                │  Pipelines (plain async, no Inngest)   │     │
                │   ├─► captureUrl(url, mode)            │     │
                │   ├─► voiceMemo(audioBytes, name)      │     │
                │   └─► writeVaultNote(...)              │     │
                │                                        │     │
                │  Vault on disk: ~/kyrell-os-vault/     │     │
                │                                        │     │
                │  Static debug UI on /debug             │     │
                └──────────────┬─────────────────────────┘     │
                               │ HTTP                          │
                               ▼                               │
                        ┌────────────┐                         │
                        │  Convex    │◄───────────────────────┘
                        │  (cloud)   │ Convex's own dashboard
                        └────────────┘ + our React debug UI
                               ▲
                               │ subscribes via Convex client
                               │
                          Browser (debug UI)
```

The Mac Mini is the "edge with local files." Convex is the "cloud co-processor for state, logs, scheduling." The vault stays on the box because that's where Obsidian reads it from.

### Component responsibilities

| Component | Lives where | Job |
|---|---|---|
| Bolt listeners | Mac Mini process | Slack event ingress; dedup; abort previous stream; trigger dispatcher |
| Dispatcher (interaction agent) | Mac Mini process | Read history from Convex; decide reply vs spawn; write back to Convex |
| Executor (sub-agent) | Mac Mini subprocess | Run a single task with scoped tools; log every step to Convex |
| HTTP routes | Mac Mini process | Voice memo upload; capture trigger; debug UI static files |
| Pipelines | Mac Mini process | Plain async functions for capture and voice memo; write to Convex + vault |
| Convex tables | Convex cloud | Source of truth for state and observability |
| Debug UI | Browser (built artifact served by Hono) | Real-time view via Convex reactive queries |
| Vault | Mac Mini disk | Markdown files; agent writes via local filesystem |

### Inngest stays — migrate self-hosted to Cloud

The pipelines (`handle-capture`, `handle-voice-memo`, `extract-jina`, `extract-local`, `extract-cf-browser`, `transcribe-elevenlabs`) **stay as Inngest functions**. They work, they have real durability primitives (`step.invoke` for tier fallback, `step.waitForEvent` for the 4h triage gate, retry-per-step on transient failures), and rewriting them as plain async would lose those properties for no real gain.

What changes: **migrate the runtime from self-hosted Inngest to Inngest Cloud**, per the existing migration plan. Self-hosted is the source of unreliability; Cloud removes that. The migration is a configuration swap (event/signing keys, CF Access bypass for `/api/inngest`), not a code rewrite.

**The two-plane split is the load-bearing decision:**

- **Inngest = durable workflows plane.** Capture, voice memo, future cold-email/SEO pipelines. Inngest's dashboard handles workflow observability.
- **Convex = state + agent observability plane.** Sessions, messages, executor logs, debug UI. Convex's reactivity handles "what is the agent doing across turns and tool calls."

The two planes are coupled via a single `inflightWorkflows` row written from the dispatcher/executor when it calls `inngest.send`. That's the entire correlation surface — see Schema section.

## Convex schema

Adapted from Boop's `convex/schema.ts` (`/Users/kyrelldixon/projects/boop-agent/convex/schema.ts`). Tables we adopt, drop, and add:

### Adopt from Boop (rename where domain-appropriate)

- **`messages`** — Slack thread transcript. `conversationId` becomes the Slack `sessionKey` (`slack-{channel}-{threadTs}`). Replaces JSON session files.
- **`conversations`** — per-thread metadata.
- **`executionAgents`** — one row per spawned sub-agent with status lifecycle (`spawned → running → completed/failed/cancelled`), tokens, cost, mcpServers.
- **`agentLogs`** — append-only per-step audit trail (`thinking | tool_use | tool_result | text | error`). This is the killer table for observability.
- **`usageRecords`** — per-LLM-call cost log tagged by `source` (`dispatcher | execution | extract` — `extract` is reserved if we later add memory extraction).
- **`drafts`** — staged external actions. Useful pattern even though we don't have Composio yet (e.g., the agent can stage a vault edit for confirmation before writing).
- **`memoryEvents`** — append-only events for live UI updates.
- **`settings`** — runtime overrides (model selection, etc.).

### Adopt from Boop, simplified

- **`memoryRecords`** — stripped-down: no tier (`short`/`long`/`permanent`), no decay rate, no embeddings, no `lifecycle`, no `supersedes`. Keep just `content`, `tags` (string[]), `createdAt`, `updatedAt`. The dispatcher's `recall` does substring search; `write_memory` inserts a row. Leaves room to add tiers/embeddings/consolidation later without a schema rewrite.

### Drop from Boop

- **Vector embeddings** on `memoryRecords` — substring recall is enough at our scale.
- **`automations`** + **`automationRuns`** — defer scheduled-task scheduler until we want it.
- **`consolidationRuns`** — drop with the consolidation pipeline.
- **`sendblueDedup`** — Slack-specific dedup, if needed, lives in a different table.

### Add for our domain

- **`inflightWorkflows`** — minimal in-flight tracker for Inngest dispatches. Schema: `eventId` (from `inngest.send().ids[0]`), `eventName`, `triggeredBy` (`agentId` + `conversationId`), `context` (human-readable label like the URL being captured), `startedAt`, `status` (`dispatched | done`). Indexed by status. **Written only from the agent side** — the dispatcher/executor inserts a row when calling `inngest.send`. The debug UI shows rows under 5 minutes old as "in flight" and lets older rows fall off automatically; no completion callback required from the Inngest function. This is the entire cross-system surface area.

### Explicitly NOT added

- No `captures`, `voiceMemos`, or `vaultNotes` tables. Inngest functions stay self-contained — they extract, write the vault file, post Slack notification, done. They don't touch Convex.
- Reasoning: the only correlation we want today is "what is the agent currently doing" across both planes. `inflightWorkflows` gives that. Anything else (cost-by-pipeline aggregation, "captures this week" view, vault search via Convex) is deferred to a future client-ready phase.

### Indexes

Mirror Boop's pattern: `by_conversation`, `by_agent`, `by_status`, `by_lifecycle`. Add `by_file_path` on `vaultNotes` for idempotency lookups.

## Dispatcher/executor split

Following Boop's pattern (`/Users/kyrelldixon/projects/boop-agent/server/interaction-agent.ts` + `execution-agent.ts`). Adapted for Slack:

### Dispatcher (interaction agent)

- **One instance per Slack message turn.**
- Reads from Convex: last 10 messages on the thread, recent agent activity, settings.
- **Tool surface (small):**
  - `recall(query)` — retrieve relevant past context. Substring search is enough for v1; vector recall later.
  - `write_memory(content, tags)` — persist a durable fact. Stays simple (no tier, no decay). Add complexity only if needed.
  - `spawn_agent(name, task)` — dispatch to a named executor with a task string. Returns the executor's reply text.
- **System prompt drills:** "you decide; you don't do." Answer chit-chat directly, spawn for real work.
- **Replies stream through Bolt back to Slack** with the existing markdown→mrkdwn conversion and chunking.

### Executor (sub-agent)

- **Spawned per task.** Ephemeral. One instance, one job, one returned string.
- **Tool surface scoped per executor type.** Initial set:
  - `capture-agent`: `trigger_capture(url, mode)`, `search_vault(query)`, `read_recent_captures()`
  - `voice-memo-agent`: `list_recent_memos()`, `search_transcripts(query)`, `transcribe_now(filePath)`
  - `general-agent`: `WebSearch`, `WebFetch` — fallback when no domain-specific executor matches
- **Future executor types** (out of scope for this restructure): a code-running executor with sandboxed file access. Design the dispatcher's `spawn_agent` API so adding a new executor is a single registration call; the schema and storage don't need to change.
- **Logs every `tool_use`, `tool_result`, `text` to `agentLogs`** so the dispatcher and the debug UI can both see what happened.
- **Permission mode:** `bypassPermissions`. The dispatcher decides whether to spawn; once spawned, the executor is trusted within its scoped tool surface.

### Why this works without Composio

Boop's executor leans on Composio for breadth (1000+ toolkits). We don't have that breadth need yet. Each of our executors gets a small, hand-written tool list. When we want Gmail or Notion later, we add a Composio-backed executor without disturbing the others.

## Pipelines (Inngest, unchanged)

The capture pipeline (`src/inngest/functions/handle-capture.ts`) and voice-memo pipeline (`src/inngest/functions/handle-voice-memo.ts`) stay as Inngest functions. Their internal logic — content-type detection, triage `step.waitForEvent`, tiered extraction via `step.invoke`, vault write, Slack notify — is preserved. Existing extractor modules (`src/capture/extract/*`) and the vault writer carry over unchanged.

The only change is how they're triggered from the agent layer:
- The `capture-agent` executor's `trigger_capture(url, mode)` tool calls `inngest.send({ name: "agent.capture.requested", data: { ... } })` and inserts an `inflightWorkflows` row with the returned event ID.
- Same pattern for voice-memo if the agent ever wants to re-trigger transcription.

The `kos capture` CLI keeps sending Inngest events directly (existing pattern).

### Agent message handler (replaces `src/inngest/functions/handle-message.ts`)

The Bolt listener calls the dispatcher **directly** instead of routing through Inngest. The agent path is in-process; only the durable workflows (capture, voice memo) go through Inngest. Flow:

1. Bolt listener receives a Slack message
2. Aborts any active stream for this `sessionKey` (existing `src/lib/streams.ts` logic carries over unchanged)
3. Inserts a `messages` row in Convex (user turn)
4. Fetches recent thread context (existing `fetch-thread-context` logic carries over)
5. Calls dispatcher (`handleUserMessage`) which may spawn executors; executor may call `inngest.send` to dispatch a workflow + write `inflightWorkflows` row
6. Streams agent text back to Slack (existing chunking + markdown conversion)
7. Inserts a `messages` row (assistant turn) on completion

The interruption pattern shipped 2026-04-04 (`src/lib/streams.ts`) keeps working — it's already in-process and unrelated to Inngest.

**Why move the agent loop off Inngest** (while keeping pipelines on Inngest): the agent loop is single-process by nature (Claude SDK subprocess, in-process abort controller, Bolt's WebSocket-style socket-mode connection). It never benefited from Inngest's durability — a server restart kills the SDK subprocess regardless. Removing the Inngest hop saves ~50ms per turn and eliminates one source of state spread (handle-message session vs Bolt session vs Inngest event). The pipelines, by contrast, are exactly the kind of multi-step, retry-able, sometimes-long-running work Inngest is designed for.

## Bolt and Slack layer

Carries over from existing kos-agent largely unchanged:

- `src/bolt/listeners/message.ts` — listens for `app_mention` and `message` events, calls `abort(sessionKey)`, then directly invokes the dispatcher (no `inngest.send()`)
- `src/lib/channels.ts` — user allowlist + notify channel
- `src/lib/slack.ts` — Slack Web API client
- `src/lib/streams.ts` — abort registry

## Debug UI

Port Boop's `debug/` directory (`/Users/kyrelldixon/projects/boop-agent/debug/`):

- React + Vite + Tailwind v4
- Subscribes to Convex via the Convex React client
- Built artifact served by Hono on `/debug` route (no separate hosting needed)
- Tabs to keep: **Dashboard** (cost + token totals + agent counts), **Agents** (timeline of executions), **Memory** (table view; skip force-directed graph since no memoryRecords), **Events** (raw `memoryEvents` stream), **Captures** (new — list of `captures` and `voiceMemos` with vault links)
- Tabs to drop initially: **Connections** (no Composio), **Automations** (no automations table), **Memory graph view**

Reachable at `https://kos.kyrelldixon.com/debug` via existing CF Tunnel + CF Access (Access protects the route; only the user can see it).

## Dev workflow

Build locally, deploy to Mac Mini.

```bash
# Laptop — first-time
git clone <repo>
cd kos-agent
bun install
bunx convex dev          # creates a dev Convex deployment, writes CONVEX_URL
varlock run -- bun --hot src/index.ts   # boots agent against dev Convex

# Laptop — daily dev loop
varlock run -- bun --hot src/index.ts

# Stopping prod (so Slack events route to local during dev)
ssh mac-mini "sudo launchctl bootout system/com.kyrelldixon.kos-agent"

# Resuming prod
ssh mac-mini "sudo launchctl bootstrap system /Library/LaunchDaemons/com.kyrelldixon.kos-agent.plist"
```

Dev uses a separate Convex deployment from prod. `bunx convex dev` creates a per-developer dev project; `bunx convex deploy` pushes schema + functions to the prod deployment. Both share the same source code in `convex/`.

## Deploy workflow

Existing GitHub-webhook + `deploy.sh` flow (already working) handles agent code:

```
git push → GitHub webhook → Mac Mini hooks route → deploy.sh
  ├─ git pull
  ├─ bun install
  ├─ bunx convex deploy   ← NEW: push Convex schema/functions to prod
  └─ touch /tmp/kos-agent-restart-trigger   ← existing restart mechanism
```

Convex deployments are atomic on Convex's side, so a deploy that updates both schema and code stays consistent.

## Portability story

The architecture runs anywhere with Bun + internet:

| Host | Process manager | Vault location | Inbound URL |
|---|---|---|---|
| Mac Mini (today) | launchd plist | `~/kyrell-os-vault/` | CF Tunnel + CF Access |
| Linux server (future) | systemd unit | `~/vault/` (configurable) | CF Tunnel or Caddy + Let's Encrypt |
| Cloud VM (clients) | systemd unit | configurable | Provider's HTTPS or CF Tunnel |
| Laptop (dev) | foreground process | configurable | not exposed (socket mode for Slack) |

Host-specific bits abstracted via env vars: `VAULT_PATH`, `CONVEX_URL`, `INBOUND_HOST`. Everything else is universal.

**Cloudflare Workers / serverless explicitly ruled out.** The Claude Agent SDK runs the `claude` CLI as a subprocess, and vault writes target a local filesystem. Both require a real always-on host.

## Secrets model

Carries over from existing kos-agent:

- `varlock + 1Password` injects secrets at process start. Works on Mac Mini and any Linux box with `op` CLI.
- New secrets to add: `CONVEX_URL`, `CONVEX_DEPLOY_KEY` (for `bunx convex deploy` in CI/deploy.sh).
- Existing secrets stay: Slack creds, ElevenLabs key, Anthropic API key (optional, falls back to Claude Code subscription), Cloudflare keys for browser-rendering tier.
- **No secrets in Convex env vars.** Convex's runtime env is fine for non-sensitive config; sensitive values stay in 1Password.

## Observability — what becomes visible

After the port, the debug UI answers:

- **Per-conversation:** what messages, what agents got spawned, what tools each called, total cost.
- **Per-agent:** timeline of `agentLogs` rows showing `tool_use → tool_result → text` sequence.
- **Per-pipeline:** `captures` and `voiceMemos` tables show every run with status.
- **Cost over time:** `usageRecords` aggregated by source (dispatcher vs executor) and date.
- **Live updates:** Convex reactivity means the UI updates without polling — when an agent posts a tool call, the dashboard renders it immediately.

Slack history is no longer the system of record for "what did the agent do." It's just a chat interface.

## Migration sequence

Ordered so each phase ends in a working system. No big-bang cutover.

### Phase 1 — Stand up Convex (Day 1-2)

1. Create Convex project, add `convex/schema.ts` with the adopted tables (no new domain tables yet)
2. Add `bunx convex dev` to laptop workflow, verify schema deploys
3. Add `convex` package to kos-agent dependencies
4. Wire a minimal Convex client into `src/lib/`
5. Don't change any existing behavior — just make Convex available
6. Commit: "feat(convex): add Convex client + base schema"

### Phase 2 — Migrate sessions to Convex (Day 2-3)

1. Replace JSON-file `getSession`/`saveSession` (`src/lib/sessions.ts`) with Convex queries/mutations on `messages` + `conversations`
2. Backward compat: read from JSON files if Convex returns nothing, write to both temporarily
3. Verify thread context fetch + session resume still works (existing tests cover this)
4. Once confirmed stable for a few days, remove JSON-file fallback
5. Commit: "feat(sessions): move session state to Convex"

### Phase 3 — Refactor handle-message into dispatcher/executor (Day 3-5)

1. Split `src/inngest/functions/handle-message.ts` into:
   - `src/agent/dispatcher.ts` (the interaction agent — Slack message handler)
   - `src/agent/executor.ts` (the sub-agent runner)
2. Define the executor types (`capture-agent`, `voice-memo-agent`, `code-agent`, `general-agent`) with their tool surfaces
3. Add `agentLogs` writes during execution (every tool_use, tool_result, text)
4. Update Bolt listener to call dispatcher directly instead of `inngest.send()`
5. Keep stream registry (`src/lib/streams.ts`) and abort behavior unchanged
6. Verify: Slack DM → dispatcher → executor → reply works end-to-end
7. Commit: "feat(agent): dispatcher/executor split with Convex agent logging"

### Phase 4 — Port debug UI (Day 5-6)

1. Copy `debug/` directory from `/Users/kyrelldixon/projects/boop-agent/debug/` into kos-agent
2. Adapt for our schema (drop Connections, Automations, Memory graph; add Captures tab)
3. Wire Convex client to our deployment
4. Build into Hono static route on `/debug`
5. Add CF Access protection for the route (probably already in place at the domain level)
6. Verify: open `https://kos.kyrelldixon.com/debug`, see live agent activity
7. Commit: "feat(debug): real-time debug dashboard"

### Phase 5 — Migrate Inngest self-hosted to Cloud (Day 6)

Per the existing migration plan in the other thread, with the three pre-flight items I added (kos CLI env, deploy.sh varlock, smoke-test event name). Self-contained, doesn't depend on Phases 1-4. Could even run earlier, but lands cleanest after the agent layer is on Convex so the `inflightWorkflows` writes work end-to-end.

1. Sign up Inngest Cloud, copy keys to 1Password
2. Pre-flight checks (kos CLI grep, deploy.sh varlock, smoke-test event name, function inventory)
3. Update varlock schema with `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY`
4. Backup plist, remove `INNGEST_DEV=1` from kos-agent plist
5. CF Access bypass for `/api/inngest`
6. Sync clock, bootout self-hosted Inngest, restart kos-agent, sync Inngest Cloud
7. Smoke test + Slack DM verification + capture verification
8. Cleanup: delete self-hosted Inngest plist, drop `inngest.kyrelldixon.com` tunnel hostname

### Phase 6 — Update CLAUDE.md and ARCHITECTURE.md (Day 6)

1. Document the new two-plane architecture in `CLAUDE.md` (Inngest = workflows, Convex = state/agent observability, dispatcher/executor split)
2. Update Inngest section to reflect Cloud (not self-hosted) and that the agent loop runs in-process
3. Reflect the change in any of `docs/agent-system-exploration/ARCHITECTURE.md` decisions that are now decided
4. Commit: "docs: update architecture for Convex + Inngest Cloud restructure"

Total: ~6 days of focused work, end-to-end. Each phase ends in a working system, so the work can be paused between phases.

## Risks

### Convex schema migration churn

The schema is going to change as we discover what queries the debug UI actually wants. Convex handles schema migrations gracefully (dev deployments rebuild instantly; prod requires a migration). Mitigation: stay on dev Convex until Phase 4 ships UI; only `bunx convex deploy` to prod after Phase 4 is solid.

### Pipeline durability — covered by Inngest

Mid-pipeline crashes (Mac Mini restart during a tier-2 extraction or an ElevenLabs call) are handled by Inngest's step replay — when the function resumes after a transient failure, completed steps are skipped. This is the property we'd lose if we ripped Inngest out, and a key reason it's staying.

### Triage durability — covered by Inngest

Capture triage uses `step.waitForEvent` with a 4h timeout. If the Mac Mini restarts during the wait, Inngest holds the suspended state on its side; the function resumes when the user clicks the triage button. This too is a property we'd lose with plain async.

### Convex outage

If Convex is down, the agent stops working — sessions, dispatcher state, executor logs all live there. Mitigation: Convex's uptime is good in practice; if we hit pain, add a degraded-mode that falls back to in-memory state for the duration. Don't pre-build.

### Boop license + upgrade path

Boop is MIT-licensed, so porting code is fine. But we're not forking — we're copying patterns and specific files (debug UI). When Boop ships upgrades, we don't get them automatically. Mitigation: maintain a file at `docs/boop-port-attribution.md` listing each copied file, the source path in `/Users/kyrelldixon/projects/boop-agent/`, and the commit hash at port time. When we want upstream changes, we diff against current Boop and pull what's relevant.

### "Always-on" lock-in

The architecture commits us to running an always-on process. If we ever want serverless, we'd have to redesign. Mitigation: vault-on-disk and Claude-Agent-SDK-subprocess constraints already require this; not a new lock-in. Document explicitly so future-us doesn't try to go serverless without realizing the constraints.

## Out of scope (revisit later)

- Memory consolidation (Boop's adversarial pipeline)
- Composio integrations
- Multi-user / client deployment
- Mini-PaaS for vibecoded apps
- Cold-email enrichment / SEO content gen workflows (built later as additional Inngest functions)
- exe.dev migration
- WorkflowKit / AgentKit
- Vector recall (substring is enough until it isn't)
- iOS app interface
- Cross-system correlation tables (`captures`, `voiceMemos`, `vaultNotes`) — only `inflightWorkflows` is in scope

## Open questions

- **Should `kos capture` CLI talk to Convex directly or to Hono?** Current proposal: Hono. Simpler — the CLI doesn't need a Convex client. Hono routes are stable per varlock.
- **Where does the dispatcher's recall query the vault?** A separate `vault-search` tool that greps the vault on disk, or a Convex query against `vaultNotes`. Probably both — vault grep for content, Convex for metadata/structure.
- **How are dev and prod Convex deployments distinguished in code?** Standard Convex pattern: `CONVEX_URL` env var differs per environment. No code changes.
- **Do we need Bun-specific Convex client adjustments?** Convex officially supports Node 20+; Bun is mostly Node-compatible but worth verifying the Convex client works without quirks during Phase 1.

## Files to be created

- `src/agent/dispatcher.ts`
- `src/agent/executor.ts`
- `src/lib/convex.ts` (Convex client wrapper)
- `convex/schema.ts`
- `convex/messages.ts`
- `convex/conversations.ts`
- `convex/executionAgents.ts`
- `convex/agentLogs.ts`
- `convex/usageRecords.ts`
- `convex/inflightWorkflows.ts`
- `convex/drafts.ts`
- `convex/memoryRecords.ts` (simplified — content + tags only)
- `convex/memoryEvents.ts`
- `convex/settings.ts`
- `debug/` (ported from `/Users/kyrelldixon/projects/boop-agent/debug/`)
- `docs/boop-port-attribution.md` (file paths + commit hashes for ported Boop code)

## Files to be deleted

- `src/inngest/functions/handle-message.ts` (Bolt calls dispatcher directly now)
- `ops/com.kyrelldixon.inngest-dev.plist` (replaced by Inngest Cloud)
- `/Library/LaunchDaemons/com.kyrelldixon.inngest-dev.plist` (on Mac Mini)
- Old session-file logic in `src/lib/sessions.ts` (after Phase 2 stable)
- `inngest.kyrelldixon.com` hostname in `~/.cloudflared/config.yml` (on Mac Mini)

## Files to be modified

- `src/index.ts` — wire Convex client; Inngest serve handler stays
- `src/bolt/listeners/message.ts` — call dispatcher directly instead of `inngest.send()` for `agent.message.received`; capture/voice-memo events still go via Inngest
- `src/lib/sessions.ts` — replace with Convex-backed equivalents
- `src/agent/session.ts` — adapt to Convex
- `package.json` — add `convex`; **keep `inngest`**
- `.env.schema` — add `CONVEX_URL`, `CONVEX_DEPLOY_KEY`, `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`
- `scripts/deploy.sh` — add `bunx convex deploy` step
- `CLAUDE.md` — update architecture section to reflect two-plane split

## Files unchanged

- `src/inngest/functions/handle-capture.ts`
- `src/inngest/functions/handle-voice-memo.ts`
- `src/inngest/functions/extract-jina.ts`, `extract-local.ts`, `extract-cf-browser.ts`, `transcribe-elevenlabs.ts`
- `src/capture/` (extractors, vault writer, templates, schema)
- `src/voice-memo/` (templates)
- `src/lib/streams.ts` (interruption — already in-process)
- Existing varlock setup, CF Tunnel config, deploy.sh shell mechanics
