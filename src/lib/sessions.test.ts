import { afterEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { getSession, saveSession } from "./sessions";

const TEST_KEY = "test-session-unit";
const SESSIONS_DIR = "data/sessions";

describe("sessions", () => {
  afterEach(async () => {
    await unlink(join(SESSIONS_DIR, `${TEST_KEY}.json`)).catch(() => {});
  });

  test("getSession returns undefined for missing session", async () => {
    const result = await getSession("nonexistent-key-xyz");
    expect(result).toBeUndefined();
  });

  test("saveSession and getSession roundtrip", async () => {
    await saveSession(TEST_KEY, { sessionId: "abc-123" });
    const result = await getSession(TEST_KEY);
    expect(result?.sessionId).toBe("abc-123");
    expect(result?.updatedAt).toBeDefined();
  });

  test("saveSession merges with existing data", async () => {
    await saveSession(TEST_KEY, { sessionId: "abc-123" });
    await saveSession(TEST_KEY, { workspace: "~/projects/foo" });
    const result = await getSession(TEST_KEY);
    expect(result?.sessionId).toBe("abc-123");
    expect(result?.workspace).toBe("~/projects/foo");
  });
});
