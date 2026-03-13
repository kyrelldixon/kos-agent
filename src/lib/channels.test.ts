import { describe, expect, test } from "bun:test";
import { isUserAllowed, resolveWorkspace } from "./channels";

describe("isUserAllowed", () => {
  test("denies unlisted user", async () => {
    const result = await isUserAllowed("U_RANDOM_UNKNOWN");
    expect(result).toBe(false);
  });
});

describe("resolveWorkspace", () => {
  test("returns global default for unknown channel", async () => {
    const result = await resolveWorkspace("C_UNKNOWN_CHANNEL");
    expect(result).toContain("projects/kyrell-os");
  });
});
