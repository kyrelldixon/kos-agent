import { describe, expect, test } from "bun:test";
import { fetchGitHubMetadata, parseGitHubUrl } from "./github";

describe("parseGitHubUrl", () => {
  test("extracts owner and repo from GitHub URL", () => {
    const result = parseGitHubUrl("https://github.com/anthropics/claude-code");
    expect(result).toEqual({ owner: "anthropics", repo: "claude-code" });
  });

  test("handles URLs with trailing path segments", () => {
    const result = parseGitHubUrl(
      "https://github.com/owner/repo/tree/main/src",
    );
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  test("returns null for non-repo URLs", () => {
    expect(parseGitHubUrl("https://github.com")).toBeNull();
    expect(parseGitHubUrl("https://github.com/owner")).toBeNull();
  });
});

describe("fetchGitHubMetadata", () => {
  test("fetches metadata from GitHub API", async () => {
    // Using a stable, well-known repo
    const meta = await fetchGitHubMetadata("anthropics", "claude-code");
    expect(meta.description).toBeDefined();
    expect(typeof meta.stars).toBe("number");
    expect(typeof meta.language).toBe("string");
  });
});
