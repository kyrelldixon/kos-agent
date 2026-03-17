import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeFilename } from "./templates";

const VAULT_DIR =
  process.env.VAULT_PATH ?? `${process.env.HOME}/kyrell-os-vault`;

export async function writeVaultNote(
  vaultDir: string = VAULT_DIR,
  title: string,
  content: string,
  url?: string,
): Promise<string> {
  const sourcesDir = join(vaultDir, "sources");
  await mkdir(sourcesDir, { recursive: true });

  // Idempotency: check if a note with this URL already exists
  if (url) {
    const existing = await findExistingNoteByUrl(vaultDir, url);
    if (existing) {
      await writeFile(existing, content, "utf-8");
      return existing;
    }
  }

  const filename = sanitizeFilename(title);
  const notePath = join(sourcesDir, `${filename}.md`);
  await writeFile(notePath, content, "utf-8");
  return notePath;
}

export async function findExistingNoteByUrl(
  vaultDir: string,
  url: string,
): Promise<string | undefined> {
  const sourcesDir = join(vaultDir, "sources");
  try {
    const files = await readdir(sourcesDir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const filePath = join(sourcesDir, file);
      const content = await readFile(filePath, "utf-8");
      // Check frontmatter for matching URL
      const urlMatch = content.match(/^url:\s*"([^"]*)"$/m);
      if (urlMatch?.[1] === url) return filePath;
    }
  } catch {
    // sources/ dir might not exist yet
  }
  return undefined;
}
