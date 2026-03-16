# Capture Pipeline Design

**Status:** Draft
**Date:** 2026-03-16
**Linear:** KYR-102

## Problem

Too many browser tabs accumulating rich content (articles, YouTube videos, HN links, tweets) with no systematic way to capture them into the knowledge vault. Content gets lost when tabs are closed or forgotten. Need a fast, reliable pipeline that gets URLs into Obsidian immediately so tabs can be closed, with optional deeper processing later.

## Goals

- Capture any URL into the vault as a source note with metadata — close the tab, content is safe
- Support multiple content types with type-appropriate extraction
- Support local file paths as input (Claude Code conversations, docs)
- Human-in-the-loop triage before expensive operations (transcripts)
- Bulk capture for clearing out large numbers of tabs
- Parallel processing — multiple captures run concurrently
- Extensible for future AI processing passes without rearchitecting

## Non-Goals

- Monitoring/recurring URL checks (separate concern, uses jobs system)
- AI-powered summarization or content processing in v1
- Chrome extension (future trigger, same pipeline)
- Content creation from captured sources (downstream of capture)

## Prerequisites

- `yt-dlp` must be installed on the Mac Mini for YouTube transcript extraction. Install via `brew install yt-dlp`.
- Cloudflare Browser Rendering API access (existing Cloudflare account).
- Agent-browser skill available for authenticated browser scraping.

## Content Types

| Type | URL Detection | Quick Capture | Full Capture |
|------|--------------|---------------|--------------|
| **article** | Default for any URL | Title, meta description, author | Full article markdown via CF Browser Rendering |
| **youtube-video** | `youtube.com/watch`, `youtu.be/` | Title, channel, duration, view count, description | Full transcript via yt-dlp subtitle extraction |
| **youtube-channel** | `youtube.com/@`, `youtube.com/c/` | Channel name, subscriber count, recent video titles | Channel profile + fan-out to capture recent videos (capped at 10) |
| **hacker-news** | `news.ycombinator.com` | Title, points, comment count | Linked article content + top HN comments |
| **twitter** | `x.com/`, `twitter.com/` | Tweet text preview | Full tweet/thread via browser scraping (always browser-first, API too expensive) |
| **file** | Local file path (not a URL) | N/A — files always do full capture | Read file content directly |

## Architecture

### Event Schema

All capture events include a `captureKey` field computed at emission time. This is the dedup key for singleton behavior.

```typescript
// URL capture
"agent.capture.requested": {
  captureKey: string              // computed: the URL itself
  url: string
  type?: "article" | "youtube-video" | "youtube-channel" | "hacker-news" | "twitter"
  source: "slack" | "cli" | "extension"
  destination?: { chatId: string; threadId?: string }  // job-style destination (no messageId)
  batchId?: string
  parentCaptureId?: string        // set when fanned out from a youtube-channel capture
  mode?: "full" | "quick" | "triage"  // default: "triage"
}

// Local file capture — always full mode, no triage
"agent.capture.file.requested": {
  captureKey: string              // computed: "file://" + absolute path
  filePath: string
  title?: string
  source: "slack" | "cli"
  destination?: { chatId: string; threadId?: string }
}

// Human decision response (from Slack button click)
"agent.capture.decision": {
  captureId: string               // matches the Inngest function run ID
  action: "full" | "quick-save" | "skip"
}
```

**Destination schema note:** Capture events use the job-style destination shape `{ chatId, threadId? }`, not the message destination shape `{ chatId, threadId, messageId }`. Captures generate their own messages rather than replying to existing ones.

### API Endpoint

New route: `POST /api/capture`

```typescript
// Request body
{
  urls?: string[]                 // one or more URLs to capture
  filePath?: string               // local file path (mutually exclusive with urls)
  mode?: "full" | "quick" | "triage"  // default: "triage"
  type?: string                   // force content type detection
  title?: string                  // override title (file captures)
}

// Response
{
  captured: Array<{
    captureKey: string
    url?: string
    filePath?: string
    type: string
    mode: string
  }>
}
```

The endpoint validates input, emits `agent.capture.requested` or `agent.capture.file.requested` events to Inngest for each URL/file, and returns immediately. Processing is async.

This follows the existing pattern: CLI → HTTP API → Inngest event. No auth required (localhost-bound, same as jobs API).

### Inngest Function: `handle-capture`

```
Triggers: [agent.capture.requested, agent.capture.file.requested]
Singleton: { key: "event.data.captureKey", mode: "cancel" }
Timeout: 10 minutes
Retries: 2
```

#### Steps — Direct Mode (full or quick)

