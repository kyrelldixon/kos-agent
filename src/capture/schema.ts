import { z } from "zod";

export const ContentTypeEnum = z.enum([
  "article",
  "youtube-video",
  "youtube-channel",
  "hacker-news",
  "twitter",
  "github-repo",
]);
export type ContentType = z.infer<typeof ContentTypeEnum>;

export const CaptureModeEnum = z.enum(["full", "quick", "triage"]);
export type CaptureMode = z.infer<typeof CaptureModeEnum>;

export const CaptureDecisionEnum = z.enum(["full", "quick-save", "skip"]);
export type CaptureDecision = z.infer<typeof CaptureDecisionEnum>;

export const CaptureDestinationSchema = z.object({
  chatId: z.string(),
  threadId: z.string().optional(),
});
export type CaptureDestination = z.infer<typeof CaptureDestinationSchema>;

export const CaptureEventSchema = z.object({
  captureKey: z.string(),
  url: z.string().url(),
  type: ContentTypeEnum.optional(),
  destination: CaptureDestinationSchema.optional(),
  batchId: z.string().optional(),
  parentCaptureId: z.string().optional(),
  mode: CaptureModeEnum.default("triage"),
});
export type CaptureEventData = z.infer<typeof CaptureEventSchema>;

// Inngest event schemas must have matching input/output types (no transforms).
// This variant uses optional() instead of default() for the mode field.
export const CaptureEventInngestSchema = z.object({
  captureKey: z.string(),
  url: z.string().url(),
  type: ContentTypeEnum.optional(),
  destination: CaptureDestinationSchema.optional(),
  batchId: z.string().optional(),
  parentCaptureId: z.string().optional(),
  mode: CaptureModeEnum.optional(),
});

export const CaptureFileEventSchema = z.object({
  captureKey: z.string(),
  filePath: z.string(),
  title: z.string().optional(),
  destination: CaptureDestinationSchema.optional(),
});
export type CaptureFileEventData = z.infer<typeof CaptureFileEventSchema>;

export const CaptureDecisionEventSchema = z.object({
  captureId: z.string(),
  action: CaptureDecisionEnum,
});
export type CaptureDecisionEventData = z.infer<
  typeof CaptureDecisionEventSchema
>;

export const CaptureRequestSchema = z
  .object({
    urls: z.array(z.string().url()).min(1).optional(),
    filePath: z.string().optional(),
    mode: CaptureModeEnum.optional(),
    type: ContentTypeEnum.optional(),
    title: z.string().optional(),
    destination: CaptureDestinationSchema.optional(),
  })
  .refine((data) => {
    const hasUrls = data.urls !== undefined && data.urls.length > 0;
    const hasFile = data.filePath !== undefined;
    return (hasUrls || hasFile) && !(hasUrls && hasFile);
  }, "Must provide either urls or filePath, not both");
export type CaptureRequest = z.infer<typeof CaptureRequestSchema>;
