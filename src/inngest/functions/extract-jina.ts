import { invoke } from "inngest";
import { z } from "zod";
import { inngest } from "../client";

export async function fetchViaJina(url: string): Promise<string> {
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { Accept: "text/markdown" },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return "";
    return await res.text();
  } catch {
    return "";
  }
}

export const jinaExtraction = inngest.createFunction(
  {
    id: "jina-extraction",
    throttle: { limit: 18, period: "1m" },
    retries: 1,
    triggers: [invoke(z.object({ url: z.string() }))],
  },
  async ({ event }) => {
    const content = await fetchViaJina(event.data.url);
    return { content };
  },
);
