// Sentinel using Unicode private-use area chars — won't appear in real messages
const S = "\uE000"; // start sentinel
const E = "\uE001"; // end sentinel

function placeholder(tag: string, index: number): string {
  return `${S}${tag}${index}${E}`;
}

function restorePattern(tag: string): RegExp {
  return new RegExp(`${S}${tag}(\\d+)${E}`, "g");
}

/** Convert markdown to Slack mrkdwn. Protects code blocks + URLs from mangling. */
export function markdownToSlackMrkdwn(text: string): string {
  const codeBlocks: string[] = [];
  let result = text.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return placeholder("CODE", codeBlocks.length - 1);
  });
  const inlineCode: string[] = [];
  result = result.replace(/`[^`]+`/g, (match) => {
    inlineCode.push(match);
    return placeholder("INLINE", inlineCode.length - 1);
  });

  // Links: [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Protect bare URLs
  const urls: string[] = [];
  result = result.replace(/https?:\/\/[^\s>)]+/g, (match) => {
    urls.push(match);
    return placeholder("URL", urls.length - 1);
  });

  // Convert bold/heading first, protecting output from italic pass
  const boldTokens: string[] = [];
  // **bold** and __bold__ → placeholder
  result = result.replace(/\*\*(.*?)\*\*/g, (_, inner) => {
    boldTokens.push(inner);
    return placeholder("BOLD", boldTokens.length - 1);
  });
  result = result.replace(/__(.*?)__/g, (_, inner) => {
    boldTokens.push(inner);
    return placeholder("BOLD", boldTokens.length - 1);
  });
  // Headings → placeholder
  result = result.replace(/^#{1,6}\s+(.+)$/gm, (_, inner) => {
    boldTokens.push(inner);
    return placeholder("BOLD", boldTokens.length - 1);
  });

  // Now italic *text* → _text_ (safe because bold is already protected)
  result = result.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "_$1_");

  // Restore bold → *text*
  result = result.replace(
    restorePattern("BOLD"),
    (_, i) => `*${boldTokens[Number(i)]}*`,
  );

  result = result
    .replace(/~~(.*?)~~/g, "~$1~")
    .replace(/^[\s]*[-*+]\s+/gm, "• ")
    .replace(/^[\s]*\d+\.\s+/gm, "1. ");

  // Restore protected tokens
  result = result.replace(restorePattern("URL"), (_, i) => urls[Number(i)]);
  result = result.replace(
    restorePattern("INLINE"),
    (_, i) => inlineCode[Number(i)],
  );
  result = result.replace(
    restorePattern("CODE"),
    (_, i) => codeBlocks[Number(i)],
  );

  return result;
}

/** Split long messages at smart boundaries (paragraph → sentence → line → word). */
export function splitMessage(text: string, maxLength = 3900): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitPoint = maxLength;
    const half = maxLength * 0.5;

    const para = remaining.lastIndexOf("\n\n", maxLength);
    if (para > half) splitPoint = para + 2;
    else {
      const sentence = remaining.lastIndexOf(". ", maxLength);
      if (sentence > half) splitPoint = sentence + 2;
      else {
        const line = remaining.lastIndexOf("\n", maxLength);
        if (line > half) splitPoint = line + 1;
        else {
          const word = remaining.lastIndexOf(" ", maxLength);
          if (word > half) splitPoint = word + 1;
        }
      }
    }

    chunks.push(remaining.slice(0, splitPoint).trim());
    remaining = remaining.slice(splitPoint).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
