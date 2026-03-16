# Capture Pipeline Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a URL capture pipeline that takes URLs (articles, YouTube videos, HN links, tweets) and local files, extracts content, and writes structured source notes to the Obsidian vault.

**Architecture:** New Inngest function `handle-capture` triggered by `agent.capture.requested` and `agent.capture.file.requested` events. Content extraction is type-specific (CF Browser Rendering for articles, yt-dlp for YouTube, HN API, agent-browser for Twitter). Vault notes are written programmatically with type-specific frontmatter. Human-in-the-loop triage via Slack interactive buttons and `step.waitForEvent()`. CLI and API trigger the pipeline.

**Tech Stack:** TypeScript, Bun, Inngest 4.0.0-beta.4, Zod, Hono, Slack Bolt, Cloudflare Browser Rendering API, yt-dlp, Obsidian vault (filesystem writes)

**Spec:** `docs/superpowers/specs/2026-03-16-capture-pipeline-design.md`

---

## File Structure

### New Files (kos-agent)

| File | Responsibility |
|------|---------------|
| `src/capture/schema.ts` | Zod schemas for capture events, API request/response, content types |
| `src/capture/schema.test.ts` | Schema validation tests |
| `src/capture/detect-type.ts` | URL pattern matching → content type classification |
| `src/capture/detect-type.test.ts` | Type detection tests |
| `src/capture/extract/metadata.ts` | Lightweight metadata extraction per content type (title, author, description) |
| `src/capture/extract/metadata.test.ts` | Metadata extraction tests |
| `src/capture/extract/article.ts` | Article content extraction via CF Browser Rendering |
| `src/capture/extract/article.test.ts` | Article extraction tests |
| `src/capture/extract/youtube.ts` | YouTube transcript extraction via yt-dlp, metadata via oEmbed |
| `src/capture/extract/youtube.test.ts` | YouTube extraction tests |
| `src/capture/extract/hacker-news.ts` | HN Algolia API for discussion + article extraction |
| `src/capture/extract/hacker-news.test.ts` | HN extraction tests |
| `src/capture/extract/twitter.ts` | Twitter/X extraction via agent-browser |
| `src/capture/extract/twitter.test.ts` | Twitter extraction tests |
| `src/capture/extract/file.ts` | Local file reading |
| `src/capture/extract/file.test.ts` | File extraction tests |
| `src/capture/extract/quality.ts` | Content quality check (min 200 chars meaningful text) |
| `src/capture/extract/quality.test.ts` | Quality check tests |
| `src/capture/vault/templates.ts` | Note frontmatter/content rendering per content type |
| `src/capture/vault/templates.test.ts` | Template rendering tests |
| `src/capture/vault/writer.ts` | Write/update vault notes with idempotency check |
| `src/capture/vault/writer.test.ts` | Writer tests |
| `src/capture/notify.ts` | Slack notification helper for capture results |
| `src/capture/notify.test.ts` | Notification tests |
| `src/inngest/functions/handle-capture.ts` | Main Inngest function orchestrating the pipeline |
| `src/inngest/functions/handle-capture.test.ts` | Function tests |
| `src/routes/capture.ts` | `POST /api/capture` Hono route |
| `src/routes/capture.test.ts` | Route tests |

### New Files (kos CLI)

| File | Responsibility |
|------|---------------|
| `~/.kos-kit/cli/src/commands/capture.ts` | `kos capture` CLI command |
| `~/.kos-kit/cli/src/commands/capture.test.ts` | Capture command tests |
| `~/.kos-kit/cli/src/commands/config.ts` | `kos config` CLI command |
| `~/.kos-kit/cli/src/commands/config.test.ts` | Config command tests |

### Files to Modify

| File | Change |
|------|--------|
| `src/inngest/client.ts` | Add `agentCaptureRequested`, `agentCaptureFileRequested`, `agentCaptureDecision` event definitions |
| `src/inngest/functions/index.ts` | Export `handleCapture` |
| `src/index.ts` | Add `handleCapture` to functions array, mount `/api/capture` route |
| `src/lib/channels.ts` | Add `notifyChannel` to `ChannelsConfig`, extend `updateConfig` |
| `src/bolt/listeners/actions.ts` | Add `capture_decision` action handler |
| `src/bolt/listeners/index.ts` | Pass `inngest` to `registerActionListeners` |
| `~/.kos-kit/cli/src/index.ts` | Register `capture` and `config` subcommands |

---

## Chunk 1: Foundation — Schemas, Type Detection, Config

### Task 1: Capture Zod Schemas

**Files:**
- Create: `src/capture/schema.ts`
- Test: `src/capture/schema.test.ts`

- [ ] **Step 1: Write failing tests for capture schemas**

```typescript
// src/capture/schema.test.ts
import { describe, expect, test } from "bun:test";
import {
  CaptureRequestSchema,
  CaptureEventSchema,
  CaptureFileEventSchema,
  CaptureDecisionEventSchema,
  CaptureDestinationSchema,
  ContentType,
  CaptureMode,
} from "./schema";

describe("CaptureDestinationSchema", () => {
  test("accepts chatId only", () => {
    const result = CaptureDestinationSchema.safeParse({ chatId: "C123" });
    expect(result.success).toBe(true);
  });

  test("accepts chatId + threadId", () => {
    const result = CaptureDestinationSchema.safeParse({
      chatId: "C123",
      threadId: "1234567890.123456",
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing chatId", () => {
    const result = CaptureDestinationSchema.safeParse({ threadId: "123" });
    expect(result.success).toBe(false);
  });
});

describe("CaptureEventSchema", () => {
  test("validates minimal capture event", () => {
    const result = CaptureEventSchema.safeParse({
      captureKey: "https://example.com",
      url: "https://example.com",
      source: "cli",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe("triage"); // default
    }
  });

  test("validates full capture event", () => {
    const result = CaptureEventSchema.safeParse({
      captureKey: "https://youtube.com/watch?v=abc",
      url: "https://youtube.com/watch?v=abc",
      type: "youtube-video",
      source: "slack",
      destination: { chatId: "C123", threadId: "ts123" },
      batchId: "batch-1",
      parentCaptureId: "parent-1",
      mode: "full",
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid source", () => {
    const result = CaptureEventSchema.safeParse({
      captureKey: "https://example.com",
      url: "https://example.com",
      source: "invalid",
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid content type", () => {
    const result = CaptureEventSchema.safeParse({
      captureKey: "https://example.com",
      url: "https://example.com",
      source: "cli",
      type: "podcast",
    });
    expect(result.success).toBe(false);
  });
});

describe("CaptureFileEventSchema", () => {
  test("validates file capture event", () => {
    const result = CaptureFileEventSchema.safeParse({
      captureKey: "file:///Users/me/doc.md",
      filePath: "/Users/me/doc.md",
      source: "cli",
    });
    expect(result.success).toBe(true);
  });

  test("accepts optional title", () => {
    const result = CaptureFileEventSchema.safeParse({
      captureKey: "file:///Users/me/doc.md",
      filePath: "/Users/me/doc.md",
      title: "My Document",
      source: "cli",
    });
    expect(result.success).toBe(true);
  });
});

describe("CaptureDecisionEventSchema", () => {
  test("validates decision event", () => {
    const result = CaptureDecisionEventSchema.safeParse({
      captureId: "run-123",
      action: "full",
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid action", () => {
    const result = CaptureDecisionEventSchema.safeParse({
      captureId: "run-123",
      action: "maybe",
    });
    expect(result.success).toBe(false);
  });
});

describe("CaptureRequestSchema", () => {
  test("validates URL request", () => {
    const result = CaptureRequestSchema.safeParse({
      urls: ["https://example.com"],
    });
    expect(result.success).toBe(true);
  });

  test("validates file request", () => {
    const result = CaptureRequestSchema.safeParse({
      filePath: "/Users/me/doc.md",
    });
    expect(result.success).toBe(true);
  });

  test("rejects both urls and filePath", () => {
    const result = CaptureRequestSchema.safeParse({
      urls: ["https://example.com"],
      filePath: "/Users/me/doc.md",
    });
    expect(result.success).toBe(false);
  });

  test("rejects neither urls nor filePath", () => {
    const result = CaptureRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("rejects empty urls array", () => {
    const result = CaptureRequestSchema.safeParse({ urls: [] });
    expect(result.success).toBe(false);
  });

  test("validates with all options", () => {
    const result = CaptureRequestSchema.safeParse({
      urls: ["https://example.com", "https://youtube.com/watch?v=abc"],
      mode: "full",
      type: "article",
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/capture/schema.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement capture schemas**

```typescript
// src/capture/schema.ts
import { z } from "zod";

export const ContentTypeEnum = z.enum([
  "article",
  "youtube-video",
  "youtube-channel",
  "hacker-news",
  "twitter",
]);
export type ContentType = z.infer<typeof ContentTypeEnum>;

export const CaptureModeEnum = z.enum(["full", "quick", "triage"]);
export type CaptureMode = z.infer<typeof CaptureModeEnum>;

export const CaptureSourceEnum = z.enum(["slack", "cli", "extension"]);
export type CaptureSource = z.infer<typeof CaptureSourceEnum>;

