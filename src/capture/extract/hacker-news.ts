import { z } from "zod";
import { extractArticleContent } from "./article";

export interface HNContent {
  article: string;
  comments: Array<{ author: string; text: string; points: number }>;
}

const HNChildSchema = z.object({
  author: z.string().optional(),
  text: z.string().optional(),
  points: z.number().optional(),
});

const HNItemSchema = z.object({
  url: z.string().optional(),
  children: z.array(HNChildSchema).optional(),
});

export async function extractHNContent(url: string): Promise<HNContent> {
  const itemId = new URL(url).searchParams.get("id");
  if (!itemId) return { article: "", comments: [] };

  try {
    const res = await fetch(`https://hn.algolia.com/api/v1/items/${itemId}`, {
      signal: AbortSignal.timeout(10_000),
    });

    const parsed = HNItemSchema.safeParse(await res.json());
    if (!parsed.success) return { article: "", comments: [] };

    const data = parsed.data;
    const article = data.url ? await extractArticleContent(data.url) : "";
    const comments = (data.children ?? [])
      .filter((c) => c.text)
      .slice(0, 20)
      .map((c) => ({
        author: c.author ?? "unknown",
        text: c.text ?? "",
        points: c.points ?? 0,
      }));

    return { article, comments };
  } catch {
    return { article: "", comments: [] };
  }
}
