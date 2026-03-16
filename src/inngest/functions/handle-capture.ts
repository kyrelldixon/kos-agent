import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { detectContentType } from "@/capture/detect-type";
import { extractArticleContent } from "@/capture/extract/article";
import { extractFileContent } from "@/capture/extract/file";
import { extractHNContent } from "@/capture/extract/hacker-news";
import type { PageMetadata } from "@/capture/extract/metadata";
import { extractMetadata } from "@/capture/extract/metadata";
import { checkContentQuality } from "@/capture/extract/quality";
import {
  extractYouTubeTranscript,
  listChannelVideos,
} from "@/capture/extract/youtube";
import { buildNotificationMessage, buildTriageBlocks } from "@/capture/notify";
import type { CaptureMode, ContentType } from "@/capture/schema";
import {
  renderVaultNote,
  type VaultNoteInput,
} from "@/capture/vault/templates";
import { writeVaultNote } from "@/capture/vault/writer";
import { getNotifyChannel } from "@/lib/channels";
import { slack } from "@/lib/slack";
import type { AgentCaptureData, AgentCaptureFileData } from "../client";
import {
  agentCaptureDecision,
  agentCaptureFileRequested,
  agentCaptureRequested,
  inngest,
} from "../client";

const CAPTURES_DIR = join(process.env.HOME ?? "", ".kos", "agent", "captures");

/**
 * Helper to narrow the Inngest event union by event name.
 *
 * When an Inngest function has multiple triggers, `event.data` is a union.
 * TypeScript doesn't narrow `event.data` based on `event.name` checks alone
 * because Inngest's generics produce a flat union rather than a discriminated one.
 * These guards provide safe narrowing without `as` casts.
 */
function isCaptureEvent(event: {
  name: string;
  data: AgentCaptureData | AgentCaptureFileData;
}): event is { name: "agent.capture.requested"; data: AgentCaptureData } {
  return event.name === "agent.capture.requested";
}

function isFileCaptureEvent(event: {
  name: string;
  data: AgentCaptureData | AgentCaptureFileData;
}): event is {
  name: "agent.capture.file.requested";
  data: AgentCaptureFileData;
} {
  return event.name === "agent.capture.file.requested";
}

