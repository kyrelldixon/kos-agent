# Capture Thread Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route capture notifications to the originating Slack thread via a `destination` passthrough, remove the redundant `source` field, and harden the agent system prompt so it always waits for async captures.

**Architecture:** Add `--channel`/`--thread` CLI flags → pass `destination` through HTTP route → Inngest event → destination-driven notification. Remove `source` from all capture schemas. Dual notification: always post to notify channel, additionally post to destination thread.

**Tech Stack:** Bun, Zod, Hono, Inngest 4.0, Slack Bolt, citty (CLI framework)

**Spec:** `docs/superpowers/specs/2026-03-18-capture-thread-routing-design.md`

---

### Task 1: Remove `source` from capture schemas

**Files:**
- Modify: `src/capture/schema.ts:16-17,28-37,42-51,53-59`
- Modify: `src/capture/schema.test.ts:50-95,97-125`

- [ ] **Step 1: Update `src/capture/schema.ts` — remove source**

Remove `CaptureSourceEnum` (line 16) and `CaptureSource` type (line 17). Remove the `source` field from `CaptureEventSchema` (line 32), `CaptureEventInngestSchema` (line 46), and `CaptureFileEventSchema` (line 57).

The file should look like:

```typescript
import { z } from "zod";

export const ContentTypeEnum = z.enum([
  "article",
  "youtube-video",
  "youtube-channel",
  "hacker-news",
  "twitter",
  "github-repo",
]);
export type ContentType = z.infer<typeof ContentTypeEnum>;

export const CaptureModeEnum = z.enum(["full", "quick", "triage"]);
export type CaptureMode = z.infer<typeof CaptureModeEnum>;

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
  destination: CaptureDestinationSchema.optional(),
  batchId: z.string().optional(),
  parentCaptureId: z.string().optional(),
  mode: CaptureModeEnum.default("triage"),
});
export type CaptureEventData = z.infer<typeof CaptureEventSchema>;

// Inngest event schemas must have matching input/output types (no transforms).
// This variant uses optional() instead of default() for the mode field.
export const CaptureEventInngestSchema = z.object({
  captureKey: z.string(),
  url: z.string().url(),
  type: ContentTypeEnum.optional(),
  destination: CaptureDestinationSchema.optional(),
  batchId: z.string().optional(),
  parentCaptureId: z.string().optional(),
  mode: CaptureModeEnum.optional(),
});

export const CaptureFileEventSchema = z.object({
  captureKey: z.string(),
  filePath: z.string(),
  title: z.string().optional(),
  destination: CaptureDestinationSchema.optional(),
});
export type CaptureFileEventData = z.infer<typeof CaptureFileEventSchema>;

export const CaptureDecisionEventSchema = z.object({
  captureId: z.string(),
  action: CaptureDecisionEnum,
});
export type CaptureDecisionEventData = z.infer<
  typeof CaptureDecisionEventSchema
>;

export const CaptureRequestSchema = z
  .object({
    urls: z.array(z.string().url()).min(1).optional(),
    filePath: z.string().optional(),
    mode: CaptureModeEnum.optional(),
    type: ContentTypeEnum.optional(),
    title: z.string().optional(),
    destination: CaptureDestinationSchema.optional(),
  })
  .refine((data) => {
    const hasUrls = data.urls !== undefined && data.urls.length > 0;
    const hasFile = data.filePath !== undefined;
    return (hasUrls || hasFile) && !(hasUrls && hasFile);
  }, "Must provide either urls or filePath, not both");
export type CaptureRequest = z.infer<typeof CaptureRequestSchema>;
```

- [ ] **Step 2: Update `src/capture/schema.test.ts` — remove source from test data, add destination tests**

Remove `source` from all test objects in `CaptureEventSchema` and `CaptureFileEventSchema` describes. Remove the "rejects invalid source" test (lines 77-84) and "rejects extension source" test (lines 117-124). Add a `CaptureRequestSchema` test for destination. (The test file does not import `CaptureSourceEnum`, so no import change is needed.)

Updated test sections:

