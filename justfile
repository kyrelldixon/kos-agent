# Agent System task runner
#
# Dev workflow:
#   Terminal 1: just restate
#   Terminal 2: just dev
#   Once both up: just register (one-time per restate restart)
#   Test:        just ping

restate-port := "9080"
restate-ingress := "8080"
restate-ui := "9070"
restate-data := env("HOME") / ".restate/agent-system"

# List available recipes
default:
    @just --list

# Start Restate server
restate:
    mkdir -p {{restate-data}}
    restate-server --base-dir={{restate-data}}

# Start the Bun app (Bolt + Restate handlers)
dev:
    bunx varlock run -- bun --watch src/index.ts

# Register service handlers with Restate (one-time per restate restart)
register:
    restate deployments register http://localhost:{{restate-port}}

# Test the ping service
ping message="hello":
    curl -s -X POST http://localhost:{{restate-ingress}}/ping/ping \
      -H 'Content-Type: application/json' \
      -d '{"message": "{{message}}"}'

# Open Restate dashboard
dashboard:
    open http://localhost:{{restate-ui}}

# Wipe all Restate state
reset:
    rm -rf {{restate-data}}
    @echo "Restate state wiped. Restart with: just restate"

# Typecheck
check:
    bunx tsc --noEmit
