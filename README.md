# KOS Agent

Personal always-on agent system: Slack Bolt + Inngest (durable execution) + Claude Agent SDK.

Runs on a Mac Mini, accessible via Slack from any device. API endpoints for CLI access behind Cloudflare Access.

## Prerequisites

- [Bun](https://bun.sh)
- [Inngest CLI](https://www.inngest.com/docs/local-development) — `brew install inngest/tap/inngest`
- [1Password](https://1password.com) desktop app with CLI integration enabled
- [varlock](https://varlock.dev) — secrets resolved from 1Password via `.env.schema`
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — `brew install yt-dlp` (for YouTube capture)
- [Obsidian](https://obsidian.md) — must be running for vault note creation

## Dev Workflow

Two terminals:

```bash
# Terminal 1: Inngest dev server
inngest-cli dev --no-discovery -u http://localhost:9080/api/inngest

# Terminal 2: App with hot reload (Bolt + Hono + Inngest functions)
bun dev
```

## API Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/health` | None | Health check |
| `GET/POST/PUT` | `/api/inngest` | None (localhost) | Inngest serve handler |
| `GET` | `/api/config` | CF Access | Current config |
| `PATCH` | `/api/config` | CF Access | Update config |
| `GET` | `/api/workspaces` | CF Access | List available workspaces |
| `POST` | `/api/hooks/deploy` | HMAC | GitHub webhook deploy |

## Capture Pipeline

Captures URLs and content into the Obsidian vault as source notes. Supports articles, YouTube videos, Hacker News posts, GitHub repos, and local files.

```bash
kos capture <url> --full     # Full content extraction
kos capture <url> --quick    # Metadata only
kos capture <url>            # Triage mode (Slack buttons)
```

Three-tier extraction for articles: Jina Reader → Readability (local) → CF Browser Rendering. Each tier is an independent Inngest function with its own retry/throttle config.

See `.claude/skills/capture-pipeline/SKILL.md` for full operational docs.

## Architecture

- **Slack Bolt** (Socket Mode) — listens for DMs and @mentions
- **Hono** on `:9080` — HTTP server for Inngest + API endpoints
- **Inngest** — durable execution for message handling, reply sending, failure recovery
- **Claude Agent SDK** — LLM sessions with tool use, resume support
- **Cloudflare Tunnel** — external access via `kos.kyrelldixon.com`

## Data

State lives at `~/.kos/agent/` (not in the repo):

```
~/.kos/agent/
├── channels.json        # Channel config, display mode, allowed users
├── sessions/            # Per-thread session state
└── deploy-secret.txt    # GitHub webhook HMAC secret
```

## Deployment

Runs on the Mac Mini via LaunchDaemons. See the setup guide in the vault: `artifacts/KOS Agent — Mac Mini Setup Guide.md`

```bash
# First-time install
bash deploy.sh --install

# Subsequent deploys (also triggered by GitHub webhook on push to main)
bash deploy.sh
```

## Env Management

Secrets managed by [varlock](https://varlock.dev) + 1Password. No `.env` file — `.env.schema` is the source of truth.

- **Local dev:** biometric auth via 1Password desktop app
- **Production:** 1Password service account token (`OP_TOKEN` in plist)
