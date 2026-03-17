import { Readability } from "@mozilla/readability";
import { invoke } from "inngest";
import { JSDOM } from "jsdom";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { z } from "zod";
import { inngest } from "../client";

export async function fetchAndConvertLocal(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "kos-agent/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return "";
    const html = await res.text();

    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article?.content) return "";

    return NodeHtmlMarkdown.translate(article.content);
  } catch {
    return "";
  }
}

export const localExtraction = inngest.createFunction(
  {
    id: "local-extraction",
    retries: 1,
    triggers: [invoke(z.object({ url: z.string() }))],
  },
  async ({ event }) => {
    const content = await fetchAndConvertLocal(event.data.url);
    return { content };
  },
);
