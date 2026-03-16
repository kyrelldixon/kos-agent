# Dynamic Job Scheduling Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add runtime-created scheduled jobs to kos-agent using macOS LaunchAgents for OS-level scheduling and Inngest for durable execution.

**Architecture:** Jobs are directories in `~/.kos/agent/jobs/` with a `job.json` config and optional `script` file. A sync system generates LaunchAgent plists from job configs. When a LaunchAgent fires, it curls an Inngest event, which triggers `handleScheduledJob` to execute the job (run a script or invoke Claude Agent SDK) and post results to Slack.

**Tech Stack:** Bun, Hono, Inngest v4, Zod, launchctl, Claude Agent SDK, Slack WebClient

**Spec:** `docs/superpowers/specs/2026-03-15-dynamic-job-scheduling-design.md`
**Reference:** qbot gist (https://gist.github.com/jlongster/99c15e40c7978404bb97b5171df0e645), joelclaw (`~/projects/joelclaw/`), Utah (`~/projects/utah/`)

---

## File Structure

```
src/
├── jobs/
│   ├── schema.ts           ← Zod schemas for job.json validation + types
│   ├── sync.ts             ← LaunchAgent sync: plist generation, launchctl, discovery
│   └── run-template.ts     ← Auto-generated run script template
├── inngest/
│   ├── client.ts           ← MODIFY: add agent.job.triggered event type
│   └── functions/
│       ├── index.ts        ← MODIFY: export handleScheduledJob
│       ├── handle-failure.ts ← NO CHANGE: early-returns for job events (no destination in event data)
│       └── handle-scheduled-job.ts ← NEW: generic job handler
├── routes/
│   └── jobs.ts             ← NEW: CRUD API routes
└── index.ts                ← MODIFY: register routes, add startup sync, register function
```

---

## Chunk 1: Job Schema + Sync System

Core infrastructure — Zod schemas, plist generation, launchctl management, job discovery. No Inngest or API yet, just the sync engine that translates job directories into running LaunchAgents.

### Task 1: Job Schema (`src/jobs/schema.ts`)

**Files:**
- Create: `src/jobs/schema.ts`
- Test: `src/jobs/schema.test.ts`

- [ ] **Step 1: Write failing tests for Zod schemas**

```typescript
// src/jobs/schema.test.ts
import { describe, expect, test } from "bun:test";
import {
  type JobConfig,
  JobConfigSchema,
  JobCreateSchema,
} from "@/jobs/schema";

describe("JobConfigSchema", () => {
  test("validates a periodic script job", () => {
    const input = {
      name: "dns-check",
      schedule: { type: "periodic", seconds: 3600 },
      execution: { type: "script" },
      destination: { chatId: "D0ABC123", threadId: "1710532800.000001" },
      disabled: false,
      createdAt: "2026-03-15T12:00:00Z",
      updatedAt: "2026-03-15T12:00:00Z",
    };
    const result = JobConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  test("validates a scheduled agent job", () => {
    const input = {
      name: "daily-review",
      schedule: {
        type: "scheduled",
        calendar: { Hour: 9, Minute: 0 },
      },
      execution: {
        type: "agent",
        prompt: "Review my day",
      },
      destination: { chatId: "D0ABC123" },
      disabled: false,
      createdAt: "2026-03-15T12:00:00Z",
      updatedAt: "2026-03-15T12:00:00Z",
    };
    const result = JobConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  test("validates calendar array (multiple times)", () => {
    const input = {
      name: "twice-daily",
      schedule: {
        type: "scheduled",
        calendar: [{ Hour: 9, Minute: 0 }, { Hour: 14, Minute: 0 }],
      },
      execution: { type: "agent", prompt: "Check in" },
      destination: { chatId: "D0ABC123" },
      disabled: false,
      createdAt: "2026-03-15T12:00:00Z",
      updatedAt: "2026-03-15T12:00:00Z",
    };
    const result = JobConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  test("rejects name with dots (path traversal)", () => {
    const input = {
      name: "bad..name",
      schedule: { type: "periodic", seconds: 60 },
      execution: { type: "script" },
      destination: { chatId: "D0ABC123" },
      disabled: false,
      createdAt: "2026-03-15T12:00:00Z",
      updatedAt: "2026-03-15T12:00:00Z",
    };
    const result = JobConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  test("rejects name starting with hyphen", () => {
    const result = JobConfigSchema.safeParse({
      name: "-bad",
      schedule: { type: "periodic", seconds: 60 },
      execution: { type: "script" },
      destination: { chatId: "D0ABC123" },
      disabled: false,
      createdAt: "2026-03-15T12:00:00Z",
      updatedAt: "2026-03-15T12:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  test("rejects periodic with zero seconds", () => {
    const result = JobConfigSchema.safeParse({
      name: "bad",
      schedule: { type: "periodic", seconds: 0 },
      execution: { type: "script" },
      destination: { chatId: "D0ABC123" },
      disabled: false,
      createdAt: "2026-03-15T12:00:00Z",
      updatedAt: "2026-03-15T12:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  test("rejects agent job with empty prompt", () => {
    const result = JobConfigSchema.safeParse({
      name: "bad",
      schedule: { type: "periodic", seconds: 60 },
      execution: { type: "agent", prompt: "" },
      destination: { chatId: "D0ABC123" },
      disabled: false,
      createdAt: "2026-03-15T12:00:00Z",
      updatedAt: "2026-03-15T12:00:00Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("JobCreateSchema", () => {
  test("accepts create payload without timestamps or disabled", () => {
    const input = {
      name: "dns-check",
      schedule: { type: "periodic", seconds: 3600 },
      execution: { type: "script" },
      destination: { chatId: "D0ABC123" },
    };
    const result = JobCreateSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/jobs/schema.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement schemas**

```typescript
// src/jobs/schema.ts
import { z } from "zod";

const CalendarDictSchema = z.record(
  z.enum(["Month", "Day", "Weekday", "Hour", "Minute"]),
  z.number().int(),
);

const PeriodicScheduleSchema = z.object({
  type: z.literal("periodic"),
  seconds: z.number().int().positive(),
});

const ScheduledScheduleSchema = z.object({
  type: z.literal("scheduled"),
  calendar: z.union([CalendarDictSchema, z.array(CalendarDictSchema)]),
});

export const JobScheduleSchema = z.discriminatedUnion("type", [
  PeriodicScheduleSchema,
  ScheduledScheduleSchema,
]);

export const JobExecutionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("script") }),
  z.object({ type: z.literal("agent"), prompt: z.string().min(1) }),
]);

