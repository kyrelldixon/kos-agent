import type { Block } from "@slack/types";
import type { CaptureMode, ContentType } from "./schema";

interface NotificationInput {
  title: string;
  url?: string;
  type: ContentType | "file";
  mode: CaptureMode | "full";
  notePath: string;
}

const TYPE_EMOJI: Record<string, string> = {
  article: "📄",
  "youtube-video": "🎥",
  "youtube-channel": "📺",
  "hacker-news": "🟧",
  twitter: "🐦",
  file: "📁",
};

export function buildNotificationMessage(input: NotificationInput): string {
  const emoji = TYPE_EMOJI[input.type] ?? "📎";
  const modeLabel = input.mode === "full" ? "full capture" : "quick save";
  const lines = [`${emoji} *${input.title}*`];
  if (input.url) lines.push(input.url);
  lines.push(`${input.type} · ${modeLabel} → \`${input.notePath}\``);
  return lines.join("\n");
}

interface TriageInput {
  captureId: string;
  type: ContentType | "file";
  title: string;
  description: string;
}

export interface SlackBlock extends Block {
  [key: string]: unknown;
}

export function buildTriageBlocks(input: TriageInput): SlackBlock[] {
  const emoji = TYPE_EMOJI[input.type] ?? "📎";
  const typeLabel = input.type.replace("-", " ");

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${emoji} *${typeLabel}:* ${input.title}\n${input.description}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Full capture" },
          action_id: `capture_decision_full_${input.captureId}`,
          value: JSON.stringify({ captureId: input.captureId, action: "full" }),
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Quick save" },
          action_id: `capture_decision_quick_${input.captureId}`,
          value: JSON.stringify({
            captureId: input.captureId,
            action: "quick-save",
          }),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Skip" },
          action_id: `capture_decision_skip_${input.captureId}`,
          value: JSON.stringify({ captureId: input.captureId, action: "skip" }),
          style: "danger",
        },
      ],
    },
  ];
}

export function buildTriageUpdateText(
  title: string,
  type: string,
  description: string,
  outcome: string,
): string {
  const emoji = TYPE_EMOJI[type] ?? "📎";
  const typeLabel = type.replace("-", " ");
  return `${emoji} *${typeLabel}:* ${title}\n${description}\n${outcome}`;
}
