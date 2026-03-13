# Agent System task runner
#
# Dev workflow:
#   Terminal 1: just inngest
#   Terminal 2: just dev
#   Test:        just test

# List available recipes
default:
    @just --list

# Start Inngest dev server (dashboard at :8288)
inngest:
    inngest dev -u http://localhost:9080/api/inngest --no-discovery

# Start the Bun app (Bolt Socket Mode + Hono :9080)
dev:
    INNGEST_DEV=1 bunx varlock run -- bun --watch src/index.ts

# Run tests
test *args:
    bun test {{args}}

# Typecheck
check:
    bunx tsc --noEmit

# Lint + format
lint:
    bunx biome check .

# Open Inngest dashboard
dashboard:
    open http://localhost:8288

# Health check
health:
    curl -s http://localhost:9080/health | jq