When `mode` is `"full"` or `"quick"`, or for file captures:

```
1. detect-type           — classify from URL patterns (or file extension for files)
2. extract-metadata  ─┐
3. extract-content   ─┘  parallel via Promise.all (see note on retries below)
4. check-quality         — if extraction returned < 200 chars of meaningful text
                           (excluding nav/footer), retry with agent-browser.
                           Twitter: always browser-first, skip quality check.
                           Quick mode: skip this step entirely.
5. write-vault-note      — write note to sources/ (see Vault Note Structure)
6. cleanup               — best-effort removal of ~/.kos/agent/captures/{captureId}/
                           (separate step; failure does not affect the written note)
7. notify                — post to configured notify channel
```

**Parallel step retry note:** If one step in the `Promise.all` fails, Inngest retries the function. Completed steps return memoized results on replay — they are not re-executed. Both extraction steps should be idempotent.

#### Steps — Triage Mode

When `mode` is `"triage"` (default for URL captures):

```
1. detect-type
2. quick-triage          — FREE: fetch page title, description, meta tags only.
                           Reuses the same extraction code as extract-metadata.
3. post-triage-prompt    — Slack message with interactive buttons to notify channel
4. wait-for-decision     — step.waitForEvent("agent.capture.decision", {
                             timeout: "4h",
                             if: `async.data.captureId == "${runId}"`
                           })
                           Timeout → auto quick-save (URL is never lost)
                           Skip → return early
                           Quick-save → write vault note with triage metadata only (skip extraction)
                           Full → continue to full extraction below
5. extract-content       — full extraction (metadata already gathered in step 2, reused)
6. check-quality         — same as direct mode
7. write-vault-note
8. cleanup
9. notify
```

**Slack action handler:** A new Slack action handler (`capture_decision`) must be registered in `src/bolt/listeners/actions.ts`. When a triage button is clicked, it emits an `agent.capture.decision` event to Inngest with the `captureId` (function run ID) and the chosen action. This bridges Slack interactive buttons to the `step.waitForEvent()` call.

#### Triage Slack Prompt Format

```
📎 YouTube Video: "How I Built My Personal AI System"
   Channel: Daniel Miessler · 45 min · 120K views

   → Full capture (transcript + metadata)
   → Quick save (just link + metadata)
   → Skip
```

### Inngest Patterns Used

| Pattern | Where | Why |
|---------|-------|-----|
| **Fan-out** | YouTube channel → N video captures (max 10) | One channel capture emits N `agent.capture.requested` events via `step.sendEvent()`. Each video processes independently. If one fails, others succeed. |
| **Parallel steps** | Metadata + content extraction | `Promise.all([step.run("extract-metadata", ...), step.run("extract-content", ...)])`. Completed steps are memoized on retry. |
| **step.sendEvent()** | Fan-out + notifications | Maintains tracing context between chained functions |
| **Loops with unique step names** | Future multi-pass processing | `step.run("process-pass-${passNumber}", ...)` — architecture hook, not built in v1 |
| **Multiple triggers** | URL + file path capture | Single function handles both event types, distinguished by `event.name` |
| **Singleton** | Dedup same URL | `{ key: "event.data.captureKey" }` prevents duplicate captures |
| **step.waitForEvent()** | Human-in-the-loop triage | Pauses function until user responds via Slack buttons. 4h timeout → auto quick-save. |

### Extraction Methods

**Layer 1 — Primary extraction:**

| Type | Method |
|------|--------|
| **article** | Cloudflare Browser Rendering `/crawl` endpoint → markdown output |
| **youtube-video** | yt-dlp subtitle/auto-caption extraction for transcript. oEmbed/page meta for metadata. |
| **youtube-channel** | Page scrape for channel info, then fan-out up to 10 recent video capture events |
| **hacker-news** | HN Algolia API for discussion metadata + CF Browser Rendering for linked article |
| **twitter** | Agent-browser with authenticated session (primary method, not fallback) |
| **file** | Direct filesystem read |

**Layer 2 — Fallback (agent-browser):**

If primary extraction returns less than 200 characters of meaningful text (excluding navigation, headers, footers), automatically retry with agent-browser using an authenticated browser session. Twitter always uses agent-browser as its primary method, so this fallback does not apply to Twitter.

### Content Storage

Extracted content is written to disk at `~/.kos/agent/captures/{captureId}/` during processing, with file paths passed between Inngest steps. This avoids exceeding Inngest step output size limits for large content (full transcripts, long articles).

