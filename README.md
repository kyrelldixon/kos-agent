# Agent System

Personal agent system: Restate (durable execution) + Slack Bolt + Claude SDK.

## Prerequisites

- [Bun](https://bun.sh)
- [Restate](https://restate.dev) — `brew install restatedev/tap/restate-server`
- [just](https://github.com/casey/just) — `brew install just`
- [1Password](https://1password.com) desktop app with CLI integration enabled
- [varlock](https://varlock.dev) — secrets resolved from 1Password via `.env.schema`

## Dev Workflow

Two long-running processes, then a one-time registration:

```bash
# Terminal 1: Restate server (data stored at ~/.restate/agent-system/)
just restate

# Terminal 2: Bun app with hot reload (Bolt + Restate handlers)
just dev

# Terminal 3 (once both are up): Register handlers with Restate
just register
```

`just register` only needs to run once per `restate` restart. If you change handler signatures, re-register.

## Useful Commands

```bash
just ping               # Test ping service
just ping "hey there"   # Test with custom message
just dashboard          # Open Restate UI at :9070
just check              # TypeScript typecheck
just reset              # Wipe all Restate state and start fresh
```

## Architecture

- **Slack Bolt** (Socket Mode) — listens for DMs and @mentions
- **Restate** on `:9080` — durable service handlers
- **Restate ingress** on `:8080` — where you invoke services
- **Restate UI** on `:9070` — dashboard for inspecting state

## Env Management

Secrets managed by [varlock](https://varlock.dev) + 1Password. No `.env` file — `.env.schema` is the source of truth. See the `using-varlock` skill in `kyrell-os` for details.
