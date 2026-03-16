#!/usr/bin/env bash
# ClawRank Token Reporter - using OpenClaw gateway usage-cost with fallback
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

# Try gateway usage-cost first
USAGE_OUTPUT=$(openclaw gateway usage-cost 2>&1 | grep "Latest day" || echo "")

TODAY_TOKENS=""
if [ -n "$USAGE_OUTPUT" ]; then
    # Parse: "Latest day: 2026-03-16 · $16.04 · 93.7m tokens"
    TODAY_TOKENS=$(echo "$USAGE_OUTPUT" | sed -E 's/.*([0-9]+\.[0-9]+m).*/\1/')
fi

# Fallback to sessions.json if gateway returns 0 or empty
if [ -z "$TODAY_TOKENS" ] || [ "$TODAY_TOKENS" = "0m" ] || [ "$TODAY_TOKENS" = "0.0m" ]; then
    log "Gateway usage-cost returned empty/0, falling back to sessions.json..."
    
    # Get tokens from sessions.json
    TODAY_TOKENS=$(python3 -c "
import json, os
total = 0
home = os.environ.get('HOME', '')
for agent_dir in os.listdir(f'{home}/.openclaw/agents/'):
    sessions_file = f'{home}/.openclaw/agents/{agent_dir}/sessions/sessions.json'
    try:
        with open(sessions_file) as f:
            data = json.load(f)
        for key, session in data.items():
            tokens = session.get('totalTokens', 0)
            if tokens:
                total += tokens
    except: pass
print(f'{total // 1000000}.{total % 1000000 // 100000}m')
" 2>/dev/null || echo "")
fi

if [ -z "$TODAY_TOKENS" ]; then
    log "No usage data found"
    exit 0
fi

log "Parsed tokens: $TODAY_TOKENS"

# Convert m tokens to integer
TODAY_INT=$(python3 -c "import sys; print(int(float('$TODAY_TOKENS'.replace('m','')) * 1000000))" 2>/dev/null || echo "0")

if [ "$TODAY_INT" = "0" ] || [ -z "$TODAY_INT" ]; then
    log "Could not parse token amount"
    exit 0
fi

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
