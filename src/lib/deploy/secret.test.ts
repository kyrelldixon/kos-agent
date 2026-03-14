import { afterEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getOrCreateDeploySecret } from "@/lib/deploy/secret";

const TEST_PATH = join(homedir(), ".kos/agent/test-deploy-secret.txt");

describe("getOrCreateDeploySecret", () => {
  afterEach(async () => {
    await unlink(TEST_PATH).catch(() => {});
  });

  test("creates a new secret if file does not exist", async () => {
    const secret = await getOrCreateDeploySecret(TEST_PATH);
    expect(secret).toHaveLength(64);
    const file = Bun.file(TEST_PATH);
    expect(await file.exists()).toBe(true);
  });

  test("returns existing secret if file exists", async () => {
    await Bun.write(TEST_PATH, "existing-secret-value");
    const secret = await getOrCreateDeploySecret(TEST_PATH);
    expect(secret).toBe("existing-secret-value");
  });
});
