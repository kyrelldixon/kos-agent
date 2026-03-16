import { describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFileContent } from "./file";

describe("extractFileContent", () => {
  test("reads file content", async () => {
    const path = join(tmpdir(), `kos-test-${Date.now()}.md`);
    await writeFile(path, "# Test\n\nHello world");
    const result = await extractFileContent(path);
    expect(result).toBe("# Test\n\nHello world");
    await rm(path);
  });

  test("returns empty string for missing file", async () => {
    const result = await extractFileContent("/nonexistent/file.md");
    expect(result).toBe("");
  });
});
