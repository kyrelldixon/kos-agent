# kos jobs CLI — Design Spec

**Date:** 2026-03-16
**Status:** Draft
**Linear:** KYR-120 (Dynamic cron/job scheduling via LaunchAgents)

## Problem

The kos-agent bot creates and manages scheduled jobs via curl commands constructed in its system prompt. Curl requires the agent to build nested JSON inside bash strings — escaping quotes, newlines in scripts, and nested objects. This is error-prone for LLMs and hard for humans to use.

## Solution

Add `kos jobs` subcommands to the existing kos CLI at `~/.kos-kit/cli/`. The CLI is agent-first (JSON output always) and supports both flag-based and raw JSON input for job creation. The agent's system prompt swaps curl templates for `kos jobs` commands.

## Command Surface

```
kos jobs list                              # List all jobs
kos jobs create <name> [flags]             # Create a job via flags
kos jobs create <name> --json '{...}'      # Create a job via raw JSON body
kos jobs delete <name>                     # Delete a job
kos jobs pause <name>                      # Disable a job
kos jobs resume <name>                     # Re-enable a job
```

### `kos jobs create` — Flag Mode

Script job:
```bash
kos jobs create water-reminder \
  --schedule periodic --seconds 120 \
  --type script --script "echo drink water" \
  --channel C123 --thread 1234.5
```

Agent job:
```bash
kos jobs create daily-summary \
  --schedule scheduled --hour 9 --minute 0 \
  --type agent --prompt "Summarize yesterday's activity" \
  --channel C123
```

### `kos jobs create` — JSON Mode

```bash
kos jobs create water-reminder --json '{"schedule":{"type":"periodic","seconds":120},"execution":{"type":"script","script":"#!/bin/bash\necho drink water"},"destination":{"chatId":"C123"}}'
```

The `name` is always a positional arg, not inside the JSON body.

### Create Flags Reference

| Flag | Type | Description |
|------|------|-------------|
| `--schedule` | `periodic \| scheduled` | Schedule type (required) |
| `--seconds` | number | Interval for periodic jobs |
| `--hour` | number (0-23) | Hour for scheduled jobs |
| `--minute` | number (0-59) | Minute for scheduled jobs |
| `--day` | number (1-31) | Day of month for scheduled jobs |
| `--weekday` | number (0-6) | Day of week (Sunday=0) for scheduled jobs |
| `--month` | number (1-12) | Month for scheduled jobs |
| `--type` | `script \| agent` | Execution type (required) |
| `--script` | string | Script content (for script jobs) |
| `--prompt` | string | Agent prompt (for agent jobs) |
| `--channel` | string | Slack channel ID (required) |
| `--thread` | string | Slack thread ID (optional) |
| `--json` | string | Raw JSON body (overrides all other flags except name) |

## Output Format

All commands return the agent-first JSON envelope.

### Success

```json
{
  "ok": true,
  "command": "kos jobs list",
  "result": [
    {
      "name": "water-reminder",
      "schedule": { "type": "periodic", "seconds": 120 },
      "execution": { "type": "script" },
      "destination": { "chatId": "C123" },
      "disabled": false,
      "createdAt": "2026-03-16T...",
      "updatedAt": "2026-03-16T..."
    }
  ],
  "next_actions": [
    {
      "command": "kos jobs delete <name>",
      "description": "Delete a job",
      "params": { "name": { "enum": ["water-reminder"] } }
    },
    {
      "command": "kos jobs pause <name>",
      "description": "Pause a job",
      "params": { "name": { "enum": ["water-reminder"] } }
    }
  ]
}
```

### Error

```json
{
  "ok": false,
  "command": "kos jobs create bad name",
  "error": {
    "message": "Validation failed: name must match ^[a-z0-9][a-z0-9_-]*$",
    "code": "VALIDATION_ERROR"
  },
  "fix": "Use lowercase alphanumeric characters, hyphens, and underscores only. Example: water-reminder",
  "next_actions": [
    {
      "command": "kos jobs create <name> --schedule periodic --seconds <N> --type script --script <content> --channel <chatId>",
      "description": "Create a script job with valid name"
    }
  ]
}
```

### Error Codes

| Code | When |
|------|------|
| `VALIDATION_ERROR` | Invalid flags or JSON body |
| `NOT_FOUND` | Job name doesn't exist (delete/pause/resume) |
| `CONFLICT` | Job name already exists (create) |
| `API_ERROR` | Server returned unexpected status |
| `CONNECTION_ERROR` | Can't reach the API (server down, bad URL) |
| `AUTH_ERROR` | CF Access credentials failed or unavailable |

