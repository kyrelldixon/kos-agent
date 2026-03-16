import { describe, expect, test } from "bun:test";
import type { JobConfig } from "@/jobs/schema";
import { labelFor, plistForJob } from "@/jobs/sync";

describe("labelFor", () => {
  test("generates kos.job prefix label", () => {
    expect(labelFor("dns-check")).toBe("kos.job.dns-check");
  });

  test("handles underscores and hyphens", () => {
    expect(labelFor("dns-check_v2")).toBe("kos.job.dns-check_v2");
  });
});

describe("plistForJob", () => {
  const periodicJob: JobConfig = {
    name: "dns-check",
    schedule: { type: "periodic", seconds: 3600 },
    execution: { type: "script" },
    destination: { chatId: "D0ABC123" },
    disabled: false,
    createdAt: "2026-03-15T12:00:00Z",
    updatedAt: "2026-03-15T12:00:00Z",
  };

  test("generates valid plist XML with StartInterval", () => {
    const plist = plistForJob(periodicJob);
    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain("<string>kos.job.dns-check</string>");
    expect(plist).toContain("<key>StartInterval</key>");
    expect(plist).toContain("<integer>3600</integer>");
    expect(plist).toContain("<key>ProgramArguments</key>");
    expect(plist).toContain("<key>ProcessType</key>");
    expect(plist).toContain("<string>Background</string>");
  });

  test("generates StartCalendarInterval for scheduled jobs", () => {
    const scheduledJob: JobConfig = {
      ...periodicJob,
      name: "daily-review",
      schedule: { type: "scheduled", calendar: { Hour: 9, Minute: 0 } },
    };
    const plist = plistForJob(scheduledJob);
    expect(plist).toContain("<key>StartCalendarInterval</key>");
    expect(plist).toContain("<key>Hour</key>");
    expect(plist).toContain("<integer>9</integer>");
  });

  test("generates array StartCalendarInterval for multiple times", () => {
    const multiJob: JobConfig = {
      ...periodicJob,
      name: "twice-daily",
      schedule: {
        type: "scheduled",
        calendar: [
          { Hour: 9, Minute: 0 },
          { Hour: 14, Minute: 0 },
        ],
      },
    };
    const plist = plistForJob(multiJob);
    expect(plist).toContain("<key>StartCalendarInterval</key>");
    expect(plist).toContain("<array>");
    expect(plist).toContain("<integer>14</integer>");
  });

  test("includes log paths", () => {
    const plist = plistForJob(periodicJob);
    expect(plist).toContain("StandardOutPath");
    expect(plist).toContain("kos.job.dns-check.out.log");
    expect(plist).toContain("StandardErrorPath");
    expect(plist).toContain("kos.job.dns-check.err.log");
  });
});
