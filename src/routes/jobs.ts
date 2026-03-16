import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { type JobConfig, JobCreateSchema } from "@/jobs/schema";
import { discoverJobs, installJob, JOBS_DIR, uninstallJob } from "@/jobs/sync";

interface JobsRoutesOptions {
  jobsDir?: string;
  skipSync?: boolean;
}

export function createJobsRoutes(options?: JobsRoutesOptions): Hono {
  const app = new Hono();
  const jobsDir = options?.jobsDir ?? JOBS_DIR;
  const skipSync = options?.skipSync ?? false;

  // GET / — list all jobs
  app.get("/", async (c) => {
    const jobs = await discoverJobs(jobsDir);
    return c.json(jobs);
  });

  // POST / — create a job
  app.post("/", async (c) => {
    const body = await c.req.json();
    const parsed = JobCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed", details: parsed.error.issues },
        400,
      );
    }

    const { name } = parsed.data;
    const jobDir = join(jobsDir, name);

    if (existsSync(jobDir)) {
      return c.json({ error: `Job '${name}' already exists` }, 409);
    }

    const now = new Date().toISOString();
    const config: JobConfig = {
      ...parsed.data,
      disabled: false,
      createdAt: now,
      updatedAt: now,
    };

    await mkdir(jobDir, { recursive: true });
    await writeFile(join(jobDir, "job.json"), JSON.stringify(config, null, 2));

    if (!skipSync) {
      await installJob(config, { jobsDir });
    }

    return c.json(config, 201);
  });

  // DELETE /:name — delete a job
  app.delete("/:name", async (c) => {
    const name = c.req.param("name");
    const jobDir = join(jobsDir, name);

    if (!existsSync(jobDir)) {
      return c.json({ error: `Job '${name}' not found` }, 404);
    }

    if (!skipSync) {
      await uninstallJob(name);
    }
    await rm(jobDir, { recursive: true, force: true });

    return c.body(null, 204);
  });

  // PATCH /:name — update a job
  app.patch("/:name", async (c) => {
    const name = c.req.param("name");
    const jobDir = join(jobsDir, name);
    const jobJsonPath = join(jobDir, "job.json");

    if (!existsSync(jobJsonPath)) {
      return c.json({ error: `Job '${name}' not found` }, 404);
    }

    const body = await c.req.json();

    // Reject immutable fields
    const immutableFields = ["name", "execution"];
    for (const field of immutableFields) {
      if (field in body) {
        return c.json(
          {
            error: `'${field}' is immutable. Delete and recreate the job instead.`,
          },
          400,
        );
      }
    }

    // Validate mutable fields
    const updates: Record<string, unknown> = {};
    if (body.disabled !== undefined) updates.disabled = body.disabled;
    if (body.schedule !== undefined) updates.schedule = body.schedule;
    if (body.destination !== undefined) updates.destination = body.destination;
    if (body.prompt !== undefined) {
      const existing = JSON.parse(await readFile(jobJsonPath, "utf-8"));
      if (existing.execution?.type !== "agent") {
        return c.json(
          { error: "'prompt' can only be updated on agent jobs" },
          400,
        );
      }
      updates.prompt = body.prompt;
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: "At least one field must be provided" }, 400);
    }

    const existingRaw = await readFile(jobJsonPath, "utf-8");
    const existing = JSON.parse(existingRaw) as JobConfig;

    // Apply updates
    const updated: JobConfig = {
      ...existing,
      ...(updates.disabled !== undefined
        ? { disabled: updates.disabled as boolean }
        : {}),
      ...(updates.schedule
        ? { schedule: updates.schedule as JobConfig["schedule"] }
        : {}),
      ...(updates.destination
        ? { destination: updates.destination as JobConfig["destination"] }
        : {}),
      updatedAt: new Date().toISOString(),
    };

    // Handle prompt update for agent jobs
    if (updates.prompt && updated.execution.type === "agent") {
      updated.execution = {
        ...updated.execution,
        prompt: updates.prompt as string,
      };
    }

    await writeFile(jobJsonPath, JSON.stringify(updated, null, 2));

    if (!skipSync) {
      if (updated.disabled) {
        await uninstallJob(name);
      } else {
        await installJob(updated, { jobsDir });
      }
    }

    return c.json(updated);
  });

  return app;
}
