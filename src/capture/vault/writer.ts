import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { sanitizeFilename } from "./templates";

function resolveVaultDir(): string {
  const raw = process.env.VAULT_PATH ?? "~/kyrell-os-vault";
  return raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
}

const VAULT_DIR = resolveVaultDir();

export async function writeVaultNote(
  vaultDir: string = VAULT_DIR,
  title: string,
  content: string,
  url?: string,
  filePath?: string,
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

  // Idempotency: check if a note with this filePath already exists
  if (!url && filePath) {
    const existing = await findExistingNoteByFilePath(vaultDir, filePath);
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

export async function findExistingNoteByFilePath(
  vaultDir: string,
  filePath: string,
): Promise<string | undefined> {
  const sourcesDir = join(vaultDir, "sources");
  try {
    const files = await readdir(sourcesDir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const fullPath = join(sourcesDir, file);
      const content = await readFile(fullPath, "utf-8");
      const match = content.match(/^file_path:\s*"([^"]*)"$/m);
      if (match?.[1] === filePath) return fullPath;
    }
  } catch {
    // sources/ dir might not exist yet
  }
  return undefined;
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
