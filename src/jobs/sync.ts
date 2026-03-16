import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateRunScript } from "@/jobs/run-template";
import { type JobConfig, JobConfigSchema } from "@/jobs/schema";

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

export interface SyncReport {
  synced: string[];
  removed: string[];
  unchanged: string[];
  errors: Array<{ name: string; error: string }>;
}

export function runLaunchctl(args: string[]): {
  ok: boolean;
  stdout: string;
  stderr: string;
} {
  const result = Bun.spawnSync(["launchctl", ...args]);
  const decoder = new TextDecoder();
  return {
    ok: result.exitCode === 0,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

export function currentUid(): string {
  return String(process.getuid?.() ?? 501);
}

export async function discoverJobs(jobsDir?: string): Promise<JobConfig[]> {
  const dir = jobsDir ?? JOBS_DIR;

  if (!existsSync(dir)) {
    return [];
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const jobs: JobConfig[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const jobJsonPath = join(dir, entry.name, "job.json");
    if (!existsSync(jobJsonPath)) continue;

    try {
      const raw = await readFile(jobJsonPath, "utf-8");
      const parsed = JSON.parse(raw);
      const result = JobConfigSchema.safeParse(parsed);
      if (result.success) {
        jobs.push(result.data);
      } else {
        console.warn(
          `Invalid job.json in ${entry.name}: ${result.error.message}`,
        );
      }
    } catch {
      console.warn(`Failed to read job.json in ${entry.name}`);
    }
  }

  return jobs;
}

export async function installJob(
  job: JobConfig,
  options?: {
    jobsDir?: string;
    launchAgentsDir?: string;
    logsDir?: string;
  },
): Promise<boolean> {
  const jobsDir = options?.jobsDir ?? JOBS_DIR;
  const launchAgentsDir = options?.launchAgentsDir ?? LAUNCH_AGENTS_DIR;
  const logsDir = options?.logsDir ?? LOGS_DIR;
  const label = labelFor(job.name);
  const plistPath = join(launchAgentsDir, `${label}.plist`);
  const jobDir = join(jobsDir, job.name);

  // Generate plist XML
  const plistXml = plistForJob(job);

  // Write run script
  const runScriptPath = join(jobDir, "run");
  const runScriptContent = generateRunScript(job.name);
  await mkdir(jobDir, { recursive: true });
  await writeFile(runScriptPath, runScriptContent);
  await chmod(runScriptPath, 0o755);

  // Chmod script file if it exists
  const scriptPath = join(jobDir, "script");
  if (existsSync(scriptPath)) {
    await chmod(scriptPath, 0o755);
  }

  // Ensure logs dir exists
  await mkdir(logsDir, { recursive: true });

  // Ensure launch agents dir exists
  await mkdir(launchAgentsDir, { recursive: true });

  // Compare with existing plist — if unchanged, return false
  if (existsSync(plistPath)) {
    try {
      const existing = await readFile(plistPath, "utf-8");
      if (existing === plistXml) {
        return false;
      }
    } catch {
      // If read fails, proceed with writing
    }
  }

  // Write plist
  await writeFile(plistPath, plistXml);
  await chmod(plistPath, 0o644);

  // Manage launchctl
  const uid = currentUid();
  const guiTarget = `gui/${uid}`;

  // Bootout (ignore errors — idempotent)
  runLaunchctl(["bootout", guiTarget, plistPath]);

  // Bootstrap
  const bootstrap = runLaunchctl(["bootstrap", guiTarget, plistPath]);
  if (!bootstrap.ok) {
    // Fallback: launchctl asuser <uid> launchctl bootstrap gui/<uid> <plistPath>
    Bun.spawnSync([
      "launchctl",
      "asuser",
      uid,
      "launchctl",
      "bootstrap",
      guiTarget,
      plistPath,
    ]);
  }

  // Enable
  runLaunchctl(["enable", `${guiTarget}/${label}`]);

  return true;
}

export async function uninstallJob(
  name: string,
  options?: { launchAgentsDir?: string },
): Promise<void> {
  const launchAgentsDir = options?.launchAgentsDir ?? LAUNCH_AGENTS_DIR;
  const label = labelFor(name);
  const plistPath = join(launchAgentsDir, `${label}.plist`);
  const uid = currentUid();

  // Bootout (ignore errors)
  runLaunchctl(["bootout", `gui/${uid}`, plistPath]);

  // Delete the plist file
  if (existsSync(plistPath)) {
    await unlink(plistPath);
  }
}

export async function syncAllJobs(options?: {
  jobsDir?: string;
  launchAgentsDir?: string;
  logsDir?: string;
}): Promise<SyncReport> {
  const jobsDir = options?.jobsDir ?? JOBS_DIR;
  const launchAgentsDir = options?.launchAgentsDir ?? LAUNCH_AGENTS_DIR;
  const logsDir = options?.logsDir ?? LOGS_DIR;

  const report: SyncReport = {
    synced: [],
    removed: [],
    unchanged: [],
    errors: [],
  };

  // Discover all jobs
  const jobs = await discoverJobs(jobsDir);
  const jobNames = new Set(jobs.map((j) => j.name));

  // Process each job
  for (const job of jobs) {
    try {
      if (job.disabled) {
        // Disabled jobs: bootout/remove plist if one exists
        const label = labelFor(job.name);
        const plistPath = join(launchAgentsDir, `${label}.plist`);
        if (existsSync(plistPath)) {
          await uninstallJob(job.name, { launchAgentsDir });
          report.removed.push(job.name);
        }
      } else {
        // Enabled jobs: install
        const changed = await installJob(job, {
          jobsDir,
          launchAgentsDir,
          logsDir,
        });
        if (changed) {
          report.synced.push(job.name);
        } else {
          report.unchanged.push(job.name);
        }
      }
    } catch (err) {
      report.errors.push({
        name: job.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Find stale plists (kos.job.* prefix, no matching job)
  if (existsSync(launchAgentsDir)) {
    const plistFiles = await readdir(launchAgentsDir);
    for (const file of plistFiles) {
      if (!file.startsWith(`${KOS_PREFIX}.`) || !file.endsWith(".plist"))
        continue;

      // Extract name from kos.job.<name>.plist
      const label = file.replace(/\.plist$/, "");
      const namepart = label.slice(`${KOS_PREFIX}.`.length);

      if (!jobNames.has(namepart)) {
        try {
          await uninstallJob(namepart, { launchAgentsDir });
          report.removed.push(namepart);
        } catch (err) {
          report.errors.push({
            name: namepart,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  return report;
}
