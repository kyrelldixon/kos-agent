import { describe, expect, test } from "bun:test";
import {
  getDisplayMode,
  isUserAllowed,
  resolveWorkspace,
  scanWorkspaces,
} from "@/lib/channels";

describe("isUserAllowed", () => {
  test("allows all users when allowedUsers is '*'", async () => {
    const result = await isUserAllowed("U_ANY_USER");
    expect(result).toBe(true);
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
    expect(["verbose", "compact", "minimal"]).toContain(result);
  });
});

describe("scanWorkspaces", () => {
  test("returns array of directories", async () => {
    const result = await scanWorkspaces();
    expect(Array.isArray(result)).toBe(true);
    if (result.length > 0) {
      expect(result[0]).toHaveProperty("name");
      expect(result[0]).toHaveProperty("path");
    }
  });
});
