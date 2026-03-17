const MIN_CONTENT_LENGTH = 200;

export function checkContentQuality(content: string): boolean {
  const cleaned = stripFormattingAndChrome(content);
  return cleaned.length >= MIN_CONTENT_LENGTH;
}

function stripFormattingAndChrome(content: string): string {
  return (
    content
      // Strip HTML elements
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
      .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, "")
      .replace(/<[^>]+>/g, "")
      // Strip markdown formatting
      .replace(/^#{1,6}\s+/gm, "") // headings
      .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
      .replace(/\*([^*]+)\*/g, "$1") // italic
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links
      .replace(/^[-*+]\s+/gm, "") // list markers
      .replace(/^\d+\.\s+/gm, "") // ordered list markers
      .replace(/^>\s+/gm, "") // blockquotes
      .replace(/`[^`]+`/g, "") // inline code
      .replace(/```[\s\S]*?```/g, "") // code blocks
      .replace(/\s+/g, " ")
      .trim()
  );
}