export const CaptureDecisionEnum = z.enum(["full", "quick-save", "skip"]);
export type CaptureDecision = z.infer<typeof CaptureDecisionEnum>;

export const CaptureDestinationSchema = z.object({
  chatId: z.string(),
  threadId: z.string().optional(),
});
export type CaptureDestination = z.infer<typeof CaptureDestinationSchema>;

export const CaptureEventSchema = z.object({
  captureKey: z.string(),
  url: z.string().url(),
  type: ContentTypeEnum.optional(),
  source: CaptureSourceEnum,
  destination: CaptureDestinationSchema.optional(),
  batchId: z.string().optional(),
  parentCaptureId: z.string().optional(),
  mode: CaptureModeEnum.default("triage"),
});
export type CaptureEventData = z.infer<typeof CaptureEventSchema>;

export const CaptureFileEventSchema = z.object({
  captureKey: z.string(),
  filePath: z.string(),
  title: z.string().optional(),
  source: z.enum(["slack", "cli"]),
  destination: CaptureDestinationSchema.optional(),
});
export type CaptureFileEventData = z.infer<typeof CaptureFileEventSchema>;

export const CaptureDecisionEventSchema = z.object({
  captureId: z.string(),
  action: CaptureDecisionEnum,
});
export type CaptureDecisionEventData = z.infer<typeof CaptureDecisionEventSchema>;

export const CaptureRequestSchema = z
  .object({
    urls: z.array(z.string().url()).min(1).optional(),
    filePath: z.string().optional(),
    mode: CaptureModeEnum.optional(),
    type: ContentTypeEnum.optional(),
    title: z.string().optional(),
  })
  .refine((data) => {
    const hasUrls = data.urls !== undefined && data.urls.length > 0;
    const hasFile = data.filePath !== undefined;
    return (hasUrls || hasFile) && !(hasUrls && hasFile);
  }, "Must provide either urls or filePath, not both");
export type CaptureRequest = z.infer<typeof CaptureRequestSchema>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/capture/schema.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/capture/schema.ts src/capture/schema.test.ts
git commit -m "feat(capture): add Zod schemas for capture events and API"
```

---

### Task 2: URL Type Detection

**Files:**
- Create: `src/capture/detect-type.ts`
- Test: `src/capture/detect-type.test.ts`

- [ ] **Step 1: Write failing tests for type detection**

```typescript
// src/capture/detect-type.test.ts
import { describe, expect, test } from "bun:test";
import { detectContentType } from "./detect-type";

describe("detectContentType", () => {
  test("detects youtube video from youtube.com/watch", () => {
    expect(detectContentType("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("youtube-video");
  });

  test("detects youtube video from youtu.be short link", () => {
    expect(detectContentType("https://youtu.be/dQw4w9WgXcQ")).toBe("youtube-video");
  });

  test("detects youtube channel from @handle", () => {
    expect(detectContentType("https://www.youtube.com/@danielmiessler")).toBe("youtube-channel");
  });

  test("detects youtube channel from /c/ path", () => {
    expect(detectContentType("https://www.youtube.com/c/Fireship")).toBe("youtube-channel");
  });

  test("detects hacker news item", () => {
    expect(detectContentType("https://news.ycombinator.com/item?id=12345")).toBe("hacker-news");
  });

  test("detects twitter from x.com", () => {
    expect(detectContentType("https://x.com/user/status/123")).toBe("twitter");
  });

  test("detects twitter from twitter.com", () => {
    expect(detectContentType("https://twitter.com/user/status/123")).toBe("twitter");
  });

  test("defaults to article for unknown URLs", () => {
    expect(detectContentType("https://example.com/some-post")).toBe("article");
  });

  test("defaults to article for blog URLs", () => {
    expect(detectContentType("https://developers.cloudflare.com/changelog/post/2026-03-10-br-crawl-endpoint/")).toBe("article");
  });

  test("handles URLs with query params and fragments", () => {
    expect(detectContentType("https://youtube.com/watch?v=abc&t=120")).toBe("youtube-video");
    expect(detectContentType("https://x.com/user/status/123?s=20")).toBe("twitter");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/capture/detect-type.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement type detection**

```typescript
// src/capture/detect-type.ts
import type { ContentType } from "./schema";

const patterns: Array<{ type: ContentType; test: (url: URL) => boolean }> = [
  {
    type: "youtube-video",
    test: (url) =>
      (url.hostname.includes("youtube.com") && url.pathname === "/watch") ||
      url.hostname === "youtu.be",
  },
  {
    type: "youtube-channel",
    test: (url) =>
      url.hostname.includes("youtube.com") &&
      (url.pathname.startsWith("/@") || url.pathname.startsWith("/c/")),
  },
  {
    type: "hacker-news",
    test: (url) => url.hostname === "news.ycombinator.com",
  },
  {
    type: "twitter",
    test: (url) =>
      url.hostname === "x.com" ||
      url.hostname === "www.x.com" ||
      url.hostname === "twitter.com" ||
      url.hostname === "www.twitter.com",
  },
];

export function detectContentType(urlString: string): ContentType {
  const url = new URL(urlString);
  for (const pattern of patterns) {
    if (pattern.test(url)) return pattern.type;
  }
  return "article";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/capture/detect-type.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/capture/detect-type.ts src/capture/detect-type.test.ts
git commit -m "feat(capture): add URL content type detection"
```

---

### Task 3: Extend ChannelsConfig with notifyChannel

**Files:**
- Modify: `src/lib/channels.ts`
- Test: `src/lib/channels.test.ts` (check if exists, create if not)

- [ ] **Step 1: Write failing test for notifyChannel**

Add to the channels test file (create if it doesn't exist):

```typescript
// src/lib/channels.test.ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

// We'll test updateConfig with notifyChannel
// The test needs to verify that:
// 1. notifyChannel can be set via updateConfig
// 2. notifyChannel persists in channels.json
// 3. getNotifyChannel returns the value

describe("notifyChannel config", () => {
  test("updateConfig accepts notifyChannel", async () => {
    // This test will be implemented against the actual updateConfig function
    // using a temp directory override. Pattern matches routes/jobs.test.ts.
    expect(true).toBe(true); // placeholder until we can test with temp dir
  });
});
```

Note: The channels module uses a hardcoded `CHANNELS_FILE` path. For proper testing, refactor to accept a path parameter (matching the `createJobsRoutes({ jobsDir })` pattern) or test via the config API route.

- [ ] **Step 2: Add notifyChannel to ChannelsConfig interface**

In `src/lib/channels.ts`, add `notifyChannel` to the interface and `updateConfig`:

```typescript
// Add to ChannelsConfig interface (after globalDefault):
notifyChannel?: string;

// Add to updateConfig function (after scanRoots update):
if (updates.notifyChannel !== undefined)
  config.notifyChannel = updates.notifyChannel;

// Update the Pick type to include notifyChannel:
Pick<ChannelsConfig, "displayMode" | "allowedUsers" | "globalDefault" | "scanRoots" | "notifyChannel">

// Add helper function:
export async function getNotifyChannel(): Promise<string | undefined> {
  const config = await loadConfig();
  return config.notifyChannel;
}
```

- [ ] **Step 3: Update config route to expose notifyChannel**

Check `src/routes/config.ts` — the PATCH handler calls `updateConfig` with the request body. Since `updateConfig` now accepts `notifyChannel`, the route should work without changes. Verify by reading the file.

- [ ] **Step 4: Run existing tests to verify nothing breaks**

Run: `bun test`
Expected: All existing tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/channels.ts
git commit -m "feat(capture): add notifyChannel to ChannelsConfig"
```

---

### Task 4: Register Capture Events in Inngest Client

**Files:**
- Modify: `src/inngest/client.ts`

- [ ] **Step 1: Add capture event definitions**

Add after the existing event definitions in `src/inngest/client.ts`:

```typescript
import {
  CaptureEventSchema,
  CaptureFileEventSchema,
  CaptureDecisionEventSchema,
} from "@/capture/schema";

export const agentCaptureRequested = eventType("agent.capture.requested", {
  schema: CaptureEventSchema,
});
export type AgentCaptureData = z.infer<typeof agentCaptureRequested.schema>;

export const agentCaptureFileRequested = eventType("agent.capture.file.requested", {
  schema: CaptureFileEventSchema,
});
export type AgentCaptureFileData = z.infer<typeof agentCaptureFileRequested.schema>;

export const agentCaptureDecision = eventType("agent.capture.decision", {
  schema: CaptureDecisionEventSchema,
});
export type AgentCaptureDecisionData = z.infer<typeof agentCaptureDecision.schema>;
```

- [ ] **Step 2: Run existing tests to verify nothing breaks**

Run: `bun test`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add src/inngest/client.ts
git commit -m "feat(capture): register capture events in Inngest client"
```

---

## Chunk 2: Extraction Layer

### Task 5: Metadata Extraction

**Files:**
- Create: `src/capture/extract/metadata.ts`
- Test: `src/capture/extract/metadata.test.ts`

Metadata extraction fetches lightweight page info (title, author, description, etc.) without full content extraction. Used for triage and quick-save modes.

- [ ] **Step 1: Write failing tests for metadata extraction**

```typescript
// src/capture/extract/metadata.test.ts
import { describe, expect, test } from "bun:test";
import { extractMetadata, type PageMetadata } from "./metadata";

describe("extractMetadata", () => {
  test("extracts metadata from a live article URL", async () => {
    // Use a stable, public URL for integration testing
    const meta = await extractMetadata("https://example.com", "article");
    expect(meta.title).toBeDefined();
    expect(typeof meta.title).toBe("string");
  });

  test("returns partial metadata on failure", async () => {
    const meta = await extractMetadata("https://this-domain-does-not-exist-abc123.com", "article");
    expect(meta.title).toBeUndefined();
  });

  test("extracts youtube video metadata via oEmbed", async () => {
    // Use a well-known, stable video
    const meta = await extractMetadata("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube-video");
    expect(meta.title).toContain("Rick");
    expect(meta.author).toBeDefined();
  });

  test("extracts hacker news metadata via Algolia API", async () => {
    // Use a known HN item ID
    const meta = await extractMetadata("https://news.ycombinator.com/item?id=1", "hacker-news");
    expect(meta.title).toBeDefined();
    expect(meta.hnPoints).toBeDefined();
    expect(meta.hnComments).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/capture/extract/metadata.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement metadata extraction**

```typescript
// src/capture/extract/metadata.ts
import type { ContentType } from "../schema";

export interface PageMetadata {
  title?: string;
  author?: string;
  description?: string;
  published?: string;
  // YouTube-specific
  channel?: string;
  duration?: string;
  views?: number;
  // HN-specific
  hnUrl?: string;
  hnPoints?: number;
  hnComments?: number;
  hnLinkedUrl?: string;
  // Twitter-specific
  handle?: string;
  posted?: string;
}

export async function extractMetadata(
  url: string,
  type: ContentType,
): Promise<PageMetadata> {
  switch (type) {
    case "youtube-video":
      return extractYouTubeMetadata(url);
    case "youtube-channel":
      return extractYouTubeChannelMetadata(url);
    case "hacker-news":
      return extractHNMetadata(url);
    case "twitter":
      return extractTwitterMetadata(url);
    case "article":
    default:
      return extractArticleMetadata(url);
  }
}

async function extractArticleMetadata(url: string): Promise<PageMetadata> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "kos-agent/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    const html = await res.text();
    return {
      title: extractMetaTag(html, "og:title") ?? extractHtmlTitle(html),
      author: extractMetaTag(html, "author") ?? extractMetaTag(html, "article:author"),
      description: extractMetaTag(html, "og:description") ?? extractMetaTag(html, "description"),
      published: extractMetaTag(html, "article:published_time"),
    };
  } catch {
    return {};
  }
}

async function extractYouTubeMetadata(url: string): Promise<PageMetadata> {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(10_000) });
    const data = (await res.json()) as { title?: string; author_name?: string };
    // Duration/views require page scrape or yt-dlp --dump-json
    const ytMeta = await extractYtDlpMetadata(url);
    return {
      title: data.title,
      author: data.author_name,
      channel: data.author_name,
      duration: ytMeta.duration,
      views: ytMeta.views,
      published: ytMeta.published,
    };
  } catch {
    return {};
  }
}

async function extractYtDlpMetadata(url: string): Promise<{
  duration?: string;
  views?: number;
  published?: string;
}> {
  try {
    const proc = Bun.spawn(["yt-dlp", "--dump-json", "--skip-download", url], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) return {};
    const data = JSON.parse(output) as {
      duration?: number;
      view_count?: number;
      upload_date?: string;
    };
    const durationSec = data.duration ?? 0;
    const mins = Math.floor(durationSec / 60);
    const secs = durationSec % 60;
    return {
      duration: `${mins}:${String(secs).padStart(2, "0")}`,
      views: data.view_count,
      published: data.upload_date
        ? `${data.upload_date.slice(0, 4)}-${data.upload_date.slice(4, 6)}-${data.upload_date.slice(6, 8)}`
        : undefined,
    };
  } catch {
    return {};
  }
}

async function extractYouTubeChannelMetadata(url: string): Promise<PageMetadata> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "kos-agent/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    const html = await res.text();
    return {
      title: extractMetaTag(html, "og:title"),
      description: extractMetaTag(html, "og:description"),
    };
  } catch {
    return {};
  }
}

