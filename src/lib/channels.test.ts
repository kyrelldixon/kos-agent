import { describe, expect, test } from "bun:test";
import {
  getDisplayMode,
  isUserAllowed,
  resolveWorkspace,
} from "@/lib/channels";

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

describe("getDisplayMode", () => {
  test("returns display mode from config", async () => {
    const result = await getDisplayMode();
    expect(result).toBe("verbose");
  });
});
