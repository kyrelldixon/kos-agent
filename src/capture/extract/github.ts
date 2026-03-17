import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export interface GitHubRepoMeta {
  description: string;
  stars: number;
  language: string;
  license: string;
  topics: string[];
  defaultBranch: string;
}

export function parseGitHubUrl(
  urlString: string,
): { owner: string; repo: string } | null {
  try {
    const url = new URL(urlString);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return null;
    return { owner: segments[0], repo: segments[1] };
  } catch {
    return null;
  }
}

const GitHubRepoSchema = z.object({
  description: z.string().nullable().optional(),
  stargazers_count: z.number().optional(),
  language: z.string().nullable().optional(),
  license: z.object({ spdx_id: z.string().optional() }).nullable().optional(),
  topics: z.array(z.string()).optional(),
  default_branch: z.string().optional(),
});

export async function fetchGitHubMetadata(
  owner: string,
  repo: string,
): Promise<GitHubRepoMeta> {
  const empty: GitHubRepoMeta = {
    description: "",
    stars: 0,
    language: "",
    license: "",
    topics: [],
    defaultBranch: "main",
  };

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "kos-agent/1.0",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) return empty;

  const parsed = GitHubRepoSchema.safeParse(await res.json());
  if (!parsed.success) return empty;

  const data = parsed.data;
  return {
    description: data.description ?? "",
    stars: data.stargazers_count ?? 0,
    language: data.language ?? "",
    license: data.license?.spdx_id ?? "",
    topics: data.topics ?? [],
    defaultBranch: data.default_branch ?? "main",
  };
}

export function getClonePath(): string {
  try {
    const result = execSync("kos config get clone_path", {
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();
    if (result && result !== "undefined" && result !== "null") {
      return result.startsWith("~/")
        ? join(homedir(), result.slice(2))
        : result;
    }
  } catch {}
  return join(homedir(), "projects");
}

export function cloneOrPullRepo(
  owner: string,
  repo: string,
  clonePath: string,
): string {
  const repoDir = join(clonePath, repo);

  if (existsSync(repoDir)) {
    try {
      execSync("git pull --ff-only", {
        cwd: repoDir,
        timeout: 60_000,
        stdio: "pipe",
      });
    } catch {
      // Pull failed — that's fine, we have the repo locally
    }
  } else {
    execSync(`git clone https://github.com/${owner}/${repo}.git "${repoDir}"`, {
      timeout: 120_000,
      stdio: "pipe",
    });
  }

  return repoDir;
}

export async function readRepoReadme(repoDir: string): Promise<string> {
  for (const name of ["README.md", "readme.md", "Readme.md", "README"]) {
    try {
      return await readFile(join(repoDir, name), "utf-8");
    } catch {}
  }
  return "";
}
