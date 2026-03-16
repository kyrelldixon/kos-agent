import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadJobConfig } from "@/inngest/functions/handle-scheduled-job";

describe("loadJobConfig", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `kos-job-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("loads valid job config", async () => {
    const jobDir = join(testDir, "test-job");
    await mkdir(jobDir);
    await writeFile(
      join(jobDir, "job.json"),
      JSON.stringify({
        name: "test-job",
        schedule: { type: "periodic", seconds: 60 },
        execution: { type: "script" },
        destination: { chatId: "D123" },
        disabled: false,
        createdAt: "2026-03-15T12:00:00Z",
        updatedAt: "2026-03-15T12:00:00Z",
      }),
    );
    const config = await loadJobConfig("test-job", testDir);
    expect(config.name).toBe("test-job");
  });

  test("throws NonRetriableError for missing job", async () => {
    expect(loadJobConfig("nope", testDir)).rejects.toThrow("not found");
  });

  test("throws NonRetriableError for invalid config", async () => {
    const jobDir = join(testDir, "bad-job");
    await mkdir(jobDir);
    await writeFile(join(jobDir, "job.json"), '{"name": 123}');
    expect(loadJobConfig("bad-job", testDir)).rejects.toThrow("invalid config");
  });
});
