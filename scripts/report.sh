#!/usr/bin/env bash
# ClawRank Token Reporter - sessions.json + cumulative tracking
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

# Get tokens with proper cumulative tracking
RESULT=$(python3 -c "
import json, os, sys

home = os.environ.get('HOME', '')
state_file = '${STATE_FILE}'

# Get current session tokens from all agents
session_total = 0
for agent_dir in os.listdir(f'{home}/.openclaw/agents/'):
    sessions_file = f'{home}/.openclaw/agents/{agent_dir}/sessions/sessions.json'
    try:
        with open(sessions_file) as f:
            data = json.load(f)
        for key, session in data.items():
            tokens = session.get('totalTokens', 0)
            if tokens:
                session_total += tokens
    except: pass

# Get previous state
prev_cumulative = 0
prev_session = 0
try:
    with open(state_file) as f:
        state = json.load(f)
    prev_cumulative = state.get('cumulative', 0)
    prev_session = state.get('last_session_total', 0)
except: pass

# Calculate delta
new_tokens = session_total - prev_session

if new_tokens > 0:
    cumulative = prev_cumulative + new_tokens
elif new_tokens < 0:
    cumulative = prev_cumulative
else:
    cumulative = prev_cumulative

# Save state with both values
with open(state_file, 'w') as f:
    json.dump({
        'total': cumulative,
        'cumulative': cumulative,
        'last_session_total': session_total
    }, f)

print(f'{cumulative}|{new_tokens}')
")

CURRENT=$(echo "$RESULT" | cut -d'|' -f1)
NEW_TOKENS=$(echo "$RESULT" | cut -d'|' -f2)

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

# Handle large delta - cap at 4M
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
    # State already saved by Python with session_total, just log success
    log "Success! Reported $REPORT_TOKENS, server total: $SERVER_TOTAL"
else
    log "Failed: $RESULT"
fi
