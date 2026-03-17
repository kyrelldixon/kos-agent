# Capture Pipeline v2 — Extraction Reliability & Notifications

**Status:** Draft
**Date:** 2026-03-17
**Linear:** KYR-102 (follow-up)
**Builds on:** `2026-03-16-capture-pipeline-design.md`

## Problem

The capture pipeline (KYR-102) is deployed and working end-to-end, but has three categories of issues:

1. **Article extraction returns raw HTML.** The pipeline depends on CF Browser Rendering for markdown conversion, but the env vars (`CF_ACCOUNT_ID`, `CF_API_TOKEN`) aren't configured. The fetch fallback returns raw HTML. This affects both article captures and HN captures (which call the article extractor for linked articles).

2. **Extraction failures are silent.** When content extraction fails entirely, nothing distinguishes a failed capture from a successful one. The vault note gets written with garbage content, and the Slack notification looks the same.

3. **Slack notifications are noisy and unhelpful.** Notifications show content type labels (`article · full capture →`) that add no value, and lack any indication of what was actually captured.

## Goals

- Reliable markdown extraction for articles and HN-linked content
- Each extraction method independently observable, rate-limited, and retriable
- Clear failure handling — never silently write bad content
- Slack notifications that tell you what was captured, not how
- GitHub repo capture — clone locally + vault reference note
- Documentation for operating and extending the capture pipeline

## Non-Goals

- Twitter extraction (stays as placeholder — needs agent-browser, separate effort)
- CF Browser Rendering env setup (optional premium tier, add later)
- YouTube channel fan-out testing (depends on yt-dlp install)
- Chrome extension or new trigger sources

## Design

### 1. Three-Tier Extraction as Separate Inngest Functions

Each extraction tier becomes its own Inngest function with independent throttle, retry, and error handling. The orchestrator (`handle-capture`) calls them via `step.invoke()` with a try/catch fallback chain.

#### Tier 1: Jina Reader API

**Function:** `jinaExtraction` in `src/inngest/functions/extract-jina.ts`

```typescript
inngest.createFunction({
  id: "jina-extraction",
  throttle: { limit: 18, period: "1m" },
  retries: 1,
})
```

- Fetches `https://r.jina.ai/{url}`, returns clean markdown
- Free tier: 20 RPM, 100K tokens/min, no API key needed
- Throttled to 18/min to leave headroom
- Timeout: 30s via `step.invoke()` caller

#### Tier 2: Local Extraction (Readability + node-html-markdown)

**Function:** `localExtraction` in `src/inngest/functions/extract-local.ts`

```typescript
inngest.createFunction({
  id: "local-extraction",
  retries: 1,
})
```

- Fetches raw HTML, pipes through `@mozilla/readability` (strips boilerplate/nav/ads) then `node-html-markdown` (converts to markdown)
- No external API dependency, no throttle needed
- Requires `jsdom` for Readability's DOM requirement
- Timeout: 30s via `step.invoke()` caller

#### Tier 3: CF Browser Rendering (optional)

**Function:** `cfBrowserExtraction` in `src/inngest/functions/extract-cf-browser.ts`

```typescript
inngest.createFunction({
  id: "cf-browser-extraction",
  retries: 1,
})
```

- Existing CF Browser Rendering logic, moved from `src/capture/extract/article.ts` into its own function
- Only invoked when `CF_ACCOUNT_ID` and `CF_API_TOKEN` are set — orchestrator skips this tier entirely if env vars are missing
- Best for JS-heavy SPAs that defeat Jina and local fetch
- Timeout: 60s via `step.invoke()` caller

#### Orchestrator Fallback Chain

In `handle-capture`, the `extract-content` step is replaced with sequential `step.invoke()` calls:

```typescript
let content = "";
let extractionMethod = "none";

// Tier 1: Jina
try {
  const result = await step.invoke("tier-1-jina", {
    function: jinaExtraction,
    url,
    timeout: "30s",
  });
  content = result.content;
  extractionMethod = "jina";
} catch {}

// Tier 2: Local (only if Jina failed or returned low-quality content)
if (!content || !checkContentQuality(content)) {
  content = "";
  try {
    const result = await step.invoke("tier-2-local", {
      function: localExtraction,
      url,
      timeout: "30s",
    });
    content = result.content;
    extractionMethod = "local";
  } catch {}
}

// Tier 3: CF Browser (only if local failed AND keys configured)
if (
  (!content || !checkContentQuality(content)) &&
  process.env.CF_ACCOUNT_ID &&
  process.env.CF_API_TOKEN
) {
  content = "";
  try {
    const result = await step.invoke("tier-3-cf-browser", {
      function: cfBrowserExtraction,
      url,
      timeout: "60s",
    });
    content = result.content;
    extractionMethod = "cf-browser";
  } catch {}
}
```