```typescript
// In CaptureEventSchema describe:
test("validates minimal capture event", () => {
  const result = CaptureEventSchema.safeParse({
    captureKey: "https://example.com",
    url: "https://example.com",
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
    destination: { chatId: "C123", threadId: "ts123" },
    batchId: "batch-1",
    parentCaptureId: "parent-1",
    mode: "full",
  });
  expect(result.success).toBe(true);
});

test("rejects invalid content type", () => {
  const result = CaptureEventSchema.safeParse({
    captureKey: "https://example.com",
    url: "https://example.com",
    type: "podcast",
  });
  expect(result.success).toBe(false);
});

// In CaptureFileEventSchema describe:
test("validates file capture event", () => {
  const result = CaptureFileEventSchema.safeParse({
    captureKey: "file:///Users/me/doc.md",
    filePath: "/Users/me/doc.md",
  });
  expect(result.success).toBe(true);
});

test("accepts optional title", () => {
  const result = CaptureFileEventSchema.safeParse({
    captureKey: "file:///Users/me/doc.md",
    filePath: "/Users/me/doc.md",
    title: "My Document",
  });
  expect(result.success).toBe(true);
});

// Replace "rejects extension source" with:
test("accepts destination", () => {
  const result = CaptureFileEventSchema.safeParse({
    captureKey: "file:///Users/me/doc.md",
    filePath: "/Users/me/doc.md",
    destination: { chatId: "C123", threadId: "ts123" },
  });
  expect(result.success).toBe(true);
});

// In CaptureRequestSchema describe, add:
test("validates with destination", () => {
  const result = CaptureRequestSchema.safeParse({
    urls: ["https://example.com"],
    destination: { chatId: "C123", threadId: "1234567890.123456" },
  });
  expect(result.success).toBe(true);
});

test("validates destination without threadId", () => {
  const result = CaptureRequestSchema.safeParse({
    urls: ["https://example.com"],
    destination: { chatId: "C123" },
  });
  expect(result.success).toBe(true);
});
```

- [ ] **Step 3: Run tests**

Run: `bun test src/capture/schema.test.ts`
Expected: All tests pass.

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: Type errors in `src/routes/capture.ts` and `src/inngest/functions/handle-capture.ts` (they still reference `source`). This is expected — we'll fix them in the next tasks.

- [ ] **Step 5: Commit**

```bash
git add src/capture/schema.ts src/capture/schema.test.ts
git commit -m "refactor(capture): remove source field from capture schemas

destination-driven notification routing replaces the source-based gate.
Add destination to CaptureRequestSchema for CLI passthrough."
```

---

### Task 2: Update HTTP route to pass destination, remove source

**Files:**
- Modify: `src/routes/capture.ts:23,34-41,50-62`

- [ ] **Step 1: Update `src/routes/capture.ts`**

Destructure `destination` from `parsed.data`. Remove `source: "cli"` from both Inngest events. Add `destination` to both events.

Full updated file:

```typescript
import { Hono } from "hono";
import { detectContentType } from "@/capture/detect-type";
import { CaptureRequestSchema } from "@/capture/schema";

// The inngest parameter is typed loosely to avoid importing the full Inngest type
// which would create a circular dependency risk. The route only needs .send()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createCaptureRoutes(inngest: {
  send: (events: any) => Promise<unknown>;
}): Hono {
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

    const { urls, filePath, mode, type, title, destination } = parsed.data;
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
          destination,
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
          name: "agent.capture.requested",
          data: {
            captureKey: url,
            url,
            type: detectedType,
            mode: resolvedMode,
            destination,
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

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: `src/routes/capture.ts` should now be clean. `src/inngest/functions/handle-capture.ts` will still have errors (source reference in fan-out on line 305 and notification on line 355).

- [ ] **Step 3: Commit**

```bash
git add src/routes/capture.ts
git commit -m "feat(capture): pass destination through HTTP route to Inngest events