export const JobDestinationSchema = z.object({
  chatId: z.string(),
  threadId: z.string().optional(),
});

export const JobConfigSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/).max(64),
  schedule: JobScheduleSchema,
  execution: JobExecutionSchema,
  destination: JobDestinationSchema,
  disabled: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type JobConfig = z.infer<typeof JobConfigSchema>;
export type JobSchedule = z.infer<typeof JobScheduleSchema>;
export type JobExecution = z.infer<typeof JobExecutionSchema>;
export type JobDestination = z.infer<typeof JobDestinationSchema>;

/** Schema for POST /api/jobs — omits server-set fields */
export const JobCreateSchema = z.object({
  name: JobConfigSchema.shape.name,
  schedule: JobScheduleSchema,
  execution: JobExecutionSchema,
  destination: JobDestinationSchema,
});

export type JobCreateInput = z.infer<typeof JobCreateSchema>;

/** Schema for PATCH /api/jobs/:name — mutable fields only */
export const JobUpdateSchema = z.object({
  disabled: z.boolean().optional(),
  schedule: JobScheduleSchema.optional(),
  destination: JobDestinationSchema.optional(),
  prompt: z.string().min(1).optional(), // only for agent jobs
}).refine(
  (data) => Object.keys(data).length > 0,
  { message: "At least one field must be provided" },
);

export type JobUpdateInput = z.infer<typeof JobUpdateSchema>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/jobs/schema.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
ga src/jobs/schema.ts src/jobs/schema.test.ts
gcm "feat(jobs): add Zod schemas for job config validation"
```

### Task 2: Run Script Template (`src/jobs/run-template.ts`)

**Files:**
- Create: `src/jobs/run-template.ts`
- Test: `src/jobs/run-template.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/jobs/run-template.test.ts
import { describe, expect, test } from "bun:test";
import { generateRunScript } from "@/jobs/run-template";

