# Foundation & Mac Mini Deployment Design

**Goal:** Move kos-agent from local-only development to a deployed, always-on system on the Mac Mini, accessible via Slack from any device and via CLI with authenticated API endpoints.

**Spec:** This document
**Plan:** TBD (created after spec approval)

---

## Scope

1. Data migration — move state from repo (`data/`) to host filesystem (`~/.kos/agent/`)
2. API layer — Hono REST endpoints for configuration and workspace discovery
3. Secrets — varlock 1Password service account for headless production
4. Deployment infrastructure — LaunchDaemons, deploy script, Cloudflare Tunnel
5. Validation — end-to-end test via Slack from phone

**Out of scope:**
- Capture pipeline (separate spec)
- `kos mode` CLI command (after deployment is validated)
- IP-based access control beyond Cloudflare Access
- Agent-platform migration/deprecation (manual cleanup later)

---

## 1. Data Migration

State moves from `data/` (in the repo) to `~/.kos/agent/` (on the host machine). Code lives in the repo, state lives on the machine.

### Directory structure on host

```
~/.kos/
├── config.json              ← kos-kit CLI config (already exists)
└── agent/
    ├── channels.json        ← channel config, display mode, allowed users
    └── sessions/            ← per-thread session state (one JSON per thread)
```

### Code changes

**`src/lib/channels.ts`** (line 4):
```typescript
// Before
const CHANNELS_FILE = "data/channels.json";

// After
const CHANNELS_FILE = join(homedir(), ".kos/agent/channels.json");
```

**`src/lib/sessions.ts`** (line 3):
```typescript
// Before
const SESSIONS_DIR = "data/sessions";

// After
const SESSIONS_DIR = join(homedir(), ".kos/agent/sessions");
```

### Startup initialization

kos-agent ensures `~/.kos/agent/sessions/` exists on startup (`mkdir -p` equivalent). If `channels.json` doesn't exist, `loadConfig()` already returns a working default (no file write needed until first mutation).

### Simplified config

Drop the static `workspaces` array. Add `scanRoots` for dynamic workspace discovery. Change defaults.

**Before:**
```json
{
  "displayMode": "compact",
  "allowedUsers": ["UGZLW3Q69"],
  "channels": { ... },
  "workspaces": [ ... ],
  "globalDefault": "~/projects/kyrell-os"
}
```

**After:**
```json
{
  "displayMode": "compact",
  "allowedUsers": "*",
  "scanRoots": ["~/projects"],
  "globalDefault": "~/projects/kyrell-os",
  "channels": {}
}
```

Changes:
- `displayMode` defaults to `"compact"` (was `"verbose"`)
- `allowedUsers` defaults to `"*"` (was `[]`). Cloudflare Access is the real security boundary, not the Slack allowlist.
- `scanRoots` replaces `workspaces`. Directories are discovered at runtime by scanning these paths.
- `workspaces` array removed entirely.

### Dynamic workspace discovery

Instead of a static workspace list, scan `scanRoots` directories at runtime:
- `readdir()` with `withFileTypes: true`
- Filter: directories only, exclude hidden (starting with `.`)
- Return sorted `{name, path}[]`

The onboarding dropdown populates dynamically from this scan. New projects cloned to `~/projects/` appear automatically.

**Tilde expansion:** `scanRoots` stores paths with `~/` prefix. The scanning function expands tildes at scan time using the existing `expandHome()` helper in `channels.ts`.

**Onboarding update:** The current onboarding listener (`src/bolt/listeners/onboarding.ts`) calls `getWorkspaces()` which returns `{label, path}[]`. This changes to a new `scanWorkspaces()` function returning `{name, path}[]`. The dropdown text field changes from `ws.label` to `ws.name` (where `name` is the directory basename).

### Data migration

