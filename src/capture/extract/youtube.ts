import { z } from "zod";

const YtDlpVideoSchema = z.object({
  url: z.string().optional(),
  id: z.string().optional(),
  title: z.string().optional(),
});

export async function extractYouTubeTranscript(url: string): Promise<string> {
  try {
    // yt-dlp can extract auto-generated subtitles
    const proc = Bun.spawn(
      [
        "yt-dlp",
        "--write-auto-sub",
        "--sub-lang",
        "en",
        "--skip-download",
        "--sub-format",
        "vtt",
        "-o",
        "/tmp/kos-yt-%(id)s",
        url,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;

    // Find the subtitle file
    const videoId = extractVideoId(url);
    if (!videoId) return "";

    const vttPath = `/tmp/kos-yt-${videoId}.en.vtt`;
    const file = Bun.file(vttPath);
    if (!(await file.exists())) return "";

    const vttContent = await file.text();
    // Clean up temp file
    const { rm: rmFile } = await import("node:fs/promises");
    await rmFile(vttPath).catch(() => {});

    return parseVttToTranscript(vttContent);
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

function extractVideoId(url: string): string | undefined {
  const parsed = new URL(url);
  if (parsed.hostname === "youtu.be") {
    return parsed.pathname.slice(1);
  }
  return parsed.searchParams.get("v") ?? undefined;
}

function parseVttToTranscript(vtt: string): string {
  const lines = vtt.split("\n");
  const textLines: string[] = [];
  let lastText = "";

  for (const line of lines) {
    // Skip VTT header, timestamps, and empty lines
    if (
      line.startsWith("WEBVTT") ||
      line.startsWith("Kind:") ||
      line.startsWith("Language:") ||
      line.includes("-->") ||
      line.trim() === "" ||
      /^\d+$/.test(line.trim())
    ) {
      continue;
    }

    // Remove VTT formatting tags
    const clean = line.replace(/<[^>]+>/g, "").trim();
    if (clean && clean !== lastText) {
      textLines.push(clean);
      lastText = clean;
    }
  }

  return textLines.join("\n");
}