Cleanup is a separate best-effort step after the vault note is written. If cleanup fails, the capture directory remains but does not affect the written note. A periodic cleanup job could be added later to sweep stale capture directories.

### Idempotency

If the same URL is captured again (singleton dedup missed, or intentional re-capture):
- The pipeline checks if a source note with the same `url` frontmatter field already exists in `sources/`.
- If found: update the existing note's content and `capture_mode` field. Do not create a duplicate.
- If not found: create a new note as normal.

This check happens in the `write-vault-note` step by scanning frontmatter in the sources directory.

## Notification

All captures post a notification to a configured Slack channel. Configured via `notifyChannel` in `channels.json`.

**Configuration:** Add `notifyChannel` to the `ChannelsConfig` interface in `src/lib/channels.ts` and extend `updateConfig` to accept it. If `notifyChannel` is not configured, notifications are skipped (no default assumed — must be explicitly set during setup).

```json
// channels.json addition
{
  "notifyChannel": "C0XXXXXX"
}
```

| Trigger | Notification behavior |
|---------|----------------------|
| **Slack** (in a thread) | Reply in thread + post to notify channel |
| **CLI** | Post to notify channel only |
| **Extension** (future) | Post to notify channel only |

Notification format is lightweight: title, URL, content type, capture mode, vault note filename.

## CLI Interface

```bash
kos capture <url>                          # single capture, triage mode
kos capture <url1> <url2> <url3>           # batch, triage mode
kos capture <url> --full                   # skip triage, full capture
kos capture <url> --quick                  # skip triage, quick save only
kos capture <url> --type youtube-video     # force content type detection
kos capture --batch-file urls.txt          # file of URLs, one per line
kos capture --file /path/to/conversation   # capture a local file
```

**Batch file format (v1):** One URL per line. Comments start with `#`. The `--full` or `--quick` flag applies to all URLs in the batch. Per-URL mode overrides can be added later if needed.

```
# urls.txt
https://some-article.com/post
https://youtube.com/watch?v=abc123
https://news.ycombinator.com/item?id=12345
```

The CLI command POSTs to `POST /api/capture` with the parsed URLs and mode flag.

## Vault Note Structure

Notes are **written programmatically** by the capture pipeline — not via Obsidian's template insertion system (which only supports `{{title}}`, `{{date}}`, `{{time}}`). The note structure is defined in code.

**Source note frontmatter:**

```yaml
---
categories:
  - "[[Sources]]"
author: "[[Author Name]]"          # or [] if unknown
url: "https://..."
created: "[[03-16-2026]]"          # MM-DD-YYYY, zero-padded, backlinked
published:                          # original publish date if available
topics: []
status: raw
source_type: article                # article, youtube-video, hacker-news, twitter
capture_mode: full                  # full or quick
duration:                           # youtube only, omitted for other types
channel: "[[Channel Name]]"        # youtube only, omitted for other types
---

# Note Title

(content below)
```

**Content by type and mode:**

| Type | Quick | Full |
|------|-------|------|
| **article** | Meta description | Full article markdown |
| **youtube-video** | Video description | Full transcript with timestamps |
| **youtube-channel** | N/A (uses YouTuber note format) | N/A (uses YouTuber note format) |
| **hacker-news** | Title + points + comment count | Article content + top comments |
| **twitter** | Tweet text preview | Full thread text |

**YouTube channel notes** use the existing YouTuber Template format with `categories: ["[[YouTubers]]"]` and a `youtube_url` field. Individual videos captured via fan-out are Sources that backlink to the channel note via the `channel` field.

**Key conventions:**
- `categories: ["[[Sources]]"]` — matches Sources.base filter, appears in "To Process" view when `status: raw`
- Date format: `[[MM-DD-YYYY]]` zero-padded (matches vault convention from `{{date:MM-DD-YYYY}}`)
- Author field uses wikilinks: `"[[Author Name]]"` to auto-create people backlinks
- Conditional fields (duration, channel) are omitted entirely when not applicable, not left empty
- Note filename: the page title, sanitized for filesystem (no slashes, colons, etc.)

## Future Extension Points

These are explicitly out of scope for v1 but the architecture supports them cleanly:

- **AI processing passes**: New `agent.capture.process.requested` event triggers enrichment on existing source notes (raw quotes, backlinks, triage verdicts). Loop-based multi-pass with unique step names.
- **Monitoring**: Scheduled jobs that discover new URLs from blogs/feeds and emit `agent.capture.requested` events into the same pipeline.
- **Chrome extension**: POSTs to `POST /api/capture`, same event, same pipeline.
- **Batch triage UI**: Single Slack summary for large batches instead of individual triage prompts.
