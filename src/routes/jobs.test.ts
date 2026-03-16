import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createJobsRoutes } from "@/routes/jobs";

describe("jobs API", () => {
  let testDir: string;
  let app: Hono;

  beforeEach(async () => {
    testDir = join(tmpdir(), `kos-jobs-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    app = new Hono();
    app.route(
      "/api/jobs",
      createJobsRoutes({ jobsDir: testDir, skipSync: true }),
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("POST /api/jobs creates a job directory and job.json", async () => {
    const res = await app.request("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "dns-check",
        schedule: { type: "periodic", seconds: 3600 },
        execution: { type: "script" },
        destination: { chatId: "D0ABC123" },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("dns-check");
    expect(body.disabled).toBe(false);
    expect(body.createdAt).toBeDefined();
    expect(existsSync(join(testDir, "dns-check", "job.json"))).toBe(true);
  });

  test("POST /api/jobs writes inline script content to file", async () => {
    const res = await app.request("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "dns-check-inline",
        schedule: { type: "periodic", seconds: 3600 },
        execution: {
          type: "script",
          script: "#!/bin/bash\ndig kyrelldixon.com NS +short",
        },
        destination: { chatId: "D0ABC123" },
      }),
    });
    expect(res.status).toBe(201);
    const scriptPath = join(testDir, "dns-check-inline", "script");
    expect(existsSync(scriptPath)).toBe(true);
    const content = await readFile(scriptPath, "utf-8");
    expect(content).toContain("#!/bin/bash");
    expect(content).toContain("dig kyrelldixon.com");
    // Script content should not be stored in job.json
    const config = JSON.parse(
      await readFile(join(testDir, "dns-check-inline", "job.json"), "utf-8"),
    );
    expect(config.execution.script).toBeUndefined();
  });

  test("POST /api/jobs returns 409 if job exists", async () => {
    await mkdir(join(testDir, "dns-check"));
    await writeFile(join(testDir, "dns-check", "job.json"), "{}");

    const res = await app.request("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "dns-check",
        schedule: { type: "periodic", seconds: 3600 },
        execution: { type: "script" },
        destination: { chatId: "D0ABC123" },
      }),
    });
    expect(res.status).toBe(409);
  });

  test("POST /api/jobs returns 400 for invalid payload", async () => {
    const res = await app.request("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bad..name" }),
    });
    expect(res.status).toBe(400);
  });

  test("GET /api/jobs lists jobs", async () => {
    const jobDir = join(testDir, "test-job");
    await mkdir(jobDir);
    await writeFile(
      join(jobDir, "job.json"),
      JSON.stringify({
        name: "test-job",
        schedule: { type: "periodic", seconds: 60 },
        execution: { type: "script" },
        destination: { chatId: "D0ABC123" },
        disabled: false,
        createdAt: "2026-03-15T12:00:00Z",
        updatedAt: "2026-03-15T12:00:00Z",
      }),
    );

    const res = await app.request("/api/jobs");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("test-job");
  });

  test("DELETE /api/jobs/:name removes job directory", async () => {
    const jobDir = join(testDir, "test-job");
    await mkdir(jobDir);
    await writeFile(join(jobDir, "job.json"), "{}");

    const res = await app.request("/api/jobs/test-job", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(existsSync(jobDir)).toBe(false);
  });

  test("DELETE /api/jobs/:name returns 404 for missing job", async () => {
    const res = await app.request("/api/jobs/nope", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  test("PATCH /api/jobs/:name updates disabled field", async () => {
    const jobDir = join(testDir, "test-job");
    await mkdir(jobDir);
    await writeFile(
      join(jobDir, "job.json"),
      JSON.stringify({
        name: "test-job",
        schedule: { type: "periodic", seconds: 60 },
        execution: { type: "script" },
        destination: { chatId: "D0ABC123" },
        disabled: false,
        createdAt: "2026-03-15T12:00:00Z",
        updatedAt: "2026-03-15T12:00:00Z",
      }),
    );

    const res = await app.request("/api/jobs/test-job", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.disabled).toBe(true);

    const onDisk = JSON.parse(
      await readFile(join(jobDir, "job.json"), "utf-8"),
    );
    expect(onDisk.disabled).toBe(true);
  });

  test("PATCH /api/jobs/:name rejects name change (immutable)", async () => {
    const jobDir = join(testDir, "test-job");
    await mkdir(jobDir);
    await writeFile(
      join(jobDir, "job.json"),
      JSON.stringify({
        name: "test-job",
        schedule: { type: "periodic", seconds: 60 },
        execution: { type: "script" },
        destination: { chatId: "D0ABC123" },
        disabled: false,
        createdAt: "2026-03-15T12:00:00Z",
        updatedAt: "2026-03-15T12:00:00Z",
      }),
    );

    const res = await app.request("/api/jobs/test-job", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed" }),
    });
    expect(res.status).toBe(400);
  });
});
