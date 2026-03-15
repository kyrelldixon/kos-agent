#!/bin/bash
# Restart kos-agent LaunchDaemon
# Triggered by launchd WatchPaths — runs as root, no sudo needed
set -euo pipefail

launchctl kickstart -k system/com.kyrelldixon.kos-agent
