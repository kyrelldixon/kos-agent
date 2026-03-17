# Capture Pipeline v2 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix article extraction (three-tier Jina → Readability → CF), add GitHub repo capture, redesign notifications, use Obsidian templates, and teach the agent its capture capabilities.

**Architecture:** Extract each tier into its own Inngest function with independent throttle/retry. Orchestrator calls them via `step.invoke()` with try/catch fallback. Vault notes use Obsidian templates from `~/kyrell-os-vault/templates/` instead of hardcoded TypeScript. Notifications are conditional on source (CLI vs agent).

**Tech Stack:** Inngest 4.0 (step.invoke), Jina Reader API, @mozilla/readability, node-html-markdown, jsdom, GitHub REST API, Obsidian CLI

**Spec:** `docs/superpowers/specs/2026-03-17-capture-pipeline-v2-design.md`

---

## File Structure

### New Files
- `src/inngest/functions/extract-jina.ts` — Jina Reader extraction function
- `src/inngest/functions/extract-local.ts` — Readability + node-html-markdown extraction function
- `src/inngest/functions/extract-cf-browser.ts` — CF Browser Rendering extraction function (moved from article.ts)
- `src/capture/extract/github.ts` — GitHub repo clone/pull + API metadata
- `.claude/skills/capture-pipeline/SKILL.md` — Operational documentation skill

### Modified Files
- `src/capture/schema.ts` — Add `github-repo` to ContentType
- `src/capture/detect-type.ts` — Add GitHub URL detection
- `src/inngest/client.ts` — Add invoke triggers for extraction functions
- `src/inngest/functions/handle-capture.ts` — Tiered step.invoke chain, conditional notify, failure handling, HN refactor
- `src/capture/extract/article.ts` — Simplify to thin wrapper (logic moved to Inngest functions)
- `src/capture/extract/hacker-news.ts` — Remove internal article extraction (moved to orchestrator)
- `src/capture/extract/quality.ts` — Support markdown content (not just HTML)
- `src/capture/notify.ts` — Clean notification format, failure format, conditional on source
- `src/capture/vault/templates.ts` — Replace hardcoded rendering with template-based approach
- `src/capture/vault/writer.ts` — Use Obsidian templates, summary in body content
- `src/agent/session.ts` — Add capture + Obsidian capabilities to system prompt
- `src/index.ts` — Register new extraction functions with Inngest serve handler
- `README.md` — Prerequisites, quick start, capture overview

### Vault Templates (created via Obsidian CLI)
- `~/kyrell-os-vault/templates/Article Source Template.md`
- `~/kyrell-os-vault/templates/YouTube Video Source Template.md`
- `~/kyrell-os-vault/templates/Hacker News Source Template.md`
- `~/kyrell-os-vault/templates/GitHub Repo Source Template.md`
- `~/kyrell-os-vault/templates/File Source Template.md`
- `~/kyrell-os-vault/templates/YouTube Channel Template.md`

---

## Chunk 1: Foundation — Dependencies, Schema, Type Detection

### Task 1: Install npm dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install dependencies**

Run: `cd /Users/kyrelldixon/projects/kos-agent && bun add @mozilla/readability node-html-markdown jsdom`

- [ ] **Step 2: Install type definitions**

Run: `bun add -d @types/jsdom`

- [ ] **Step 3: Verify typecheck passes**

Run: `bun run typecheck`
Expected: PASS (no new errors)

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lockb
git commit -m "deps: add readability, node-html-markdown, jsdom for local extraction"
```

### Task 2: Add `github-repo` to ContentType schema

**Files:**
- Modify: `src/capture/schema.ts`

- [ ] **Step 1: Write the test**

Create `src/capture/schema.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { ContentTypeEnum } from "./schema";

