import { z } from "zod";

const CrawlResponseSchema = z.object({
  success: z.boolean(),
  result: z
    .object({
      id: z.string(),
    })
    .optional(),
});

const CrawlStatusSchema = z.object({
  success: z.boolean(),
  result: z
    .object({
      status: z.string(),
      pages: z
        .array(
          z.object({
            markdown: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

export async function extractArticleContent(url: string): Promise<string> {
  const accountId = process.env.CF_ACCOUNT_ID;
  const apiToken = process.env.CF_API_TOKEN;

  if (!accountId || !apiToken) {
    return extractViaFetch(url);
  }

  try {
    const crawlRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/crawl`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url,
          scrapeOptions: { formats: ["markdown"] },
          limit: 1,
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );

    const crawlParsed = CrawlResponseSchema.safeParse(await crawlRes.json());
    if (!crawlParsed.success || !crawlParsed.data.result?.id) {
      return extractViaFetch(url);
    }

    const jobId = crawlParsed.data.result.id;
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2_000));
      const statusRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/crawl/${jobId}`,
        {
          headers: { Authorization: `Bearer ${apiToken}` },
          signal: AbortSignal.timeout(10_000),
        },
      );

      const statusParsed = CrawlStatusSchema.safeParse(await statusRes.json());
      if (!statusParsed.success) continue;

      const status = statusParsed.data.result?.status;
      if (status === "complete") {
        return statusParsed.data.result?.pages?.[0]?.markdown ?? "";
      }
      if (status === "failed") {
        return extractViaFetch(url);
      }
    }

    return extractViaFetch(url);
  } catch {
    return extractViaFetch(url);
  }
}

async function extractViaFetch(url: string): Promise<string> {
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
