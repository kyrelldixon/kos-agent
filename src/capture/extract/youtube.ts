import { YoutubeTranscript } from "youtube-transcript";
import { z } from "zod";

const YtDlpVideoSchema = z.object({
  url: z.string().optional(),
  id: z.string().optional(),
  title: z.string().optional(),
});

export async function extractYouTubeTranscript(url: string): Promise<string> {
  try {
    const entries = await YoutubeTranscript.fetchTranscript(url, {
      lang: "en",
    });
    if (!entries.length) return "";

    return entries.map((entry) => entry.text).join(" ");
  } catch {
    return "";
  }
}

export async function listChannelVideos(
  channelUrl: string,
  limit = 10,
): Promise<Array<{ url: string; title: string }>> {
  try {
    const proc = Bun.spawn(
      [
        "yt-dlp",
        "--flat-playlist",
        "--dump-json",
        "--playlist-end",
        String(limit),
        `${channelUrl}/videos`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) return [];

    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parsed = YtDlpVideoSchema.safeParse(JSON.parse(line));
        if (!parsed.success) return null;
        const data = parsed.data;
        return {
          url: data.url ?? `https://www.youtube.com/watch?v=${data.id}`,
          title: data.title ?? "Untitled",
        };
      })
      .filter(
        (entry): entry is { url: string; title: string } => entry !== null,
      );
  } catch {
    return [];
  }
}
