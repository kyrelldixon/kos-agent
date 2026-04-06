import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { detectContentType } from "@/capture/detect-type";
import { extractFileContent } from "@/capture/extract/file";
import {
  cloneOrPullRepo,
  getClonePath,
  parseGitHubUrl,
  readRepoReadme,
} from "@/capture/extract/github";
import type { PageMetadata } from "@/capture/extract/metadata";
import { extractMetadata } from "@/capture/extract/metadata";
import { checkContentQuality } from "@/capture/extract/quality";
import {
  extractYouTubeTranscript,
  listChannelVideos,
} from "@/capture/extract/youtube";
import { buildNotificationMessage, buildTriageBlocks } from "@/capture/notify";
import type { CaptureMode, ContentType } from "@/capture/schema";
import { buildVaultNote, type VaultNoteInput } from "@/capture/vault/templates";
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
import { cfBrowserExtraction } from "./extract-cf-browser";
import { jinaExtraction } from "./extract-jina";
import { localExtraction } from "./extract-local";

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
      const triageMessages = await step.run("post-triage-prompt", async () => {
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
      });

      // Wait for user decision (4h timeout)
      const decision = await step.waitForEvent("wait-for-decision", {
        event: agentCaptureDecision,
        timeout: "4h",
        if: `async.data.captureId == "${event.data.captureKey}"`,
      });

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

      if (decision?.data.action === "skip") return { status: "skipped", url };
      resolvedMode = decision?.data.action === "full" ? "full" : "quick";
    }

    // Step 3: Create capture working directory
    const captureId = `capture-${Date.now()}`;
    const captureDir = join(CAPTURES_DIR, captureId);
    await step.run("init-capture-dir", () =>
      mkdir(captureDir, { recursive: true }),
    );

    // Step 4: Extract metadata (content extraction now uses step.invoke, can't parallelize)
    const metadata = await step.run(
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

    // Step 5: Content extraction — tiered for articles, direct for other types
    let content = "";
    let extractionMethod = "none";

    if (resolvedMode === "quick") {
      content = "";
    } else if (isFile) {
      if (!filePath) throw new Error("filePath required for file captures");
      content = await step.run("extract-file-content", () =>
        extractFileContent(filePath),
      );
      extractionMethod = "file";
    } else if (!url) {
      throw new Error("URL required for non-file captures");
    } else if (type === "youtube-video") {
      content = await step.run("extract-youtube-transcript", () =>
        extractYouTubeTranscript(url),
      );
      extractionMethod = "youtube";
    } else if (type === "youtube-channel") {
      const videos = await step.run("list-channel-videos", () =>
        listChannelVideos(url),
      );
      content = JSON.stringify(videos);
      extractionMethod = "youtube";
    } else if (type === "twitter") {
      content = "";
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
      // Article, HN, or unknown — use tiered extraction
      // For HN, use the linked article URL from metadata (already fetched via Algolia)
      const extractUrl =
        type === "hacker-news" && metadata.hnLinkedUrl
          ? metadata.hnLinkedUrl
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

    const extractionFailed =
      resolvedMode === "full" &&
      !content &&
      type !== "twitter" &&
      type !== "github-repo" &&
      type !== "file";

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
          destination,
          parentCaptureId: event.data.captureKey,
          mode: "full" as const,
        },
      }));
      if (events.length > 0) {
        await step.sendEvent("fan-out-videos", events);
      }
    }

    // Step 7: Write vault note
    const notePath = await step.run("write-vault-note", async () => {
      const noteInput: VaultNoteInput = {
        type: type === "file" ? "file" : type,
        title: metadata.title ?? url ?? filePath ?? "Untitled",
        url,
        author: metadata.author,
        description: metadata.description,
        published: metadata.published,
        content: resolvedMode === "full" ? content : undefined,
        extractionMethod,
        extractionFailed,
        channel: metadata.channel,
        duration: metadata.duration,
        views: metadata.views,
        hnUrl: metadata.hnUrl,
        hnLinkedUrl: metadata.hnLinkedUrl,
        hnPoints: metadata.hnPoints,
        hnComments: metadata.hnComments,
        handle: metadata.handle,
        posted: metadata.posted,
        filePath,
        stars: metadata.stars,
        language: metadata.language,
        license: metadata.license,
        localPath:
          type === "github-repo" && url
            ? `~/projects/${parseGitHubUrl(url)?.repo}`
            : undefined,
      };
      const rendered = buildVaultNote(noteInput);
      return writeVaultNote(undefined, noteInput.title, rendered, url);
    });

    // Step 9: Cleanup capture directory
    await step.run("cleanup", async () => {
      await rm(captureDir, { recursive: true, force: true }).catch(() => {});
    });
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

    return {
      status: extractionFailed ? "extraction-failed" : "captured",
      type,
      mode: resolvedMode,
      url: url ?? filePath,
      notePath,
      extractionMethod,
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