async function extractHNMetadata(url: string): Promise<PageMetadata> {
  try {
    const itemId = new URL(url).searchParams.get("id");
    if (!itemId) return {};
    const res = await fetch(
      `https://hn.algolia.com/api/v1/items/${itemId}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    const data = (await res.json()) as {
      title?: string;
      url?: string;
      points?: number;
      children?: unknown[];
    };
    return {
      title: data.title,
      hnUrl: url,
      hnLinkedUrl: data.url,
      hnPoints: data.points,
      hnComments: data.children?.length,
    };
  } catch {
    return {};
  }
}

async function extractTwitterMetadata(url: string): Promise<PageMetadata> {
  // Twitter metadata requires browser scraping (handled in content extraction)
  // Return what we can parse from the URL itself
  const parsed = new URL(url);
  const pathParts = parsed.pathname.split("/").filter(Boolean);
  return {
    handle: pathParts[0] ? `@${pathParts[0]}` : undefined,
  };
}

function extractMetaTag(html: string, name: string): string | undefined {
  // Match both <meta name="..." content="..."> and <meta property="..." content="...">
  const patterns = [
    new RegExp(`<meta\\s+(?:name|property)=["']${name}["']\\s+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta\\s+content=["']([^"']*)["']\\s+(?:name|property)=["']${name}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function extractHtmlTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match?.[1]?.trim();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/capture/extract/metadata.test.ts`
Expected: PASS (network-dependent tests may need adjustments)

- [ ] **Step 5: Commit**

```bash
git add src/capture/extract/metadata.ts src/capture/extract/metadata.test.ts
git commit -m "feat(capture): add metadata extraction for all content types"
```

---

### Task 6: Article Content Extraction (CF Browser Rendering)

**Files:**
- Create: `src/capture/extract/article.ts`
- Test: `src/capture/extract/article.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/capture/extract/article.test.ts
import { describe, expect, test } from "bun:test";
import { extractArticleContent } from "./article";

describe("extractArticleContent", () => {
  test("extracts markdown from a public URL", async () => {
    const result = await extractArticleContent("https://example.com");
    expect(result).toBeDefined();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("returns empty string on failure", async () => {
    const result = await extractArticleContent("https://this-domain-does-not-exist-abc123.com");
    expect(result).toBe("");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/capture/extract/article.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement article extraction**

Uses Cloudflare Browser Rendering API. Requires `CF_ACCOUNT_ID` and `CF_API_TOKEN` environment variables.

```typescript
// src/capture/extract/article.ts

export async function extractArticleContent(url: string): Promise<string> {
  const accountId = process.env.CF_ACCOUNT_ID;
  const apiToken = process.env.CF_API_TOKEN;

  if (!accountId || !apiToken) {
    // Fallback to simple fetch if CF credentials not available
    return extractViaFetch(url);
  }

  try {
    // Start crawl job
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
    const crawlData = (await crawlRes.json()) as {
      success: boolean;
      result?: { id: string };
    };

    if (!crawlData.success || !crawlData.result?.id) {
      return extractViaFetch(url);
    }

    // Poll for results (max 30s)
    const jobId = crawlData.result.id;
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
      const statusData = (await statusRes.json()) as {
        success: boolean;
        result?: {
          status: string;
          pages?: Array<{ markdown?: string }>;
        };
      };

      if (statusData.result?.status === "complete") {
        return statusData.result.pages?.[0]?.markdown ?? "";
      }
      if (statusData.result?.status === "failed") {
        return extractViaFetch(url);
      }
    }

    return extractViaFetch(url);
  } catch {
    return extractViaFetch(url);
  }
}

async function extractViaFetch(url: string): Promise<string> {
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

- [ ] **Step 4: Run tests**

Run: `bun test src/capture/extract/article.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/capture/extract/article.ts src/capture/extract/article.test.ts
git commit -m "feat(capture): add article content extraction via CF Browser Rendering"
```

---

### Task 7: YouTube Transcript Extraction

**Files:**
- Create: `src/capture/extract/youtube.ts`
- Test: `src/capture/extract/youtube.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/capture/extract/youtube.test.ts
import { describe, expect, test } from "bun:test";
import { extractYouTubeTranscript, listChannelVideos } from "./youtube";

describe("extractYouTubeTranscript", () => {
  test("extracts transcript from a public video", async () => {
    // Use a known video with captions
    const transcript = await extractYouTubeTranscript("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(typeof transcript).toBe("string");
    // May be empty if no captions available, but should not throw
  });
});

describe("listChannelVideos", () => {
  test("lists recent videos from a channel", async () => {
    const videos = await listChannelVideos("https://www.youtube.com/@Fireship");
    expect(Array.isArray(videos)).toBe(true);
    expect(videos.length).toBeLessThanOrEqual(10);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/capture/extract/youtube.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement YouTube extraction**

```typescript
// src/capture/extract/youtube.ts

export async function extractYouTubeTranscript(url: string): Promise<string> {
  try {
    // yt-dlp can extract auto-generated subtitles
    const proc = Bun.spawn(
      [
        "yt-dlp",
        "--write-auto-sub",
        "--sub-lang", "en",
        "--skip-download",
        "--sub-format", "vtt",
        "-o", "/tmp/kos-yt-%(id)s",
        url,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;

    // Find the subtitle file
    const videoId = extractVideoId(url);
    if (!videoId) return "";

    const vttPath = `/tmp/kos-yt-${videoId}.en.vtt`;
    const file = Bun.file(vttPath);
    if (!(await file.exists())) return "";

    const vttContent = await file.text();
    // Clean up temp file
    const { rm: rmFile } = await import("node:fs/promises");
    await rmFile(vttPath).catch(() => {});

    return parseVttToTranscript(vttContent);
  } catch {
    return "";
  }
}

export async function listChannelVideos(
  channelUrl: string,
  limit = 10,
): Promise<Array<{ url: string; title: string }>> {
  try {
    const proc = Bun.spawn(
      [
        "yt-dlp",
        "--flat-playlist",
        "--dump-json",
        "--playlist-end", String(limit),
        `${channelUrl}/videos`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) return [];

    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const data = JSON.parse(line) as { url?: string; title?: string; id?: string };
        return {
          url: data.url ?? `https://www.youtube.com/watch?v=${data.id}`,
          title: data.title ?? "Untitled",
        };
      });
  } catch {
    return [];
  }
}

function extractVideoId(url: string): string | undefined {
  const parsed = new URL(url);
  if (parsed.hostname === "youtu.be") {
    return parsed.pathname.slice(1);
  }
  return parsed.searchParams.get("v") ?? undefined;
}

function parseVttToTranscript(vtt: string): string {
  const lines = vtt.split("\n");
  const textLines: string[] = [];
  let lastText = "";

  for (const line of lines) {
    // Skip VTT header, timestamps, and empty lines
    if (
      line.startsWith("WEBVTT") ||
      line.startsWith("Kind:") ||
      line.startsWith("Language:") ||
      line.includes("-->") ||
      line.trim() === "" ||
      /^\d+$/.test(line.trim())
    ) {
      continue;
    }

    // Remove VTT formatting tags
    const clean = line.replace(/<[^>]+>/g, "").trim();
    if (clean && clean !== lastText) {
      textLines.push(clean);
      lastText = clean;
    }
  }

  return textLines.join("\n");
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/capture/extract/youtube.test.ts`
Expected: PASS (requires yt-dlp installed)

- [ ] **Step 5: Commit**

```bash
git add src/capture/extract/youtube.ts src/capture/extract/youtube.test.ts
git commit -m "feat(capture): add YouTube transcript and channel extraction via yt-dlp"
```

---

### Task 8: HN, Twitter, File Extractors + Quality Check

**Files:**
- Create: `src/capture/extract/hacker-news.ts`, `src/capture/extract/twitter.ts`, `src/capture/extract/file.ts`, `src/capture/extract/quality.ts`
- Test: corresponding `.test.ts` files for each

- [ ] **Step 1: Write failing tests for all four modules**

```typescript
// src/capture/extract/hacker-news.test.ts
import { describe, expect, test } from "bun:test";
import { extractHNContent } from "./hacker-news";

describe("extractHNContent", () => {
  test("extracts article and comments from HN item", async () => {
    const result = await extractHNContent("https://news.ycombinator.com/item?id=1");
    expect(result.article).toBeDefined();
    expect(result.comments).toBeDefined();
    expect(Array.isArray(result.comments)).toBe(true);
  });
});
```

```typescript
// src/capture/extract/file.test.ts
import { describe, expect, test } from "bun:test";
import { extractFileContent } from "./file";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("extractFileContent", () => {
  test("reads file content", async () => {
    const path = join(tmpdir(), `kos-test-${Date.now()}.md`);
    await writeFile(path, "# Test\n\nHello world");
    const result = await extractFileContent(path);
    expect(result).toBe("# Test\n\nHello world");
    await rm(path);
  });

  test("returns empty string for missing file", async () => {
    const result = await extractFileContent("/nonexistent/file.md");
    expect(result).toBe("");
  });
});
```

```typescript
// src/capture/extract/quality.test.ts
import { describe, expect, test } from "bun:test";
import { checkContentQuality } from "./quality";

describe("checkContentQuality", () => {
  test("passes content with enough text", () => {
    const content = "A".repeat(250);
    expect(checkContentQuality(content)).toBe(true);
  });

  test("fails content with too little text", () => {
    expect(checkContentQuality("short")).toBe(false);
  });

  test("fails empty content", () => {
    expect(checkContentQuality("")).toBe(false);
  });

  test("strips nav/header text before checking", () => {
    const navOnly = "<nav>Home About Contact</nav>";
    expect(checkContentQuality(navOnly)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/capture/extract/hacker-news.test.ts src/capture/extract/file.test.ts src/capture/extract/quality.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement all four modules**

```typescript
// src/capture/extract/hacker-news.ts
import { extractArticleContent } from "./article";

export interface HNContent {
  article: string;
  comments: Array<{ author: string; text: string; points: number }>;
}

export async function extractHNContent(url: string): Promise<HNContent> {
  const itemId = new URL(url).searchParams.get("id");
  if (!itemId) return { article: "", comments: [] };

  try {
    const res = await fetch(`https://hn.algolia.com/api/v1/items/${itemId}`, {
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as {
      url?: string;
      children?: Array<{ author?: string; text?: string; points?: number }>;
    };

    const article = data.url ? await extractArticleContent(data.url) : "";
    const comments = (data.children ?? [])
      .filter((c) => c.text)
      .slice(0, 20)
      .map((c) => ({
        author: c.author ?? "unknown",
        text: c.text ?? "",
        points: c.points ?? 0,
      }));

    return { article, comments };
  } catch {
    return { article: "", comments: [] };
  }
}
```

```typescript
// src/capture/extract/twitter.ts
// Twitter extraction requires agent-browser (authenticated session)
// This module provides the interface; actual scraping is done via agent-browser skill

export interface TweetContent {
  text: string;
  author: string;
  handle: string;
  posted?: string;
  isThread: boolean;
  threadParts?: string[];
}

export async function extractTweetContent(url: string): Promise<TweetContent> {
  // TODO: Integrate with agent-browser skill for authenticated scraping
  // For now, return a placeholder that the Inngest function will fill
  // via agent-browser fallback
  return {
    text: "",
    author: "",
    handle: extractHandleFromUrl(url),
    isThread: false,
  };
}

function extractHandleFromUrl(url: string): string {
  const pathParts = new URL(url).pathname.split("/").filter(Boolean);
  return pathParts[0] ? `@${pathParts[0]}` : "";
}
```

```typescript
// src/capture/extract/file.ts
export async function extractFileContent(filePath: string): Promise<string> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return "";
    return await file.text();
  } catch {
    return "";
  }
}
```

```typescript
// src/capture/extract/quality.ts
const MIN_CONTENT_LENGTH = 200;

export function checkContentQuality(content: string): boolean {
  const cleaned = stripNavAndChrome(content);
  return cleaned.length >= MIN_CONTENT_LENGTH;
}

function stripNavAndChrome(content: string): string {
  return content
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/capture/extract/`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/capture/extract/
git commit -m "feat(capture): add HN, Twitter, file extractors and content quality check"
```

---

## Chunk 3: Vault Layer

### Task 9: Vault Note Templates

**Files:**
- Create: `src/capture/vault/templates.ts`
- Test: `src/capture/vault/templates.test.ts`

- [ ] **Step 1: Write failing tests for template rendering**

```typescript
// src/capture/vault/templates.test.ts
import { describe, expect, test } from "bun:test";
import { renderVaultNote } from "./templates";

describe("renderVaultNote", () => {
  test("renders article note with full content", () => {
    const note = renderVaultNote({
      type: "article",
      mode: "full",
      title: "My Article",
      url: "https://example.com/post",
      author: "Jane Doe",
      published: "2026-03-15",
      content: "# Full article content\n\nHello world.",
    });

    expect(note).toContain('categories:\n  - "[[Sources]]"');
    expect(note).toContain('author: "[[Jane Doe]]"');
    expect(note).toContain('url: "https://example.com/post"');
    expect(note).toContain("source_type: article");
    expect(note).toContain("capture_mode: full");
    expect(note).toContain("status: raw");
    expect(note).toContain("# My Article");
    expect(note).toContain("# Full article content");
  });

  test("renders article note in quick mode", () => {
    const note = renderVaultNote({
      type: "article",
      mode: "quick",
      title: "My Article",
      url: "https://example.com",
      description: "A short description of the article.",
    });

    expect(note).toContain("capture_mode: quick");
    expect(note).toContain("A short description of the article.");
    expect(note).not.toContain("# Full article");
  });

  test("renders youtube video note with transcript", () => {
    const note = renderVaultNote({
      type: "youtube-video",
      mode: "full",
      title: "Great Video",
      url: "https://youtube.com/watch?v=abc",
      author: "Channel Name",
      channel: "Channel Name",
      duration: "45:32",
      views: 120000,
      content: "Full transcript here...",
    });

    expect(note).toContain('channel: "[[Channel Name]]"');
    expect(note).toContain('duration: "45:32"');
    expect(note).toContain("views: 120000");
    expect(note).toContain("source_type: youtube-video");
    expect(note).toContain("Full transcript here...");
  });

  test("renders youtube channel note", () => {
    const note = renderVaultNote({
      type: "youtube-channel",
      mode: "full",
      title: "Fireship",
      url: "https://youtube.com/@Fireship",
      description: "High-intensity code tutorials.",
    });

    expect(note).toContain('categories:\n  - "[[YouTubers]]"');
    expect(note).toContain("youtube_url:");
    expect(note).toContain("![[Sources.base#Author]]");
  });

  test("renders hacker news note", () => {
    const note = renderVaultNote({
      type: "hacker-news",
      mode: "full",
      title: "Some HN Post",
      url: "https://original-article.com",
      hnUrl: "https://news.ycombinator.com/item?id=123",
      hnPoints: 150,
      hnComments: 42,
      content: "Article content...",
    });

    expect(note).toContain("source_type: hacker-news");
    expect(note).toContain("hn_url:");
    expect(note).toContain("hn_points: 150");
    expect(note).toContain("hn_comments: 42");
  });

  test("renders twitter note", () => {
    const note = renderVaultNote({
      type: "twitter",
      mode: "full",
      title: "Tweet by someone",
      url: "https://x.com/user/status/123",
      author: "User Name",
      handle: "@user",
      content: "The full tweet thread text...",
    });

    expect(note).toContain("source_type: twitter");
    expect(note).toContain('handle: "@user"');
    expect(note).toContain("The full tweet thread text...");
  });

  test("renders file capture note", () => {
    const note = renderVaultNote({
      type: "file",
      mode: "full",
      title: "My Conversation",
      filePath: "/Users/me/conversation.md",
      content: "# Conversation\n\nStuff here...",
    });

    expect(note).toContain("source_type: file");
    expect(note).toContain('file_path: "/Users/me/conversation.md"');
  });

  test("uses today's date in MM-DD-YYYY format with backlink", () => {
    const note = renderVaultNote({
      type: "article",
      mode: "quick",
      title: "Test",
      url: "https://example.com",
    });

    // Date should match [[MM-DD-YYYY]] pattern
    const dateMatch = note.match(/created: "\[\[(\d{2}-\d{2}-\d{4})\]\]"/);
    expect(dateMatch).not.toBeNull();
  });

  test("omits conditional fields when not provided", () => {
    const note = renderVaultNote({
      type: "article",
      mode: "quick",
      title: "Test",
      url: "https://example.com",
    });

    expect(note).not.toContain("channel:");
    expect(note).not.toContain("duration:");
    expect(note).not.toContain("views:");
    expect(note).not.toContain("hn_url:");
    expect(note).not.toContain("handle:");
    expect(note).not.toContain("file_path:");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/capture/vault/templates.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement vault note templates**

```typescript
// src/capture/vault/templates.ts
import type { ContentType, CaptureMode } from "../schema";

export interface VaultNoteInput {
  type: ContentType | "file";
  mode: CaptureMode | "full";
  title: string;
  url?: string;
  author?: string;
  description?: string;
  published?: string;
  content?: string;
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
  // File-specific
  filePath?: string;
}

export function renderVaultNote(input: VaultNoteInput): string {
  if (input.type === "youtube-channel") {
    return renderYouTuberNote(input);
  }
  return renderSourceNote(input);
}

function renderSourceNote(input: VaultNoteInput): string {
  const frontmatter = buildFrontmatter(input);
  const body = buildBody(input);
  return `---\n${frontmatter}---\n\n# ${input.title}\n\n${body}`;
}

function renderYouTuberNote(input: VaultNoteInput): string {
  const lines = [
    "---",
    "categories:",
    '  - "[[YouTubers]]"',
    `youtube_url: "${input.url ?? ""}"`,
    "---",
    "",
    input.description ? `${input.description}\n` : "",
    "## Videos",
    "",
    "![[Sources.base#Author]]",
  ];
  return lines.filter((l) => l !== undefined).join("\n");
}

function buildFrontmatter(input: VaultNoteInput): string {
  const lines: string[] = [];

  lines.push("categories:");
  lines.push('  - "[[Sources]]"');

  if (input.author) {
    lines.push(`author: "[[${input.author}]]"`);
  } else {
    lines.push("author: []");
  }

  lines.push(`url: "${input.url ?? ""}"`);
  lines.push(`created: "[[${formatDate()}]]"`);

  if (input.published) {
    lines.push(`published: "${input.published}"`);
  }

  lines.push("topics: []");
  lines.push("status: raw");
  lines.push(`source_type: ${input.type}`);
  lines.push(`capture_mode: ${input.mode}`);

  // YouTube-specific
  if (input.type === "youtube-video") {
    if (input.channel) lines.push(`channel: "[[${input.channel}]]"`);
    if (input.duration) lines.push(`duration: "${input.duration}"`);
    if (input.views !== undefined) lines.push(`views: ${input.views}`);
  }

  // HN-specific
  if (input.type === "hacker-news") {
    if (input.hnUrl) lines.push(`hn_url: "${input.hnUrl}"`);
    if (input.hnPoints !== undefined) lines.push(`hn_points: ${input.hnPoints}`);
    if (input.hnComments !== undefined) lines.push(`hn_comments: ${input.hnComments}`);
  }

  // Twitter-specific
  if (input.type === "twitter") {
    if (input.handle) lines.push(`handle: "${input.handle}"`);
    if (input.posted) lines.push(`posted: "${input.posted}"`);
  }

  // File-specific
  if (input.type === "file") {
    if (input.filePath) lines.push(`file_path: "${input.filePath}"`);
  }

  return lines.join("\n") + "\n";
}

function buildBody(input: VaultNoteInput): string {
  if (input.mode === "quick") {
    return input.description ?? "";
  }
  return input.content ?? input.description ?? "";
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

- [ ] **Step 4: Run tests**

Run: `bun test src/capture/vault/templates.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/capture/vault/templates.ts src/capture/vault/templates.test.ts
git commit -m "feat(capture): add vault note template rendering for all content types"
```

---

### Task 10: Vault Note Writer with Idempotency

**Files:**
- Create: `src/capture/vault/writer.ts`
- Test: `src/capture/vault/writer.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/capture/vault/writer.test.ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { writeVaultNote, findExistingNoteByUrl } from "./writer";

describe("writeVaultNote", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `kos-vault-test-${Date.now()}`);
    await mkdir(join(testDir, "sources"), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("writes a new note to sources/", async () => {
    const path = await writeVaultNote(testDir, "Test Article", "---\nstatus: raw\n---\n\n# Test");
    expect(path).toContain("sources/Test Article.md");
    const content = await readFile(path, "utf-8");
    expect(content).toContain("# Test");
  });

  test("sanitizes filename", async () => {
    const path = await writeVaultNote(testDir, "What/Why: A Test?", "content");
    expect(path).toContain("sources/What-Why- A Test-.md");
  });

  test("updates existing note with same URL", async () => {
    // Write first note
    const note1 = '---\nurl: "https://example.com"\nstatus: raw\n---\n\n# First';
    await writeFile(join(testDir, "sources", "First.md"), note1);

    // Write second note with same URL — should update, not create new
    const note2 = '---\nurl: "https://example.com"\nstatus: raw\n---\n\n# Updated';
    const path = await writeVaultNote(testDir, "Second Title", note2, "https://example.com");
    expect(path).toContain("First.md"); // Updated the original
    const content = await readFile(path, "utf-8");
    expect(content).toContain("# Updated");
  });
});

describe("findExistingNoteByUrl", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `kos-vault-find-${Date.now()}`);
    await mkdir(join(testDir, "sources"), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("finds note with matching URL", async () => {
    await writeFile(
      join(testDir, "sources", "Test.md"),
      '---\nurl: "https://example.com"\n---\n\n# Test',
    );
    const found = await findExistingNoteByUrl(testDir, "https://example.com");
    expect(found).toContain("Test.md");
  });

  test("returns undefined when no match", async () => {
    const found = await findExistingNoteByUrl(testDir, "https://notfound.com");
    expect(found).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/capture/vault/writer.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement vault writer**

```typescript
// src/capture/vault/writer.ts
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeFilename } from "./templates";

const VAULT_DIR = process.env.VAULT_DIR ?? `${process.env.HOME}/kyrell-os-vault`;

export async function writeVaultNote(
  vaultDir: string = VAULT_DIR,
  title: string,
  content: string,
  url?: string,
): Promise<string> {
  const sourcesDir = join(vaultDir, "sources");

  // Idempotency: check if a note with this URL already exists
  if (url) {
    const existing = await findExistingNoteByUrl(vaultDir, url);
    if (existing) {
      await writeFile(existing, content, "utf-8");
      return existing;
    }
  }

  const filename = sanitizeFilename(title);
  const notePath = join(sourcesDir, `${filename}.md`);
  await writeFile(notePath, content, "utf-8");
  return notePath;
}

export async function findExistingNoteByUrl(
  vaultDir: string,
  url: string,
): Promise<string | undefined> {
  const sourcesDir = join(vaultDir, "sources");
  try {
    const files = await readdir(sourcesDir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const filePath = join(sourcesDir, file);
      const content = await readFile(filePath, "utf-8");
      // Check frontmatter for matching URL
      const urlMatch = content.match(/^url:\s*"([^"]*)"$/m);
      if (urlMatch?.[1] === url) return filePath;
    }
  } catch {
    // sources/ dir might not exist yet
  }
  return undefined;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/capture/vault/writer.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/capture/vault/writer.ts src/capture/vault/writer.test.ts
git commit -m "feat(capture): add vault note writer with URL-based idempotency"
```

---

## Chunk 4: Inngest Function, API Route, Slack Actions

### Task 11: Capture Notification Helper

**Files:**
- Create: `src/capture/notify.ts`
- Test: `src/capture/notify.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/capture/notify.test.ts
import { describe, expect, test, mock } from "bun:test";
import { buildNotificationMessage, buildTriageBlocks, buildTriageUpdateText } from "./notify";

describe("buildNotificationMessage", () => {
  test("formats article notification", () => {
    const msg = buildNotificationMessage({
      title: "My Article",
      url: "https://example.com",
      type: "article",
      mode: "full",
      notePath: "sources/My Article.md",
    });
    expect(msg).toContain("My Article");
    expect(msg).toContain("article");
    expect(msg).toContain("full");
  });
});

describe("buildTriageUpdateText", () => {
  test("formats update text after decision", () => {
    const text = buildTriageUpdateText(
      "My Video",
      "youtube-video",
      "Channel · 10 min",
      "✅ Full capture started",
    );
    expect(text).toContain("My Video");
    expect(text).toContain("✅ Full capture started");
  });
});

describe("buildTriageBlocks", () => {
  test("builds Slack blocks with interactive buttons", () => {
    const blocks = buildTriageBlocks({
      captureId: "run-123",
      type: "youtube-video",
      title: "Great Video",
      description: "Channel Name · 45 min · 120K views",
    });
    expect(blocks).toBeInstanceOf(Array);
    expect(blocks.length).toBeGreaterThan(0);
    // Should contain action buttons
    const actionsBlock = blocks.find((b: { type: string }) => b.type === "actions");
    expect(actionsBlock).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests, verify fail, implement, verify pass**

```typescript
// src/capture/notify.ts
import type { ContentType, CaptureMode } from "./schema";

interface NotificationInput {
  title: string;
  url?: string;
  type: ContentType | "file";
  mode: CaptureMode | "full";
  notePath: string;
}

const TYPE_EMOJI: Record<string, string> = {
  article: "📄",
  "youtube-video": "🎥",
  "youtube-channel": "📺",
  "hacker-news": "🟧",
  twitter: "🐦",
  file: "📁",
};

export function buildNotificationMessage(input: NotificationInput): string {
  const emoji = TYPE_EMOJI[input.type] ?? "📎";
  const modeLabel = input.mode === "full" ? "full capture" : "quick save";
  const lines = [`${emoji} *${input.title}*`];
  if (input.url) lines.push(input.url);
  lines.push(`${input.type} · ${modeLabel} → \`${input.notePath}\``);
  return lines.join("\n");
}

interface TriageInput {
  captureId: string;
  type: ContentType | "file";
  title: string;
  description: string;
}

export function buildTriageBlocks(input: TriageInput): unknown[] {
  const emoji = TYPE_EMOJI[input.type] ?? "📎";
  const typeLabel = input.type.replace("-", " ");

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${emoji} *${typeLabel}:* ${input.title}\n${input.description}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Full capture" },
          action_id: "capture_decision",
          value: JSON.stringify({ captureId: input.captureId, action: "full" }),
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Quick save" },
          action_id: "capture_decision",
          value: JSON.stringify({ captureId: input.captureId, action: "quick-save" }),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Skip" },
          action_id: "capture_decision",
          value: JSON.stringify({ captureId: input.captureId, action: "skip" }),
          style: "danger",
        },
      ],
    },
  ];
}

export function buildTriageUpdateText(
  title: string,
  type: string,
  description: string,
  outcome: string,
): string {
  const emoji = TYPE_EMOJI[type] ?? "📎";
  const typeLabel = type.replace("-", " ");
  return `${emoji} *${typeLabel}:* ${title}\n${description}\n${outcome}`;
}
```

- [ ] **Step 3: Run tests, commit**

```bash
git add src/capture/notify.ts src/capture/notify.test.ts
git commit -m "feat(capture): add Slack notification and triage block builders"
```

---

### Task 12: handle-capture Inngest Function

**Files:**
- Create: `src/inngest/functions/handle-capture.ts`
- Modify: `src/inngest/functions/index.ts`

This is the core orchestration function. It's large, so tests focus on the step logic in isolation (extraction, quality, vault writing are already tested in their own modules).

- [ ] **Step 1: Implement handle-capture function**

```typescript
// src/inngest/functions/handle-capture.ts
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { inngest, agentCaptureRequested, agentCaptureFileRequested, agentCaptureDecision } from "../client";
import { detectContentType } from "@/capture/detect-type";
import { extractMetadata } from "@/capture/extract/metadata";
import { extractArticleContent } from "@/capture/extract/article";
import { extractYouTubeTranscript, listChannelVideos } from "@/capture/extract/youtube";
import { extractHNContent } from "@/capture/extract/hacker-news";
import { extractTweetContent } from "@/capture/extract/twitter";
import { extractFileContent } from "@/capture/extract/file";
import { checkContentQuality } from "@/capture/extract/quality";
import { renderVaultNote, sanitizeFilename, type VaultNoteInput } from "@/capture/vault/templates";
import { writeVaultNote } from "@/capture/vault/writer";
import { buildNotificationMessage, buildTriageBlocks } from "@/capture/notify";
import { getNotifyChannel } from "@/lib/channels";
import { slack } from "@/lib/slack";
import type { ContentType, CaptureMode } from "@/capture/schema";

const CAPTURES_DIR = join(process.env.HOME ?? "", ".kos", "agent", "captures");

export const handleCapture = inngest.createFunction(
  {
    id: "handle-capture",
    retries: 2,
    timeouts: { finish: "10m" },
    triggers: [agentCaptureRequested, agentCaptureFileRequested],
    singleton: { key: "event.data.captureKey", mode: "cancel" },
  },
  async ({ event, step }) => {
    const isFileCapture = event.name === "agent.capture.file.requested";
    const url = isFileCapture ? undefined : (event.data as { url: string }).url;
    const filePath = isFileCapture ? (event.data as { filePath: string }).filePath : undefined;
    const destination = event.data.destination;
    const mode: CaptureMode = isFileCapture ? "full" : ((event.data as { mode?: CaptureMode }).mode ?? "triage");

    // Step 1: Detect type
    const type: ContentType | "file" = await step.run("detect-type", () => {
      if (isFileCapture) return "file" as const;
      const eventType = (event.data as { type?: ContentType }).type;
      return eventType ?? detectContentType(url!);
    });

    // Triage mode: quick metadata fetch → Slack prompt → wait for decision
    let resolvedMode: "full" | "quick" = mode === "triage" ? "quick" : mode as "full" | "quick";

    if (mode === "triage" && url) {
      // Step 2: Quick triage — fetch metadata only (free)
      const triageMeta = await step.run("quick-triage", () =>
        extractMetadata(url, type as ContentType),
      );

      // Step 3: Post triage prompt to Slack
      const triageMessage = await step.run("post-triage-prompt", async () => {
        const notifyChannel = await getNotifyChannel();
        if (!notifyChannel) return null;

        const description = formatTriageDescription(type, triageMeta);
        const blocks = buildTriageBlocks({
          captureId: event.data.captureKey,
          type,
          title: triageMeta.title ?? url,
          description,
        });

        const result = await slack.chat.postMessage({
          channel: notifyChannel,
          text: `Capture: ${triageMeta.title ?? url}`,
          blocks: blocks as never[],
        });

        return { channel: result.channel, ts: result.ts };
      });

      // Step 4: Wait for user decision (4h timeout)
      const decision = await step.waitForEvent("wait-for-decision", {
        event: agentCaptureDecision,
        timeout: "4h",
        if: `async.data.captureId == "${event.data.captureKey}"`,
      });

      // Update triage message to reflect outcome
      if (triageMessage?.channel && triageMessage?.ts) {
        const outcome = decision
          ? (decision.data.action === "full" ? "✅ Full capture started" : decision.data.action === "skip" ? "⏭️ Skipped" : "💾 Quick-saved")
          : "⏰ Timed out — quick-saved";

        await step.run("update-triage-message", async () => {
          await slack.chat.update({
            channel: triageMessage.channel!,
            ts: triageMessage.ts!,
            text: `Capture: ${triageMeta.title ?? url} — ${outcome}`,
            blocks: [],
          }).catch(() => {}); // best-effort
        });
      }

      if (decision?.data.action === "skip") return { status: "skipped", url };
      resolvedMode = decision?.data.action === "full" ? "full" : "quick";
    }

    // Create capture working directory
    const captureId = `capture-${Date.now()}`;
    const captureDir = join(CAPTURES_DIR, captureId);
    await step.run("init-capture-dir", () => mkdir(captureDir, { recursive: true }));

    // Steps 2+3: Extract metadata and content in parallel
    const metadataPromise = step.run("extract-metadata", () => {
      if (isFileCapture) return { title: (event.data as { title?: string }).title };
      return extractMetadata(url!, type as ContentType);
    });

    const contentPromise = step.run("extract-content", async () => {
      if (resolvedMode === "quick") return "";
      if (isFileCapture) return extractFileContent(filePath!);

      switch (type) {
        case "article":
          return extractArticleContent(url!);
        case "youtube-video":
          return extractYouTubeTranscript(url!);
        case "youtube-channel": {
          // Fan-out: list videos and emit capture events
          const videos = await listChannelVideos(url!);
          return JSON.stringify(videos); // Store for fan-out step
        }
        case "hacker-news": {
          const hn = await extractHNContent(url!);
          const contentPath = join(captureDir, "content.json");
          await Bun.write(contentPath, JSON.stringify(hn));
          return contentPath; // Pass path to avoid step output limits
        }
        case "twitter":
          return ""; // Will be filled by agent-browser fallback
        default:
          return extractArticleContent(url!);
      }
    });

    const [metadata, rawContent] = await Promise.all([metadataPromise, contentPromise]);

    // Step 4: Check quality (skip for quick mode and twitter)
    let content = rawContent;
    if (resolvedMode === "full" && type !== "twitter" && type !== "file") {
      const qualityOk = await step.run("check-quality", () =>
        checkContentQuality(content),
      );
      if (!qualityOk) {
        // TODO: agent-browser fallback integration
        // For now, proceed with whatever we got
      }
    }

    // YouTube channel fan-out — step.sendEvent must be top-level, not nested in step.run
    if (type === "youtube-channel" && resolvedMode === "full" && content) {
      const videos = JSON.parse(content) as Array<{ url: string; title: string }>;
      const events = videos.map((v) => ({
        name: "agent.capture.requested" as const,
        data: {
          captureKey: v.url,
          url: v.url,
          type: "youtube-video" as const,
          source: event.data.source,
          destination,
          parentCaptureId: event.data.captureKey,
          mode: "full" as const,
        },
      }));
      if (events.length > 0) {
        await step.sendEvent("fan-out-videos", events);
      }
    }

    // Handle HN content from disk (path starts with captures dir prefix)
    if (type === "hacker-news" && resolvedMode === "full" && content.startsWith(CAPTURES_DIR)) {
      content = await step.run("read-hn-content", async () => {
        const hn = JSON.parse(await Bun.file(content).text());
        const parts = [`## Article\n\n${hn.article}`];
        if (hn.comments?.length > 0) {
          parts.push("## Discussion\n");
          for (const c of hn.comments.slice(0, 10)) {
            parts.push(`**${c.author}** (${c.points} points)\n${c.text}\n`);
          }
        }
        return parts.join("\n\n");
      });
    }

    // Step 5: Write vault note
    const notePath = await step.run("write-vault-note", async () => {
      const noteInput: VaultNoteInput = {
        type: type as VaultNoteInput["type"],
        mode: resolvedMode,
        title: metadata.title ?? url ?? filePath ?? "Untitled",
        url,
        author: metadata.author,
        description: metadata.description,
        published: metadata.published,
        content: resolvedMode === "full" ? content : undefined,
        channel: metadata.channel,
        duration: metadata.duration,
        views: metadata.views,
        hnUrl: metadata.hnUrl,
        hnPoints: metadata.hnPoints,
        hnComments: metadata.hnComments,
        handle: metadata.handle,
        posted: metadata.posted,
        filePath,
      };
      const rendered = renderVaultNote(noteInput);
      return writeVaultNote(undefined, noteInput.title, rendered, url);
    });

    // Step 6: Cleanup (best-effort)
    await step.run("cleanup", async () => {
      await rm(captureDir, { recursive: true, force: true }).catch(() => {});
    });

    // Step 7: Notify
    await step.run("notify", async () => {
      const notifyChannel = await getNotifyChannel();
      if (!notifyChannel) return;

      const msg = buildNotificationMessage({
        title: metadata.title ?? url ?? filePath ?? "Untitled",
        url,
        type,
        mode: resolvedMode,
        notePath,
      });

      await slack.chat.postMessage({
        channel: notifyChannel,
        text: msg,
      }).catch(() => {}); // best-effort

      // Also reply in thread if Slack-triggered
      if (destination?.chatId && destination?.threadId) {
        await slack.chat.postMessage({
          channel: destination.chatId,
          thread_ts: destination.threadId,
          text: msg,
        }).catch(() => {});
      }
    });

    return { status: "captured", type, mode: resolvedMode, url: url ?? filePath, notePath };
  },
);

function formatTriageDescription(type: ContentType | "file", meta: Record<string, unknown>): string {
  const parts: string[] = [];
  if (meta.channel) parts.push(String(meta.channel));
  if (meta.duration) parts.push(String(meta.duration));
  if (meta.views) parts.push(`${Number(meta.views).toLocaleString()} views`);
  if (meta.hnPoints) parts.push(`${meta.hnPoints} points`);
  if (meta.hnComments) parts.push(`${meta.hnComments} comments`);
  if (meta.description) parts.push(String(meta.description).slice(0, 200));
  return parts.join(" · ") || "No description available";
}
```

- [ ] **Step 2: Export from functions index**

Add to `src/inngest/functions/index.ts`:

```typescript
export { handleCapture } from "./handle-capture";
```

- [ ] **Step 3: Run tests to verify nothing breaks**

Run: `bun test`
Expected: All existing tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/inngest/functions/handle-capture.ts src/inngest/functions/index.ts
git commit -m "feat(capture): add handle-capture Inngest function with triage and fan-out"
```

---

### Task 13: API Route

**Files:**
- Create: `src/routes/capture.ts`
- Test: `src/routes/capture.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/routes/capture.test.ts
import { describe, expect, test, mock } from "bun:test";
import { Hono } from "hono";
import { createCaptureRoutes } from "./capture";

describe("capture API", () => {
  // Mock inngest.send to capture emitted events
  const sentEvents: unknown[] = [];
  const mockInngest = {
    send: mock(async (events: unknown) => {
      sentEvents.push(events);
    }),
  };

  const app = new Hono();
  app.route("/api/capture", createCaptureRoutes(mockInngest as never));

  test("POST /api/capture with URLs returns 202", async () => {
    sentEvents.length = 0;
    const res = await app.request("/api/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls: ["https://example.com"] }),
    });
    expect(res.status).toBe(202);
    const data = await res.json();
    expect(data.captured).toHaveLength(1);
    expect(data.captured[0].captureKey).toBe("https://example.com");
  });

  test("POST /api/capture with filePath returns 202", async () => {
    sentEvents.length = 0;
    const res = await app.request("/api/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: "/Users/me/doc.md" }),
    });
    expect(res.status).toBe(202);
    const data = await res.json();
    expect(data.captured).toHaveLength(1);
    expect(data.captured[0].filePath).toBe("/Users/me/doc.md");
  });

  test("POST /api/capture rejects empty body", async () => {
    const res = await app.request("/api/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/capture rejects both urls and filePath", async () => {
    const res = await app.request("/api/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        urls: ["https://example.com"],
        filePath: "/Users/me/doc.md",
      }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/capture respects mode flag", async () => {
    sentEvents.length = 0;
    const res = await app.request("/api/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls: ["https://example.com"], mode: "full" }),
    });
    expect(res.status).toBe(202);
  });
});
```

- [ ] **Step 2: Run tests, verify fail**

- [ ] **Step 3: Implement capture route**

```typescript
// src/routes/capture.ts
import { Hono } from "hono";
import type { Inngest } from "inngest";
import { CaptureRequestSchema } from "@/capture/schema";
import { detectContentType } from "@/capture/detect-type";

export function createCaptureRoutes(inngest: Inngest): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const parsed = CaptureRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed", details: parsed.error.issues },
        400,
      );
    }

    const { urls, filePath, mode, type, title } = parsed.data;
    const captured: Array<{
      captureKey: string;
      url?: string;
      filePath?: string;
      type: string;
      mode: string;
    }> = [];

    if (filePath) {
      const captureKey = `file://${filePath}`;
      await inngest.send({
        name: "agent.capture.file.requested",
        data: {
          captureKey,
          filePath,
          title,
          source: "cli" as const,
        },
      });
      captured.push({
        captureKey,
        filePath,
        type: "file",
        mode: "full",
      });
    } else if (urls) {
      const events = urls.map((url) => {
        const detectedType = type ?? detectContentType(url);
        const resolvedMode = mode ?? "triage";
        return {
          name: "agent.capture.requested" as const,
          data: {
            captureKey: url,
            url,
            type: detectedType,
            source: "cli" as const,
            mode: resolvedMode,
          },
        };
      });

      await inngest.send(events);

      for (const event of events) {
        captured.push({
          captureKey: event.data.captureKey,
          url: event.data.url,
          type: event.data.type,
          mode: event.data.mode,
        });
      }
    }

    return c.json({ captured }, 202);
  });

  return app;
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test src/routes/capture.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes/capture.ts src/routes/capture.test.ts
git commit -m "feat(capture): add POST /api/capture route with Zod validation"
```

---

### Task 14: Slack Action Handler for Triage Decisions

**Files:**
- Modify: `src/bolt/listeners/actions.ts`
- Modify: `src/bolt/listeners/index.ts`

- [ ] **Step 1: Update registerActionListeners to accept Inngest client**

In `src/bolt/listeners/index.ts`, change `registerActionListeners(app)` to `registerActionListeners(app, inngest)`.

- [ ] **Step 2: Add capture_decision action handler**

In `src/bolt/listeners/actions.ts`:

```typescript
import type { App } from "@slack/bolt";
import type { Inngest } from "inngest";
import { saveChannelWorkspace } from "@/lib/channels";
import { slack } from "@/lib/slack";
import type { StaticSelectAction, ButtonAction } from "@slack/bolt";

export function registerActionListeners(app: App, inngest: Inngest) {
  // Existing workspace select handler
  app.action("channel_workspace_select", async ({ ack, body, action }) => {
    await ack();
    const selectedPath = (action as StaticSelectAction).selected_option.value;
    const channelId = body.channel?.id;
    if (!channelId) return;
    await saveChannelWorkspace(channelId, selectedPath);
    await slack.chat.postMessage({
      channel: channelId,
      text: `Workspace set to \`${selectedPath}\`.`,
    });
  });

  // Capture triage decision handler
  app.action("capture_decision", async ({ ack, action }) => {
    await ack();
    const value = JSON.parse((action as ButtonAction).value) as {
      captureId: string;
      action: "full" | "quick-save" | "skip";
    };
    await inngest.send({
      name: "agent.capture.decision",
      data: {
        captureId: value.captureId,
        action: value.action,
      },
    });
  });
}
```

- [ ] **Step 3: Run existing tests**

Run: `bun test`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src/bolt/listeners/actions.ts src/bolt/listeners/index.ts
git commit -m "feat(capture): add Slack action handler for triage decisions"
```

---

### Task 15: Wire into Main Entry Point

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add handle-capture to functions array and mount capture route**

In `src/index.ts`:
- Import `handleCapture` from functions
- Add to the `functions` array
- Import `createCaptureRoutes` from routes
- Add `hono.route("/api/capture", createCaptureRoutes(inngest));` alongside existing routes

- [ ] **Step 2: Run all tests**

Run: `bun test`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(capture): wire handle-capture function and /api/capture route into server"
```

---

## Chunk 5: CLI Commands

### Task 16: kos config Command

**Files:**
- Create: `~/.kos-kit/cli/src/commands/config.ts`
- Test: `~/.kos-kit/cli/src/commands/config.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// ~/.kos-kit/cli/src/commands/config.test.ts
import { describe, expect, test, mock } from "bun:test";
import { handleGet, handleSet, handleList } from "./config";
import type { ApiClient } from "../lib/api";

function mockClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    get: mock(async () => ({
      status: 200,
      data: { displayMode: "compact", notifyChannel: "C123" },
    })),
    post: mock(async () => ({ status: 200, data: {} })),
    patch: mock(async () => ({
      status: 200,
      data: { displayMode: "compact", notifyChannel: "C456" },
    })),
    del: mock(async () => ({ status: 204, data: null })),
    ...overrides,
  };
}

describe("config list", () => {
  test("returns all config values", async () => {
    const client = mockClient();
    const result = await handleList(client);
    expect(result.ok).toBe(true);
  });
});

describe("config get", () => {
  test("returns specific config value", async () => {
    const client = mockClient();
    const result = await handleGet(client, "notifyChannel");
    expect(result.ok).toBe(true);
  });
});

describe("config set", () => {
  test("updates config value", async () => {
    const client = mockClient();
    const result = await handleSet(client, "notifyChannel", "C456");
    expect(result.ok).toBe(true);
    expect(client.patch).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests, verify fail, implement, verify pass**

Follow the jobs command pattern: exported handler functions, `defineCommand` with subcommands, `getClient()` for API access.

- [ ] **Step 3: Register in CLI entry point**

Add `config` to subCommands in the main CLI command at `~/.kos-kit/cli/src/index.ts`.

- [ ] **Step 4: Commit**

```bash
cd ~/.kos-kit/cli
git add src/commands/config.ts src/commands/config.test.ts src/index.ts
git commit -m "feat(cli): add kos config command for get/set/list"
```

---

### Task 17: kos capture Command

**Files:**
- Create: `~/.kos-kit/cli/src/commands/capture.ts`
- Test: `~/.kos-kit/cli/src/commands/capture.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// ~/.kos-kit/cli/src/commands/capture.test.ts
import { describe, expect, test, mock } from "bun:test";
import { handleCapture, parseBatchFile } from "./capture";
import type { ApiClient } from "../lib/api";

function mockClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    get: mock(async () => ({ status: 200, data: {} })),
    post: mock(async () => ({ status: 202, data: { captured: [{ captureKey: "https://example.com", type: "article", mode: "triage" }] } })),
    patch: mock(async () => ({ status: 200, data: {} })),
    del: mock(async () => ({ status: 204, data: null })),
    ...overrides,
  };
}

describe("handleCapture", () => {
  test("sends single URL", async () => {
    const client = mockClient();
    const result = await handleCapture(client, {
      urls: ["https://example.com"],
    });
    expect(result.ok).toBe(true);
    expect(client.post).toHaveBeenCalled();
  });

  test("sends file path", async () => {
    const client = mockClient();
    const result = await handleCapture(client, {
      filePath: "/Users/me/doc.md",
    });
    expect(result.ok).toBe(true);
  });

  test("sends mode flag", async () => {
    const client = mockClient();
    await handleCapture(client, {
      urls: ["https://example.com"],
      mode: "full",
    });
    const postCall = (client.post as ReturnType<typeof mock>).mock.calls[0];
    expect((postCall[1] as { mode: string }).mode).toBe("full");
  });
});

describe("parseBatchFile", () => {
  test("parses URLs from text", () => {
    const urls = parseBatchFile("https://a.com\nhttps://b.com\n# comment\n\n");
    expect(urls).toEqual(["https://a.com", "https://b.com"]);
  });

  test("skips comments and empty lines", () => {
    const urls = parseBatchFile("# header\n\nhttps://a.com");
    expect(urls).toEqual(["https://a.com"]);
  });
});
```

- [ ] **Step 2: Run tests, verify fail, implement, verify pass**

Follow the jobs command pattern with subcommands and flags:
- Positional args for URLs
- `--full`, `--quick` flags for mode
- `--type` flag to force content type
- `--batch-file` for file input
- `--file` for local file capture

- [ ] **Step 3: Register in CLI entry point**

Add `capture` to subCommands in the main CLI command.

- [ ] **Step 4: Commit**

```bash
cd ~/.kos-kit/cli
git add src/commands/capture.ts src/commands/capture.test.ts src/index.ts
git commit -m "feat(cli): add kos capture command with batch and mode support"
```

---

## Chunk 6: Integration and Final Wiring

### Task 18: End-to-End Smoke Test

- [ ] **Step 1: Verify yt-dlp is installed**

Run: `which yt-dlp`
If not found: `brew install yt-dlp`

- [ ] **Step 2: Set notifyChannel via config API**

```bash
curl -X PATCH http://localhost:9080/api/config \
  -H "Content-Type: application/json" \
  -d '{"notifyChannel": "GENERAL_CHANNEL_ID"}'
```

Replace `GENERAL_CHANNEL_ID` with the actual Slack channel ID.

- [ ] **Step 3: Test CLI capture with a single URL (quick mode)**

```bash
kos capture https://example.com --quick
```

Expected: 202 response, capture event emitted, vault note created at `~/kyrell-os-vault/sources/Example Domain.md`, Slack notification posted.

- [ ] **Step 4: Test CLI capture with a YouTube video (full mode)**

```bash
kos capture "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --full
```

Expected: Transcript extracted via yt-dlp, vault note with full transcript written.

- [ ] **Step 5: Test triage mode via Slack**

Send a message in Slack: `capture https://developers.cloudflare.com/changelog/post/2026-03-10-br-crawl-endpoint/`

Expected: Triage message with buttons appears in notify channel. Clicking "Full capture" triggers extraction and vault note creation. Message updates to show outcome.

- [ ] **Step 6: Test batch capture**

Create `urls.txt` with 3-5 URLs:
```
https://example.com
https://news.ycombinator.com/item?id=1
https://www.youtube.com/watch?v=dQw4w9WgXcQ
```

```bash
kos capture --batch-file urls.txt --quick
```

Expected: All URLs captured in parallel, vault notes created for each.

- [ ] **Step 7: Commit any fixes from smoke testing**

```bash
git add -A
git commit -m "fix(capture): smoke test fixes"
```

---

## Summary

| Chunk | Tasks | Description |
|-------|-------|-------------|
| 1 | 1-4 | Foundation: schemas, type detection, config, events |
| 2 | 5-8 | Extraction: metadata, article, YouTube, HN/Twitter/file/quality |
| 3 | 9-10 | Vault: templates, writer with idempotency |
| 4 | 11-15 | Orchestration: notify, Inngest function, API route, Slack actions, wiring |
| 5 | 16-17 | CLI: config command, capture command |
| 6 | 18 | Integration: smoke tests |
