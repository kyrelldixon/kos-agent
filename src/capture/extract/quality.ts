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
