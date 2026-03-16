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

Flag mode constructs a single calendar trigger. For multiple triggers per job (e.g., 9:00 and 17:00), use JSON mode:

```bash
kos jobs create twice-daily \
  --json '{"schedule":{"type":"scheduled","calendar":[{"Hour":9,"Minute":0},{"Hour":17,"Minute":0}]},"execution":{"type":"agent","prompt":"Check in"},"destination":{"chatId":"C123"}}'
```

### `kos jobs create` — JSON Mode

```bash
kos jobs create water-reminder --json '{"schedule":{"type":"periodic","seconds":120},"execution":{"type":"script","script":"#!/bin/bash\necho drink water"},"destination":{"chatId":"C123"}}'
```

**Name merge behavior:** The CLI injects `{ name: <positional> }` into the parsed `--json` object before sending. If `name` appears inside the JSON body, the positional arg wins (overwritten silently).

### Create Flags Reference

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--schedule` | `periodic \| scheduled` | Yes | Schedule type |
| `--seconds` | number | When periodic | Interval in seconds |
| `--hour` | number (0-23) | No | Hour for scheduled jobs (maps to `calendar.Hour`) |
| `--minute` | number (0-59) | No | Minute for scheduled jobs (maps to `calendar.Minute`) |
| `--day` | number (1-31) | No | Day of month (maps to `calendar.Day`) |
| `--weekday` | number (0-6) | No | Day of week, Sunday=0 (maps to `calendar.Weekday`) |
| `--month` | number (1-12) | No | Month (maps to `calendar.Month`) |
| `--type` | `script \| agent` | Yes | Execution type |
| `--script` | string | When `--type script` | Script content (CLI-enforced required for script jobs) |
| `--prompt` | string | When `--type agent` | Agent prompt (CLI-enforced required for agent jobs) |
| `--channel` | string | Yes | Slack channel ID |
| `--thread` | string | No | Slack thread ID |
| `--json` | string | No | Raw JSON body (overrides all other flags except name) |

**Flag → API key mapping:** CLI flags use lowercase (`--hour`, `--minute`, etc.) but the API schema uses PascalCase calendar keys (`Hour`, `Minute`, `Day`, `Weekday`, `Month`). The CLI handles this mapping internally — flags are translated to PascalCase before sending.

**Validation:** `--script` is rejected when `--type agent`. `--prompt` is rejected when `--type script`.

## Output Format

All commands return the agent-first JSON envelope.

### Success — List (script job)

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

Note: Script job `execution` objects show `{ "type": "script" }` without the script content — the server strips inline script content on creation and stores it as a separate file. The script file is the source of truth, not job.json.

### Success — List (agent job)

```json
{
  "ok": true,
  "command": "kos jobs list",
  "result": [
    {
      "name": "daily-summary",
      "schedule": { "type": "scheduled", "calendar": { "Hour": 9, "Minute": 0 } },
      "execution": { "type": "agent", "prompt": "Summarize yesterday's activity" },
      "destination": { "chatId": "C123" },
      "disabled": false,
      "createdAt": "2026-03-16T...",
      "updatedAt": "2026-03-16T..."
    }
  ],
  "next_actions": [ ... ]
}
```

Agent job `execution` objects include the `prompt` field since it's stored in job.json.

### Success — Delete

The server returns HTTP 204 with no body on delete. The CLI synthesizes the success envelope locally:

```json
{
  "ok": true,
  "command": "kos jobs delete water-reminder",
  "result": { "deleted": "water-reminder" },
  "next_actions": [
    { "command": "kos jobs list", "description": "List remaining jobs" }
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

The only two supported `api_url` values are `http://localhost:9080` and `https://kos.kyrelldixon.com`. Other URLs may work but are not tested — any non-localhost URL will trigger CF Access credential resolution.

For remote access, the CLI resolves `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` from 1Password via varlock on every request. No secrets stored on disk.

If varlock/1Password is unavailable, the CLI returns:
```json
{
  "ok": false,
  "command": "kos jobs list",
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

For multiple triggers per job, use --json mode with a calendar array.
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
| `kos jobs create` (flags, script) | Creates job, returns 201 data in envelope |
| `kos jobs create` (flags, agent) | Creates agent job with prompt |
| `kos jobs create` (JSON) | Same via --json flag |
| `kos jobs create` (JSON with calendar array) | Multi-trigger job via --json |
| `kos jobs create` (duplicate) | Returns error with code `CONFLICT` |
| `kos jobs create` (bad name) | Returns error with code `VALIDATION_ERROR` and fix |
| `kos jobs create` (script with newlines/quotes) | Multiline script content survives flag-to-JSON round trip |
| `kos jobs create` (--script with --type agent) | Returns `VALIDATION_ERROR` |
| `kos jobs list` (with jobs) | Returns jobs array with next_actions populated |
| `kos jobs delete` | Removes job, returns CLI-synthesized success envelope |
| `kos jobs delete` (missing) | Returns error with code `NOT_FOUND` |
| `kos jobs pause` | Sets disabled=true, returns updated job |
| `kos jobs resume` | Sets disabled=false, returns updated job |
| Calendar key casing | Flags `--hour 9` produces `{ "Hour": 9 }` in API request body |
| Auth error | Returns `AUTH_ERROR` with fix when 1Password unavailable |
| Connection error | Returns `CONNECTION_ERROR` when server unreachable |

## Non-Goals

- No `kos jobs update` command — to change a job's prompt, schedule, or destination, delete and recreate. The API supports PATCH for these fields but the CLI does not expose it yet.
- No migration of existing kos CLI commands to JSON output — jobs is the first agent-first command. Others can migrate incrementally.
- No interactive prompts — agent-first means no TTY assumptions.