export const handleCapture = inngest.createFunction(
  {
    id: "handle-capture",
    retries: 2,
    timeouts: { finish: "10m" },
    triggers: [agentCaptureRequested, agentCaptureFileRequested],
    singleton: { key: "event.data.captureKey", mode: "cancel" },
  },
  async ({ event, step }) => {
    // Extract fields from the event union using type guards
    const isFile = isFileCaptureEvent(event);
    const url = isCaptureEvent(event) ? event.data.url : undefined;
    const filePath = isFileCaptureEvent(event)
      ? event.data.filePath
      : undefined;
    const destination = event.data.destination;
    const mode: CaptureMode = isCaptureEvent(event)
      ? (event.data.mode ?? "triage")
      : "full";

    // Step 1: Detect content type
    const type: ContentType | "file" = await step.run("detect-type", () => {
      if (isFile) return "file" as const;
      const eventType = isCaptureEvent(event) ? event.data.type : undefined;
      if (eventType) return eventType;
      if (!url) throw new Error("URL required for non-file captures");
      return detectContentType(url);
    });

    // Step 2: Triage mode handling
    let resolvedMode: "full" | "quick" =
      mode === "triage" ? "quick" : mode === "quick" ? "quick" : "full";

    if (mode === "triage" && url) {
      // Quick metadata fetch for triage display
      const triageMeta = await step.run("quick-triage", () =>
        extractMetadata(url, type === "file" ? "article" : type),
      );

      // Post triage buttons to Slack
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
          blocks,
        });

        return { channel: result.channel, ts: result.ts };
      });

      // Wait for user decision (4h timeout)
      const decision = await step.waitForEvent("wait-for-decision", {
        event: agentCaptureDecision,
        timeout: "4h",
        if: `async.data.captureId == "${event.data.captureKey}"`,
      });

      // Update triage message with outcome
      const triageChannel = triageMessage?.channel;
      const triageTs = triageMessage?.ts;
      if (triageChannel && triageTs) {
        const outcome = decision
          ? decision.data.action === "full"
            ? "Full capture started"
            : decision.data.action === "skip"
              ? "Skipped"
              : "Quick-saved"
          : "Timed out - quick-saved";

        await step.run("update-triage-message", async () => {
          await slack.chat
            .update({
              channel: triageChannel,
              ts: triageTs,
              text: `Capture: ${triageMeta.title ?? url} - ${outcome}`,
              blocks: [],
            })
            .catch(() => {});
        });
      }

      if (decision?.data.action === "skip") return { status: "skipped", url };
      resolvedMode = decision?.data.action === "full" ? "full" : "quick";
    }

    // Step 3: Create capture working directory
    const captureId = `capture-${Date.now()}`;
    const captureDir = join(CAPTURES_DIR, captureId);
    await step.run("init-capture-dir", () =>
      mkdir(captureDir, { recursive: true }),
    );

    // Step 4: Extract metadata and content in parallel
    const metadataPromise = step.run(
      "extract-metadata",
      async (): Promise<PageMetadata> => {
        if (isFile) {
          const title = isFileCaptureEvent(event)
            ? event.data.title
            : undefined;
          return { title };
        }
        if (!url) throw new Error("URL required for non-file captures");
        return extractMetadata(url, type === "file" ? "article" : type);
      },
    );

    const contentPromise = step.run("extract-content", async () => {
      if (resolvedMode === "quick") return "";
      if (isFile) {
        if (!filePath) throw new Error("filePath required for file captures");
        return extractFileContent(filePath);
      }
      if (!url) throw new Error("URL required for non-file captures");

      switch (type) {
        case "article":
          return extractArticleContent(url);
        case "youtube-video":
          return extractYouTubeTranscript(url);
        case "youtube-channel": {
          const videos = await listChannelVideos(url);
          return JSON.stringify(videos);
        }
        case "hacker-news": {
          const hn = await extractHNContent(url);
          const contentPath = join(captureDir, "content.json");
          await Bun.write(contentPath, JSON.stringify(hn));
          return contentPath;
        }
        case "twitter":
          return "";
        default:
          return extractArticleContent(url);
      }
    });

    const [metadata, rawContent] = await Promise.all([
      metadataPromise,
      contentPromise,
    ]);

    // Step 5: Quality check (skip for quick mode, twitter, file)
    let content = rawContent;
    if (resolvedMode === "full" && type !== "twitter" && type !== "file") {
      await step.run("check-quality", () => {
        const qualityOk = checkContentQuality(content);
        if (!qualityOk) {
          // TODO: agent-browser fallback integration
        }
        return qualityOk;
      });
    }

    // Step 6: YouTube channel fan-out
    if (type === "youtube-channel" && resolvedMode === "full" && content) {
      const parsed: unknown = JSON.parse(content);
      const videos = Array.isArray(parsed)
        ? parsed.filter(
            (v): v is { url: string; title: string } =>
              typeof v === "object" && v !== null && "url" in v && "title" in v,
          )
        : [];
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

    // Step 7: HN content from disk (avoids step output size limits)
    if (
      type === "hacker-news" &&
      resolvedMode === "full" &&
      content.startsWith(CAPTURES_DIR)
    ) {
      content = await step.run("read-hn-content", async () => {
        const raw = await Bun.file(content).text();
        const parsed: unknown = JSON.parse(raw);
        const hn =
          typeof parsed === "object" && parsed !== null ? parsed : null;
        const article =
          hn && "article" in hn && typeof hn.article === "string"
            ? hn.article
            : "";
        const rawComments =
          hn && "comments" in hn && Array.isArray(hn.comments)
            ? hn.comments
            : [];
        const comments = rawComments.filter(
          (c): c is { author: string; text: string; points: number } =>
            typeof c === "object" &&
            c !== null &&
            "author" in c &&
            "text" in c &&
            "points" in c,
        );
        const parts = [`## Article\n\n${article}`];
        if (comments.length > 0) {
          parts.push("## Discussion\n");
          for (const c of comments.slice(0, 10)) {
            parts.push(`**${c.author}** (${c.points} points)\n${c.text}\n`);
          }
        }
        return parts.join("\n\n");
      });
    }

    // Step 8: Write vault note
    const notePath = await step.run("write-vault-note", async () => {
      const noteInput: VaultNoteInput = {
        type: type === "file" ? "file" : type,
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

    // Step 9: Cleanup capture directory
    await step.run("cleanup", async () => {
      await rm(captureDir, { recursive: true, force: true }).catch(() => {});
    });

    // Step 10: Notify via Slack
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

      await slack.chat
        .postMessage({
          channel: notifyChannel,
          text: msg,
        })
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

    return {
      status: "captured",
      type,
      mode: resolvedMode,
      url: url ?? filePath,
      notePath,
    };
  },
);

function formatTriageDescription(
  _type: ContentType | "file",
  meta: PageMetadata,
): string {
  const parts: string[] = [];
  if (meta.channel) parts.push(meta.channel);
  if (meta.duration) parts.push(meta.duration);
  if (meta.views !== undefined)
    parts.push(`${meta.views.toLocaleString()} views`);
  if (meta.hnPoints !== undefined) parts.push(`${meta.hnPoints} points`);
  if (meta.hnComments !== undefined) parts.push(`${meta.hnComments} comments`);
  if (meta.description) parts.push(meta.description.slice(0, 200));
  return parts.join(" \u00b7 ") || "No description available";
}
