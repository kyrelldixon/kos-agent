---
name: capture-pipeline
description: Use when working on the capture pipeline, content extraction, vault note creation, or debugging capture issues
---

# Capture Pipeline

Captures URLs and files into the Obsidian vault as source notes.

## Architecture

```
CLI/Agent → POST /api/capture → Inngest event → handle-capture function
                                                       ↓
                                          detect type → extract metadata
                                                       ↓
                                          tiered content extraction:
                                            1. Jina Reader (r.jina.ai)
                                            2. Local (Readability + node-html-markdown)
                                            3. CF Browser Rendering (if keys set)
                                                       ↓
                                          write vault note (Obsidian template)
                                                       ↓
                                          notify (CLI only; agent handles its own)
```

## Content Types

| Type | Detection | Extraction |
|------|-----------|------------|
| `article` | Default | Tiered: Jina → Local → CF |
| `youtube-video` | youtube.com/watch, youtu.be | yt-dlp transcript |
| `youtube-channel` | youtube.com/@, /c/ | yt-dlp video listing → fan-out |
| `hacker-news` | news.ycombinator.com | Algolia API + tiered for linked article |
| `github-repo` | github.com/{owner}/{repo} | Clone/pull + GitHub API metadata |
| `twitter` | x.com, twitter.com | Placeholder (TODO: agent-browser) |
| `file` | Local file path | Direct file read |

## CLI Commands

```bash
kos capture <url> --quick          # Metadata only
kos capture <url> --full           # Full content extraction
kos capture <url>                  # Triage (Slack buttons)
kos capture --batch-file urls.txt  # Batch
kos capture --file /path/to/doc    # Local file
```

## Env Vars

| Var | Required | Purpose |
|-----|----------|---------|
| `VAULT_PATH` | Yes | Path to Obsidian vault (default: ~/kyrell-os-vault) |
| `CF_ACCOUNT_ID` | No | Cloudflare Account ID (enables Tier 3 extraction) |
| `CF_API_TOKEN` | No | Cloudflare API token (enables Tier 3 extraction) |

## Extraction Functions (Inngest)

Each tier is a separate Inngest function with independent config:

| Function | ID | Throttle | Retries |
|----------|----|----------|---------|
| `jinaExtraction` | jina-extraction | 18/min | 1 |
| `localExtraction` | local-extraction | none | 1 |
| `cfBrowserExtraction` | cf-browser-extraction | none | 1 |

Orchestrator calls via `step.invoke()` with try/catch fallback.

## Vault Templates

Templates are in `~/kyrell-os-vault/templates/`. Never hardcode note formats in TypeScript.

| Template | For |
|----------|-----|
| Article Source Template | Articles, blog posts |
| YouTube Video Source Template | YouTube videos |
| Hacker News Source Template | HN posts |
| GitHub Repo Source Template | GitHub repos |
| File Source Template | Local files |
| YouTube Channel Template | YouTube channels |

## Failure Handling

- All tiers fail → `status: extraction-failed` in frontmatter
- Slack notification says "metadata saved, needs manual processing"
- Search vault for `status: extraction-failed` to find failed captures

## Testing

```bash
# Article (should use Jina)
kos capture "https://example.com/article" --full

# HN (linked article uses tiered extraction)
kos capture "https://news.ycombinator.com/item?id=42358514" --full

# GitHub repo (clones to ~/projects/)
kos capture "https://github.com/owner/repo" --full

# YouTube (requires yt-dlp installed)
kos capture "https://youtube.com/watch?v=abc" --full

# Batch
kos capture --batch-file urls.txt --quick
```

## Key Files

- `src/inngest/functions/handle-capture.ts` — Orchestrator
- `src/inngest/functions/extract-jina.ts` — Tier 1
- `src/inngest/functions/extract-local.ts` — Tier 2
- `src/inngest/functions/extract-cf-browser.ts` — Tier 3
- `src/capture/extract/github.ts` — GitHub extractor
- `src/capture/vault/templates.ts` — Vault note builder
- `src/capture/notify.ts` — Slack notifications