### next_actions Behavior

- `list` → offers delete/pause/resume with actual job names populated
- `create` → offers list and delete for the created job
- `delete` → offers list
- `pause` → offers resume for the paused job, list
- `resume` → offers pause for the resumed job, list
- Errors → offers the corrected command template

## Config & Auth

### API URL

`~/.kos/config.json` gets one new field:

```json
{
  "api_url": "http://localhost:9080"
}
```

### Auto-Detection (kos setup)

During `kos setup`:
1. Try `fetch("http://localhost:9080/health")`
2. Success → `api_url: "http://localhost:9080"`
3. Fail → `api_url: "https://kos.kyrelldixon.com"`

Stored once, editable anytime by modifying the file directly.

### Auth Logic

```
if api_url starts with http://localhost → no auth headers
otherwise → resolve CF Access creds via varlock + 1Password, attach headers
```

For remote access, the CLI resolves `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` from 1Password via varlock on every request. No secrets stored on disk.

If varlock/1Password is unavailable, the CLI returns:
```json
{
  "ok": false,
  "error": { "message": "Could not resolve CF Access credentials", "code": "AUTH_ERROR" },
  "fix": "Unlock 1Password or run: op signin"
}
```

### Server-Side Auth

No changes to server middleware. Cloudflare Access at the tunnel level gates remote requests. The app does not add CF Access middleware to `/api/jobs` routes. Localhost requests bypass Cloudflare entirely.

## Agent Integration

The agent's system prompt in `src/agent/session.ts` swaps curl templates for CLI commands:

```
## Scheduled Jobs
Manage scheduled jobs with the kos CLI. All output is JSON.

Create a script job:
kos jobs create <name> --schedule periodic --seconds <N> --type script --script "<commands>" --channel <chatId> --thread <threadId>

Create an agent job:
kos jobs create <name> --schedule scheduled --hour 9 --minute 0 --type agent --prompt "<what to do>" --channel <chatId> --thread <threadId>

Other commands:
kos jobs list
kos jobs delete <name>
kos jobs pause <name>
kos jobs resume <name>

Schedule types:
- periodic: --seconds N
- scheduled: --hour H --minute M (also --day, --weekday, --month)
```

### Deployment Prerequisite

`kos` must be on PATH in the agent's shell environment on the Mac Mini. Verify via SSH before deploying the prompt change.

## Files Changed

### `~/.kos-kit/cli/` (kos CLI)

| File | Change |
|------|--------|
| `src/commands/jobs.ts` | New — jobs subcommand with list/create/delete/pause/resume |
| `src/lib/api.ts` | New — HTTP client (reads api_url from config, handles CF Access via varlock) |
| `src/lib/output.ts` | New — JSON envelope helpers (success, error, nextAction builders) |
| `src/index.ts` | Modified — register jobs subcommand |
| `src/lib/config.ts` | Modified — add api_url field to config schema |

### `~/projects/kos-agent/` (kos-agent)

| File | Change |
|------|--------|
| `src/agent/session.ts` | Modified — swap curl templates for kos CLI commands in system prompt |

## Testing

E2E tests per the CLI skill's guidance. Seed data via API, run CLI commands, assert JSON envelope structure.

| Test | What it validates |
|------|-------------------|
| `kos jobs list` (empty) | Returns `{ ok: true, result: [] }` |
| `kos jobs create` (flags) | Creates job, returns 201 data in envelope |
| `kos jobs create` (JSON) | Same via --json flag |
| `kos jobs create` (duplicate) | Returns error with code `CONFLICT` |
| `kos jobs create` (bad name) | Returns error with code `VALIDATION_ERROR` and fix |
| `kos jobs list` (with jobs) | Returns jobs array with next_actions populated |
| `kos jobs delete` | Removes job, returns success |
| `kos jobs delete` (missing) | Returns error with code `NOT_FOUND` |
| `kos jobs pause` | Sets disabled=true, returns updated job |
| `kos jobs resume` | Sets disabled=false, returns updated job |
| Auth error | Returns `AUTH_ERROR` with fix when 1Password unavailable |
| Connection error | Returns `CONNECTION_ERROR` when server unreachable |

## Non-Goals

- No `kos jobs update` command — pause/resume covers the primary use case. Add later if needed.
- No migration of existing kos CLI commands to JSON output — jobs is the first agent-first command. Others can migrate incrementally.
- No interactive prompts — agent-first means no TTY assumptions.
