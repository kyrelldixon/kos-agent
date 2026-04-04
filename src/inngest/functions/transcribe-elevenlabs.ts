import { invoke } from "inngest";
import { z } from "zod";
import { transcribeAudio } from "@/voice-memo/elevenlabs";
import { inngest } from "../client";

export const transcribeElevenlabs = inngest.createFunction(
  {
    id: "transcribe-elevenlabs",
    retries: 2,
    triggers: [invoke(z.object({ filePath: z.string() }))],
  },
  async ({ event }) => {
    try {
      const result = await transcribeAudio(event.data.filePath);
      return { transcript: result.transcript, duration: result.duration };
    } catch (error) {
      console.error("Transcription failed:", error);
      return { transcript: "", duration: "" };
    }
  },
);
