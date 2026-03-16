import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findExistingNoteByUrl, writeVaultNote } from "./writer";

describe("writeVaultNote", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `kos-vault-test-${Date.now()}`);
    await mkdir(join(testDir, "sources"), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("writes a new note to sources/", async () => {
    const path = await writeVaultNote(
      testDir,
      "Test Article",
      "---\nstatus: raw\n---\n\n# Test",
    );
    expect(path).toContain("sources/Test Article.md");
    const content = await readFile(path, "utf-8");
    expect(content).toContain("# Test");
  });

  test("sanitizes filename", async () => {
    const path = await writeVaultNote(testDir, "What/Why: A Test?", "content");
    expect(path).toContain("sources/What-Why- A Test-.md");
  });

  test("updates existing note with same URL", async () => {
    // Write first note
    const note1 =
      '---\nurl: "https://example.com"\nstatus: raw\n---\n\n# First';
    await writeFile(join(testDir, "sources", "First.md"), note1);

    // Write second note with same URL — should update, not create new
    const note2 =
      '---\nurl: "https://example.com"\nstatus: raw\n---\n\n# Updated';
    const path = await writeVaultNote(
      testDir,
      "Second Title",
      note2,
      "https://example.com",
    );
    expect(path).toContain("First.md"); // Updated the original
    const content = await readFile(path, "utf-8");
    expect(content).toContain("# Updated");
  });
});

describe("findExistingNoteByUrl", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `kos-vault-find-${Date.now()}`);
    await mkdir(join(testDir, "sources"), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("finds note with matching URL", async () => {
    await writeFile(
      join(testDir, "sources", "Test.md"),
      '---\nurl: "https://example.com"\n---\n\n# Test',
    );
    const found = await findExistingNoteByUrl(testDir, "https://example.com");
    expect(found).toContain("Test.md");
  });

  test("returns undefined when no match", async () => {
    const found = await findExistingNoteByUrl(testDir, "https://notfound.com");
    expect(found).toBeUndefined();
  });
});
