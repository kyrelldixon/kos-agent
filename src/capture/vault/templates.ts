import type { CaptureMode, ContentType } from "../schema";

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
    if (input.hnPoints !== undefined)
      lines.push(`hn_points: ${input.hnPoints}`);
    if (input.hnComments !== undefined)
      lines.push(`hn_comments: ${input.hnComments}`);
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