**Note:** `checkContentQuality()` is used between tiers to catch cases where a tier returns a 200 but with garbage content (cookie walls, "JavaScript required" notices, nav-only boilerplate). This prevents a tier from "succeeding" with useless content and blocking the next tier from trying.

Non-article content types (YouTube, GitHub repo, file, twitter) bypass the tiered chain and use their existing extractors directly.

#### New Dependencies

- `@mozilla/readability` — article content extraction (same algo as Firefox Reader View)
- `node-html-markdown` — HTML to markdown conversion
- `jsdom` — DOM implementation for Readability

#### Event Schema

Each extraction function needs an invoke trigger. The invoke payload is spread at the top level alongside `function` and `timeout` (no `data` wrapper):

```typescript
// Invoke trigger schema for each extraction function
z.object({ url: z.string() })

// Called as:
step.invoke("tier-1-jina", {
  function: jinaExtraction,
  url: "https://example.com",  // spread at top level, not nested in data
  timeout: "30s",
})
```

Return type for all three:

```typescript
{ content: string }  // markdown content, or empty string on failure
```

### 2. Extraction Failure Handling

When all tiers fail (or content is empty after all attempts):

- **Vault note still written** with metadata (title, author, URL, date) but no body content
- **Frontmatter `status` set to `extraction-failed`** instead of `raw`
- **Slack notification uses failure format** (see section 4)
- **Nothing silently dropped** — you can search your vault for `status: extraction-failed` to find notes needing manual processing

The quality check step already exists. When it detects insufficient content AND all tiers have been exhausted, it sets a flag that flows through to the vault writer and notifier.

### 3. Summary Generation — Agent Responsibility, Not Pipeline

Summaries are **not** generated inside the Inngest pipeline. The pipeline handles mechanical extraction only.

**Agent-triggered captures** (Slack bot):
- The agent calls `kos capture` via CLI
- The pipeline extracts content and writes the vault note
- The agent reads the result, generates a summary natively (it IS an LLM), and can update the vault note's `summary` frontmatter field
- The agent posts its own Slack notification with context-appropriate messaging
- No separate LLM API key needed

**CLI-triggered captures** (user in terminal):
- The pipeline extracts content and writes the vault note
- `metadata.description` is used as the summary fallback in the vault note
- The Inngest function posts a Slack notification (see section 4)

This means the `summary` frontmatter field is populated in two ways:
1. By the agent after capture (richer, context-aware)
2. By the pipeline using `metadata.description` (simple fallback for CLI-triggered captures)

### 4. Slack Notification Redesign

Notifications are **conditional on source**:

- **CLI-triggered** (`source === "cli"`) → Inngest function posts notification
- **Agent-triggered** (`source === "slack"`) → agent handles its own notification, Inngest skips the notify step

```typescript
if (source === "cli") {
  await step.run("notify", async () => { ... });
}
```

**CLI notification format (success):**

```
*Title*
metadata description
URL → vault path
```

**CLI notification format (failure):**

```
*Failed: Title*
Could not extract content — metadata saved, needs manual processing
URL → vault path
```

Changes to `src/capture/notify.ts`:

- `buildNotificationMessage()` takes an optional `failed` boolean
- Drop the `type · mode →` labeling
- Use `metadata.description` as the summary line
- Full URL and full vault path (no truncation)

The `NotificationInput` interface becomes:

```typescript
interface NotificationInput {
  title: string;
  url?: string;
  notePath: string;
  description: string;
  failed?: boolean;
}
```

### 5. Vault Notes — Obsidian Templates, Not Hardcoded Rendering

**The current `src/capture/vault/templates.ts` hardcodes note formats in TypeScript. This is wrong.** Note formats belong in the Obsidian vault as templates, not in application code.

#### New Obsidian Templates

Create these templates in `~/kyrell-os-vault/templates/`:

**Article Source Template:**
```yaml
---
categories:
  - "[[Sources]]"
author: []
url:
created: "{{date:MM-DD-YYYY}}"
published:
topics: []
status: raw
source_type: article
extraction_method:
---
```

**YouTube Video Source Template:**
```yaml
---
categories:
  - "[[Sources]]"
author: []
url:
created: "{{date:MM-DD-YYYY}}"
published:
topics: []
status: raw
source_type: youtube-video
channel:
duration:
views:
extraction_method:
---
```