describe("ContentTypeEnum", () => {
  test("accepts github-repo as a valid content type", () => {
    const result = ContentTypeEnum.safeParse("github-repo");
    expect(result.success).toBe(true);
  });

  test("still accepts existing content types", () => {
    for (const t of ["article", "youtube-video", "youtube-channel", "hacker-news", "twitter"]) {
      expect(ContentTypeEnum.safeParse(t).success).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/capture/schema.test.ts`
Expected: FAIL — `github-repo` not in enum

- [ ] **Step 3: Add `github-repo` to the enum**

In `src/capture/schema.ts`, change line 3:

```typescript
export const ContentTypeEnum = z.enum([
  "article",
  "youtube-video",
  "youtube-channel",
  "hacker-news",
  "twitter",
  "github-repo",
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/capture/schema.test.ts`
Expected: PASS

- [ ] **Step 5: Verify typecheck passes**

Run: `bun run typecheck`
Expected: PASS (no new errors — all switch/match on ContentType should have default cases or be tolerant)

- [ ] **Step 6: Commit**

```bash
git add src/capture/schema.ts src/capture/schema.test.ts
git commit -m "feat(capture): add github-repo to ContentType enum"
```

### Task 3: Add GitHub URL detection

**Files:**
- Modify: `src/capture/detect-type.ts`

- [ ] **Step 1: Write the test**

Create `src/capture/detect-type.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { detectContentType } from "./detect-type";

describe("detectContentType", () => {
  test("detects github.com repo URLs as github-repo", () => {
    expect(detectContentType("https://github.com/owner/repo")).toBe("github-repo");
  });

  test("detects github.com repo URLs with trailing path", () => {
    expect(detectContentType("https://github.com/owner/repo/tree/main")).toBe("github-repo");
  });

  test("does not match github.com root or user profile as github-repo", () => {
    expect(detectContentType("https://github.com")).toBe("article");
    expect(detectContentType("https://github.com/owner")).toBe("article");
  });

  test("preserves existing detections", () => {
    expect(detectContentType("https://youtube.com/watch?v=abc")).toBe("youtube-video");
    expect(detectContentType("https://news.ycombinator.com/item?id=123")).toBe("hacker-news");
    expect(detectContentType("https://x.com/user/status/123")).toBe("twitter");
    expect(detectContentType("https://example.com/article")).toBe("article");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/capture/detect-type.test.ts`
Expected: FAIL — GitHub URLs return `article`

- [ ] **Step 3: Add GitHub detection pattern**

In `src/capture/detect-type.ts`, add to the `patterns` array before the closing bracket (insert before the last entry or at an appropriate position):

```typescript
{
  type: "github-repo",
  test: (url) => {
    if (url.hostname !== "github.com") return false;
    // Must have at least /owner/repo (2 path segments)
    const segments = url.pathname.split("/").filter(Boolean);
    return segments.length >= 2;
  },
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/capture/detect-type.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/capture/detect-type.ts src/capture/detect-type.test.ts
git commit -m "feat(capture): detect github.com repo URLs as github-repo type"
```

---

## Chunk 2: Extraction Functions — Jina, Local, CF Browser

### Task 4: Create Jina extraction Inngest function

**Files:**
- Create: `src/inngest/functions/extract-jina.ts`
- Modify: `src/inngest/client.ts`

- [ ] **Step 1: Write the test**

Create `src/inngest/functions/extract-jina.test.ts`:

```typescript
import { describe, expect, mock, test } from "bun:test";

// Test the extraction logic directly (not the Inngest wrapper)
import { fetchViaJina } from "./extract-jina";

describe("fetchViaJina", () => {
  test("fetches markdown from r.jina.ai", async () => {
    const content = await fetchViaJina("https://example.com");
    // Should return non-empty string (actual content depends on Jina availability)
    expect(typeof content).toBe("string");
  });

  test("returns empty string on timeout/failure", async () => {
    const content = await fetchViaJina("https://this-domain-does-not-exist-abc123.com");
    expect(content).toBe("");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/inngest/functions/extract-jina.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement extract-jina.ts**

Create `src/inngest/functions/extract-jina.ts`:

```typescript
import { invoke } from "inngest";
import { z } from "zod";
import { inngest } from "../client";

export async function fetchViaJina(url: string): Promise<string> {
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { Accept: "text/markdown" },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return "";
    return await res.text();
  } catch {
    return "";
  }
}

export const jinaExtraction = inngest.createFunction(
  {
    id: "jina-extraction",
    throttle: { limit: 18, period: "1m" },
    retries: 1,
  },
  { trigger: invoke(z.object({ url: z.string() })) },
  async ({ event }) => {
    const content = await fetchViaJina(event.data.url);
    return { content };
  },
);
```

**Key:** The `invoke()` trigger from `inngest` creates a trigger compatible with `step.invoke()`. The schema defines the expected `data` payload. Callers use `step.invoke("name", { function: jinaExtraction, data: { url }, timeout: "30s" })`.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/inngest/functions/extract-jina.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/inngest/functions/extract-jina.ts src/inngest/functions/extract-jina.test.ts src/inngest/client.ts
git commit -m "feat(capture): add Jina Reader extraction Inngest function"
```

### Task 5: Create local extraction Inngest function

**Files:**
- Create: `src/inngest/functions/extract-local.ts`

- [ ] **Step 1: Write the test**

Create `src/inngest/functions/extract-local.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { fetchAndConvertLocal } from "./extract-local";

describe("fetchAndConvertLocal", () => {
  test("converts HTML to markdown via Readability + node-html-markdown", async () => {
    const content = await fetchAndConvertLocal("https://example.com");
    expect(typeof content).toBe("string");
    // Example.com has minimal content but should return something
    expect(content.length).toBeGreaterThan(0);
    // Should NOT contain HTML tags (converted to markdown)
    expect(content).not.toContain("<html");
    expect(content).not.toContain("<body");
  });

  test("returns empty string on failure", async () => {
    const content = await fetchAndConvertLocal("https://this-domain-does-not-exist-abc123.com");
    expect(content).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/inngest/functions/extract-local.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement extract-local.ts**

Create `src/inngest/functions/extract-local.ts`:

```typescript
import { Readability } from "@mozilla/readability";
import { invoke } from "inngest";
import { JSDOM } from "jsdom";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { z } from "zod";
import { inngest } from "../client";

export async function fetchAndConvertLocal(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "kos-agent/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return "";
    const html = await res.text();

    // Use Readability to extract article content (strips nav, ads, boilerplate)
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article?.content) return "";

    // Convert the clean HTML to markdown
    return NodeHtmlMarkdown.translate(article.content);
  } catch {
    return "";
  }
}

export const localExtraction = inngest.createFunction(
  {
    id: "local-extraction",
    retries: 1,
  },
  { trigger: invoke(z.object({ url: z.string() })) },
  async ({ event }) => {
    const content = await fetchAndConvertLocal(event.data.url);
    return { content };
  },
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/inngest/functions/extract-local.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/inngest/functions/extract-local.ts src/inngest/functions/extract-local.test.ts
git commit -m "feat(capture): add local Readability extraction Inngest function"
```

### Task 6: Create CF Browser Rendering Inngest function

**Files:**
- Create: `src/inngest/functions/extract-cf-browser.ts`
- Modify: `src/capture/extract/article.ts`

- [ ] **Step 1: Move CF logic to its own Inngest function**

Create `src/inngest/functions/extract-cf-browser.ts` — move the CF Browser Rendering logic from `src/capture/extract/article.ts` (lines 28-88, the crawl/poll logic) into a standalone function:

```typescript
import { invoke } from "inngest";
import { z } from "zod";
import { inngest } from "../client";

const CrawlResponseSchema = z.object({
  success: z.boolean(),
  result: z.object({ id: z.string() }).optional(),
});

const CrawlStatusSchema = z.object({
  success: z.boolean(),
  result: z.object({
    status: z.string(),
    pages: z.array(z.object({ markdown: z.string().optional() })).optional(),
  }).optional(),
});

export async function fetchViaCFBrowser(url: string): Promise<string> {
  const accountId = process.env.CF_ACCOUNT_ID;
  const apiToken = process.env.CF_API_TOKEN;
  if (!accountId || !apiToken) return "";

  try {
    const crawlRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/crawl`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url,
          scrapeOptions: { formats: ["markdown"] },
          limit: 1,
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );

    const crawlParsed = CrawlResponseSchema.safeParse(await crawlRes.json());
    if (!crawlParsed.success || !crawlParsed.data.result?.id) return "";

    const jobId = crawlParsed.data.result.id;
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2_000));
      const statusRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/crawl/${jobId}`,
        {
          headers: { Authorization: `Bearer ${apiToken}` },
          signal: AbortSignal.timeout(10_000),
        },
      );

      const statusParsed = CrawlStatusSchema.safeParse(await statusRes.json());
      if (!statusParsed.success) continue;

      const status = statusParsed.data.result?.status;
      if (status === "complete") {
        return statusParsed.data.result?.pages?.[0]?.markdown ?? "";
      }
      if (status === "failed") return "";
    }
    return "";
  } catch {
    return "";
  }
}

export const cfBrowserExtraction = inngest.createFunction(
  {
    id: "cf-browser-extraction",
    retries: 1,
  },
  { trigger: invoke(z.object({ url: z.string() })) },
  async ({ event }) => {
    const content = await fetchViaCFBrowser(event.data.url);
    return { content };
  },
);
```

- [ ] **Step 2: Simplify article.ts**

Replace `src/capture/extract/article.ts` with a thin wrapper that just re-exports the fetch fallback (for any remaining internal callers):

```typescript
/**
 * Thin wrapper for backward compatibility.
 * Real extraction logic lives in Inngest functions:
 * - extract-jina.ts (Tier 1)
 * - extract-local.ts (Tier 2)
 * - extract-cf-browser.ts (Tier 3)
 */
export async function extractArticleContent(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "kos-agent/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    return await res.text();
  } catch {
    return "";
  }
}
```

- [ ] **Step 3: Verify typecheck passes**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/inngest/functions/extract-cf-browser.ts src/capture/extract/article.ts
git commit -m "feat(capture): move CF Browser Rendering to its own Inngest function"
```

### Task 7: Register extraction functions with Inngest serve handler

**Files:**
- Modify: `src/index.ts`
- Modify: `src/inngest/functions/index.ts` (if it exists as a barrel export)

- [ ] **Step 1: Check for barrel export file**

Run: `cat src/inngest/functions/index.ts` — if it exists, add the new exports there.

- [ ] **Step 2: Add imports and register functions**

In `src/index.ts`, add imports for the three new extraction functions and add them to the `functions` array:

```typescript
import { jinaExtraction } from "@/inngest/functions/extract-jina";
import { localExtraction } from "@/inngest/functions/extract-local";
import { cfBrowserExtraction } from "@/inngest/functions/extract-cf-browser";

// In the functions array:
const functions = [
  acknowledgeMessage,
  handleCapture,
  handleFailure,
  handleMessage,
  handleScheduledJob,
  sendReply,
  jinaExtraction,
  localExtraction,
  cfBrowserExtraction,
];
```

- [ ] **Step 3: Verify typecheck passes**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/index.ts src/inngest/functions/index.ts
git commit -m "feat(capture): register extraction functions with Inngest serve handler"
```

---

## Chunk 3: Orchestrator Refactor — Tiered Fallback Chain

### Task 8: Update quality check for markdown content

**Files:**
- Modify: `src/capture/extract/quality.ts`

- [ ] **Step 1: Write the test**

Create `src/capture/extract/quality.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { checkContentQuality } from "./quality";

describe("checkContentQuality", () => {
  test("rejects short content", () => {
    expect(checkContentQuality("too short")).toBe(false);
  });

  test("accepts 200+ chars of real content", () => {
    const content = "a".repeat(250);
    expect(checkContentQuality(content)).toBe(true);
  });

  test("strips HTML tags before measuring", () => {
    const html = `<nav>nav content</nav><p>${"a".repeat(100)}</p>`;
    expect(checkContentQuality(html)).toBe(false);
  });

  test("strips markdown formatting before measuring", () => {
    // Headings, bold, links should be stripped for measurement
    const md = `# Heading\n\n**bold** and [link](url) with ${"a".repeat(200)}`;
    expect(checkContentQuality(md)).toBe(true);
  });

  test("rejects markdown that is mostly formatting", () => {
    const md = "# H\n## H\n### H\n- item\n- item\n[link](url)";
    expect(checkContentQuality(md)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/capture/extract/quality.test.ts`
Expected: Some tests FAIL (markdown stripping not implemented)

- [ ] **Step 3: Update quality.ts to handle markdown**

```typescript
const MIN_CONTENT_LENGTH = 200;

export function checkContentQuality(content: string): boolean {
  const cleaned = stripFormattingAndChrome(content);
  return cleaned.length >= MIN_CONTENT_LENGTH;
}

function stripFormattingAndChrome(content: string): string {
  return content
    // Strip HTML elements
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, "")
    .replace(/<[^>]+>/g, "")
    // Strip markdown formatting
    .replace(/^#{1,6}\s+/gm, "")        // headings
    .replace(/\*\*([^*]+)\*\*/g, "$1")   // bold
    .replace(/\*([^*]+)\*/g, "$1")       // italic
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links
    .replace(/^[-*+]\s+/gm, "")         // list markers
    .replace(/^\d+\.\s+/gm, "")         // ordered list markers
    .replace(/^>\s+/gm, "")             // blockquotes
    .replace(/`[^`]+`/g, "")            // inline code
    .replace(/```[\s\S]*?```/g, "")     // code blocks
    .replace(/\s+/g, " ")
    .trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/capture/extract/quality.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/capture/extract/quality.ts src/capture/extract/quality.test.ts
git commit -m "feat(capture): update quality check to handle markdown content"
```

### Task 9: Refactor handle-capture orchestrator with tiered extraction

**Files:**
- Modify: `src/inngest/functions/handle-capture.ts`

This is the core refactor. Replace the single `extract-content` step with sequential `step.invoke()` calls.

- [ ] **Step 1: Add imports for extraction functions**

At the top of `handle-capture.ts`, add:

```typescript
import { jinaExtraction } from "./extract-jina";
import { localExtraction } from "./extract-local";
import { cfBrowserExtraction } from "./extract-cf-browser";
```

- [ ] **Step 2: Replace the extract-content step (lines 176-204)**

Replace the `contentPromise` step with the tiered fallback chain. The new code goes in the same location, but instead of a single `step.run("extract-content", ...)`, it uses sequential `step.invoke()` calls:

```typescript
// Content extraction — tiered for articles, direct for other types
let content = "";
let extractionMethod = "none";

if (resolvedMode === "quick") {
  content = "";
} else if (isFile) {
  if (!filePath) throw new Error("filePath required for file captures");
  content = await step.run("extract-file-content", () => extractFileContent(filePath));
  extractionMethod = "file";
} else if (!url) {
  throw new Error("URL required for non-file captures");
} else if (type === "youtube-video") {
  content = await step.run("extract-youtube-transcript", () => extractYouTubeTranscript(url));
  extractionMethod = "youtube";
} else if (type === "youtube-channel") {
  const videos = await step.run("list-channel-videos", () => listChannelVideos(url));
  content = JSON.stringify(videos);
  extractionMethod = "youtube";
} else if (type === "twitter") {
  content = "";
} else {
  // Article, HN, GitHub, or unknown — use tiered extraction
  const extractUrl = type === "hacker-news"
    ? await step.run("get-hn-article-url", async () => {
        // Fetch the linked article URL from HN API
        const itemId = new URL(url).searchParams.get("id");
        if (!itemId) return url;
        const res = await fetch(`https://hn.algolia.com/api/v1/items/${itemId}`);
        const data = await res.json() as { url?: string };
        return data.url ?? url;
      })
    : url;

  // Tier 1: Jina
  try {
    const result = await step.invoke("tier-1-jina", {
      function: jinaExtraction,
      data: { url: extractUrl },
      timeout: "30s",
    });
    content = result.content;
    extractionMethod = "jina";
  } catch {}

  // Tier 2: Local (if Jina failed or low quality)
  if (!content || !checkContentQuality(content)) {
    content = "";
    try {
      const result = await step.invoke("tier-2-local", {
        function: localExtraction,
        data: { url: extractUrl },
        timeout: "30s",
      });
      content = result.content;
      extractionMethod = "local";
    } catch {}
  }

  // Tier 3: CF Browser (if local failed AND keys configured)
  if (
    (!content || !checkContentQuality(content)) &&
    process.env.CF_ACCOUNT_ID &&
    process.env.CF_API_TOKEN
  ) {
    content = "";
    try {
      const result = await step.invoke("tier-3-cf-browser", {
        function: cfBrowserExtraction,
        data: { url: extractUrl },
        timeout: "60s",
      });
      content = result.content;
      extractionMethod = "cf-browser";
    } catch {}
  }
}

const extractionFailed = resolvedMode === "full" && !content && type !== "twitter" && type !== "file";
```

- [ ] **Step 3: Update the metadata step to run in parallel (keep existing)**

The metadata step stays as-is. Remove the old `Promise.all` pattern — metadata and content are no longer parallel since content extraction now uses `step.invoke()` (which are already durable steps). Run metadata first, then content:

```typescript
const metadata = await step.run("extract-metadata", async (): Promise<PageMetadata> => {
  // ... existing metadata logic unchanged
});

// Then the content extraction from step 2 above
```

- [ ] **Step 4: Update the notify step to be conditional on source**

Replace the existing notify step (lines 317-351) with:

```typescript
// Only notify for CLI-triggered captures (agent handles its own notifications)
const source = isCaptureEvent(event) ? event.data.source : "cli";
if (source === "cli") {
  await step.run("notify", async () => {
    const notifyChannel = await getNotifyChannel();
    if (!notifyChannel) return;

    const msg = buildNotificationMessage({
      title: metadata.title ?? url ?? filePath ?? "Untitled",
      url,
      notePath,
      description: metadata.description ?? "",
      failed: extractionFailed,
    });

    await slack.chat
      .postMessage({ channel: notifyChannel, text: msg })
      .catch(() => {});

    if (
      destination &&
      "chatId" in destination &&
      "threadId" in destination &&
      destination.threadId
    ) {
      await slack.chat
        .postMessage({
          channel: destination.chatId,
          thread_ts: destination.threadId,
          text: msg,
        })
        .catch(() => {});
    }
  });
}
```

- [ ] **Step 5: Remove the old quality check step**

The quality check is now inline in the tiered extraction chain (between tiers). Remove the standalone quality check step (lines 212-221).

- [ ] **Step 6: Update the return value**

```typescript
return {
  status: extractionFailed ? "extraction-failed" : "captured",
  type,
  mode: resolvedMode,
  url: url ?? filePath,
  notePath,
  extractionMethod,
};
```

- [ ] **Step 7: Verify typecheck passes**

Run: `bun run typecheck`
Expected: PASS (may need adjustments based on Inngest's `step.invoke()` types)

- [ ] **Step 8: Commit**

```bash
git add src/inngest/functions/handle-capture.ts
git commit -m "feat(capture): refactor orchestrator with tiered step.invoke extraction chain"
```

---

## Chunk 4: Notifications, Vault Templates, GitHub Extraction

### Task 10: Redesign Slack notifications

**Files:**
- Modify: `src/capture/notify.ts`

- [ ] **Step 1: Write the test**

Create `src/capture/notify.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { buildNotificationMessage } from "./notify";

describe("buildNotificationMessage", () => {
  test("formats success notification with description", () => {
    const msg = buildNotificationMessage({
      title: "Article Title",
      url: "https://example.com/article",
      notePath: "~/kyrell-os-vault/sources/Article Title.md",
      description: "A great article about testing",
    });
    expect(msg).toContain("*Article Title*");
    expect(msg).toContain("A great article about testing");
    expect(msg).toContain("https://example.com/article");
    expect(msg).toContain("~/kyrell-os-vault/sources/Article Title.md");
    // Should NOT contain old format labels
    expect(msg).not.toContain("article ·");
    expect(msg).not.toContain("full capture");
  });

  test("formats failure notification", () => {
    const msg = buildNotificationMessage({
      title: "Bad Page",
      url: "https://example.com/broken",
      notePath: "~/kyrell-os-vault/sources/Bad Page.md",
      description: "",
      failed: true,
    });
    expect(msg).toContain("*Failed: Bad Page*");
    expect(msg).toContain("metadata saved, needs manual processing");
  });

  test("handles missing URL", () => {
    const msg = buildNotificationMessage({
      title: "Local File",
      notePath: "~/kyrell-os-vault/sources/Local File.md",
      description: "A local document",
    });
    expect(msg).toContain("*Local File*");
    expect(msg).not.toContain("undefined");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/capture/notify.test.ts`
Expected: FAIL — old interface doesn't match

- [ ] **Step 3: Update notify.ts**

```typescript
import type { Block } from "@slack/types";

interface NotificationInput {
  title: string;
  url?: string;
  notePath: string;
  description: string;
  failed?: boolean;
}

export function buildNotificationMessage(input: NotificationInput): string {
  if (input.failed) {
    const lines = [`*Failed: ${input.title}*`];
    lines.push("Could not extract content \u2014 metadata saved, needs manual processing");
    if (input.url) lines.push(`${input.url} \u2192 \`${input.notePath}\``);
    else lines.push(`\`${input.notePath}\``);
    return lines.join("\n");
  }

  const lines = [`*${input.title}*`];
  if (input.description) lines.push(input.description);
  if (input.url) lines.push(`${input.url} \u2192 \`${input.notePath}\``);
  else lines.push(`\`${input.notePath}\``);
  return lines.join("\n");
}

// Keep triage blocks unchanged
interface TriageInput {
  captureId: string;
  type: string;
  title: string;
  description: string;
}

export interface SlackBlock extends Block {
  [key: string]: unknown;
}

// ... keep buildTriageBlocks and buildTriageUpdateText unchanged
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/capture/notify.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/capture/notify.ts src/capture/notify.test.ts
git commit -m "feat(capture): redesign notifications — clean format, failure support"
```

### Task 11: Create Obsidian vault templates

**Files:**
- Create: 6 template files in `~/kyrell-os-vault/templates/`

- [ ] **Step 1: Create Article Source Template**

Run:
```bash
obsidian create name="Article Source Template" folder="templates" content="---\ncategories:\n  - \"[[Sources]]\"\nauthor: []\nurl:\ncreated: \"{{date:MM-DD-YYYY}}\"\npublished:\ntopics: []\nstatus: raw\nsource_type: article\nextraction_method:\n---"
```

- [ ] **Step 2: Create YouTube Video Source Template**

Run:
```bash
obsidian create name="YouTube Video Source Template" folder="templates" content="---\ncategories:\n  - \"[[Sources]]\"\nauthor: []\nurl:\ncreated: \"{{date:MM-DD-YYYY}}\"\npublished:\ntopics: []\nstatus: raw\nsource_type: youtube-video\nchannel:\nduration:\nviews:\nextraction_method:\n---"
```

- [ ] **Step 3: Create Hacker News Source Template**

Run:
```bash
obsidian create name="Hacker News Source Template" folder="templates" content="---\ncategories:\n  - \"[[Sources]]\"\nauthor: []\nurl:\ncreated: \"{{date:MM-DD-YYYY}}\"\ntopics: []\nstatus: raw\nsource_type: hacker-news\nhn_url:\nhn_points:\nhn_comments:\nextraction_method:\n---"
```

- [ ] **Step 4: Create GitHub Repo Source Template**

Run:
```bash
obsidian create name="GitHub Repo Source Template" folder="templates" content="---\ncategories:\n  - \"[[Sources]]\"\nurl:\ncreated: \"{{date:MM-DD-YYYY}}\"\ntopics: []\nstatus: raw\nsource_type: github-repo\nstars:\nlanguage:\nlicense:\nlocal_path:\n---"
```

- [ ] **Step 5: Create File Source Template**

Run:
```bash
obsidian create name="File Source Template" folder="templates" content="---\ncategories:\n  - \"[[Sources]]\"\ncreated: \"{{date:MM-DD-YYYY}}\"\ntopics: []\nstatus: raw\nsource_type: file\nfile_path:\n---"
```

- [ ] **Step 6: Create YouTube Channel Template**

Run:
```bash
obsidian create name="YouTube Channel Template" folder="templates" content="---\ncategories:\n  - \"[[YouTube Channels]]\"\nyoutube_url:\ncreated: \"{{date:MM-DD-YYYY}}\"\ntopics: []\n---\n\n## Videos\n\n![[Sources.base#Author]]"
```

- [ ] **Step 7: Verify templates exist**

Run: `obsidian templates`
Expected: All 6 new templates appear in the list

- [ ] **Step 8: Commit vault changes**

```bash
cd ~/kyrell-os-vault && git add templates/ && git commit -m "feat: add source capture templates for pipeline v2"
```

### Task 12: Refactor vault writer to use templates

**Files:**
- Modify: `src/capture/vault/templates.ts`
- Modify: `src/capture/vault/writer.ts`

- [ ] **Step 1: Write the test**

Create `src/capture/vault/writer.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { buildVaultNote } from "./templates";

describe("buildVaultNote", () => {
  test("builds article note with frontmatter and body content", () => {
    const note = buildVaultNote({
      type: "article",
      title: "Test Article",
      url: "https://example.com",
      author: "John Doe",
      description: "A test article",
      content: "Full article content here",
      extractionMethod: "jina",
    });

    // Frontmatter
    expect(note).toContain('source_type: article');
    expect(note).toContain('url: "https://example.com"');
    expect(note).toContain('extraction_method: jina');
    expect(note).toContain('status: raw');
    // Body — summary in content, not frontmatter
    expect(note).toContain("# Test Article");
    expect(note).toContain("A test article");
    expect(note).toContain("Full article content here");
  });

  test("sets extraction-failed status when content is empty on full mode", () => {
    const note = buildVaultNote({
      type: "article",
      title: "Failed Article",
      url: "https://example.com",
      extractionFailed: true,
    });
    expect(note).toContain("status: extraction-failed");
  });

  test("builds github-repo note with repo-specific fields", () => {
    const note = buildVaultNote({
      type: "github-repo",
      title: "cool-repo",
      url: "https://github.com/owner/cool-repo",
      stars: 1234,
      language: "TypeScript",
      license: "MIT",
      localPath: "~/projects/cool-repo",
    });
    expect(note).toContain("source_type: github-repo");
    expect(note).toContain("stars: 1234");
    expect(note).toContain('language: "TypeScript"');
    expect(note).toContain('local_path: "~/projects/cool-repo"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/capture/vault/writer.test.ts`
Expected: FAIL — `buildVaultNote` doesn't exist

- [ ] **Step 3: Rewrite templates.ts with template-based approach**

Replace `src/capture/vault/templates.ts` with a new implementation that builds notes matching the Obsidian template format. The function reads the template structure (frontmatter fields per type) and populates them:

```typescript
import type { ContentType } from "../schema";

export interface VaultNoteInput {
  type: ContentType | "file";
  title: string;
  url?: string;
  author?: string;
  description?: string;
  published?: string;
  content?: string;
  extractionMethod?: string;
  extractionFailed?: boolean;
  // YouTube-specific
  channel?: string;
  duration?: string;
  views?: number;
  // HN-specific
  hnUrl?: string;
  hnPoints?: number;
  hnComments?: number;
  // Twitter-specific
  handle?: string;
  posted?: string;
  // GitHub-specific
  stars?: number;
  language?: string;
  license?: string;
  localPath?: string;
  // File-specific
  filePath?: string;
}

export function buildVaultNote(input: VaultNoteInput): string {
  if (input.type === "youtube-channel") {
    return buildYouTubeChannelNote(input);
  }
  const frontmatter = buildFrontmatter(input);
  const body = buildBody(input);
  return `---\n${frontmatter}---\n\n# ${input.title}\n\n${body}`;
}

function buildFrontmatter(input: VaultNoteInput): string {
  const lines: string[] = [];
  const status = input.extractionFailed ? "extraction-failed" : "raw";

  lines.push("categories:");
  lines.push('  - "[[Sources]]"');

  // Author (not for github-repo or file)
  if (input.type !== "github-repo" && input.type !== "file") {
    if (input.author) {
      lines.push("author:");
      lines.push(`  - "[[${input.author}]]"`);
    } else {
      lines.push("author: []");
    }
  }

  lines.push(`url: "${input.url ?? ""}"`);
  lines.push(`created: "[[${formatDate()}]]"`);

  if (input.published) {
    lines.push(`published: "${input.published}"`);
  }

  lines.push("topics: []");
  lines.push(`status: ${status}`);
  lines.push(`source_type: ${input.type}`);

  if (input.extractionMethod) {
    lines.push(`extraction_method: ${input.extractionMethod}`);
  }

  // Type-specific fields
  if (input.type === "youtube-video") {
    if (input.channel) lines.push(`channel: "[[${input.channel}]]"`);
    if (input.duration) lines.push(`duration: "${input.duration}"`);
    if (input.views !== undefined) lines.push(`views: ${input.views}`);
  }

  if (input.type === "hacker-news") {
    if (input.hnUrl) lines.push(`hn_url: "${input.hnUrl}"`);
    if (input.hnPoints !== undefined) lines.push(`hn_points: ${input.hnPoints}`);
    if (input.hnComments !== undefined) lines.push(`hn_comments: ${input.hnComments}`);
  }

  if (input.type === "twitter") {
    if (input.handle) lines.push(`handle: "${input.handle}"`);
    if (input.posted) lines.push(`posted: "${input.posted}"`);
  }

  if (input.type === "github-repo") {
    if (input.stars !== undefined) lines.push(`stars: ${input.stars}`);
    if (input.language) lines.push(`language: "${input.language}"`);
    if (input.license) lines.push(`license: "${input.license}"`);
    if (input.localPath) lines.push(`local_path: "${input.localPath}"`);
  }

  if (input.type === "file") {
    if (input.filePath) lines.push(`file_path: "${input.filePath}"`);
  }

  return lines.join("\n") + "\n";
}

function buildBody(input: VaultNoteInput): string {
  const parts: string[] = [];

  // Summary/description as first paragraph (body content, not frontmatter)
  if (input.description) {
    parts.push(input.description);
  }

  // Full content separated by horizontal rule
  if (input.content) {
    if (parts.length > 0) parts.push("\n---\n");
    parts.push(input.content);
  }

  return parts.join("\n\n");
}

function buildYouTubeChannelNote(input: VaultNoteInput): string {
  const lines = [
    "---",
    "categories:",
    '  - "[[YouTube Channels]]"',
    `youtube_url: "${input.url ?? ""}"`,
    `created: "[[${formatDate()}]]"`,
    "topics: []",
    "---",
    "",
    "## Videos",
    "",
    "![[Sources.base#Author]]",
  ];
  return lines.join("\n");
}

function formatDate(): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const yyyy = now.getFullYear();
  return `${mm}-${dd}-${yyyy}`;
}

export function sanitizeFilename(title: string): string {
  return title
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/capture/vault/writer.test.ts`
Expected: PASS

- [ ] **Step 5: Verify typecheck passes**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/capture/vault/templates.ts src/capture/vault/writer.ts src/capture/vault/writer.test.ts
git commit -m "feat(capture): template-based vault notes with extraction_method and failure status"
```

### Task 13: Create GitHub repo extractor

**Files:**
- Create: `src/capture/extract/github.ts`

- [ ] **Step 1: Write the test**

Create `src/capture/extract/github.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { parseGitHubUrl, fetchGitHubMetadata } from "./github";

describe("parseGitHubUrl", () => {
  test("extracts owner and repo from GitHub URL", () => {
    const result = parseGitHubUrl("https://github.com/anthropics/claude-code");
    expect(result).toEqual({ owner: "anthropics", repo: "claude-code" });
  });

  test("handles URLs with trailing path segments", () => {
    const result = parseGitHubUrl("https://github.com/owner/repo/tree/main/src");
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  test("returns null for non-repo URLs", () => {
    expect(parseGitHubUrl("https://github.com")).toBeNull();
    expect(parseGitHubUrl("https://github.com/owner")).toBeNull();
  });
});

describe("fetchGitHubMetadata", () => {
  test("fetches metadata from GitHub API", async () => {
    // Using a stable, well-known repo
    const meta = await fetchGitHubMetadata("anthropics", "claude-code");
    expect(meta.description).toBeDefined();
    expect(typeof meta.stars).toBe("number");
    expect(typeof meta.language).toBe("string");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/capture/extract/github.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement github.ts**

Create `src/capture/extract/github.ts`:

```typescript
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export interface GitHubRepoMeta {
  description: string;
  stars: number;
  language: string;
  license: string;
  topics: string[];
  defaultBranch: string;
}

export function parseGitHubUrl(urlString: string): { owner: string; repo: string } | null {
  try {
    const url = new URL(urlString);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return null;
    return { owner: segments[0], repo: segments[1] };
  } catch {
    return null;
  }
}

const GitHubRepoSchema = z.object({
  description: z.string().nullable().optional(),
  stargazers_count: z.number().optional(),
  language: z.string().nullable().optional(),
  license: z.object({ spdx_id: z.string().optional() }).nullable().optional(),
  topics: z.array(z.string()).optional(),
  default_branch: z.string().optional(),
});

export async function fetchGitHubMetadata(owner: string, repo: string): Promise<GitHubRepoMeta> {
  const empty: GitHubRepoMeta = { description: "", stars: 0, language: "", license: "", topics: [], defaultBranch: "main" };

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "kos-agent/1.0",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) return empty;

  const parsed = GitHubRepoSchema.safeParse(await res.json());
  if (!parsed.success) return empty;

  const data = parsed.data;
  return {
    description: data.description ?? "",
    stars: data.stargazers_count ?? 0,
    language: data.language ?? "",
    license: data.license?.spdx_id ?? "",
    topics: data.topics ?? [],
    defaultBranch: data.default_branch ?? "main",
  };
}

export function getClonePath(): string {
  // Read from kos config, fall back to ~/projects/
  try {
    const result = execSync("kos config get clone_path", { encoding: "utf-8", timeout: 5_000 }).trim();
    if (result && result !== "undefined" && result !== "null") {
      return result.startsWith("~/") ? join(homedir(), result.slice(2)) : result;
    }
  } catch {}
  return join(homedir(), "projects");
}

export function cloneOrPullRepo(owner: string, repo: string, clonePath: string): string {
  const repoDir = join(clonePath, repo);

  if (existsSync(repoDir)) {
    // Pull latest
    try {
      execSync("git pull --ff-only", { cwd: repoDir, timeout: 60_000, stdio: "pipe" });
    } catch {
      // Pull failed (diverged, etc.) — that's fine, we have the repo locally
    }
  } else {
    // Clone
    execSync(`git clone https://github.com/${owner}/${repo}.git "${repoDir}"`, {
      timeout: 120_000,
      stdio: "pipe",
    });
  }

  return repoDir;
}

export async function readRepoReadme(repoDir: string): Promise<string> {
  for (const name of ["README.md", "readme.md", "Readme.md", "README"]) {
    try {
      return await readFile(join(repoDir, name), "utf-8");
    } catch {}
  }
  return "";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/capture/extract/github.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/capture/extract/github.ts src/capture/extract/github.test.ts
git commit -m "feat(capture): add GitHub repo extractor — clone, pull, API metadata"
```

### Task 14: Wire GitHub extraction into handle-capture orchestrator

**Files:**
- Modify: `src/inngest/functions/handle-capture.ts`
- Modify: `src/capture/extract/metadata.ts`

- [ ] **Step 1: Add GitHub case to the content extraction switch**

In the orchestrator's content extraction section (from Task 9), the `else` branch handles articles, HN, and now GitHub. Add a GitHub-specific branch before the tiered extraction:

```typescript
} else if (type === "github-repo") {
  content = await step.run("extract-github-repo", async () => {
    const parsed = parseGitHubUrl(url);
    if (!parsed) return "";
    const clonePath = getClonePath();
    const repoDir = cloneOrPullRepo(parsed.owner, parsed.repo, clonePath);
    return readRepoReadme(repoDir);
  });
  extractionMethod = "github";
} else {
  // Tiered extraction for articles, HN, etc.
```

Add imports at the top:
```typescript
import { parseGitHubUrl, getClonePath, cloneOrPullRepo, readRepoReadme, fetchGitHubMetadata } from "@/capture/extract/github";
```

- [ ] **Step 2: Add GitHub metadata case**

In `src/capture/extract/metadata.ts`, add a `github-repo` case that calls `fetchGitHubMetadata()` and maps the result to `PageMetadata`.

- [ ] **Step 3: Update the vault note input to include GitHub fields**

In the `write-vault-note` step, add GitHub-specific fields when `type === "github-repo"`:

```typescript
stars: metadata.stars,
language: metadata.language,
license: metadata.license,
localPath: type === "github-repo" ? `~/projects/${parseGitHubUrl(url!)?.repo}` : undefined,
```

- [ ] **Step 4: Verify typecheck passes**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/inngest/functions/handle-capture.ts src/capture/extract/metadata.ts
git commit -m "feat(capture): wire GitHub repo extraction into orchestrator"
```

---

## Chunk 5: Agent Awareness, Documentation, Cleanup

### Task 15: Teach the agent its capture capabilities

**Files:**
- Modify: `src/agent/session.ts`

- [ ] **Step 1: Add capture section to buildSystemAppend()**

In `src/agent/session.ts`, add after the scheduled jobs section (before the `return` statement):

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
  'kos capture --batch-file urls.txt  # Batch capture from file',
  "kos capture --file /path/to/doc    # Capture a local file",
  "",
  "Content types (auto-detected): article, youtube-video, youtube-channel, hacker-news, github-repo",
  "",
  "After capturing, you can:",
  '- Read the vault note with: obsidian read file="Title"',
  '- Add a summary: obsidian append file="Title" content="Summary text"',
  '- Update properties: obsidian property:set name=status value=done file="Title"',
  '- Create notes from templates: obsidian create name="Title" template="Template Name"',
  "",
  "When someone shares a URL in Slack, consider whether to capture it.",
  "After capturing, read the extracted content and provide a useful summary.",
);
```

- [ ] **Step 2: Verify typecheck passes**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/agent/session.ts
git commit -m "feat(agent): teach agent about capture pipeline and Obsidian capabilities"
```

### Task 16: Create capture pipeline skill

**Files:**
- Create: `.claude/skills/capture-pipeline/SKILL.md`

- [ ] **Step 1: Create the skill**

```bash
mkdir -p /Users/kyrelldixon/projects/kos-agent/.claude/skills/capture-pipeline
```

Write `.claude/skills/capture-pipeline/SKILL.md`:

```markdown
---
name: capture-pipeline
description: Use when working on the capture pipeline, content extraction, vault note creation, or debugging capture issues. Covers content types, extraction tiers, CLI usage, env vars, failure modes.
---

# Capture Pipeline

Captures URLs and files into the Obsidian vault as source notes.

## Architecture

```
CLI/Agent → POST /api/capture → Inngest event → handle-capture function
                                                       ↓
                                          detect type → extract metadata
                                                       ↓
                                          tiered content extraction:
                                            1. Jina Reader (r.jina.ai)
                                            2. Local (Readability + node-html-markdown)
                                            3. CF Browser Rendering (if keys set)
                                                       ↓
                                          write vault note (Obsidian template)
                                                       ↓
                                          notify (CLI only; agent handles its own)
```

## Content Types

| Type | Detection | Extraction |
|------|-----------|------------|
| `article` | Default | Tiered: Jina → Local → CF |
| `youtube-video` | youtube.com/watch, youtu.be | yt-dlp transcript |
| `youtube-channel` | youtube.com/@, /c/ | yt-dlp video listing → fan-out |
| `hacker-news` | news.ycombinator.com | Algolia API + tiered for linked article |
| `github-repo` | github.com/{owner}/{repo} | Clone/pull + GitHub API metadata |
| `twitter` | x.com, twitter.com | Placeholder (TODO: agent-browser) |
| `file` | Local file path | Direct file read |

## CLI Commands

```bash
kos capture <url> --quick          # Metadata only
kos capture <url> --full           # Full content extraction
kos capture <url>                  # Triage (Slack buttons)
kos capture --batch-file urls.txt  # Batch
kos capture --file /path/to/doc    # Local file
```

## Env Vars

| Var | Required | Purpose |
|-----|----------|---------|
| `VAULT_PATH` | Yes | Path to Obsidian vault (default: ~/kyrell-os-vault) |
| `CF_ACCOUNT_ID` | No | Cloudflare Account ID (enables Tier 3 extraction) |
| `CF_API_TOKEN` | No | Cloudflare API token (enables Tier 3 extraction) |

## Extraction Functions (Inngest)

Each tier is a separate Inngest function with independent config:

| Function | ID | Throttle | Retries |
|----------|----|----------|---------|
| `jinaExtraction` | jina-extraction | 18/min | 1 |
| `localExtraction` | local-extraction | none | 1 |
| `cfBrowserExtraction` | cf-browser-extraction | none | 1 |

Orchestrator calls via `step.invoke()` with try/catch fallback.

## Vault Templates

Templates are in `~/kyrell-os-vault/templates/`. Never hardcode note formats in TypeScript.

| Template | For |
|----------|-----|
| Article Source Template | Articles, blog posts |
| YouTube Video Source Template | YouTube videos |
| Hacker News Source Template | HN posts |
| GitHub Repo Source Template | GitHub repos |
| File Source Template | Local files |
| YouTube Channel Template | YouTube channels |

## Failure Handling

- All tiers fail → `status: extraction-failed` in frontmatter
- Slack notification says "metadata saved, needs manual processing"
- Search vault for `status: extraction-failed` to find failed captures

## Testing

```bash
# Article (should use Jina)
kos capture "https://example.com/article" --full

# HN (linked article uses tiered extraction)
kos capture "https://news.ycombinator.com/item?id=42358514" --full

# GitHub repo (clones to ~/projects/)
kos capture "https://github.com/owner/repo" --full

# YouTube (requires yt-dlp installed)
kos capture "https://youtube.com/watch?v=abc" --full

# Batch
kos capture --batch-file urls.txt --quick
```

## Key Files

- `src/inngest/functions/handle-capture.ts` — Orchestrator
- `src/inngest/functions/extract-jina.ts` — Tier 1
- `src/inngest/functions/extract-local.ts` — Tier 2
- `src/inngest/functions/extract-cf-browser.ts` — Tier 3
- `src/capture/extract/github.ts` — GitHub extractor
- `src/capture/vault/templates.ts` — Vault note builder
- `src/capture/notify.ts` — Slack notifications
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/capture-pipeline/
git commit -m "docs: add capture pipeline skill for operational documentation"
```

### Task 17: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read current README**

Read `README.md` to understand current structure before modifying.

- [ ] **Step 2: Add prerequisites and capture pipeline sections**

Add sections covering:
- Prerequisites: Bun, yt-dlp (`brew install yt-dlp`), env vars (VAULT_PATH, SLACK_* tokens)
- Quick start: clone, install, configure env, start
- Capture pipeline overview: what it does, supported content types, link to skill for details

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: update README with prerequisites and capture pipeline overview"
```

### Task 18: Final verification

- [ ] **Step 1: Run full typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 2: Run all tests**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 3: Verify Inngest functions register**

Run: `bun run src/index.ts` (briefly, check for startup errors)
Expected: "kos-agent running" message, no errors about missing functions

- [ ] **Step 4: Test a capture end-to-end**

Run: `kos capture "https://example.com" --full`
Expected: Vault note created, Slack notification sent, extraction method logged
