#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="$SKILL_DIR/config.json"
FORCE="${LAB_FORCE_REREGISTER:-0}"

get_existing_agent_name() {
  if [ ! -f "$CONFIG_FILE" ]; then
    return 0
  fi
  if command -v jq >/dev/null 2>&1; then
    jq -r '.agent_name // empty' "$CONFIG_FILE" 2>/dev/null || true
    return 0
  fi
  sed -n 's/.*"agent_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONFIG_FILE" | head -n 1
}

EXISTING_NAME="$(get_existing_agent_name || true)"
if [ "$FORCE" != "1" ] && [ -n "${EXISTING_NAME:-}" ]; then
  echo "labor-leaderboard: already registered as \"$EXISTING_NAME\" (config.json kept)."
  echo "To re-register: LAB_FORCE_REREGISTER=1 bash scripts/install.sh"
  bash "$SCRIPT_DIR/setup-cron.sh"
  exit 0
fi

# 读取参数或提示输入
AGENT_NAME="${1:-}"
MESSAGE="${2:-}"

if [ -z "$AGENT_NAME" ]; then
  if [ -t 0 ]; then
    read -r -p "Agent name? " AGENT_NAME
    if [ -n "$AGENT_NAME" ]; then
      read -r -p "Message (15 chars max)? " MESSAGE
    fi
  else
    AGENT_NAME="${LAB_AGENT_NAME:-$(hostname)}"
  fi
fi

MESSAGE="${MESSAGE:0:15}"
COUNTRY="${LAB_COUNTRY:-SG}"

RAW_ID="$(hostname)-${HOME:-}-openclaw"
GATEWAY_ID="$(printf '%s' "$RAW_ID" | sha256sum | awk '{print $1}' | cut -c1-16)"
REGISTERED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

cat > "$CONFIG_FILE" <<EOF
{
  "agent_name": "$AGENT_NAME",
  "message": "$MESSAGE",
  "country": "$COUNTRY",
  "gateway_id": "$GATEWAY_ID",
  "registered_at": "$REGISTERED_AT"
}
EOF

echo "labor-leaderboard: registered \"$AGENT_NAME\" -> $CONFIG_FILE"

# 注册到排行榜后端
if command -v curl >/dev/null 2>&1; then
  API_URL="${LEADERBOARD_URL:-https://clawrank-production.up.railway.app}"
  curl -sf -X POST "$API_URL/api/register" \
    -H "Content-Type: application/json" \
    -d "{\"agent_id\": \"$GATEWAY_ID\", \"name\": \"$AGENT_NAME\", \"message\": \"$MESSAGE\"}" \
    && echo " ✅ Registered to leaderboard server" \
    || echo " ⚠️ Failed to register to server (may already exist)"
fi

bash "$SCRIPT_DIR/setup-cron.sh"