**Hacker News Source Template:**
```yaml
---
categories:
  - "[[Sources]]"
author: []
url:
created: "{{date:MM-DD-YYYY}}"
topics: []
status: raw
source_type: hacker-news
hn_url:
hn_points:
hn_comments:
extraction_method:
---
```

**GitHub Repo Source Template:**
```yaml
---
categories:
  - "[[Sources]]"
url:
created: "{{date:MM-DD-YYYY}}"
topics: []
status: raw
source_type: github-repo
stars:
language:
license:
local_path:
---
```

**File Source Template:**
```yaml
---
categories:
  - "[[Sources]]"
created: "{{date:MM-DD-YYYY}}"
topics: []
status: raw
source_type: file
file_path:
---
```

**YouTube Channel Template:**
```yaml
---
categories:
  - "[[YouTube Channels]]"
youtube_url:
created: "{{date:MM-DD-YYYY}}"
topics: []
---

## Videos

![[Sources.base#Author]]
```

Note: YouTube channels are entities, not people. The existing YouTuber Template stays for the person. A channel can have multiple YouTubers and a YouTuber can have multiple channels.

#### Summary Goes in Body Content, Not Frontmatter

Summaries, descriptions, and analysis are body content — they're human-readable narrative, not structured metadata.

```markdown
---
(frontmatter fields)
---

# Article Title

Short summary or description goes here as the first paragraph.

---

Full extracted content below...
```

#### Pipeline Changes

Refactor `src/capture/vault/templates.ts` → `src/capture/vault/writer.ts`:

1. **Read the template** from the vault's `templates/` directory (or use `obsidian create` with `template=` when Obsidian is running)
2. **Populate frontmatter** using `obsidian property:set` or by parsing/writing YAML directly as a fallback
3. **Append body content** — summary line + extracted content
4. **Set `status: extraction-failed`** when content extraction failed (via `property:set`)

The `renderVaultNote()` function is replaced with a template-based approach that reads the format from Obsidian, not from TypeScript.

**`extraction_method`** tracks which tier succeeded (`jina`, `local`, `cf-browser`, or `none`) — useful for debugging quality issues.

**`status` values:**
- `raw` — successfully captured, not yet processed
- `extraction-failed` — metadata saved, content needs manual processing

### 6. GitHub Repo Capture — New Content Type

**Type detection:** `github.com/{owner}/{repo}` URLs → `github-repo` type

Added to `src/capture/detect-type.ts`.

#### Extraction

**Metadata** via GitHub API (`api.github.com/repos/{owner}/{repo}`):
- Description, stars, language, topics, license
- Last commit date, default branch
- No auth needed for public repos (60 req/hr unauthenticated, 5K/hr with token)

**Content extraction:**
- Clone repo to `{clone_path}/{repo}` (default `~/projects/`, configurable via `kos config set clone_path`)
- If already cloned (directory exists with same remote), `git pull` to update instead
- Read `README.md` from the cloned repo for AI summary input

**Vault note** uses the GitHub Repo Source Template (see section 5). Body content includes the repo description and space for notes — the cloned repo is the actual content, the vault note is a reference card.

#### Config

New config key: `clone_path`
- Default: `~/projects/`
- Set via: `kos config set clone_path /some/other/dir`
- Used by the GitHub repo extractor to determine where to clone

#### Implementation Files

- `src/capture/extract/github.ts` — New. Clone/pull logic + GitHub API metadata fetch
- `src/capture/extract/metadata.ts` — Add `github-repo` case for metadata extraction
- `src/capture/detect-type.ts` — Add `github.com` URL detection
- `src/capture/schema.ts` — Add `"github-repo"` to `ContentType` union
- `src/capture/vault/templates.ts` — Add `github-repo` vault note template

### 7. YouTube — yt-dlp

`brew install yt-dlp` on the Mac Mini server. No code changes needed — the shell-out logic in `src/capture/extract/youtube.ts` already exists.

### 8. HN Linked Article Extraction

