#!/bin/bash
# Deploy kos-agent to the local machine
# Usage: bash deploy.sh [--install]
#   --install  First-time setup: copy plists + bootstrap services
#   (default)  Update: pull, build, restart
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Service definitions
KA_PLIST_NAME="com.kyrelldixon.kos-agent"
KA_PLIST_SRC="$REPO_DIR/ops/$KA_PLIST_NAME.plist"
KA_PLIST_DST="/Library/LaunchDaemons/$KA_PLIST_NAME.plist"
KA_SERVICE="system/$KA_PLIST_NAME"

IN_PLIST_NAME="com.kyrelldixon.inngest-dev"
IN_PLIST_SRC="$REPO_DIR/ops/$IN_PLIST_NAME.plist"
IN_PLIST_DST="/Library/LaunchDaemons/$IN_PLIST_NAME.plist"
IN_SERVICE="system/$IN_PLIST_NAME"

RS_PLIST_NAME="com.kyrelldixon.kos-agent-restarter"
RS_PLIST_SRC="$REPO_DIR/ops/$RS_PLIST_NAME.plist"
RS_PLIST_DST="/Library/LaunchDaemons/$RS_PLIST_NAME.plist"
RS_SERVICE="system/$RS_PLIST_NAME"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[+]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[x]${NC} $1"; exit 1; }
step()  { echo -e "\n${BOLD}==> $1${NC}"; }

check_prereqs() {
  command -v bun &>/dev/null || error "bun not found."
  command -v inngest &>/dev/null || error "inngest not found. Install with: brew install inngest/tap/inngest"
  command -v git &>/dev/null || error "git not found."

  info "bun: $(which bun)"
  info "inngest: $(which inngest)"
}

build() {
  step "Updating kos-agent"
  cd "$REPO_DIR"

  info "Pulling latest..."
  git pull --ff-only

  info "Installing dependencies..."
  bun install

  info "Updating kos CLI..."
  kos update
}

install_plist() {
  local name="$1" src="$2" dst="$3" service="$4"

  if [[ ! -f "$src" ]]; then
    error "Plist not found at $src"
  fi

  # Bootout if already loaded (ignore errors)
  sudo launchctl bootout "$service" 2>/dev/null || true

  info "Copying $name plist to $dst"
  sudo cp "$src" "$dst"
  sudo chown root:wheel "$dst"
  sudo chmod 600 "$dst"

  info "Bootstrapping $name..."
  sudo launchctl bootstrap system "$dst"
}

install_services() {
  step "Installing LaunchDaemons"
  mkdir -p "$HOME/Library/Logs"
  mkdir -p "$HOME/.kos/agent/sessions"

  install_plist "kos-agent" "$KA_PLIST_SRC" "$KA_PLIST_DST" "$KA_SERVICE"
  install_plist "inngest-dev" "$IN_PLIST_SRC" "$IN_PLIST_DST" "$IN_SERVICE"
  install_plist "restarter" "$RS_PLIST_SRC" "$RS_PLIST_DST" "$RS_SERVICE"

  info "Services installed"
}

trigger_restart() {
  step "Triggering restart"
  touch /private/tmp/kos-agent-restart-trigger
  info "Restart triggered (WatchPaths)"
}

main() {
  echo ""
  echo "  kos-agent deploy"
  echo "  ================"
  echo ""

  check_prereqs

  local install=false
  for arg in "$@"; do
    case "$arg" in
      --install) install=true ;;
    esac
  done

  build

  if [[ "$install" == true ]]; then
    install_services
  fi

  trigger_restart
}

main "$@"
