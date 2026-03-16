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
