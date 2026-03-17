/**
 * Thin wrapper for backward compatibility.
 * Real extraction logic lives in Inngest functions:
 * - extract-jina.ts (Tier 1)
 * - extract-local.ts (Tier 2)
 * - extract-cf-browser.ts (Tier 3)
 */
export async function extractArticleContent(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "kos-agent/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    return await res.text();
  } catch {
    return "";
  }
}