No migration needed. Existing `data/channels.json` content (one onboarded channel, display mode preference) is not worth copying. The bot starts with default config on the Mac Mini and rebuilds state through normal usage. Locally, the bot creates `~/.kos/agent/channels.json` on first write.

### Cleanup

- Delete `data/` directory from repo
- Remove `data/sessions/` from `.gitignore` (no longer relevant)
- Update `channels.test.ts` and `sessions.test.ts` to use the new paths

### Reference files

- Current channels module: `src/lib/channels.ts`
- Current sessions module: `src/lib/sessions.ts`
- agent-platform project scanner (workspace discovery pattern): `/Users/kyrelldixon/projects/agent-platform/server/projects/scanner.ts`
- agent-platform projects route (`/available` endpoint): `/Users/kyrelldixon/projects/agent-platform/server/routes/projects.ts`

---

## 2. API Layer

Hono REST endpoints for configuration and workspace discovery. These are what the kos CLI and other clients hit remotely.

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET /api/config` | Return current config (displayMode, allowedUsers, globalDefault, scanRoots, channels) |
| `PATCH /api/config` | Merge-update config fields (see validation rules below). Body: `{ displayMode?, allowedUsers?, globalDefault?, scanRoots? }` |
| `GET /api/workspaces` | Scan `scanRoots`, return `{name, path}[]` of available directories |
| `GET /health` | Health check (already exists, keep as-is) |
| `POST /api/inngest` | Inngest serve handler (already exists, keep as-is) |

### PATCH validation

- `displayMode`: must be `"verbose"`, `"compact"`, or `"minimal"`. Reject others with 400.
- `allowedUsers`: must be `"*"` or `string[]`. Reject other types with 400.
- `globalDefault`: must be a string. No path traversal validation needed (this is a personal system).
- `scanRoots`: must be `string[]`.
- `channels`: not writable via PATCH. Channels are managed per-channel through the Slack onboarding action. This is intentional — the PATCH endpoint handles global config, not per-channel state.
- Unknown keys: ignored (not rejected). Keeps the API forward-compatible.

### Authentication

All `/api/*` routes (except `/api/inngest` and `/health`) are protected by Cloudflare Access service token validation. Middleware checks the `CF-Access-Client-Id` header against an expected value.

The `/api/inngest` endpoint is accessed by the local Inngest dev server (same machine). It does not need Cloudflare Access — localhost binding protects it.

### File changes

- New: `src/routes/config.ts` — config GET/PATCH endpoints
- New: `src/routes/workspaces.ts` — workspace scanning endpoint
- New: `src/lib/middleware/access.ts` — Cloudflare Access service token validation
- Modify: `src/index.ts` — mount new routes
- Modify: `src/lib/channels.ts` — add `updateConfig()` function for PATCH support, update `ChannelsConfig` interface (remove `workspaces`, add `scanRoots`)

### Reference files

- agent-platform projects route: `/Users/kyrelldixon/projects/agent-platform/server/routes/projects.ts`
- agent-infra CF Access headers pattern: `/Users/kyrelldixon/projects/agent-infra/apps/worker/src/routes/webhook.ts`

---

## 3. Secrets

varlock's 1Password plugin supports both biometric (local dev) and service account (production) natively.

### Schema changes

**Current `.env.schema`:**
```
# @plugin(@varlock/1password-plugin)
# @initOp(allowAppAuth=true, account=my)
# @defaultRequired=infer @defaultSensitive=false
# @generateTypes(lang=ts, path=env.d.ts)
# ---
```

**Updated `.env.schema`:**
```
# @plugin(@varlock/1password-plugin)
# @initOp(token=$OP_TOKEN, allowAppAuth=forEnv(dev), account=my)
# @defaultRequired=infer @defaultSensitive=false
# @generateTypes(lang=ts, path=env.d.ts)
# ---

# 1Password service account token (production only, empty in dev)
# @type=opServiceAccountToken @sensitive
OP_TOKEN=
```

Changes:
- Add `token=$OP_TOKEN` — service account token for production auth
- Change `allowAppAuth=true` → `allowAppAuth=forEnv(dev)` — biometric only in dev
- Add `OP_TOKEN` config item

### How secrets load at runtime

In both dev and production, secrets are injected via `varlock/auto-load` configured as a Bun preload in `bunfig.toml`:

```toml
preload = ["varlock/auto-load"]
env = false
```

At process startup, Bun runs the varlock preload which:
1. Reads `.env.schema` from the working directory (set by `WorkingDirectory` in the plist)
2. Resolves `OP_TOKEN` from environment variables (set in plist's `EnvironmentVariables`)
3. Uses `OP_TOKEN` to authenticate with 1Password via the SDK (no CLI needed)
4. Fetches secret values (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`) and injects them into `process.env`

The plist's `ProgramArguments` is simply `/opt/homebrew/bin/bun run src/index.ts` — no `varlock run` wrapper needed. The preload handles everything.

**Critical:** The plist must set `WorkingDirectory` to the repo root so that varlock can find `.env.schema`.

### Production setup (one-time, on Mac Mini)

1. Create 1Password service account in web UI (from laptop)
2. Grant access to the Developer vault (where Slack tokens live)
3. Save the service account token
4. Set `OP_TOKEN` in the kos-agent LaunchDaemon plist's `EnvironmentVariables`

No 1Password CLI or desktop app needed on the Mac Mini. The varlock plugin uses the 1Password SDK (bundled via `@varlock/1password-plugin` npm package) for service account auth.

### Local dev

No change. `OP_TOKEN` is empty, `allowAppAuth=forEnv(dev)` triggers biometric via desktop app. The same `varlock/auto-load` preload runs, but uses desktop app auth instead of service account.

### Reference files

- Current schema: `/Users/kyrelldixon/projects/kos-agent/.env.schema`
- varlock 1Password plugin docs: https://varlock.dev/plugins/1password

---

## 4. Deployment Infrastructure

Three LaunchDaemon plists, a deploy script, and Cloudflare Tunnel configuration. Pattern proven by agent-platform.

### LaunchDaemons

**kos-agent service** (`ops/com.kyrelldixon.kos-agent.plist`):

| Key | Value | Notes |
|-----|-------|-------|
| Label | `com.kyrelldixon.kos-agent` | |
| ProgramArguments | `/opt/homebrew/bin/bun run src/index.ts` | Absolute path — LaunchDaemons don't load shell profiles |
| WorkingDirectory | `/Users/kyrelldixon/projects/kos-agent` | |
| UserName | `kyrelldixon` | Run as user, not root |
| PORT | `9080` | Hono server port |
| NODE_ENV | `production` | |
| INNGEST_DEV | `1` | Connect to local Inngest dev server |
| OP_TOKEN | `<service account token>` | varlock 1Password auth |
| HOME | `/Users/kyrelldixon` | Explicit — LaunchDaemons don't set this |
| PATH | `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` | Must include Homebrew for bun, inngest-cli |
| KeepAlive | `true` | Auto-restart on crash |
| RunAtLoad | `true` | Start on boot |
| StandardOutPath | `/Users/kyrelldixon/Library/Logs/kos-agent.log` | |
| StandardErrorPath | `/Users/kyrelldixon/Library/Logs/kos-agent.err` | |

**Inngest dev server** (`ops/com.kyrelldixon.inngest-dev.plist`):

| Key | Value | Notes |
|-----|-------|-------|
| Label | `com.kyrelldixon.inngest-dev` | |
| ProgramArguments | `/opt/homebrew/bin/inngest-cli dev --no-discovery -u http://localhost:9080/api/inngest` | Explicit SDK URL since no auto-discovery |
| UserName | `kyrelldixon` | Run as user, consistent with kos-agent |
| HOME | `/Users/kyrelldixon` | Explicit — needed for consistency |
| PATH | `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` | Must include Homebrew for inngest-cli |
| KeepAlive | `true` | |
| RunAtLoad | `true` | |
| ThrottleInterval | `5` | Prevent crash loops (same as cloudflared) |
| StandardOutPath | `/Users/kyrelldixon/Library/Logs/inngest-dev.log` | |
| StandardErrorPath | `/Users/kyrelldixon/Library/Logs/inngest-dev.err` | |

**kos-agent restarter** (`ops/com.kyrelldixon.kos-agent-restarter.plist`):

| Key | Value | Notes |
|-----|-------|-------|
| Label | `com.kyrelldixon.kos-agent-restarter` | |
| ProgramArguments | `/bin/bash /Users/kyrelldixon/projects/kos-agent/restart-kos-agent.sh` | |
| WatchPaths | `/private/tmp/kos-agent-restart-trigger` | Touch file to trigger restart |

**`restart-kos-agent.sh`:**
```bash
#!/bin/bash
set -euo pipefail
launchctl kickstart -k system/com.kyrelldixon.kos-agent
```

The restarter plist intentionally omits `UserName` — it runs as root because `launchctl kickstart -k system/...` requires root privileges. Same pattern as agent-platform's restarter.

### Localhost binding

**Note:** Binding to `127.0.0.1` changes the current default (Bun.serve binds to `0.0.0.0` by default). This is intentional for production security. The Inngest SDK registration URL should remain `http://localhost:9080/api/inngest` which resolves to `127.0.0.1` — no conflict.

Both services bind to `127.0.0.1`, not `0.0.0.0`:
- kos-agent Hono server: `hostname: "127.0.0.1"` in Bun.serve options
- Inngest dev server: check if `--host 127.0.0.1` flag is available, otherwise acceptable since port 8288 is not exposed through the tunnel without Cloudflare Access

This ensures direct network connections (Tailscale or otherwise) cannot bypass Cloudflare Access.

### GitHub webhook deploy

Push to `main` triggers automatic deployment via GitHub webhook → kos-agent endpoint → deploy script. Same pattern as agent-platform.

**Endpoint:** `POST /api/hooks/deploy`

Flow:
1. GitHub sends push event with HMAC-SHA256 signature (`x-hub-signature-256` header)
2. kos-agent verifies signature against deploy secret stored at `~/.kos/agent/deploy-secret.txt`
3. Only triggers on push events to `refs/heads/main` — ignores other branches and event types
4. Spawns `deploy.sh` as a detached child process (unref'd so the HTTP response returns immediately)
5. Deploy logs written to `~/Library/Logs/kos-agent-deploy.log`

**Deploy secret:** Auto-generated on first startup if `~/.kos/agent/deploy-secret.txt` doesn't exist. Copy this value into the GitHub webhook settings.

**Cloudflare Access:** The `/api/hooks/*` path gets a **bypass** rule — GitHub can't authenticate via service tokens or email OTP, so Cloudflare Access must allow the request through. The HMAC signature is the auth layer for this path.

**GitHub webhook setup (one-time):**
1. Go to kos-agent repo → Settings → Webhooks → Add webhook
2. Payload URL: `https://kos.kyrelldixon.com/api/hooks/deploy`
3. Content type: `application/json`
4. Secret: copy from `~/.kos/agent/deploy-secret.txt` on Mac Mini
5. Events: just pushes

**File changes:**
- New: `src/routes/hooks.ts` — deploy webhook endpoint (port from agent-platform)
- New: `src/lib/deploy/verify-signature.ts` — HMAC-SHA256 verification (port from agent-platform)
- New: `src/lib/deploy/secret.ts` — auto-generate deploy secret on first run
- Modify: `src/index.ts` — mount hooks route at `/api/hooks`

### Deploy script

`deploy.sh` follows the agent-platform pattern:

**`--install` (first-time):**
1. Check prereqs: bun, inngest-cli, git
2. `git pull --ff-only && bun install`
3. Copy plists to `/Library/LaunchDaemons/` (sudo, `root:wheel`, `0600` — NOT `0644`, see Security section)
4. Bootstrap all three services via `launchctl bootstrap system`
5. Create `~/Library/Logs` and `~/.kos/agent/sessions/` directories

**Default (subsequent deploys):**
1. `git pull --ff-only && bun install`
2. Touch `/private/tmp/kos-agent-restart-trigger`

No client build step (kos-agent has no frontend).

### Cloudflare Tunnel

**Updated `~/.cloudflared/config.yml`:**
```yaml
tunnel: 4aac80e6-277f-48b5-b544-3333c21618e6
credentials-file: /Users/kyrelldixon/.cloudflared/4aac80e6-277f-48b5-b544-3333c21618e6.json

ingress:
  - hostname: kos.kyrelldixon.com
    service: http://localhost:9080
  - hostname: inngest.kyrelldixon.com
    service: http://localhost:8288
  - service: http_status:404
```

**DNS setup (one-time, from Mac Mini):**
```bash
cloudflared tunnel route dns 4aac80e6 kos.kyrelldixon.com
cloudflared tunnel route dns 4aac80e6 inngest.kyrelldixon.com
```

**Cloudflare Access policies (configured in Zero Trust dashboard):**
- `kos.kyrelldixon.com` — service token policy (CLI and machine-to-machine)
- `inngest.kyrelldixon.com` — email OTP policy (your email addresses only)

**Removing agent-platform:** Stop and remove agent-platform LaunchDaemons when ready. This is manual cleanup, not part of the automated deploy.

### Startup order

Inngest dev server and kos-agent both have `RunAtLoad: true`. No ordering guarantee. The Inngest SDK with `INNGEST_DEV=1` retries registration with the dev server — if kos-agent starts first, it catches up within seconds.

### Reference files

- agent-platform plists: `/Users/kyrelldixon/projects/agent-platform/ops/`
- agent-platform deploy.sh: `/Users/kyrelldixon/projects/agent-platform/deploy.sh`
- agent-platform restarter: `/Users/kyrelldixon/projects/agent-platform/restart-agent-platform.sh`
- agent-platform deploy routes: `/Users/kyrelldixon/projects/agent-platform/server/deploy/routes.ts`
- agent-platform signature verification: `/Users/kyrelldixon/projects/agent-platform/server/deploy/verify-signature.ts`
- agent-platform deploy wiring in app.ts: `/Users/kyrelldixon/projects/agent-platform/server/app.ts` (lines 58-79)
- Cloudflare Tunnel guide: `/Users/kyrelldixon/kyrell-os-vault/artifacts/Cloudflare Tunnels vs Tailscale - Guide.md`
- Mac Mini deployment plan: `/Users/kyrelldixon/kyrell-os-vault/plans/02-28-2026 Mac Mini Deployment.md`

---

## 5. Security

### Access control model

| Layer | Mechanism | Protects against |
|-------|-----------|-----------------|
| Cloudflare Access | Service tokens for API, email OTP for dashboard | Unauthorized public access |
| Localhost binding | Services bind to `127.0.0.1` only | Network bypass of Cloudflare (Tailscale, direct IP) |
| Slack allowedUsers | Bot ignores messages from unknown Slack users | Unauthorized users in your Slack workspace |

### Plist secret protection

The kos-agent plist contains `OP_TOKEN` (1Password service account token) in its `EnvironmentVariables`. This is the "secret-zero" — it grants access to all other secrets. The agent runs arbitrary commands as `kyrelldixon`, so any file readable by that user is accessible to the agent.

**Mitigation:** All plists in `/Library/LaunchDaemons/` are set to `0600 root:wheel` (not `0644`). `launchd` runs as root and can read `0600` files. The agent process (running as `kyrelldixon`) cannot read the plist, so `OP_TOKEN` is not exposed to the agent.

The deploy script must use `sudo chmod 600` (not `644`) when installing plists. The agent-platform deploy script used `644` — this is the fix.

### What's already safe

- **Slack Socket Mode** — outbound WebSocket from Mac Mini to Slack. Nothing to expose.
- **1Password secrets** — pulled at startup via SDK, injected into `process.env`. The plist containing `OP_TOKEN` is root-only (`0600`).
- **Inngest dev server** — same machine as kos-agent, communicates over localhost.

### Future hardening (out of scope)

- JWT verification of `CF-Access-Jwt-Assertion` header (defense in depth)
- Inngest signing key verification
- IP allowlisting beyond Cloudflare
- Rate limiting on API endpoints

---

## 6. Validation

After deploying, verify the system works end-to-end:

1. **Services running** — SSH into Mac Mini, `launchctl list | grep kos`, `launchctl list | grep inngest`. Both should show PID and exit status 0.
2. **Inngest dashboard** — Open `inngest.kyrelldixon.com` in browser. Cloudflare Access login. See kos-agent functions registered.
3. **API endpoints** — `curl` with service token headers:
   - `GET kos.kyrelldixon.com/api/config` → returns default config
   - `PATCH kos.kyrelldixon.com/api/config` → updates displayMode, verify change persists
   - `GET kos.kyrelldixon.com/api/workspaces` → returns directories from `~/projects/` on Mac Mini
4. **Slack end-to-end** — DM the bot from your phone. Verify: brain reaction → streaming tool use → response → checkmark.
5. **Restart resilience** — `touch /private/tmp/kos-agent-restart-trigger`, verify service comes back and Slack bot reconnects.

**Success criteria:** DM the bot from your phone, get a response. This proves Slack Socket Mode → Inngest → Agent SDK → Slack reply all works remotely.

---

## Files Changed (Summary)

| File | Change |
|------|--------|
| `src/lib/channels.ts` | Path to `~/.kos/agent/channels.json`, update `ChannelsConfig` interface (drop `workspaces`, add `scanRoots`), update defaults (compact, `*`), add `updateConfig()` |
| `src/lib/sessions.ts` | Path to `~/.kos/agent/sessions` |
| `src/lib/channels.test.ts` | Update for new config shape |
| `src/lib/sessions.test.ts` | Update for new paths |
| `src/routes/config.ts` | New: GET/PATCH `/api/config` |
| `src/routes/workspaces.ts` | New: GET `/api/workspaces` with directory scanning |
| `src/routes/hooks.ts` | New: POST `/api/hooks/deploy` — GitHub webhook deploy trigger |
| `src/lib/deploy/verify-signature.ts` | New: HMAC-SHA256 signature verification (ported from agent-platform) |
| `src/lib/deploy/secret.ts` | New: auto-generate deploy secret at `~/.kos/agent/deploy-secret.txt` |
| `src/lib/middleware/access.ts` | New: Cloudflare Access service token validation |
| `src/index.ts` | Mount new routes, ensure `~/.kos/agent/sessions/` exists on startup, bind to `127.0.0.1` |
| `src/bolt/listeners/onboarding.ts` | Use dynamic workspace scanning instead of static list |
| `.env.schema` | Add `OP_TOKEN`, update `@initOp` for service account + conditional app auth |
| `.gitignore` | Remove `data/sessions/` |
| `ops/com.kyrelldixon.kos-agent.plist` | New: LaunchDaemon for kos-agent |
| `ops/com.kyrelldixon.inngest-dev.plist` | New: LaunchDaemon for Inngest dev server |
| `ops/com.kyrelldixon.kos-agent-restarter.plist` | New: WatchPaths restarter |
| `deploy.sh` | New: deploy script (install + update modes) |
| `restart-kos-agent.sh` | New: restart script for WatchPaths trigger |
| `data/` | Deleted from repo |
