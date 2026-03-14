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

# Count tokens from all agents after registration
CURRENT=$(python3 -c "
import json,glob,os,datetime
total=0
home=os.environ.get('HOME','')
reg_ts=float($REG_TS) if $REG_TS else 0

for f in glob.glob(f'{home}/.openclaw/agents/*/sessions/*.jsonl'):
    try:
        for line in open(f):
            try:
                obj=json.loads(line)
                ts=obj.get('timestamp','')
                if ts and reg_ts>0:
                    try:
                        rt=datetime.datetime.fromisoformat(ts.replace('Z','+00:00')).timestamp()
                        if rt<reg_ts: continue
                    except: pass
                msg=obj.get('message',{})
                if isinstance(msg,dict) and msg.get('role')=='assistant':
                    u=msg.get('usage',{})
                    if u:
                        t=u.get('totalTokens',u.get('total',0))
                        if not isinstance(t,(int,float))or t<=0:
                            t=u.get('input',0)+u.get('output',0)
                        total+=t if isinstance(t,(int,float))else 0
            except:pass
    except:pass
print(total)
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
        echo "{\"total\": $NEW_PREV, \"time\": $(date +%s)000}" > "$STATE_FILE"
        log "Success! Reported $REPORT_TOKENS, saved state for next run. Server total: $SERVER_TOTAL"
    else
        echo "{\"total\": $CURRENT, \"time\": $(date +%s)000}" > "$STATE_FILE"
        log "Success! Reported $REPORT_TOKENS, server total: $SERVER_TOTAL"
    fi
else
    log "Failed: $RESULT"
fi