Remove hardcoded source field. Destination from the request body
flows into both URL and file capture events."
```

---

### Task 3: Update handle-capture — notification, fan-out, triage

**Files:**
- Modify: `src/inngest/functions/handle-capture.ts:95-152,290-313,354-391`

- [ ] **Step 1: Update triage mode to be destination-aware (lines 95-152)**

Replace the `post-triage-prompt` step to post buttons to both notify channel and destination thread. Track both message references for cleanup.

Note: `triageMessage` (singular, returning `{ channel, ts } | null`) becomes `triageMessages` (plural, returning `Array<{ channel, ts }>`). The `triageChannel`/`triageTs` variables in the cleanup block (lines 131-132) are eliminated by the new array-based approach.

**Lines 122-129 (the `waitForEvent` block and `if decision?.data.action === "skip"` check) remain unchanged.**

Replace lines 101-121 with:

```typescript
      // Post triage buttons to Slack
      const triageMessages = await step.run(
        "post-triage-prompt",
        async () => {
          const description = formatTriageDescription(type, triageMeta);
          const blocks = buildTriageBlocks({
            captureId: event.data.captureKey,
            type,
            title: triageMeta.title ?? url,
            description,
          });
          const text = `Capture: ${triageMeta.title ?? url}`;

          const messages: Array<{ channel: string; ts: string }> = [];

          // Always post to notify channel
          const notifyChannel = await getNotifyChannel();
          if (notifyChannel) {
            const result = await slack.chat
              .postMessage({ channel: notifyChannel, text, blocks })
              .catch(() => null);
            if (result?.channel && result?.ts) {
              messages.push({ channel: result.channel, ts: result.ts });
            }
          }

          // Also post to destination thread if present
          if (destination?.chatId) {
            const result = await slack.chat
              .postMessage({
                channel: destination.chatId,
                thread_ts: destination.threadId,
                text,
                blocks,
              })
              .catch(() => null);
            if (result?.channel && result?.ts) {
              messages.push({ channel: result.channel, ts: result.ts });
            }
          }

          return messages;
        },
      );
```

Then replace the triage message update (lines 130-152) with:

```typescript
      // Update all triage messages with outcome
      if (triageMessages.length > 0) {
        const outcome = decision
          ? decision.data.action === "full"
            ? "Full capture started"
            : decision.data.action === "skip"
              ? "Skipped"
              : "Quick-saved"
          : "Timed out - quick-saved";

        await step.run("update-triage-messages", async () => {
          for (const msg of triageMessages) {
            await slack.chat
              .update({
                channel: msg.channel,
                ts: msg.ts,
                text: `Capture: ${triageMeta.title ?? url} - ${outcome}`,
                blocks: [],
              })
              .catch(() => {});
          }
        });
      }
```

- [ ] **Step 2: Remove `source` from YouTube fan-out (line 305)**

In the YouTube channel fan-out event data (line 299-309), remove `source: event.data.source,` (line 305). The `destination` field on line 306 is already present and provides the routing.

- [ ] **Step 3: Replace notification step (lines 354-391)**

Replace the entire notification step with destination-driven dual notification:

```typescript
    // Step 10: Notify via Slack
    await step.run("notify", async () => {
      const msg = buildNotificationMessage({
        title: metadata.title ?? url ?? filePath ?? "Untitled",
        url,
        notePath,
        description: metadata.description ?? "",
        failed: extractionFailed,
      });

      // Always post to notify channel for the capture feed
      const notifyChannel = await getNotifyChannel();
      if (notifyChannel) {
        await slack.chat
          .postMessage({ channel: notifyChannel, text: msg })
          .catch(() => {});
      }

      // Also post to destination thread if present
      if (destination?.chatId) {
        await slack.chat
          .postMessage({
            channel: destination.chatId,
            thread_ts: destination.threadId,
            text: msg,
          })
          .catch(() => {});
      }
    });
```

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: Clean — no more `source` references.

- [ ] **Step 5: Run all tests**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/inngest/functions/handle-capture.ts
git commit -m "feat(capture): destination-driven notifications and triage buttons

Always post to notify channel. Additionally post to destination thread
when present. Triage buttons and cleanup update both copies.
Remove source from YouTube channel fan-out."
```

---

### Task 4: Add `--channel`/`--thread` flags to kos CLI

**Files:**
- Modify: `~/.kos-kit/cli/src/commands/capture.ts:8-14,20-29,77-95,96-143`
- Modify: `~/.kos-kit/cli/src/commands/capture.test.ts`

- [ ] **Step 1: Update `CaptureOptions` interface and `handleCapture`**

Add `destination` to the interface and include it in the request body:

```typescript
interface CaptureOptions {
	urls?: string[];
	filePath?: string;
	mode?: string;
	type?: string;
	title?: string;
	destination?: { chatId: string; threadId?: string };
}

export async function handleCapture(
	client: ApiClient,
	options: CaptureOptions,
): Promise<CLIResponse> {
	const body: Record<string, unknown> = {};

	if (options.filePath) {
		body.filePath = options.filePath;
		if (options.title) body.title = options.title;
	} else if (options.urls) {
		body.urls = options.urls;
		if (options.mode) body.mode = options.mode;
		if (options.type) body.type = options.type;
	}

	if (options.destination) body.destination = options.destination;

	const res = await client.post("/api/capture", body);
```

- [ ] **Step 2: Add `--channel` and `--thread` args to command definition**

