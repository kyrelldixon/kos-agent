import { sanitizeFilename } from "@/capture/vault/templates";

export interface VoiceMemoNoteInput {
  title: string;
  filePath: string;
  duration: string;
  transcript: string;
  extractionMethod: string;
}

const DEFAULT_NAME_PATTERNS = [
  /^\d{8}\s+\d{6}\.[^.]+$/i, // 20260404 142345.m4a (or any extension)
  /^New Recording(\s+\d+)?\.[^.]+$/i, // New Recording.m4a, New Recording 3.mp3
  /^Recording(\s+\d+)?\.[^.]+$/i, // Recording.m4a, Recording.wav
];

function formatDate(): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const yyyy = now.getFullYear();
  return `${mm}-${dd}-${yyyy}`;
}

function formatDateTime(): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const yyyy = now.getFullYear();
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return `${mm}-${dd}-${yyyy} ${hh}:${min}`;
}

export function deriveTitle(fileName: string): string {
  const isDefaultName = DEFAULT_NAME_PATTERNS.some((pattern) =>
    pattern.test(fileName),
  );

  if (isDefaultName) {
    return `Voice Memo — ${formatDateTime()}`;
  }

  // Strip extension
  return fileName.replace(/\.[^.]+$/, "");
}

export function buildVoiceMemoNote(input: VoiceMemoNoteInput): string {
  const status = input.transcript ? "raw" : "transcription-failed";
  const date = formatDate();

  const lines: string[] = [
    "---",
    "categories:",
    '  - "[[Sources]]"',
    "source_type: voice-memo",
    `file_path: "${input.filePath}"`,
    `created: "[[${date}]]"`,
    `duration: "${input.duration}"`,
    `extraction_method: ${input.extractionMethod}`,
    "topics: []",
    `status: ${status}`,
    "---",
    "",
    `# ${input.title}`,
  ];

  if (input.transcript) {
    lines.push("", input.transcript);
  }

  return `${lines.join("\n")}\n`;
}

export { sanitizeFilename };
