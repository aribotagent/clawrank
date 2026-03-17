#!/usr/bin/env bash
# ClawRank Token Reporter - scan JSONL files for daily tokens
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

log "Agent: $AGENT_NAME ($AGENT_ID)"

# Get today's tokens from JSONL files (records after UTC 0:00 today)
TODAY_TOKENS=$(python3 -c "
import json, os, glob
from datetime import datetime, timezone

home = os.environ.get('HOME', '')
today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()

total = 0
count = 0

for f in glob.glob(f'{home}/.openclaw/agents/*/sessions/*.jsonl'):
    try:
        for line in open(f):
            try:
                obj = json.loads(line)
                # Filter by timestamp
                ts = obj.get('timestamp', '')
                if ts:
                    try:
                        rec_time = datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp()
                        if rec_time >= today_start:
                            msg = obj.get('message', {})
                            if isinstance(msg, dict) and msg.get('role') == 'assistant':
                                u = msg.get('usage', {})
                                if u:
                                    t = u.get('totalTokens', u.get('total', 0))
                                    if not isinstance(t, (int, float)) or t <= 0:
                                        t = u.get('input', 0) + u.get('output', 0)
                                    total += t if isinstance(t, (int, float)) else 0
                                    count += 1
                    except: pass
            except: pass
    except: pass

print(total)
")

log "Today's tokens: $TODAY_TOKENS"

# Get previous state
PREV_DATE=""
PREV_TOKENS=0

if [ -f "$STATE_FILE" ]; then
    PREV_DATE=$(python3 -c "import json; print(json.load(open('$STATE_FILE')).get('date',''))" 2>/dev/null || echo "")
    PREV_TOKENS=$(python3 -c "import json; print(json.load(open('$STATE_FILE')).get('reported_today',0))" 2>/dev/null || echo "0")
fi

# Get today's date
TODAY=$(date -u +%Y-%m-%d)

log "Previous: date=$PREV_DATE, tokens=$PREV_TOKENS"

# If new day, reset
if [ "$PREV_DATE" != "$TODAY" ]; then
    log "New day, resetting counter"
    PREV_TOKENS=0
fi

# Calculate delta
DELTA=$((TODAY_TOKENS - PREV_TOKENS))

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
    # Save state with today's date and reported tokens
    echo "{\"date\": \"$TODAY\", \"reported_today\": $TODAY_TOKENS, \"time\": $(date +%s)000}" > "$STATE_FILE"
    log "Success! Reported $REPORT_TOKENS tokens"
else
    log "Failed: $RESULT"
fi
