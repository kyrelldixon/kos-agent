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
