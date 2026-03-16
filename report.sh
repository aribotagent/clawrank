#!/usr/bin/env bash
# ClawRank Token Reporter - using OpenClaw gateway usage-cost
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/config.json"
STATE_FILE="${HOME}/.openclaw/labor-leaderboard-state.json"
LOG_FILE="${HOME}/.openclaw/clawrank-report.log"
API_URL="https://clawrank-production.up.railway.app"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

log "Starting report..."

# Get agent info
AGENT_ID=$(python3 -c "import json; cfg=json.load(open('$CONFIG_FILE')); print(cfg.get('agent_id',''))")
AGENT_NAME=$(python3 -c "import json; cfg=json.load(open('$CONFIG_FILE')); print(cfg.get('name','unknown'))")

log "Agent: $AGENT_NAME ($AGENT_ID)"

# Get today's token usage from OpenClaw gateway
USAGE_OUTPUT=$(openclaw gateway usage-cost 2>&1 | grep "Latest day" || echo "")

if [ -z "$USAGE_OUTPUT" ]; then
    log "No usage data found"
    exit 0
fi

# Parse: "Latest day: 2026-03-16 · $16.04 · 93.7m tokens"
TODAY_TOKENS=$(echo "$USAGE_OUTPUT" | sed -E 's/.*([0-9]+\.[0-9]+m).*/\1/')

if [ -z "$TODAY_TOKENS" ]; then
    log "Could not parse token amount"
    exit 0
fi

# Convert m tokens to integer (e.g., "93.7m" -> 93700000)
TODAY_INT=$(python3 -c "import sys; print(int(float('$TODAY_TOKENS'.replace('m','')) * 1000000))")

log "Today's tokens: $TODAY_INT"

# Get previous reported value
PREV=$(python3 -c "import json; print(json.load(open('$STATE_FILE')).get('last_tokens', 0))" 2>/dev/null || echo "0")

log "Previous: $PREV"

DELTA=$((TODAY_INT - PREV))

if [ "$DELTA" -le 0 ]; then
    log "No new tokens to report"
    exit 0
fi

log "Delta: $DELTA"

# Handle large delta - cap at 4M
REPORT_TOKENS=$DELTA
if [ "$DELTA" -gt 4000000 ]; then
    REPORT_TOKENS=4000000
    log "Capped to 4M"
fi

log "Reporting $REPORT_TOKENS tokens..."

RESULT=$(curl -s -X POST "$API_URL/api/report" \
    -H "Content-Type: application/json" \
    -d "{\"agent_id\": \"$AGENT_ID\", \"agent_name\": \"$AGENT_NAME\", \"tokens_in\": $REPORT_TOKENS}")

if echo "$RESULT" | python3 -c "import json,sys; exit(0 if json.load(sys.stdin).get('ok') else 1)"; then
    # Save today's tokens as last reported
    echo "{\"last_tokens\": $TODAY_INT, \"time\": $(date +%s)000}" > "$STATE_FILE"
    log "Success! Reported $REPORT_TOKENS tokens"
else
    log "Failed: $RESULT"
fi