`extractHNContent()` in `hacker-news.ts` calls `extractArticleContent()` to fetch the linked article. Post-refactor, `article.ts` retains a thin `extractArticleContent(url)` function that calls the tiered extraction chain via `step.invoke()`. However, since HN extraction runs inside an Inngest step already, the HN extractor cannot call `step.invoke()` directly (steps don't nest).

**Solution:** The HN content extraction step in `handle-capture` is refactored to:
1. Use the HN Algolia API for metadata and comments (unchanged)
2. Run the tiered extraction chain for the linked article URL as separate `step.invoke()` calls in the orchestrator, before the HN formatting step

This means HN captures get the same Jina → local → CF fallback chain for the linked article.

### 9. Quality Check Update

The current `checkContentQuality()` strips HTML tags to measure content length. Post-refactor, extraction tiers return markdown, not HTML. Update the quality check to work with both formats — strip markdown formatting (headings, links, emphasis) in addition to HTML tags when measuring content length.

### 10. Agent Awareness — Teach the Agent Its Capabilities

The agent's system prompt (`src/agent/session.ts`) currently only knows about scheduled jobs and Slack context. It has no idea it can capture URLs, create vault notes, or process content. The agent needs to know about:

**Update `buildSystemAppend()` in `src/agent/session.ts`** to add a Capture section:

```typescript
lines.push(
  "",
  "## Content Capture",
  "Capture URLs and content into the Obsidian vault using the kos CLI.",
  "",
  "Commands:",
  "kos capture <url> --quick          # Quick save: metadata only",
  "kos capture <url> --full           # Full capture: extract content",
  "kos capture <url>                  # Triage: Slack buttons to decide",
  "kos capture --batch-file urls.txt  # Batch capture from file",
  "kos capture --file /path/to/doc    # Capture a local file",
  "",
  "Content types (auto-detected): article, youtube-video, youtube-channel, hacker-news, github-repo",
  "",
  "After capturing, you can:",
  "- Read the vault note with: obsidian read file=\"Title\"",
  "- Add a summary: obsidian append file=\"Title\" content=\"Summary text\"",
  "- Update properties: obsidian property:set name=status value=done file=\"Title\"",
  "- Create notes from templates: obsidian create name=\"Title\" template=\"Template Name\"",
  "",
  "When someone shares a URL in Slack, consider whether to capture it.",
  "After capturing, read the extracted content and provide a useful summary.",
);
```

This gives the agent the knowledge to:
- Capture URLs proactively when shared in Slack
- Use the right mode (quick/full/triage) based on context
- Post-process captures (read content, generate summaries, update notes)
- Use the Obsidian CLI to create and manage vault notes

### 11. Documentation

**Project skill:** `.claude/skills/capture-pipeline/SKILL.md`

Covers:
- Content types and how each is extracted
- Three-tier extraction strategy with Inngest function architecture
- CLI usage: `kos capture` flags, modes, batch capture
- Env vars: required vs optional, what each controls
- Failure modes and how to diagnose (check Inngest dashboard by tier)
- Testing commands for each content type
- Known limitations (Twitter placeholder, yt-dlp dependency)

**README updates:**

- Prerequisites section: Node/Bun, yt-dlp, required env vars
- Quick start for getting the agent running locally
- Brief capture pipeline description with link to skill for details

## File Changes Summary

| File | Change |
|------|--------|
| `src/inngest/functions/extract-jina.ts` | New — Jina extraction function |
| `src/inngest/functions/extract-local.ts` | New — Readability + node-html-markdown function |
| `src/inngest/functions/extract-cf-browser.ts` | New — CF Browser Rendering function (moved from article.ts) |
| `src/inngest/functions/handle-capture.ts` | Refactor — tiered `step.invoke()` chain, conditional notify, failure handling |
| `src/inngest/client.ts` | Add invoke triggers for extraction functions |
| `src/capture/extract/article.ts` | Retain thin `extractArticleContent()` for internal callers; extraction logic moved to Inngest functions |
| `src/capture/extract/hacker-news.ts` | Refactor — linked article extraction moved to orchestrator's tiered chain |
| `src/capture/extract/github.ts` | New — clone/pull + GitHub API metadata |
| `src/capture/detect-type.ts` | Add `github.com` URL detection |
| `src/capture/schema.ts` | Add `github-repo` to ContentType union |
| `src/capture/notify.ts` | Redesign — clean format, failure format, drop type/mode labels |
| `src/capture/vault/templates.ts` | Replace hardcoded rendering with template-based approach |
| `~/kyrell-os-vault/templates/` | New templates: Article Source, YouTube Video Source, HN Source, GitHub Repo Source, File Source, YouTube Channel |
| `src/capture/extract/quality.ts` | Wire failure flag for downstream use |
| `.claude/skills/capture-pipeline/SKILL.md` | New — operational documentation skill |
| `README.md` | Update — prerequisites, quick start, capture overview |
| `src/agent/session.ts` | Add capture pipeline and Obsidian capabilities to agent system prompt |
| `src/index.ts` | Register new extraction functions with Inngest serve handler |
| `package.json` | Add `@mozilla/readability`, `node-html-markdown`, `jsdom` |
