import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { writeVaultNote } from "@/capture/vault/writer";
import { buildVoiceMemoNote, deriveTitle } from "@/voice-memo/templates";
import { inngest, voiceMemoDetected } from "../client";
import { transcribeElevenlabs } from "./transcribe-elevenlabs";

export const handleVoiceMemo = inngest.createFunction(
  {
    id: "handle-voice-memo",
    retries: 2,
    timeouts: { finish: "10m" },
    triggers: [voiceMemoDetected],
    singleton: { key: "event.data.captureKey", mode: "cancel" },
  },
  async ({ event, step }) => {
    const { filePath, fileName } = event.data;

    // Step 1: Validate file exists and derive title
    const metadata = await step.run("validate-file", () => {
      if (!existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }
      const title = deriveTitle(fileName);
      return { title };
    });

    // Step 2: Transcribe via ElevenLabs (invokeable sub-function)
    const transcription = await step.invoke("transcribe-audio", {
      function: transcribeElevenlabs,
      data: { filePath },
      timeout: "5m",
    });

    // Step 3: Write vault note
    const notePath = await step.run("write-vault-note", async () => {
      const note = buildVoiceMemoNote({
        title: metadata.title,
        filePath,
        duration: transcription.duration,
        transcript: transcription.transcript,
        extractionMethod: "elevenlabs",
      });

      return writeVaultNote(
        undefined,
        metadata.title,
        note,
        undefined,
        filePath,
      );
    });

    // Step 4: Notify via Slack
    await step.run("notify", async () => {
      const failed = !transcription.transcript;
      const preview = transcription.transcript
        ? transcription.transcript.slice(0, 200) +
          (transcription.transcript.length > 200 ? "..." : "")
        : "Transcription failed";

      const lines = [
        failed ? `*Failed: ${metadata.title}*` : `*${metadata.title}*`,
        `Duration: ${transcription.duration || "unknown"}`,
        "",
        preview,
        "",
        `→ \`${notePath}\``,
      ];
      const msg = lines.join("\n");

      const { slack } = await import("@/lib/slack");
      const { getNotifyChannel } = await import("@/lib/channels");
      const notifyChannel = await getNotifyChannel();
      if (notifyChannel) {
        await slack.chat
          .postMessage({ channel: notifyChannel, text: msg })
          .catch(() => {});
      }
    });

    // Step 5: Cleanup capture directory
    await step.run("cleanup", () => {
      const captureDir = dirname(filePath);
      if (captureDir.includes("voice-memo-")) {
        rmSync(captureDir, { recursive: true, force: true });
      }
    });

    return {
      status: transcription.transcript ? "success" : "transcription-failed",
      title: metadata.title,
      duration: transcription.duration,
      notePath,
    };
  },
);