describe("generateRunScript", () => {
  test("generates a bash script that curls inngest", () => {
    const script = generateRunScript("dns-check");
    expect(script).toContain("#!/bin/bash");
    expect(script).toContain("set -e");
    expect(script).toContain("agent.job.triggered");
    expect(script).toContain('"job":"dns-check"');
  });

  test("uses configurable event URL", () => {
    const script = generateRunScript("test-job");
    expect(script).toContain("INNGEST_EVENT_URL:-");
    expect(script).toContain("http://localhost:8288/e/key");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/jobs/run-template.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```typescript
// src/jobs/run-template.ts
const DEFAULT_INNGEST_EVENT_URL = "http://localhost:8288/e/key";

export function generateRunScript(jobName: string): string {
  const escapedName = jobName.replace(/"/g, '\\"');
  return `#!/bin/bash
set -e
curl -sf -X POST "\${INNGEST_EVENT_URL:-${DEFAULT_INNGEST_EVENT_URL}}" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"agent.job.triggered","data":{"job":"${escapedName}"}}'
`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/jobs/run-template.test.ts`
Expected: All 2 tests PASS

- [ ] **Step 5: Commit**

```bash
ga src/jobs/run-template.ts src/jobs/run-template.test.ts
gcm "feat(jobs): add run script template generator"
```

### Task 3: Sync System — Plist Generation (`src/jobs/sync.ts`)

**Files:**
- Create: `src/jobs/sync.ts`
- Test: `src/jobs/sync.test.ts`

This is the largest task. Adapted from the qbot gist. Focus on plist generation and XML helpers first, then launchctl + discovery.

**Reference:** Read the qbot gist at https://gist.github.com/jlongster/99c15e40c7978404bb97b5171df0e645 for the `plistForJob()`, `plistValue()`, `escapeXml()`, and `normalizeCalendarForLaunchd()` functions. Adapt them for our types and constants.

- [ ] **Step 1: Write failing tests for plist generation**

```typescript
// src/jobs/sync.test.ts
import { describe, expect, test } from "bun:test";
import { plistForJob, labelFor } from "@/jobs/sync";
import type { JobConfig } from "@/jobs/schema";

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
        calendar: [{ Hour: 9, Minute: 0 }, { Hour: 14, Minute: 0 }],
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/jobs/sync.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement plist generation**

Create `src/jobs/sync.ts` with:
- Constants: `KOS_PREFIX`, `JOBS_DIR`, `LAUNCH_AGENTS_DIR`, `LOGS_DIR`
- `sanitizeName(name: string): string`
- `labelFor(name: string): string`
- `escapeXml(value: string): string`
- `plistValue(value: unknown, indent?: string): string`
- `plistForJob(job: JobConfig): string`

Adapt directly from the qbot gist's `plistForJob()`, `plistValue()`, `escapeXml()` functions. Key changes from qbot:
- Replace `QBOT_PREFIX` with `KOS_PREFIX` ("kos.job")
- Replace `DATA_DIR` with `JOBS_DIR` (join(homedir(), ".kos/agent/jobs"))
- Replace `LAUNCH_AGENTS_DIR` path with `join(homedir(), "Library/LaunchAgents")`
- Replace `logsDir` with `LOGS_DIR` (join(homedir(), ".kos/agent/logs"))
- Remove the `scope` parameter — our v1 only has user scope
- The `ProgramArguments` path uses `join(JOBS_DIR, job.name, "run")`
- The `WorkingDirectory` uses `join(JOBS_DIR, job.name)`
- No `EnvironmentVariables` in plist (unlike qbot's `QBOT_JOB_LABEL`)
- Export `labelFor` and `plistForJob` for testing

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/jobs/sync.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
ga src/jobs/sync.ts src/jobs/sync.test.ts
gcm "feat(jobs): add plist generation for LaunchAgent sync"
```

### Task 4: Sync System — launchctl + Install/Uninstall/Sync

**Files:**
- Modify: `src/jobs/sync.ts`
- Modify: `src/jobs/sync.test.ts`

- [ ] **Step 1: Write failing tests for install, uninstall, and sync**

Add to `src/jobs/sync.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  installJob,
  uninstallJob,
  syncAllJobs,
  discoverJobs,
  JOBS_DIR,
} from "@/jobs/sync";
import type { JobConfig } from "@/jobs/schema";

// These tests use a temp directory to avoid touching real LaunchAgents.
// The sync functions accept optional dir overrides for testability.

describe("discoverJobs", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `kos-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("discovers job directories with valid job.json", async () => {
    const jobDir = join(testDir, "dns-check");
    await mkdir(jobDir);
    await writeFile(
      join(jobDir, "job.json"),
      JSON.stringify({
        name: "dns-check",
        schedule: { type: "periodic", seconds: 3600 },
        execution: { type: "script" },
        destination: { chatId: "D0ABC123" },
        disabled: false,
        createdAt: "2026-03-15T12:00:00Z",
        updatedAt: "2026-03-15T12:00:00Z",
      }),
    );

    const jobs = await discoverJobs(testDir);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("dns-check");
  });

  test("skips directories without job.json", async () => {
    await mkdir(join(testDir, "empty-dir"));
    const jobs = await discoverJobs(testDir);
    expect(jobs).toHaveLength(0);
  });

  test("skips directories with invalid job.json", async () => {
    const jobDir = join(testDir, "bad-job");
    await mkdir(jobDir);
    await writeFile(join(jobDir, "job.json"), "not json");
    const jobs = await discoverJobs(testDir);
    expect(jobs).toHaveLength(0);
  });

  test("returns empty array for non-existent directory", async () => {
    const jobs = await discoverJobs("/tmp/does-not-exist-kos");
    expect(jobs).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/jobs/sync.test.ts`
Expected: FAIL on new tests — `discoverJobs` not exported

- [ ] **Step 3: Implement discovery, install, uninstall, sync**

Add to `src/jobs/sync.ts`:
- `runLaunchctl(args: string[]): { ok: boolean; stdout: string; stderr: string }` — uses `Bun.spawnSync`
- `currentUid(): string` — via `process.getuid()`
- `SyncReport` type:
  ```typescript
  export interface SyncReport {
    synced: string[];
    removed: string[];
    unchanged: string[];
    errors: Array<{ name: string; error: string }>;
  }
  ```
- `discoverJobs(jobsDir?: string): Promise<JobConfig[]>` — reads dirs, parses job.json, validates with Zod, skips invalid with console.warn
- `installJob(job: JobConfig, options?: { jobsDir?: string; launchAgentsDir?: string; logsDir?: string }): Promise<boolean>` — generates plist, writes run script, chmods script, ensures logs dir exists, launchctl bootstrap
- `uninstallJob(name: string, options?: { launchAgentsDir?: string }): Promise<void>` — launchctl bootout, delete plist
- `syncAllJobs(options?: { jobsDir?: string; launchAgentsDir?: string; logsDir?: string }): Promise<SyncReport>` — discover, install enabled, bootout disabled, remove stale

The `options` parameters allow tests to use temp directories. When omitted, use the real paths from constants.

**Important:** The launchctl calls (`bootstrap gui/<uid>`) may fail when running from a system LaunchDaemon. If bootstrap fails, try `launchctl asuser <uid> launchctl bootstrap gui/<uid> <plist>` as fallback. Log a warning if both fail.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/jobs/sync.test.ts`
Expected: All tests PASS (launchctl tests may need mocking or skipping in CI — the discovery tests work with real filesystem)

- [ ] **Step 5: Commit**

```bash
ga src/jobs/sync.ts src/jobs/sync.test.ts
gcm "feat(jobs): add job discovery, install, uninstall, and sync"
```

---

## Chunk 2: Inngest Function + handleFailure Update

### Task 5: Add `agent.job.triggered` Event Type

**Files:**
- Modify: `src/inngest/client.ts`

- [ ] **Step 1: Add event type to Inngest client**

Add to `src/inngest/client.ts` after the existing event definitions:

```typescript
export const agentJobTriggered = eventType("agent.job.triggered", {
  schema: z.object({
    job: z.string(),
  }),
});

export type AgentJobData = z.infer<typeof agentJobTriggered.schema>;
```

- [ ] **Step 2: Run existing tests to verify nothing broke**

Run: `bun test`
Expected: All existing tests PASS

- [ ] **Step 3: Commit**

```bash
ga src/inngest/client.ts
gcm "feat(jobs): add agent.job.triggered event type"
```

### Task 6: (No changes to `handleFailure`)

The existing `handleFailure` function early-returns when `originalEvent.data.destination` is absent (line 13). Since `agent.job.triggered` events only carry `{ job: string }`, `handleFailure` will skip job failures entirely. This is intentional — `handleScheduledJob` handles its own errors internally (see Task 7), posting failure messages to Slack using the destination from `job.json`. No changes needed to `handleFailure`.

### Task 7: Implement `handleScheduledJob` Inngest Function

**Files:**
- Create: `src/inngest/functions/handle-scheduled-job.ts`
- Modify: `src/inngest/functions/index.ts`

- [ ] **Step 1: Write failing test for `loadJobConfig` helper**

```typescript
// src/inngest/functions/handle-scheduled-job.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/inngest/functions/handle-scheduled-job.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the function**

```typescript
// src/inngest/functions/handle-scheduled-job.ts
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { NonRetriableError } from "inngest";
import { agentJobTriggered, inngest } from "@/inngest/client";
import { JobConfigSchema, type JobConfig } from "@/jobs/schema";
import { streamAgentSession } from "@/agent/session";
import { getSession, saveSession } from "@/lib/sessions";
import { markdownToSlackMrkdwn, splitMessage } from "@/lib/format";
import { slack } from "@/lib/slack";
import type { SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import { resolveWorkspace } from "@/lib/channels";

const DEFAULT_JOBS_DIR = join(homedir(), ".kos/agent/jobs");

/** Exported for testing. Pass jobsDir override in tests. */
export async function loadJobConfig(
  jobName: string,
  jobsDir = DEFAULT_JOBS_DIR,
): Promise<JobConfig> {
  const configPath = join(jobsDir, jobName, "job.json");
  if (!existsSync(configPath)) {
    throw new NonRetriableError(`Job '${jobName}' not found: ${configPath}`);
  }
  const raw = await readFile(configPath, "utf-8");
  const parsed = JobConfigSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new NonRetriableError(
      `Job '${jobName}' has invalid config: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** Post error to Slack. Best-effort — does not throw. */
async function postJobError(
  config: JobConfig,
  error: string,
): Promise<void> {
  await slack.chat.postMessage({
    channel: config.destination.chatId,
    text: `Job \`${config.name}\` failed: ${error.slice(0, 300)}`,
    thread_ts: config.destination.threadId,
  }).catch((err) => console.warn("job error notification failed:", err));
}

export const handleScheduledJob = inngest.createFunction(
  {
    id: "handle-scheduled-job",
    retries: 1,
    timeouts: { finish: "5m" },
    triggers: [agentJobTriggered],
    singleton: { key: "event.data.job", mode: "cancel" },
  },
  async ({ event, step }) => {
    const { job: jobName } = event.data;

    const config = await step.run("load-config", () => loadJobConfig(jobName));
    const { destination } = config;

    try {
      if (config.execution.type === "script") {
        // --- Script job ---
        const scriptPath = join(DEFAULT_JOBS_DIR, jobName, "script");
        if (!existsSync(scriptPath)) {
          await postJobError(config, "No script file found");
          throw new NonRetriableError(`Job '${jobName}' has no script file`);
        }

        const output = await step.run("execute-script", async () => {
          const proc = Bun.spawn(["./script"], {
            cwd: join(DEFAULT_JOBS_DIR, jobName),
            stdout: "pipe",
            stderr: "pipe",
          });
          const stdout = await new Response(proc.stdout).text();
          const stderr = await new Response(proc.stderr).text();
          const exitCode = await proc.exited;
          return { stdout, stderr, exitCode };
        });

        await step.run("post-script-result", async () => {
          const text = output.exitCode === 0
            ? output.stdout.trim() || "_Script completed with no output._"
            : `Script failed (exit ${output.exitCode}):\n\`\`\`\n${(output.stderr || output.stdout).trim()}\n\`\`\``;

          const chunks = splitMessage(text);
          for (const chunk of chunks) {
            await slack.chat.postMessage({
              channel: destination.chatId,
              text: chunk,
              thread_ts: destination.threadId,
            });
          }
        });

        if (output.exitCode !== 0) {
          throw new Error(`Script '${jobName}' failed with exit code ${output.exitCode}`);
        }
      } else {
        // --- Agent job ---
        const { prompt } = config.execution;
        const sessionKey = destination.threadId
          ? `slack-${destination.chatId}-${destination.threadId}`
          : `slack-${destination.chatId}`;

        const session = await step.run("resolve-session", async () => {
          return getSession(sessionKey);
        });

        const workspace = await step.run("resolve-workspace", async () => {
          return session?.workspace ?? (await resolveWorkspace(destination.chatId));
        });

        // Streaming zone — not in a step
        let sessionId: string | undefined = session?.sessionId;
        let resultText = "";

        const stream = streamAgentSession({
          message: prompt,
          sessionId,
          workspace,
        });

        for await (const msg of stream) {
          if (msg.type === "system" && msg.subtype === "init") {
            sessionId = msg.session_id;
          }
          if (msg.type === "result") {
            const resultMsg = msg as SDKResultSuccess;
            if (msg.subtype === "success") {
              resultText = resultMsg.result ?? "";
            }
          }
        }

        // Post final text only (minimal mode)
        if (resultText.trim()) {
          const formatted = markdownToSlackMrkdwn(resultText);
          const chunks = splitMessage(formatted);
          for (const chunk of chunks) {
            await slack.chat.postMessage({
              channel: destination.chatId,
              text: chunk,
              thread_ts: destination.threadId,
            });
          }
        } else {
          await slack.chat.postMessage({
            channel: destination.chatId,
            text: "_No response generated._",
            thread_ts: destination.threadId,
          });
        }

        if (sessionId) {
          await step.run("save-session", async () => {
            await saveSession(sessionKey, {
              sessionId: sessionId as string,
              workspace,
            });
          });
        }
      }
    } catch (error) {
      // Post error to Slack before re-throwing (handleFailure can't handle
      // job events since they lack destination in event data)
      if (!(error instanceof NonRetriableError)) {
        await postJobError(
          config,
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }

    return { job: jobName, type: config.execution.type };
  },
);
```

- [ ] **Step 2: Export from index**

Add to `src/inngest/functions/index.ts`:
```typescript
export { handleScheduledJob } from "@/inngest/functions/handle-scheduled-job";
```

- [ ] **Step 3: Run existing tests**

Run: `bun test`
Expected: All existing tests PASS

- [ ] **Step 4: Commit**

```bash
ga src/inngest/functions/handle-scheduled-job.ts src/inngest/functions/index.ts
gcm "feat(jobs): add handleScheduledJob Inngest function"
```

---

## Chunk 3: API Routes + Server Wiring

### Task 8: Job API Routes (`src/routes/jobs.ts`)

**Files:**
- Create: `src/routes/jobs.ts`
- Test: `src/routes/jobs.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/routes/jobs.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { createJobsRoutes } from "@/routes/jobs";

describe("jobs API", () => {
  let testDir: string;
  let app: Hono;

  beforeEach(async () => {
    testDir = join(tmpdir(), `kos-jobs-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    // Pass testDir to avoid touching real ~/.kos/agent/jobs
    app = new Hono();
    app.route("/api/jobs", createJobsRoutes({ jobsDir: testDir, skipSync: true }));
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
    // Create a job first
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

    // Verify persisted
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/routes/jobs.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement routes**

Create `src/routes/jobs.ts`. Follow the pattern from `src/routes/config.ts`:
- `createJobsRoutes(options?: { jobsDir?: string; skipSync?: boolean }): Hono`
- POST `/` — validate with `JobCreateSchema`, create dir, write job.json, call `installJob()` (unless `skipSync`)
- GET `/` — call `discoverJobs()`, return array
- DELETE `/:name` — check exists, call `uninstallJob()` (unless `skipSync`), rm dir
- PATCH `/:name` — validate with `JobUpdateSchema`, reject immutable fields (`name`, `execution.type`), merge, write, re-sync

The `skipSync` option skips launchctl calls in tests.

**PATCH route implementation notes:**
- Before Zod parsing, check for immutable fields (`name`, `execution`) in the raw body. Zod strips unknown keys, so you must reject these BEFORE parsing. Return 400 with clear error.
- When `prompt` is in the update, verify the existing job has `execution.type === "agent"`. Reject with 400 if it's a script job.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/routes/jobs.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
ga src/routes/jobs.ts src/routes/jobs.test.ts
gcm "feat(jobs): add CRUD API routes for job management"
```

### Task 9: Wire Everything into Server (`src/index.ts`)

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Register the new Inngest function**

In `src/index.ts`, add `handleScheduledJob` to the imports and the functions array:

```typescript
import {
  acknowledgeMessage,
  handleFailure,
  handleMessage,
  handleScheduledJob,
  sendReply,
} from "@/inngest/functions/index";

const functions = [
  acknowledgeMessage,
  handleFailure,
  handleMessage,
  handleScheduledJob,
  sendReply,
];
```

- [ ] **Step 2: Mount job routes with CF Access middleware**

Add after the existing workspaces routes:

```typescript
import { createJobsRoutes } from "@/routes/jobs";

// In the CF Access middleware section, add:
if (cfClientId) {
  // ... existing middleware ...
  hono.use("/api/jobs", accessMw);
  hono.use("/api/jobs/*", accessMw);
}
hono.route("/api/jobs", createJobsRoutes());
```

- [ ] **Step 3: Add startup sync + ensure directories**

After the existing `mkdir` call for sessions:

```typescript
import { syncAllJobs } from "@/jobs/sync";

// Ensure data directories exist
const dataDir = join(homedir(), ".kos/agent");
await mkdir(join(dataDir, "sessions"), { recursive: true });
await mkdir(join(dataDir, "jobs"), { recursive: true });
await mkdir(join(dataDir, "logs"), { recursive: true });

// Sync LaunchAgents on startup
const syncReport = await syncAllJobs();
if (syncReport.synced.length || syncReport.removed.length) {
  console.log(
    `[jobs] Synced: ${syncReport.synced.length}, removed: ${syncReport.removed.length}, unchanged: ${syncReport.unchanged.length}`,
  );
}
```

- [ ] **Step 4: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 5: Run the dev server to verify startup**

Run: `bun run dev`
Expected: Server starts, logs sync report (0 synced, 0 removed if no jobs exist), no errors.

- [ ] **Step 6: Commit**

```bash
ga src/index.ts
gcm "feat(jobs): wire job routes, Inngest function, and startup sync into server"
```

---

## Chunk 4: End-to-End Validation

### Task 10: Manual E2E Test — Script Job

No code changes. Validate the full flow works.

- [ ] **Step 1: Start the dev server**

Run: `bun run dev`
Also ensure Inngest dev server is running: `inngest dev -u http://localhost:9080/api/inngest --no-discovery`

- [ ] **Step 2: Create a test script job via API**

First, create the script file:
```bash
mkdir -p ~/.kos/agent/jobs/test-echo
echo '#!/bin/bash
echo "Hello from scheduled job at $(date)"' > ~/.kos/agent/jobs/test-echo/script
chmod +x ~/.kos/agent/jobs/test-echo/script
```

Then register the job:
```bash
curl -s -X POST http://localhost:9080/api/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "name": "test-echo",
    "schedule": {"type": "periodic", "seconds": 60},
    "execution": {"type": "script"},
    "destination": {"chatId": "YOUR_DM_CHANNEL_ID"}
  }' | jq .
```

Expected: 201 response with job config. Check `~/Library/LaunchAgents/kos.job.test-echo.plist` exists.

- [ ] **Step 3: Verify LaunchAgent is registered**

```bash
launchctl list | grep kos.job
```

Expected: `kos.job.test-echo` appears with a PID or status.

- [ ] **Step 4: Wait for the job to fire (or trigger manually)**

```bash
# Manual trigger via Inngest event:
curl -s -X POST http://localhost:8288/e/key \
  -H "Content-Type: application/json" \
  -d '{"name":"agent.job.triggered","data":{"job":"test-echo"}}'
```

Expected: Check Inngest dashboard for `handle-scheduled-job` function run. Check Slack DM for output message.

- [ ] **Step 5: Test list and delete**

```bash
curl -s http://localhost:9080/api/jobs | jq .
curl -s -X DELETE http://localhost:9080/api/jobs/test-echo
launchctl list | grep kos.job  # should be gone
```

- [ ] **Step 6: Test pause/resume**

Re-create the test job (deleted in Step 5), then test pause/resume:
```bash
# Re-create
mkdir -p ~/.kos/agent/jobs/test-echo
echo '#!/bin/bash
echo "pause test: $(date)"' > ~/.kos/agent/jobs/test-echo/script
chmod +x ~/.kos/agent/jobs/test-echo/script

curl -s -X POST http://localhost:9080/api/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "name": "test-echo",
    "schedule": {"type": "periodic", "seconds": 120},
    "execution": {"type": "script"},
    "destination": {"chatId": "YOUR_DM_CHANNEL_ID"}
  }' | jq .

# Pause
curl -s -X PATCH http://localhost:9080/api/jobs/test-echo \
  -H "Content-Type: application/json" \
  -d '{"disabled": true}' | jq .
# Verify plist is removed:
ls ~/Library/LaunchAgents/kos.job.test-echo.plist  # should not exist

# Resume
curl -s -X PATCH http://localhost:9080/api/jobs/test-echo \
  -H "Content-Type: application/json" \
  -d '{"disabled": false}' | jq .
# Verify plist is restored:
ls ~/Library/LaunchAgents/kos.job.test-echo.plist  # should exist
```

- [ ] **Step 7: Clean up test job**

```bash
curl -s -X DELETE http://localhost:9080/api/jobs/test-echo
```

### Task 11: Manual E2E Test — LaunchDaemon Domain Check

This tests the known risk from the spec: can the kos-agent process (running as a system LaunchDaemon) manage user-scope LaunchAgents?

- [ ] **Step 1: Deploy to Mac Mini**

Push to main to trigger auto-deploy, or manually deploy:
```bash
ssh kyrelldixon@mac-mini
cd ~/projects/kos-agent && git pull && bun install
```

- [ ] **Step 2: Create a job via API from the Mac Mini**

```bash
curl -s -X POST http://localhost:9080/api/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "name": "launchd-test",
    "schedule": {"type": "periodic", "seconds": 120},
    "execution": {"type": "script"},
    "destination": {"chatId": "YOUR_DM_CHANNEL_ID"}
  }'
```

Then write the script:
```bash
echo '#!/bin/bash
echo "launchd domain test: $(date)"' > ~/.kos/agent/jobs/launchd-test/script
chmod +x ~/.kos/agent/jobs/launchd-test/script
```

- [ ] **Step 3: Check launchctl status**

```bash
launchctl list | grep kos.job
```

If the job does NOT appear, check kos-agent logs:
```bash
tail -20 ~/Library/Logs/kos-agent.err
```

If you see `launchctl bootstrap` permission errors, the fallback (`launchctl asuser`) needs to be activated in `src/jobs/sync.ts`.

- [ ] **Step 4: Clean up**

```bash
curl -s -X DELETE http://localhost:9080/api/jobs/launchd-test
```

### Task 12: Final Commit — Update Spec Plan Link

- [ ] **Step 1: Update spec to reference this plan**

In `docs/superpowers/specs/2026-03-15-dynamic-job-scheduling-design.md`, change:
```
**Plan:** TBD (created after spec approval)
```
to:
```
**Plan:** `docs/superpowers/plans/2026-03-15-dynamic-job-scheduling.md`
```

- [ ] **Step 2: Commit**

```bash
ga docs/superpowers/specs/2026-03-15-dynamic-job-scheduling-design.md
ga docs/superpowers/plans/2026-03-15-dynamic-job-scheduling.md
gcm "docs: add implementation plan for dynamic job scheduling"
```
