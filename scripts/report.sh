#!/usr/bin/env bash
# ClawRank Token Reporter
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../config.json"
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

# Get registration timestamp
REG_TS=$(python3 -c "
import json,datetime
cfg=json.load(open('$CONFIG_FILE'))
reg=cfg.get('registered_at','')
if reg:
    print(int(datetime.datetime.fromisoformat(reg.replace('Z','+00:00')).timestamp()))
else: print(0)
")

log "Registered at: $REG_TS"

# Get tokens from sessions.json with cumulative tracking
CURRENT=$(python3 -c "
import json, os
home = os.environ.get('HOME', '')
state_file = os.environ.get('STATE_FILE', '')

# Get current session tokens from all agents
session_total = 0
for agent_dir in ['main', 'xander', 'eva', 'frank', 'cci', 'cci_assistant']:
    sessions_file = f'{home}/.openclaw/agents/{agent_dir}/sessions/sessions.json'
    try:
        with open(sessions_file) as f:
            data = json.load(f)
        for key, session in data.items():
            tokens = session.get('totalTokens', 0)
            if tokens:
                session_total += tokens
    except: pass

# Get previous cumulative from state
prev_cumulative = 0
try:
    with open(state_file) as f:
        state = json.load(f)
    prev_cumulative = state.get('cumulative', 0)
except: pass

# If sessions were reset (current < prev), keep previous cumulative
# Otherwise use current session total
if session_total >= prev_cumulative:
    cumulative = session_total
else:
    cumulative = prev_cumulative

print(cumulative)
")

# Get previous
PREV=$(python3 -c "import json; print(json.load(open('$STATE_FILE')).get('total',0))" 2>/dev/null || echo "0")

log "Current: $CURRENT, Previous: $PREV"

DELTA=$((CURRENT - PREV))
if [ "$DELTA" -lt 0 ]; then
    log "Negative delta, resetting"
    DELTA=0
fi

if [ "$DELTA" -le 0 ]; then
    log "No new tokens"
    exit 0
fi

# Handle large delta - cap at 4M and carry over remainder
REPORT_TOKENS=$DELTA
REMAINDER=0
if [ "$DELTA" -gt 4000000 ]; then
    REPORT_TOKENS=4000000
    REMAINDER=$((DELTA - 4000000))
    log "Delta $DELTA exceeds limit, reporting 4M, carrying over $REMAINDER"
fi

log "Reporting $REPORT_TOKENS tokens..."

RESULT=$(curl -s -X POST "$API_URL/api/report" \
    -H "Content-Type: application/json" \
    -d "{\"agent_id\": \"$AGENT_ID\", \"agent_name\": \"$AGENT_NAME\", \"tokens_in\": $REPORT_TOKENS}")

if echo "$RESULT" | python3 -c "import json,sys; exit(0 if json.load(sys.stdin).get('ok') else 1)"; then
    SERVER_TOTAL=$(echo "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('total',0))")
    
    # Save state - if there's remainder, save (CURRENT - REMAINDER) as previous
    if [ "$REMAINDER" -gt 0 ]; then
        NEW_PREV=$((CURRENT - REMAINDER))
        echo "{\"total\": $NEW_PREV, \"time\": $(date +%s)000, \"cumulative\": $CURRENT}" > "$STATE_FILE"
        log "Success! Reported $REPORT_TOKENS, saved state for next run. Server total: $SERVER_TOTAL"
    else
        echo "{\"total\": $CURRENT, \"time\": $(date +%s)000, \"cumulative\": $CURRENT}" > "$STATE_FILE"
        log "Success! Reported $REPORT_TOKENS, server total: $SERVER_TOTAL"
    fi
else
    log "Failed: $RESULT"
fi
