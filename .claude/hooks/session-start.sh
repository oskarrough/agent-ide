#!/bin/bash
# Claude Code on the web only: install deps and agent-browser, pointed at the container's Chromium.
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

cd "$CLAUDE_PROJECT_DIR"
bun install
command -v agent-browser >/dev/null || npm install -g agent-browser
[ -n "${CLAUDE_ENV_FILE:-}" ] && echo 'export AGENT_BROWSER_EXECUTABLE_PATH=/opt/pw-browsers/chromium' >> "$CLAUDE_ENV_FILE"
exit 0
