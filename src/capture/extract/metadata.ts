import { z } from "zod";
import type { ContentType } from "../schema";
import { fetchGitHubMetadata, parseGitHubUrl } from "./github";

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
  // GitHub-specific
  stars?: number;
  language?: string;
  license?: string;
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
    case "github-repo":
      return extractGitHubRepoMetadata(url);
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
      author:
        extractMetaTag(html, "author") ??
        extractMetaTag(html, "article:author"),
      description:
        extractMetaTag(html, "og:description") ??
        extractMetaTag(html, "description"),
      published: extractMetaTag(html, "article:published_time"),
    };
  } catch {
    return {};
  }
}

const YouTubeOEmbedSchema = z.object({
  title: z.string().optional(),
  author_name: z.string().optional(),
});

async function extractYouTubeMetadata(url: string): Promise<PageMetadata> {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(10_000) });
    const parsed = YouTubeOEmbedSchema.safeParse(await res.json());
    if (!parsed.success) return {};
    const data = parsed.data;

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

const YtDlpSchema = z.object({
  duration: z.number().optional(),
  view_count: z.number().optional(),
  upload_date: z.string().optional(),
});

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

    const parsed = YtDlpSchema.safeParse(JSON.parse(output));
    if (!parsed.success) return {};
    const data = parsed.data;

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

async function extractYouTubeChannelMetadata(
  url: string,
): Promise<PageMetadata> {
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

const HNAlgoliaSchema = z.object({
  title: z.string().optional(),
  url: z.string().optional(),
  points: z.number().optional(),
  children: z.array(z.unknown()).optional(),
});

async function extractHNMetadata(url: string): Promise<PageMetadata> {
  try {
    const itemId = new URL(url).searchParams.get("id");
    if (!itemId) return {};
    const res = await fetch(`https://hn.algolia.com/api/v1/items/${itemId}`, {
      signal: AbortSignal.timeout(10_000),
    });
    const parsed = HNAlgoliaSchema.safeParse(await res.json());
    if (!parsed.success) return {};
    const data = parsed.data;
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

function extractTwitterMetadata(url: string): PageMetadata {
  // Twitter metadata requires browser scraping (handled in content extraction)
  // Return what we can parse from the URL itself
  const parsed = new URL(url);
  const pathParts = parsed.pathname.split("/").filter(Boolean);
  return {
    handle: pathParts[0] ? `@${pathParts[0]}` : undefined,
  };
}

async function extractGitHubRepoMetadata(url: string): Promise<PageMetadata> {
  const parsed = parseGitHubUrl(url);
  if (!parsed) return {};
  const meta = await fetchGitHubMetadata(parsed.owner, parsed.repo);
  return {
    title: parsed.repo,
    description: meta.description,
    stars: meta.stars,
    language: meta.language,
    license: meta.license,
  };
}

function extractMetaTag(html: string, name: string): string | undefined {
  // Match both <meta name="..." content="..."> and <meta property="..." content="...">
  const patterns = [
    new RegExp(
      `<meta\\s+(?:name|property)=["']${name}["']\\s+content=["']([^"']*)["']`,
      "i",
    ),
    new RegExp(
      `<meta\\s+content=["']([^"']*)["']\\s+(?:name|property)=["']${name}["']`,
      "i",
    ),
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