Add after `title` in the `args` object:

```typescript
		channel: {
			type: "string",
			description: "Slack channel ID for notifications",
		},
		thread: {
			type: "string",
			description: "Slack thread timestamp for notifications",
		},
```

- [ ] **Step 3: Build destination from args and pass to `handleCapture`**

In the `run` function, after `const mode = ...` (line 133), build the destination:

```typescript
			const destination = args.channel
				? { chatId: args.channel, threadId: args.thread }
				: undefined;
```

Then add `destination` to the `handleCapture` call:

```typescript
			output(
				await handleCapture(client, {
					urls,
					filePath,
					mode,
					type: args.type,
					title: args.title,
					destination,
				}),
			);
```

- [ ] **Step 4: Add CLI test for destination passthrough**

Add to `~/.kos-kit/cli/src/commands/capture.test.ts` in the `handleCapture` describe:

```typescript
	test("sends destination when provided", async () => {
		const client = mockClient();
		await handleCapture(client, {
			urls: ["https://example.com"],
			destination: { chatId: "C123", threadId: "ts456" },
		});
		const postCall = (client.post as ReturnType<typeof mock>).mock.calls[0];
		const body = postCall[1];
		expect(body).toHaveProperty("destination", { chatId: "C123", threadId: "ts456" });
	});

	test("omits destination when not provided", async () => {
		const client = mockClient();
		await handleCapture(client, {
			urls: ["https://example.com"],
		});
		const postCall = (client.post as ReturnType<typeof mock>).mock.calls[0];
		const body = postCall[1];
		expect(body).not.toHaveProperty("destination");
	});
```

- [ ] **Step 5: Run CLI tests**

Run: `cd ~/.kos-kit/cli && bun test src/commands/capture.test.ts`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
cd ~/.kos-kit/cli
git add src/commands/capture.ts src/commands/capture.test.ts
git commit -m "feat(capture): add --channel and --thread flags for destination routing

Pass Slack thread context through to the agent for notification routing."
```

---

### Task 5: Harden agent system prompt

**Files:**
- Modify: `src/agent/session.ts:52-78`

- [ ] **Step 1: Replace the Content Capture section in `buildSystemAppend`**

Replace lines 52-78 (the entire Content Capture push block) with:

```typescript
  lines.push(
    "",
    "## Content Capture — CRITICAL: THIS IS ASYNC",
    "",
    "kos capture triggers a background pipeline. It returns IMMEDIATELY.",
    "The vault note WILL NOT EXIST for 5-30 seconds after the command returns.",
    "",
    "ALWAYS use --full or --quick mode. ALWAYS include --channel and --thread flags:",
    `  kos capture <url> --full --channel ${destination?.chatId ?? "<chatId>"} --thread ${destination?.threadId ?? "<threadId>"}`,
    "",
    "After running kos capture, you MUST follow this exact sequence:",
    "1. Run: sleep 15",
    '2. Run: obsidian read file="<Title>"',
    "3. If the note doesn't exist yet, run: sleep 10",
    '4. Run: obsidian read file="<Title>" one more time',
    "5. Only AFTER you have successfully read the note, summarize it for the user",
    "",
    "NEVER tell the user you captured something before verifying the note exists.",
    "NEVER try to manually create or write the note yourself — the pipeline handles it.",
    "",
    "Content types (auto-detected): article, youtube-video, youtube-channel, hacker-news, github-repo",
    "",
    "Other capture commands:",
    "  kos capture <url> --quick          # Quick save: metadata only",
    "  kos capture --batch-file urls.txt  # Batch capture from file",
    "  kos capture --file /path/to/doc    # Capture a local file",
    "",
    "After confirming the note exists, you can:",
    '  obsidian append file="Title" content="Summary text"',
    '  obsidian property:set name=status value=done file="Title"',
  );
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: Clean.

- [ ] **Step 3: Commit**

```bash
git add src/agent/session.ts
git commit -m "fix(agent): harden system prompt for async capture behavior

Make capture instructions much more forceful about waiting.
Always include --channel/--thread flags with actual context values.
Explicit 5-step sequence the agent must follow after every capture."
```

---

### Task 6: Final verification

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: Clean.

- [ ] **Step 3: Verify no stale `source` references in capture code**

Run: `grep -r "CaptureSource\|source.*cli\|source.*slack" src/capture/ src/routes/ src/inngest/functions/handle-capture.ts`
Expected: No matches (or only comments).
