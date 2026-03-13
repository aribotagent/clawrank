#!/usr/bin/env bash
# ClawRank Token Reporter - with registered_at filter
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
AGENT_ID=$(python3 -c "
import json
with open('$CONFIG_FILE') as f:
    cfg = json.load(f)
print(cfg.get('agent_id', ''))
")

AGENT_NAME=$(python3 -c "
import json
with open('$CONFIG_FILE') as f:
    cfg = json.load(f)
print(cfg.get('name', 'unknown'))
")

REGISTERED_AT=$(python3 -c "
import json
from datetime import datetime
with open('$CONFIG_FILE') as f:
    cfg = json.load(f)
reg = cfg.get('registered_at', '')
if reg:
    try:
        ts = int(datetime.fromisoformat(reg.replace('Z','+00:00')).timestamp() * 1000)
        print(ts)
    except: print(0)
else: print(0)
")

log "Registered at: $REGISTERED_AT"

# Get current total (only after registered_at)
CURRENT=$(python3 -c "
import json, glob, os
from datetime import datetime
total = 0
home = os.environ.get('HOME', '')
reg_ts = $REGISTERED_AT

for f in glob.glob(f'{home}/.openclaw/agents/*/sessions/*.jsonl'):
    try:
        # Skip files before registration
        if reg_ts > 0:
            mtime = os.path.getmtime(f) * 1000
            if mtime < reg_ts:
                continue
        for line in open(f):
            try:
                obj = json.loads(line)
                msg = obj.get('message', {})
                if isinstance(msg, dict) and msg.get('role') == 'assistant':
                    usage = msg.get('usage', {})
                    if usage:
                        # Try totalTokens first, then total, then input+output
                        t = usage.get('totalTokens', usage.get('total', 0))
                        if not isinstance(t, (int, float)) or t <= 0:
                            t = usage.get('input', 0) + usage.get('output', 0)
                        total += t if isinstance(t, (int, float)) else 0
            except: pass
    except: pass
print(total)
")

# Get previous from state
PREV=$(python3 -c "
import json
try:
    with open('$STATE_FILE') as f:
        data = json.load(f)
    print(data.get('total', 0))
except: print(0)
")

log "Current: $CURRENT, Previous: $PREV"

DELTA=$((CURRENT - PREV))

if [ "$DELTA" -le 0 ]; then
    log "No new tokens (delta=$DELTA)"
    exit 0
fi

if [ "$DELTA" -gt 4000000 ]; then
    log "WARNING: delta $DELTA exceeds limit, capping to 4000000"
    DELTA=4000000
fi

log "Reporting $DELTA tokens..."

# Report
RESULT=$(curl -s -X POST "$API_URL/api/report" \
    -H "Content-Type: application/json" \
    -d "{\"agent_id\": \"$AGENT_ID\", \"agent_name\": \"$AGENT_NAME\", \"tokens_in\": $DELTA, \"tokens_out\": 0}")

if echo "$RESULT" | python3 -c "import json,sys; exit(0 if json.load(sys.stdin).get('ok') else 1)"; then
    SERVER_TOTAL=$(echo "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('total', 0))")
    echo "{\"total\": $CURRENT, \"time\": $(date +%s)000}" > "$STATE_FILE"
    log "Success! Reported $DELTA tokens, server total: $SERVER_TOTAL"
else
    log "Failed: $RESULT"
fi
