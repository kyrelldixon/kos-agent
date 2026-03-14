import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyGitHubSignature } from "@/lib/deploy/verify-signature";

const SECRET = "test-secret-123";

function sign(body: string): string {
  const hmac = createHmac("sha256", SECRET).update(body).digest("hex");
  return `sha256=${hmac}`;
}

describe("verifyGitHubSignature", () => {
  test("returns true for valid signature", () => {
    const body = '{"ref":"refs/heads/main"}';
    expect(verifyGitHubSignature(SECRET, body, sign(body))).toBe(true);
  });

  test("returns false for missing signature", () => {
    expect(verifyGitHubSignature(SECRET, "{}", undefined)).toBe(false);
  });

  test("returns false for invalid signature", () => {
    expect(verifyGitHubSignature(SECRET, "{}", "sha256=bad")).toBe(false);
  });

  test("returns false for wrong prefix", () => {
    expect(verifyGitHubSignature(SECRET, "{}", "md5=abc")).toBe(false);
  });
});
