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
  hnLinkedUrl?: string;
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
    if (input.hnLinkedUrl) lines.push(`hn_linked_url: "${input.hnLinkedUrl}"`);
    if (input.hnPoints !== undefined)
      lines.push(`hn_points: ${input.hnPoints}`);
    if (input.hnComments !== undefined)
      lines.push(`hn_comments: ${input.hnComments}`);
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

  return `${lines.join("\n")}\n`;
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
