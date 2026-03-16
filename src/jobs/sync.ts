import { homedir } from "node:os";
import { join } from "node:path";
import type { JobConfig } from "@/jobs/schema";

export const KOS_PREFIX = "kos.job";
export const JOBS_DIR = join(homedir(), ".kos/agent/jobs");
export const LAUNCH_AGENTS_DIR = join(homedir(), "Library/LaunchAgents");
export const LOGS_DIR = join(homedir(), ".kos/agent/logs");

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function labelFor(name: string): string {
  return `${KOS_PREFIX}.${sanitizeName(name)}`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plistValue(value: unknown, indent = "  "): string {
  if (typeof value === "string")
    return `${indent}<string>${escapeXml(value)}</string>`;
  if (typeof value === "number")
    return `${indent}<integer>${Math.trunc(value)}</integer>`;
  if (typeof value === "boolean")
    return `${indent}<${value ? "true" : "false"}/>`;
  if (Array.isArray(value)) {
    const entries = value
      .map((entry) => plistValue(entry, `${indent}  `))
      .join("\n");
    return `${indent}<array>\n${entries}\n${indent}</array>`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(
        ([key, entry]) =>
          `${indent}  <key>${escapeXml(key)}</key>\n${plistValue(entry, `${indent}  `)}`,
      )
      .join("\n");
    return `${indent}<dict>\n${entries}\n${indent}</dict>`;
  }
  return `${indent}<string></string>`;
}

export function plistForJob(job: JobConfig): string {
  const label = labelFor(job.name);

  const base: Record<string, unknown> = {
    Label: label,
    ProgramArguments: [join(JOBS_DIR, job.name, "run")],
    WorkingDirectory: join(JOBS_DIR, job.name),
    StandardOutPath: join(LOGS_DIR, `${label}.out.log`),
    StandardErrorPath: join(LOGS_DIR, `${label}.err.log`),
    ProcessType: "Background",
    KeepAlive: false,
    RunAtLoad: false,
  };

  if (job.schedule.type === "periodic") {
    base.StartInterval = job.schedule.seconds;
  }
  if (job.schedule.type === "scheduled") {
    base.StartCalendarInterval = job.schedule.calendar;
  }

  const dict = plistValue(base, "  ");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    dict,
    "</plist>",
    "",
  ].join("\n");
}
