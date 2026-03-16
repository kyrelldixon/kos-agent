import { describe, expect, test } from "bun:test";
import { JobConfigSchema, JobCreateSchema } from "@/jobs/schema";

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
      execution: { type: "agent", prompt: "Review my day" },
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
        calendar: [
          { Hour: 9, Minute: 0 },
          { Hour: 14, Minute: 0 },
        ],
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
    expect(JobConfigSchema.safeParse(input).success).toBe(false);
  });

  test("rejects name starting with hyphen", () => {
    expect(
      JobConfigSchema.safeParse({
        name: "-bad",
        schedule: { type: "periodic", seconds: 60 },
        execution: { type: "script" },
        destination: { chatId: "D0ABC123" },
        disabled: false,
        createdAt: "2026-03-15T12:00:00Z",
        updatedAt: "2026-03-15T12:00:00Z",
      }).success,
    ).toBe(false);
  });

  test("rejects periodic with zero seconds", () => {
    expect(
      JobConfigSchema.safeParse({
        name: "bad",
        schedule: { type: "periodic", seconds: 0 },
        execution: { type: "script" },
        destination: { chatId: "D0ABC123" },
        disabled: false,
        createdAt: "2026-03-15T12:00:00Z",
        updatedAt: "2026-03-15T12:00:00Z",
      }).success,
    ).toBe(false);
  });

  test("rejects agent job with empty prompt", () => {
    expect(
      JobConfigSchema.safeParse({
        name: "bad",
        schedule: { type: "periodic", seconds: 60 },
        execution: { type: "agent", prompt: "" },
        destination: { chatId: "D0ABC123" },
        disabled: false,
        createdAt: "2026-03-15T12:00:00Z",
        updatedAt: "2026-03-15T12:00:00Z",
      }).success,
    ).toBe(false);
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
    expect(JobCreateSchema.safeParse(input).success).toBe(true);
  });
});
